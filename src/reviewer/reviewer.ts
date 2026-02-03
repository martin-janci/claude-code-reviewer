import type { AppConfig, PullRequest, ReviewVerdict, ReviewFinding, ErrorPhase, ErrorKind, PRState, ReviewResult } from "../types.js";
import type { StateStore } from "../state/store.js";
import type { CloneManager } from "../clone/manager.js";
import type { MetricsCollector, PhaseTimings } from "../metrics.js";
import type { Logger } from "../logger.js";
import type { ReviewComment } from "./github.js";
import type { Feature, FeatureContext } from "../features/plugin.js";
import { runFeatures } from "../features/plugin.js";
import { jiraPlugin } from "../features/jira-plugin.js";
import { autoDescriptionPlugin } from "../features/auto-description-plugin.js";
import { autoLabelPlugin } from "../features/auto-label-plugin.js";
import { shouldReview } from "../state/decisions.js";
import { getPRDiff, postReview, postComment, updateComment, deleteComment, findExistingComment, getReviewThreads, resolveReviewThread, type ReviewEvent } from "./github.js";
import { reviewDiff } from "./claude.js";
import { parseCommentableLines, findNearestCommentableLine, filterDiff } from "./diff-parser.js";
import { formatReviewBody, formatInlineComment, type JiraLink } from "./formatter.js";
import { extractJiraKey } from "../features/jira.js";

function parseLegacyVerdict(body: string): ReviewVerdict {
  // Scan first 5 non-empty lines for a verdict keyword
  const lines = body.split("\n").filter((l) => l.trim()).slice(0, 5);
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    // Match standalone verdict keywords (with optional markdown formatting)
    if (/\bREQUEST[_\s]CHANGES\b/.test(upper)) return "REQUEST_CHANGES";
    if (/\bAPPROVE[D]?\b/.test(upper)) return "APPROVE";
    if (/\bCOMMENT\b/.test(upper)) return "COMMENT";
  }
  return "unknown";
}

/**
 * Classify an error as transient (retryable) or permanent (skip retries).
 * Permanent errors: 404 Not Found, 403 Blocked, 422 Validation, explicit auth failures.
 * Everything else is transient.
 */
function classifyError(err: unknown, phase: ErrorPhase): ErrorKind {
  const message = err instanceof Error ? err.message : String(err);

  // Permanent: resource not found or deleted
  if (/404|not found/i.test(message)) return "permanent";

  // Permanent: blocked, forbidden, or access denied
  if (/403|blocked|forbidden|access denied/i.test(message)) return "permanent";

  // Permanent: validation errors (malformed request, invalid parameters)
  if (/422|validation|invalid/i.test(message)) return "permanent";

  // Permanent: authentication failures
  if (/401|unauthorized|authentication/i.test(message)) return "permanent";

  // Permanent: rate limit exceeded (often requires manual intervention)
  if (/rate limit/i.test(message)) return "permanent";

  // Default: transient (timeout, network issues, temporary service errors)
  return "transient";
}

/** Internal state passed through review phases */
interface ReviewPhaseState {
  pr: PullRequest;
  state: PRState;
  log: Logger;
  diff: string;
  cwd?: string;
  timings: Partial<PhaseTimings>;
  phaseStart: number;
  jiraLink?: JiraLink;
}

export class Reviewer {
  private locks = new Map<string, Promise<void>>();
  private inflightCount = 0;
  private features: Feature[];

  constructor(
    private config: AppConfig,
    private store: StateStore,
    private logger: Logger,
    private cloneManager?: CloneManager,
    private metrics?: MetricsCollector,
  ) {
    // Register feature plugins
    this.features = [
      jiraPlugin,
      autoDescriptionPlugin,
      autoLabelPlugin,
    ];
  }

  get lockKeys(): string[] {
    return [...this.locks.keys()];
  }

  get inflight(): number {
    return this.inflightCount;
  }

