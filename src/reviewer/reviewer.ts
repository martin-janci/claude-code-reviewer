import type { AppConfig, PullRequest, ReviewVerdict, ReviewFinding, ErrorPhase, ErrorKind, PRState, FeatureExecution, FeatureName, FeatureStatus } from "../types.js";
import type { StateStore } from "../state/store.js";
import type { CloneManager } from "../clone/manager.js";
import type { MetricsCollector, PhaseTimings } from "../metrics.js";
import type { Logger } from "../logger.js";
import type { ReviewComment } from "./github.js";
import { shouldReview } from "../state/decisions.js";
import { getPRDiff, getPRBody, updatePRBody, getPRLabels, postReview, postComment, updateComment, findExistingComment, getReviewThreads, resolveReviewThread } from "./github.js";
import { reviewDiff } from "./claude.js";
import { parseCommentableLines, findNearestCommentableLine, filterDiff } from "./diff-parser.js";
import { formatReviewBody, formatInlineComment, type JiraLink } from "./formatter.js";
import { extractJiraKey, validateJiraIssue } from "../features/jira.js";
import { generateDescription } from "../features/auto-description.js";
import { computeLabels, applyLabels } from "../features/auto-label.js";

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
  const msgLower = message.toLowerCase();

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

export class Reviewer {
  private locks = new Map<string, Promise<void>>();
  private inflightCount = 0;

  constructor(
    private config: AppConfig,
    private store: StateStore,
    private logger: Logger,
    private cloneManager?: CloneManager,
    private metrics?: MetricsCollector,
  ) {}

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
    const { owner, repo, number: prNumber, title, headSha, isDraft, baseBranch, headBranch } = pr;
    const label = `${owner}/${repo}#${prNumber}`;

    // 1. Get or create state entry
    const state = this.store.getOrCreate(owner, repo, prNumber, {
      title,
      isDraft,
      headSha,
      baseBranch,
      headBranch,
    });

    // 2. Sync metadata — detect changes
    this.syncMetadata(state, pr);