  async processPR(pr: PullRequest): Promise<void> {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    const traceId = Math.random().toString(36).slice(2, 10);
    const log = this.logger.child({ pr: key, traceId });

    // Per-PR mutex: wait in a loop until no lock exists for this key.
    // Loop handles 3+ concurrent callers correctly — after waking,
    // re-check in case another waiter acquired the lock first.
    if (this.locks.has(key)) {
      log.info("Waiting for mutex (another review in progress)");
    }
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    let unlock: () => void;
    const lock = new Promise<void>((resolve) => { unlock = resolve; });
    this.locks.set(key, lock);
    this.inflightCount++;
    log.info("Processing PR", { sha: pr.headSha.slice(0, 7), inflight: this.inflightCount });

    try {
      await this.doProcessPR(pr, log);
    } finally {
      this.inflightCount--;
      this.locks.delete(key);
      unlock!();
      log.info("Finished processing PR");
    }
  }

  private async doProcessPR(pr: PullRequest, log: Logger): Promise<void> {
    const { owner, repo, number: prNumber, headSha } = pr;

    log.info("Phase 1: Initializing state", { phase: "init" });

    // Phase 1: Initialize state and check gating conditions
    const state = this.initializeState(pr, log);
    if (!state) {
      log.info("Phase 1: Gating check failed, skipping review", { phase: "init" });
      return;
    }

    log.info("Phase 2: Fetching diff", { phase: "diff_fetch" });

    // Phase 2: Fetch and filter diff
    const diffResult = await this.fetchDiff(pr, log);
    if (!diffResult) {
      log.info("Phase 2: Diff fetch failed", { phase: "diff_fetch" });
      return;
    }

    log.info("Phase 2: Diff fetched", { phase: "diff_fetch", lines: diffResult.diff.split("\n").length, durationMs: diffResult.diffFetchMs });

    // Set status to reviewing (lock)
    this.store.setStatus(owner, repo, prNumber, "reviewing");
    log.info("Status set to reviewing", { phase: "reviewing" });

    const phaseStart = Date.now();
    const timings: Partial<PhaseTimings> = { diff_fetch_ms: diffResult.diffFetchMs };

    // Post "review started" comment
    let statusCommentId: string | null = null;
    if (!this.config.review.dryRun) {
      try {
        const startMessage = `🔍 **Review started** for commit \`${headSha.slice(0, 7)}\`\n\n_Claude is analyzing your changes..._`;
        statusCommentId = await postComment(owner, repo, prNumber, startMessage);
        log.info("Posted review-started comment", { commentId: statusCommentId });
      } catch (err) {
        log.warn("Failed to post review-started comment", { error: String(err) });
      }
    }

    // Helper to delete status comment (fire-and-forget)
    const deleteStatusComment = () => {
      if (statusCommentId) {
        deleteComment(owner, repo, statusCommentId).catch((err) => {
          log.warn("Failed to delete status comment", { error: String(err) });
        });
      }
    };

    // Update capacity metrics
    const queueDepth = (this.store.getStatusCounts().pending_review ?? 0) + (this.store.getStatusCounts().changes_pushed ?? 0);
    this.metrics?.updateCapacity(this.inflightCount, queueDepth);

    // Check diff size
    const lineCount = diffResult.diff.split("\n").length;
    if (lineCount > this.config.review.maxDiffLines) {
      log.info("Skipping: diff too large", { lineCount, maxDiffLines: this.config.review.maxDiffLines });
      this.metrics?.recordSkip("diff_too_large");
      this.store.update(owner, repo, prNumber, {
        status: "skipped",
        skipReason: "diff_too_large",
        skipDiffLines: lineCount,
        skippedAtSha: headSha,
      });
      deleteStatusComment();
      return;
    }

    try {
    // Build feature context for pre_review phase
    const featureCtx: FeatureContext = {
      pr,
      state: this.store.get(owner, repo, prNumber)!,
      config: this.config,
      logger: log,
      store: this.store,
      dryRun: this.config.review.dryRun,
      diff: diffResult.diff,
    };

    // Run pre_review features (jira extraction, auto-description)
    log.info("Running pre_review features", { phase: "pre_review_features" });
    await runFeatures(this.features, "pre_review", featureCtx);
    log.info("Completed pre_review features", { phase: "pre_review_features" });

    // Re-read state after features may have modified it
    const currentState = this.store.get(owner, repo, prNumber)!;

    // Phase 3: Prepare codebase worktree if enabled
    let cwd: string | undefined;
    if (this.cloneManager) {
      log.info("Phase 3: Preparing worktree", { phase: "clone_prepare" });
      try {
        const t0 = Date.now();
        cwd = await this.cloneManager.prepareForPR(owner, repo, prNumber, headSha);
        timings.clone_prepare_ms = Date.now() - t0;
        log.info("Phase 3: Worktree ready", { phase: "clone_prepare", cwd, durationMs: timings.clone_prepare_ms });
      } catch (err) {
        log.error("Phase 3: Worktree preparation failed", { phase: "clone_prepare", error: String(err) });
        this.recordError(owner, repo, prNumber, headSha, err, "clone_prepare", log);
        return;
      }
    }

    // Phase 4: Run Claude review
    log.info("Phase 4: Starting Claude review", { phase: "claude_review", codebaseAccess: !!cwd });
    const reviewResult = await this.runReview(pr, currentState, diffResult.diff, cwd, timings, log);
    if (!reviewResult) {
      log.info("Phase 4: Claude review failed", { phase: "claude_review" });
      return;
    }
    log.info("Phase 4: Claude review completed", { phase: "claude_review", structured: !!reviewResult.structured, durationMs: timings.claude_review_ms });

    // Cleanup worktree (fire-and-forget)
    if (this.cloneManager) {
      log.debug("Cleaning up worktree", { phase: "worktree_cleanup" });
      this.cloneManager.cleanupPR(owner, repo, prNumber).catch((err) => {
        log.error("Worktree cleanup failed", { phase: "worktree_cleanup", error: String(err) });
      });
    }

    // Build Jira link from state if validated
    let jiraLink: JiraLink | undefined;
    if (this.config.features.jira.enabled && currentState.jiraKey && this.config.features.jira.baseUrl) {
      jiraLink = {
        key: currentState.jiraKey,
        url: `${this.config.features.jira.baseUrl}/browse/${currentState.jiraKey}`,
        valid: currentState.jiraValidated,
      };
      log.debug("Jira link built", { jiraKey: currentState.jiraKey, valid: currentState.jiraValidated });
    }

    // Phase 5: Post review results
    log.info("Phase 5: Posting review results", { phase: "comment_post" });
    const postResult = await this.postResults(
      { pr, state: currentState, log, diff: diffResult.diff, cwd, timings, phaseStart, jiraLink },
      reviewResult,
    );
    if (!postResult) {
      log.info("Phase 5: Failed to post review", { phase: "comment_post" });
      return;
    }
    log.info("Phase 5: Review posted", { phase: "comment_post", verdict: postResult.verdict, reviewId: postResult.reviewId, durationMs: timings.comment_post_ms });

    // Run post_review features (auto-labeling)
    log.info("Running post_review features", { phase: "post_review_features" });
    const postFeatureCtx: FeatureContext = {
      ...featureCtx,
      state: this.store.get(owner, repo, prNumber)!,
      reviewResult: reviewResult.structured,
      verdict: postResult.verdict,
    };
    await runFeatures(this.features, "post_review", postFeatureCtx);
    log.info("Completed post_review features", { phase: "post_review_features" });

    // Phase 6: Finalize review
    log.info("Phase 6: Finalizing review", { phase: "finalize" });
    this.finalizeReview(
      { pr, state: this.store.get(owner, repo, prNumber)!, log, diff: diffResult.diff, timings, phaseStart },
      reviewResult,
      postResult,
    );
    log.info("Phase 6: Review finalized", { phase: "finalize" });
    } finally {
      // Always delete the status comment when review finishes (success or error)
      deleteStatusComment();
    }
  }

  /**
   * Phase 1: Initialize state, sync metadata, check gating conditions.
   * Returns null if PR should not be reviewed.
   */
  private initializeState(pr: PullRequest, log: Logger): PRState | null {
    const { owner, repo, number: prNumber, title, headSha, isDraft, baseBranch, headBranch } = pr;

    // Get or create state entry
    const state = this.store.getOrCreate(owner, repo, prNumber, {
      title,
      isDraft,
      headSha,
      baseBranch,
      headBranch,
    });

    // Sync metadata — detect changes
    this.syncMetadata(state, pr);

    // Jira key extraction (after metadata sync so title/branch are current)
    if (this.config.features.jira.enabled) {
      const currentKey = extractJiraKey(
        state.title,
        state.headBranch,
        this.config.features.jira.projectKeys,
      );
      if (currentKey !== state.jiraKey) {
        this.store.update(owner, repo, prNumber, {
          jiraKey: currentKey,
          jiraValidated: false,
        });
      }
    }

    // Evaluate transitions
    this.evaluateTransitions(state);
    const freshState = this.store.get(owner, repo, prNumber)!;
    log.info("PR state", { status: freshState.status, headSha: freshState.headSha.slice(0, 7), lastReviewedSha: freshState.lastReviewedSha?.slice(0, 7) ?? "none", errors: freshState.consecutiveErrors });

    // Check skip conditions
    if (this.config.review.skipDrafts && freshState.isDraft) {
      if (pr.forceReview) {
        log.info("Ignoring /review trigger: PR is a draft (skipDrafts is enabled)");
      }
      if (freshState.status !== "skipped" || freshState.skipReason !== "draft") {
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "draft", skippedAtSha: null });
        this.metrics?.recordSkip("draft");
      }
      return null;
    }
    if (this.config.review.skipWip && freshState.title.toLowerCase().startsWith("wip")) {
      if (pr.forceReview) {
        log.info("Ignoring /review trigger: PR title starts with WIP (skipWip is enabled)");
      }
      if (freshState.status !== "skipped" || freshState.skipReason !== "wip_title") {
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "wip_title", skippedAtSha: null });
        this.metrics?.recordSkip("wip_title");
      }
      return null;
    }

    // Check if we should review
    const decision = shouldReview(freshState, this.config.review, pr.forceReview);
    if (!decision.shouldReview) {
      log.info("Skipping PR", { reason: decision.reason, status: freshState.status });
      return null;
    }

    log.info("Reviewing PR", { sha: headSha.slice(0, 7), reason: decision.reason });
    return freshState;
  }

  /**
   * Phase 2: Fetch diff and apply exclusion filters.
   * Returns null on error.
   */
  private async fetchDiff(
    pr: PullRequest,
    log: Logger,
  ): Promise<{ diff: string; diffFetchMs: number } | null> {
    const { owner, repo, number: prNumber, headSha } = pr;

    let diff: string;
    let diffFetchMs: number;
    try {
      const t0 = Date.now();
      diff = await getPRDiff(owner, repo, prNumber);
      diffFetchMs = Date.now() - t0;
    } catch (err) {
      this.recordError(owner, repo, prNumber, headSha, err, "diff_fetch", log);
      return null;
    }

    // Filter excluded paths from diff
    if (this.config.review.excludePaths.length > 0) {
      const { filtered, excludedCount } = filterDiff(diff, this.config.review.excludePaths);
      if (excludedCount > 0) {
        log.info("Filtered excluded paths from diff", { excludedCount, patterns: this.config.review.excludePaths });
        diff = filtered;
      }
    }

    return { diff, diffFetchMs };
  }

  /**
   * Phase 4: Run Claude review.
   * Returns null on error.
   */
  private async runReview(
    pr: PullRequest,
    state: Readonly<PRState>,
    diff: string,
    cwd: string | undefined,
    timings: Partial<PhaseTimings>,
    log: Logger,
  ): Promise<ReviewResult | null> {
    const { owner, repo, number: prNumber, headSha, title } = pr;

    // Build re-review context if applicable
    const lastReview = state.reviews.length > 0 ? state.reviews[state.reviews.length - 1] : null;

    // Collect unique findings from ALL previous reviews for thread resolution
    const allPreviousFindings: ReviewFinding[] = [];
    if (state.reviews.length > 0) {
      const seen = new Set<string>();
      for (const rev of state.reviews) {
        for (const f of rev.findings ?? []) {
          const key = `${f.path}:${f.line}:${f.body}`;
          if (!seen.has(key)) {
            seen.add(key);
            allPreviousFindings.push(f);
          }
        }
      }
    }

    const context = lastReview ? {
      previousVerdict: lastReview.verdict,
      previousSha: lastReview.sha,
      previousFindings: allPreviousFindings,
    } : undefined;

    // Run Claude review
    const effectiveMaxTurns = pr.overrides?.maxTurns ?? (cwd ? this.config.review.reviewMaxTurns : undefined);
    log.info("Starting Claude review", { phase: "claude_review", timeoutMs: this.config.review.reviewTimeoutMs, maxTurns: effectiveMaxTurns, codebase: !!cwd, focusPaths: pr.overrides?.focusPaths });

    const claudeT0 = Date.now();
    const result = await reviewDiff({
      diff,
      prTitle: title,
      context,
      cwd,
      timeoutMs: this.config.review.reviewTimeoutMs,
      maxTurns: effectiveMaxTurns,
      logger: log,
      focusPaths: pr.overrides?.focusPaths,
    });
    timings.claude_review_ms = Date.now() - claudeT0;

    if (!result.success) {
      log.error("Claude review failed", { phase: "claude_review" });
      this.recordError(owner, repo, prNumber, headSha, new Error(result.body || "Claude review returned unsuccessful"), "claude_review", log);
      return null;
    }

    log.info("Claude review succeeded", { structured: !!result.structured });
    return result;
  }

  /**
   * Phase 5: Post review results to GitHub.
   * Returns null on error.
   */
  private async postResults(
    phase: ReviewPhaseState,
    result: ReviewResult,
  ): Promise<{ verdict: ReviewVerdict; reviewId: string | null; commentId: string | null } | null> {
    const { pr, state, log, diff, jiraLink, timings } = phase;
    const { owner, repo, number: prNumber, headSha } = pr;

    const postT0 = Date.now();
    const tag = this.config.review.commentTag;
    let verdict: ReviewVerdict;
    let reviewId: string | null = null;
    let commentId: string | null = state.commentId;

    // Build re-review context for thread resolution
    const allPreviousFindings: ReviewFinding[] = [];
    if (state.reviews.length > 0) {
      const seen = new Set<string>();
      for (const rev of state.reviews) {
        for (const f of rev.findings ?? []) {
          const key = `${f.path}:${f.line}:${f.body}`;
          if (!seen.has(key)) {
            seen.add(key);
            allPreviousFindings.push(f);
          }
        }
      }
    }

    if (result.structured) {
      // Structured path: PR Reviews API with inline comments
      const structured = result.structured;
      verdict = structured.verdict;

      // Auto-escalate verdict if any previous blocking finding is still open
      if (structured.resolutions?.length && allPreviousFindings.length) {
        const hasOpenBlocking = allPreviousFindings.some((pf) => {
          if (!pf.blocking) return false;
          const resolution = structured.resolutions?.find(
            (r) => r.path === pf.path && r.line === pf.line,
          );
          return !resolution || resolution.resolution === "open";
        });
        if (hasOpenBlocking && verdict !== "REQUEST_CHANGES") {
          log.info("Escalating verdict to REQUEST_CHANGES — unresolved blocking finding(s)");
          verdict = "REQUEST_CHANGES";
        }
      }

      // Parse commentable lines from the diff
      const commentable = parseCommentableLines(diff);

      // Build inline comments, collecting orphans
      const inlineComments: ReviewComment[] = [];
      const orphanFindings: ReviewFinding[] = [];

      for (const finding of structured.findings) {
        // Praise goes in the review body, not as inline comments
        if (finding.severity === "praise") {
          orphanFindings.push(finding);
          continue;
        }
        const snappedLine = findNearestCommentableLine(commentable, finding.path, finding.line);
        if (snappedLine != null) {
          inlineComments.push({
            path: finding.path,
            line: snappedLine,
            body: formatInlineComment(finding),
          });
        } else {
          orphanFindings.push(finding);
        }
      }

      if (orphanFindings.length > 0) {
        log.info("Findings promoted to review body", { orphanCount: orphanFindings.length });
      }

      // Build top-level review body
      const body = formatReviewBody(structured, headSha, tag, orphanFindings, jiraLink);

      // Map verdict to GitHub review event
      const reviewEvent: ReviewEvent = verdict === "APPROVE" ? "APPROVE" : "COMMENT";

      if (this.config.review.dryRun) {
        log.info("Dry run: skipping PR review post", { phase: "comment_post", inlineComments: inlineComments.length, orphans: orphanFindings.length, verdict, event: reviewEvent });
      } else {
        try {
          log.info("Posting PR review", { phase: "comment_post", inlineComments: inlineComments.length, orphans: orphanFindings.length, verdict, event: reviewEvent });
          reviewId = await postReview(owner, repo, prNumber, body, headSha, inlineComments, reviewEvent);
        } catch (err) {
          this.recordError(owner, repo, prNumber, headSha, err, "comment_post", log);
          return null;
        }
      }

      // Resolve review threads for findings marked as resolved
      const resolvedResolutions = structured.resolutions?.filter((r) => r.resolution === "resolved") ?? [];
      if (resolvedResolutions.length > 0 && allPreviousFindings.length && !this.config.review.dryRun) {
        try {
          log.info("Fetching review threads to resolve findings", { resolvedCount: resolvedResolutions.length });
          const threads = await getReviewThreads(owner, repo, prNumber);
          log.info("Found review threads", { total: threads.length, unresolved: threads.filter(t => !t.isResolved).length });
          const unresolvedThreads = threads.filter((t) => !t.isResolved);
          const resolvedIds = new Set<string>();

          for (const resolution of resolvedResolutions) {
            const relatedFindings = allPreviousFindings.filter(
              (pf) => pf.path === resolution.path && pf.line === resolution.line,
            );
            if (relatedFindings.length === 0) continue;

            for (const thread of unresolvedThreads) {
              if (resolvedIds.has(thread.id)) continue;
              if (thread.path !== resolution.path) continue;
              const matches = relatedFindings.some((pf) => thread.body.includes(pf.body));
              if (matches) {
                await resolveReviewThread(thread.id);
                resolvedIds.add(thread.id);
              }
            }
          }

          if (resolvedIds.size > 0) {
            log.info("Resolved review threads", { count: resolvedIds.size });
          }
        } catch (err) {
          log.warn("Failed to resolve review threads", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    } else {
      // Fallback path: legacy issue comment
      verdict = parseLegacyVerdict(result.body);
      const body = `${tag}\n\n${result.body}\n\n---\n*Reviewed by Claude Code at commit ${headSha.slice(0, 7)}*`;

      if (this.config.review.dryRun) {
        log.info("Dry run: skipping legacy comment post", { phase: "comment_post", verdict });
      } else {
        try {
          const existingId = state.commentId ?? await findExistingComment(owner, repo, prNumber, tag);
          if (existingId) {
            log.info("Updating existing comment", { phase: "comment_post" });
            await updateComment(owner, repo, existingId, body);
            commentId = existingId;
          } else {
            log.info("Posting new comment", { phase: "comment_post" });
            commentId = await postComment(owner, repo, prNumber, body);
          }
        } catch (err) {
          this.recordError(owner, repo, prNumber, headSha, err, "comment_post", log);
          return null;
        }
      }
    }

    timings.comment_post_ms = Date.now() - postT0;
    return { verdict, reviewId, commentId };
  }

  /**
   * Phase 6: Record review and transition to reviewed state.
   */
  private finalizeReview(
    phase: ReviewPhaseState,
    result: ReviewResult,
    postResult: { verdict: ReviewVerdict; reviewId: string | null; commentId: string | null },
  ): void {
    const { pr, state, log, timings, phaseStart } = phase;
    const { owner, repo, number: prNumber, headSha } = pr;
    const { verdict, reviewId, commentId } = postResult;

    // Re-read state to check for concurrent lifecycle events
    const current = this.store.get(owner, repo, prNumber);
    if (current && (current.status === "closed" || current.status === "merged")) {
      log.info("Review complete but PR is now terminal — not overwriting", { terminalStatus: current.status });
      return;
    }

    this.metrics?.recordReview(verdict);

    // Record phase timings
    const totalMs = Date.now() - phaseStart;
    const fullTimings: PhaseTimings = {
      diff_fetch_ms: timings.diff_fetch_ms ?? 0,
      clone_prepare_ms: timings.clone_prepare_ms ?? 0,
      claude_review_ms: timings.claude_review_ms ?? 0,
      comment_post_ms: timings.comment_post_ms ?? 0,
      total_ms: totalMs,
    };
    this.metrics?.recordReviewTiming(fullTimings);
    log.info("Review timings", fullTimings as unknown as Record<string, unknown>);

    const now = new Date().toISOString();
    const maxHistory = this.config.review.maxReviewHistory;
    const posted = !this.config.review.dryRun;
    const reviews = [...state.reviews, {
      sha: headSha,
      reviewedAt: now,
      commentId,
      reviewId,
      verdict,
      posted,
      findings: result.structured?.findings ?? [],
    }].slice(-maxHistory);

    this.store.update(owner, repo, prNumber, {
      status: "reviewed",
      reviews,
      lastReviewedSha: headSha,
      lastReviewedAt: now,
      commentId,
      commentVerifiedAt: commentId ? now : null,
      reviewId,
      reviewVerifiedAt: reviewId ? now : null,
      lastError: null,
      consecutiveErrors: 0,
      skipReason: null,
      skipDiffLines: null,
      skippedAtSha: null,
    });

    log.info("Review complete", { verdict });
  }

  private syncMetadata(state: PRState, pr: PullRequest): void {
    const updates: Partial<PRState> = {};
    let changed = false;

    if (state.title !== pr.title) {
      updates.title = pr.title;
      changed = true;
    }
    if (state.isDraft !== pr.isDraft) {
      updates.isDraft = pr.isDraft;
      changed = true;
    }
    if (state.baseBranch !== pr.baseBranch) {
      updates.baseBranch = pr.baseBranch;
      changed = true;
    }
    if (state.headBranch !== pr.headBranch) {
      updates.headBranch = pr.headBranch;
      changed = true;
    }
    if (state.headSha !== pr.headSha) {
      updates.headSha = pr.headSha;
      updates.lastPushAt = new Date().toISOString();
      changed = true;
    }

    if (changed) {
      this.store.update(state.owner, state.repo, state.number, updates);
    }
  }

  private evaluateTransitions(state: PRState): void {
    // reviewed + new SHA → changes_pushed
    if (state.status === "reviewed" && state.lastReviewedSha && state.headSha !== state.lastReviewedSha) {
      this.store.setStatus(state.owner, state.repo, state.number, "changes_pushed");
    }

    // skipped + condition cleared → pending_review
    if (state.status === "skipped") {
      let cleared = false;
      if (state.skipReason === "draft" && !state.isDraft) cleared = true;
      if (state.skipReason === "wip_title" && !state.title.toLowerCase().startsWith("wip")) cleared = true;
      if (state.skipReason === "diff_too_large" && state.skippedAtSha && state.headSha !== state.skippedAtSha) {
        cleared = true;
      }

      if (cleared) {
        this.store.update(state.owner, state.repo, state.number, {
          status: "pending_review",
          skipReason: null,
          skipDiffLines: null,
          skippedAtSha: null,
        });
      }
    }
  }

  private recordError(owner: string, repo: string, prNumber: number, sha: string, err: unknown, phase: ErrorPhase, log: Logger): void {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyError(err, phase);
    this.metrics?.recordError(phase);
    log.error("Review phase error", { phase, error: message, kind });

    // Re-read fresh state to get current consecutiveErrors
    const freshState = this.store.get(owner, repo, prNumber);
    const currentErrors = freshState?.consecutiveErrors ?? 0;

    // Permanent errors skip retries by immediately setting consecutiveErrors to maxRetries
    const consecutiveErrors = kind === "permanent"
      ? this.config.review.maxRetries
      : currentErrors + 1;

    this.store.update(owner, repo, prNumber, {
      status: "error",
      lastError: {
        occurredAt: new Date().toISOString(),
        sha,
        message,
        phase,
        kind,
      },
      consecutiveErrors,
    });
  }
}