    // 2b. Jira key extraction (after metadata sync so title/branch are current)
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
        Object.assign(state, { jiraKey: currentKey, jiraValidated: false });
      }
    }

    // 3. Evaluate transitions
    this.evaluateTransitions(state);
    log.info("PR state", { status: state.status, headSha: state.headSha.slice(0, 7), lastReviewedSha: state.lastReviewedSha?.slice(0, 7) ?? "none", errors: state.consecutiveErrors });

    // 4. Persist skip status for draft/WIP so we don't re-evaluate every cycle.
    //    Also update skip reason if already skipped for a different reason (e.g. diff_too_large → draft).
    if (this.config.review.skipDrafts && state.isDraft) {
      if (pr.forceReview) {
        log.info("Ignoring /review trigger: PR is a draft (skipDrafts is enabled)");
      }
      if (state.status !== "skipped" || state.skipReason !== "draft") {
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "draft", skippedAtSha: null });
        Object.assign(state, { status: "skipped", skipReason: "draft", skippedAtSha: null });
        this.metrics?.recordSkip("draft");
      }
      return;
    }
    if (this.config.review.skipWip && state.title.toLowerCase().startsWith("wip")) {
      if (pr.forceReview) {
        log.info("Ignoring /review trigger: PR title starts with WIP (skipWip is enabled)");
      }
      if (state.status !== "skipped" || state.skipReason !== "wip_title") {
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "wip_title", skippedAtSha: null });
        Object.assign(state, { status: "skipped", skipReason: "wip_title", skippedAtSha: null });
        this.metrics?.recordSkip("wip_title");
      }
      return;
    }

    // 5. Check if we should review
    const decision = shouldReview(state, this.config.review, pr.forceReview);
    if (!decision.shouldReview) {
      log.info("Skipping PR", { reason: decision.reason, status: state.status });
      return;
    }

    log.info("Reviewing PR", { sha: headSha.slice(0, 7), reason: decision.reason });

    // 5. Set status to reviewing (lock)
    this.store.setStatus(owner, repo, prNumber, "reviewing");

    const phaseStart = Date.now();
    const timings: Partial<PhaseTimings> = {};

    // Update capacity metrics
    const queueDepth = (this.store.getStatusCounts().pending_review ?? 0) + (this.store.getStatusCounts().changes_pushed ?? 0);
    this.metrics?.updateCapacity(this.inflightCount, queueDepth);

    // 6. Fetch diff
    let diff: string;
    try {
      const t0 = Date.now();
      diff = await getPRDiff(owner, repo, prNumber);
      timings.diff_fetch_ms = Date.now() - t0;
    } catch (err) {
      this.recordError(state, headSha, err, "diff_fetch", log);
      return;
    }

    // 6b. Filter excluded paths from diff
    if (this.config.review.excludePaths.length > 0) {
      const { filtered, excludedCount } = filterDiff(diff, this.config.review.excludePaths);
      if (excludedCount > 0) {
        log.info("Filtered excluded paths from diff", { excludedCount, patterns: this.config.review.excludePaths });
        diff = filtered;
      }
    }

    // 7. Check diff size
    const lineCount = diff.split("\n").length;
    if (lineCount > this.config.review.maxDiffLines) {
      log.info("Skipping: diff too large", { lineCount, maxDiffLines: this.config.review.maxDiffLines });
      this.metrics?.recordSkip("diff_too_large");
      this.store.update(owner, repo, prNumber, {
        status: "skipped",
        skipReason: "diff_too_large",
        skipDiffLines: lineCount,
        skippedAtSha: headSha,
      });
      return;
    }

    // 7b. Auto-generate PR description if enabled and body is empty
    const skipDescription = pr.overrides?.skipDescription ?? false;
    if (this.config.features.autoDescription.enabled && !state.descriptionGenerated && !skipDescription) {
      const featureT0 = Date.now();
      try {
        const currentBody = await getPRBody(owner, repo, prNumber);
        const hasBody = currentBody.trim().length > 0;
        if (!hasBody || this.config.features.autoDescription.overwriteExisting) {
          log.info("Generating PR description", { phase: "description_generate" });
          const description = await generateDescription(
            diff, title, this.config.features.autoDescription.timeoutMs,
          );
          if (description) {
            if (this.config.review.dryRun) {
              log.info("Dry run: skipping PR description update");
            } else {
              await updatePRBody(owner, repo, prNumber, description);
              log.info("PR description posted");
            }
          }
        }
        this.store.update(owner, repo, prNumber, { descriptionGenerated: true });
        Object.assign(state, { descriptionGenerated: true });
        this.recordFeatureExecution(state, "auto_description", "success", Date.now() - featureT0);
      } catch (err) {
        // Non-fatal: log and continue with review
        log.warn("Auto-description failed", { phase: "description_generate", error: err instanceof Error ? err.message : String(err) });
        this.metrics?.recordError("description_generate");
        this.recordFeatureExecution(state, "auto_description", "error", Date.now() - featureT0, err instanceof Error ? err.message : String(err));
      }
    } else if (this.config.features.autoDescription.enabled && (state.descriptionGenerated || skipDescription)) {
      this.recordFeatureExecution(state, "auto_description", "skipped", undefined, skipDescription ? "override" : "already_done");
    }

    // 8. Build re-review context if applicable
    const lastReview = state.reviews.length > 0 ? state.reviews[state.reviews.length - 1] : null;

    // Collect unique findings from ALL previous reviews for thread resolution.
    // Each review iteration may rephrase the same finding, creating different thread
    // bodies on GitHub. We need every unique body to match threads correctly.
    // Deduplicate by path:line:body to avoid exact duplicates while keeping rephrased ones.
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

    // 8b. Prepare codebase worktree if enabled
    let cwd: string | undefined;
    if (this.cloneManager) {
      try {
        const t0 = Date.now();
        cwd = await this.cloneManager.prepareForPR(owner, repo, prNumber, headSha);
        timings.clone_prepare_ms = Date.now() - t0;
        log.info("Worktree ready", { phase: "clone_prepare", cwd, durationMs: timings.clone_prepare_ms });
      } catch (err) {
        this.recordError(state, headSha, err, "clone_prepare", log);
        return;
      }
    }

    // 9. Run Claude review
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

    // 9b. Cleanup worktree (fire-and-forget)
    if (this.cloneManager) {
      this.cloneManager.cleanupPR(owner, repo, prNumber).catch((err) => {
        log.error("Worktree cleanup failed", { error: String(err) });
      });
    }

    if (!result.success) {
      log.error("Claude review failed", { phase: "claude_review" });
      this.recordError(state, headSha, new Error(result.body || "Claude review returned unsuccessful"), "claude_review", log);
      return;
    }
    log.info("Claude review succeeded", { structured: !!result.structured });


    // 9c. Jira validation (after Claude review, before posting)
    let jiraLink: JiraLink | undefined;
    if (this.config.features.jira.enabled && state.jiraKey) {
      const jiraConfig = this.config.features.jira;
      const featureT0 = Date.now();
      if (jiraConfig.baseUrl && jiraConfig.email && jiraConfig.token && !state.jiraValidated) {
        try {
          const validation = await validateJiraIssue(
            jiraConfig.baseUrl, jiraConfig.email, jiraConfig.token, state.jiraKey,
          );
          jiraLink = {
            key: state.jiraKey,
            url: validation.url,
            summary: validation.summary,
            valid: validation.valid,
          };
          this.store.update(owner, repo, prNumber, { jiraValidated: validation.valid });
          Object.assign(state, { jiraValidated: validation.valid });
          this.recordFeatureExecution(state, "jira", "success", Date.now() - featureT0);
        } catch (err) {
          // Non-fatal: skip Jira link if validation fails
          log.warn("Jira validation failed", { phase: "jira_validate", jiraKey: state.jiraKey, error: err instanceof Error ? err.message : String(err) });
          this.metrics?.recordError("jira_validate");
          jiraLink = {
            key: state.jiraKey,
            url: `${jiraConfig.baseUrl}/browse/${state.jiraKey}`,
            valid: false,
          };
          this.recordFeatureExecution(state, "jira", "error", Date.now() - featureT0, err instanceof Error ? err.message : String(err));
        }
      } else if (jiraConfig.baseUrl) {
        // Already validated or missing credentials — link without summary
        jiraLink = {
          key: state.jiraKey,
          url: `${jiraConfig.baseUrl}/browse/${state.jiraKey}`,
          valid: state.jiraValidated,
        };
        this.recordFeatureExecution(state, "jira", "skipped", undefined, state.jiraValidated ? "already_validated" : "missing_credentials");
      }
    }

    // 10. Post review — structured (PR Reviews API) or legacy (issue comment)
    const postT0 = Date.now();
    const tag = this.config.review.commentTag;
    let verdict: ReviewVerdict;
    let reviewId: string | null = null;
    let commentId: string | null = state.commentId;

    if (result.structured) {
      // Structured path: PR Reviews API with inline comments
      const structured = result.structured;
      verdict = structured.verdict;

      // Auto-escalate verdict if any previous blocking finding is still open
      if (structured.resolutions?.length && context?.previousFindings?.length) {
        const hasOpenBlocking = context.previousFindings.some((pf) => {
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

      if (this.config.review.dryRun) {
        log.info("Dry run: skipping PR review post", { phase: "comment_post", inlineComments: inlineComments.length, orphans: orphanFindings.length, verdict });
      } else {
        try {
          log.info("Posting PR review", { phase: "comment_post", inlineComments: inlineComments.length, orphans: orphanFindings.length });
          reviewId = await postReview(owner, repo, prNumber, body, headSha, inlineComments);
        } catch (err) {
          this.recordError(state, headSha, err, "comment_post", log);
          return;
        }
      }

      // 10b. Resolve review threads for findings marked as resolved.
      //
      // A single conceptual issue may span multiple threads across review iterations
      // (e.g. "matching logic is flawed" → "matching logic is still flawed" → fixed).
      // Each iteration creates a new thread with slightly different body text.
      // For each resolved finding, collect ALL previous findings at the same path:line
      // (across all reviews) and resolve any thread whose body matches any of them.
      const resolvedResolutions = structured.resolutions?.filter((r) => r.resolution === "resolved") ?? [];
      if (resolvedResolutions.length > 0 && context?.previousFindings?.length && !this.config.review.dryRun) {
        try {
          log.info("Fetching review threads to resolve findings", { resolvedCount: resolvedResolutions.length });
          const threads = await getReviewThreads(owner, repo, prNumber);
          log.info("Found review threads", { total: threads.length, unresolved: threads.filter(t => !t.isResolved).length });
          const unresolvedThreads = threads.filter((t) => !t.isResolved);
          const resolvedIds = new Set<string>();

          for (const resolution of resolvedResolutions) {
            // Find ALL previous findings at this path:line (across review iterations)
            const relatedFindings = context.previousFindings.filter(
              (pf) => pf.path === resolution.path && pf.line === resolution.line,
            );
            if (relatedFindings.length === 0) continue;

            // Resolve any unresolved thread whose body matches any related finding
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
          // Non-fatal — thread resolution is best-effort
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
          this.recordError(state, headSha, err, "comment_post", log);
          return;
        }
      }
    }

    timings.comment_post_ms = Date.now() - postT0;

    // 10c. Auto-labeling (after review is posted)
    const skipLabels = pr.overrides?.skipLabels ?? false;
    if (this.config.features.autoLabel.enabled && result.structured && !this.config.review.dryRun && !skipLabels) {
      const featureT0 = Date.now();
      let labelsMutated = false;
      let featureError: string | undefined;
      try {
        const currentLabels = await getPRLabels(owner, repo, prNumber);
        const labelDecision = computeLabels(
          verdict, result.structured.findings, diff,
          this.config.features.autoLabel, currentLabels,
        );
        if (labelDecision.add.length > 0 || labelDecision.remove.length > 0) {
          labelsMutated = true;
          await applyLabels(owner, repo, prNumber, labelDecision);
          log.info("Labels updated", { phase: "label_apply", add: labelDecision.add, remove: labelDecision.remove });
        }
      } catch (err) {
        // Non-fatal: log and continue
        log.warn("Auto-labeling failed", { phase: "label_apply", error: err instanceof Error ? err.message : String(err) });
        this.metrics?.recordError("label_apply");
        featureError = err instanceof Error ? err.message : String(err);
      } finally {
        // Always re-fetch from GitHub after any mutation attempt so state
        // reflects reality even on partial failures (e.g. add succeeds, remove fails)
        if (labelsMutated) {
          try {
            const actualLabels = await getPRLabels(owner, repo, prNumber);
            this.store.update(owner, repo, prNumber, { labelsApplied: actualLabels });
            Object.assign(state, { labelsApplied: actualLabels });
          } catch {
            // Best-effort — label state may be stale but review still proceeds
          }
        }
        this.recordFeatureExecution(state, "auto_label", featureError ? "error" : "success", Date.now() - featureT0, featureError);
      }
    } else if (this.config.features.autoLabel.enabled && (skipLabels || !result.structured || this.config.review.dryRun)) {
      const skipReason = skipLabels ? "override" : !result.structured ? "no_structured_review" : "dry_run";
      this.recordFeatureExecution(state, "auto_label", "skipped", undefined, skipReason);
    }

    // 11. Record review and transition to reviewed.
    //     Re-read state to check for concurrent lifecycle events (e.g. webhook closed/merged
    //     the PR while the review was in progress — lifecycle events bypass the per-PR mutex).
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
      Object.assign(state, updates);
    }
  }

  private evaluateTransitions(state: PRState): void {
    // Note: store.update() mutates the live state object via Object.assign,
    // so the `state` reference is updated in-place — no manual sync needed.

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

  private recordError(state: PRState, sha: string, err: unknown, phase: ErrorPhase, log: Logger): void {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyError(err, phase);
    this.metrics?.recordError(phase);
    log.error("Review phase error", { phase, error: message, kind });

    // Permanent errors skip retries by immediately setting consecutiveErrors to maxRetries
    const consecutiveErrors = kind === "permanent"
      ? this.config.review.maxRetries
      : state.consecutiveErrors + 1;

    this.store.update(state.owner, state.repo, state.number, {
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

  private recordFeatureExecution(
    state: PRState,
    feature: FeatureName,
    status: FeatureStatus,
    durationMs?: number,
    error?: string,
  ): void {
    const execution: FeatureExecution = {
      feature,
      status,
      timestamp: new Date().toISOString(),
    };
    if (durationMs != null) execution.durationMs = durationMs;
    if (error) execution.error = error;

    // Keep last 20 executions per PR to avoid unbounded growth
    const executions = [...state.featureExecutions, execution].slice(-20);
    this.store.update(state.owner, state.repo, state.number, { featureExecutions: executions });
    Object.assign(state, { featureExecutions: executions });
  }
}
