import type { AppConfig, PullRequest, ReviewVerdict, ReviewFinding, ErrorPhase, ErrorKind, PRState, ReviewResult, ProcessPRResult, ClaudeUsage } from "../types.js";
import type { StateStore } from "../state/store.js";
import type { CloneManager } from "../clone/manager.js";
import type { MetricsCollector, PhaseTimings } from "../metrics.js";
import type { Logger } from "../logger.js";
import type { ReviewComment } from "./github.js";
import type { Feature, FeatureContext } from "../features/plugin.js";
import type { RateLimitGuard } from "../rate-limit-guard.js";
import { UsageStore } from "../usage/store.js";
import { runFeatures } from "../features/plugin.js";
import { jiraPlugin } from "../features/jira-plugin.js";
import { autoDescriptionPlugin } from "../features/auto-description-plugin.js";
import { autoLabelPlugin } from "../features/auto-label-plugin.js";
import { slackPlugin } from "../features/slack-plugin.js";
import { sendSlackNotification, buildErrorNotification, shouldNotify } from "../features/slack.js";
import { shouldReview } from "../state/decisions.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPRDiff, isDiffTooLargeError, listPRCommits, getCompareDiff, getClaudeIgnore, postReview, postComment, updateComment, deleteComment, findExistingComment, getReviewThreads, resolveReviewThread, type ReviewEvent } from "./github.js";
import { reviewDiff } from "./claude.js";
import { parseCommentableLines, findNearestCommentableLine, filterDiff, mergeExcludePatterns, extractDiffPaths, findSecurityPaths } from "./diff-parser.js";
import { formatReviewBody, formatInlineComment, filterByConfidence, type JiraLink } from "./formatter.js";
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
 *
 * Rate limit detection relies on pattern matching against Claude CLI stderr output.
 * Expected Claude API error patterns (as of 2025):
 *   - 429: "rate_limit_error" / "rate limit" with optional "retry-after: <seconds>"
 *   - 429 spending: includes "spending" / "budget" / "billing" keywords, or retry-after > 300s
 *   - 529: "overloaded_error" / "overloaded"
 * If the error format changes, unrecognized patterns fall through to "transient" (safe default).
 */
export function classifyError(err: unknown, phase: ErrorPhase): ErrorKind {
  const message = err instanceof Error ? err.message : String(err);

  // Turn budget exhausted before the model produced a review. Checked before the
  // generic patterns below because the CLI's own wording ("Reached maximum number
  // of turns") would otherwise fall through to transient and be retried unchanged.
  if (/reached maximum number of turns|error_max_turns|terminated: max_turns/i.test(message)) return "max_turns";

  // Permanent: resource not found or deleted
  if (/404|not found/i.test(message)) return "permanent";

  // Permanent: blocked, forbidden, or access denied
  if (/403|blocked|forbidden|access denied/i.test(message)) return "permanent";

  // Permanent: validation errors (malformed request, invalid parameters)
  if (/422|validation|invalid/i.test(message)) return "permanent";

  // Permanent: authentication failures
  if (/401|unauthorized|authentication/i.test(message)) return "permanent";

  // Spending limit: Claude.ai subscription daily/hourly cap
  // Claude CLI returns is_error with "You've hit your limit · resets Xpm (UTC)"
  if (/hit your limit|resets \d+[ap]m/i.test(message)) return "spending_limit";

  // Rate limit: Claude API 429 — distinguish spending limit from rate limit
  if (/rate limit/i.test(message)) {
    if (/spending|budget|billing/i.test(message)) return "spending_limit";
    // Check retry-after to distinguish: long/absent = spending, short = rate limit
    const retryAfter = extractRetryAfterSeconds(message);
    if (retryAfter !== null && retryAfter > 300) return "spending_limit";
    return "rate_limit";
  }

  // Overloaded: Claude API 529
  if (/overloaded|529/i.test(message)) return "overloaded";

  // Default: transient (timeout, network issues, temporary service errors)
  return "transient";
}

/** Extract retry-after seconds from error messages (e.g. "retry-after: 120" or "retry after 30s"). */
function extractRetryAfterSeconds(message: string): number | null {
  const match = message.match(/retry.?after[:\s]*(\d+)(?:s\b)?/i);
  return match ? parseInt(match[1], 10) : null;
}

/** Describes a partial-diff review: only the last N commits of the PR were reviewed. */
interface PartialDiffInfo {
  reviewedCommits: number;
  totalCommits: number;
  baseSha: string;
}

/** What the exclusion filters removed from the diff, and where the rules came from. */
interface ExclusionInfo {
  /** Effective patterns (config + base-branch .claudeignore), last-match-wins order */
  patterns: string[];
  excludedCount: number;
  claudeignoreApplied: boolean;
  /** The PR itself touches .claudeignore — its version was deliberately not honoured */
  claudeignoreChangedInPR: boolean;
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
  partial?: PartialDiffInfo;
  exclusions?: ExclusionInfo;
}

export class Reviewer {
  private locks = new Map<string, Promise<void>>();
  private inflightCount = 0;
  private features: Feature[];
  // Memoized "is the graphify CLI installed?" probe — the answer can't change mid-process
  private graphifyCliProbe: Promise<boolean> | null = null;
  // Semaphore for limiting concurrent reviews
  private concurrencyQueue: Array<() => void> = [];
  private activeReviews = 0;
  // One pending retry timer per PR — debounced/backed-off reviews are deferred, not lost
  private retryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private config: AppConfig,
    private store: StateStore,
    private logger: Logger,
    private cloneManager?: CloneManager,
    private metrics?: MetricsCollector,
    private auditLogger?: import("../audit/logger.js").AuditLogger,
    private usageStore?: UsageStore,
    private rateLimitGuard?: RateLimitGuard,
  ) {
    // Register feature plugins
    this.features = [
      jiraPlugin,
      autoDescriptionPlugin,
      autoLabelPlugin,
      slackPlugin,
    ];
  }

  /**
   * Hot-reload: swap the config reference for subsequent reviews.
   * Note: reviews already in-flight will continue using the config snapshot they
   * captured at the start of reviewPR(). Only reviews that begin after this call
   * will pick up the new config. This is intentional — mid-flight config changes
   * could cause inconsistent behavior within a single review.
   */
  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  /**
   * Acquire a slot in the concurrency pool.
   * Returns a release function to call when done.
   * Throws if wait exceeds timeout (default 10 minutes).
   */
  private async acquireConcurrencySlot(log: Logger, timeoutMs: number = 600_000): Promise<() => void> {
    const maxConcurrent = this.config.review.maxConcurrentReviews;

    if (this.activeReviews < maxConcurrent) {
      this.activeReviews++;
      log.debug("Acquired concurrency slot", { active: this.activeReviews, max: maxConcurrent });
      return () => this.releaseConcurrencySlot(log);
    }

    // Wait in queue with timeout
    log.info("Waiting for concurrency slot", { active: this.activeReviews, max: maxConcurrent, queued: this.concurrencyQueue.length, timeoutMs });

    let resolver: (() => void) | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const waitPromise = new Promise<"resolved" | "timeout">((resolve) => {
      resolver = () => resolve("resolved");
      this.concurrencyQueue.push(resolver);

      timeoutHandle = setTimeout(() => {
        // Remove from queue if still waiting
        const idx = this.concurrencyQueue.indexOf(resolver!);
        if (idx !== -1) {
          this.concurrencyQueue.splice(idx, 1);
        }
        resolve("timeout");
      }, timeoutMs);
    });

    const result = await waitPromise;

    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (result === "timeout") {
      log.error("Concurrency slot timeout — queue may be stuck", { active: this.activeReviews, queued: this.concurrencyQueue.length });
      throw new Error(`Timed out waiting for concurrency slot after ${timeoutMs}ms`);
    }

    this.activeReviews++;
    log.debug("Acquired concurrency slot after wait", { active: this.activeReviews, max: maxConcurrent });
    return () => this.releaseConcurrencySlot(log);
  }

  private releaseConcurrencySlot(log: Logger): void {
    this.activeReviews--;
    log.debug("Released concurrency slot", { active: this.activeReviews, queued: this.concurrencyQueue.length });

    // Wake next waiter if any
    const next = this.concurrencyQueue.shift();
    if (next) {
      next();
    }
  }

  get lockKeys(): string[] {
    return [...this.locks.keys()];
  }

  get inflight(): number {
    return this.inflightCount;
  }

  async processPR(pr: PullRequest): Promise<ProcessPRResult> {
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

    // Wait for rate limit guard (blocks if globally paused).
    // Ordering: mutex → guard → concurrency slot. This ensures no concurrency
    // slot is held while waiting on the guard, preventing slot leaks during pauses.
    if (this.rateLimitGuard) {
      await this.rateLimitGuard.acquire();
    }

    // Acquire concurrency slot (limits total parallel reviews across all PRs)
    const releaseConcurrency = await this.acquireConcurrencySlot(log);

    let unlock: () => void;
    const lock = new Promise<void>((resolve) => { unlock = resolve; });
    this.locks.set(key, lock);
    this.inflightCount++;
    log.info("Processing PR", { sha: pr.headSha.slice(0, 7), inflight: this.inflightCount, maxConcurrent: this.config.review.maxConcurrentReviews });

    try {
      return await this.doProcessPR(pr, log);
    } finally {
      this.inflightCount--;
      this.locks.delete(key);
      unlock!();
      releaseConcurrency();
      log.info("Finished processing PR");
    }
  }

  private async doProcessPR(pr: PullRequest, log: Logger): Promise<ProcessPRResult> {
    const { owner, repo, number: prNumber, headSha } = pr;
    const reviewStartTime = Date.now();

    log.info("Phase 1: Initializing state", { phase: "init" });

    // Audit: review started
    this.auditLogger?.reviewStarted(owner, repo, prNumber, headSha, "reviewer");

    // Phase 1: Initialize state and check gating conditions
    const initResult = this.initializeState(pr, log);
    if (!initResult.state) {
      log.info("Phase 1: Gating check failed, skipping review", { phase: "init", reason: initResult.skipReason });
      // Audit: review skipped
      this.auditLogger?.reviewSkipped(owner, repo, prNumber, initResult.skipReason ?? "gating check failed", "reviewer");
      return { outcome: "skipped", skipReason: initResult.skipReason };
    }
    const state = initResult.state;

    log.info("Phase 2: Fetching diff", { phase: "diff_fetch" });

    // Phase 2: Fetch and filter diff
    const diffResult = await this.fetchDiff(pr, log);
    if (!diffResult) {
      log.info("Phase 2: Diff fetch failed", { phase: "diff_fetch" });
      // Audit: review failed
      this.auditLogger?.reviewFailed(owner, repo, prNumber, headSha, "Failed to fetch diff", "diff_fetch", "reviewer");
      return { outcome: "error", error: "Failed to fetch diff" };
    }
    if ("skippedTooLarge" in diffResult) {
      log.info("Phase 2: Diff too large to fetch, skipping review", { phase: "diff_fetch" });
      return { outcome: "skipped", skipReason: diffResult.skippedTooLarge };
    }

    log.info("Phase 2: Diff fetched", { phase: "diff_fetch", lines: diffResult.diff.split("\n").length, durationMs: diffResult.diffFetchMs, partial: !!diffResult.partial });

    // Nothing left to review — every file was excluded, or the PR has no file changes.
    // Reviewing an empty payload would produce a hollow "no issues found" verdict.
    if (!/^diff --git /m.test(diffResult.diff)) {
      const { excludedCount, claudeignoreApplied } = diffResult.exclusions;
      const reason = excludedCount > 0
        ? `All ${excludedCount} changed file(s) were excluded by ${claudeignoreApplied ? "`.claudeignore` / exclude patterns" : "exclude patterns"}`
        : "No file changes to review";
      log.info("Skipping: nothing to review after exclusions", { excludedCount, claudeignoreApplied });
      this.metrics?.recordSkip("empty_diff");
      this.store.update(owner, repo, prNumber, {
        status: "skipped",
        skipReason: "empty_diff",
        skipDiffLines: null,
        skippedAtSha: headSha,
      });
      this.auditLogger?.reviewSkipped(owner, repo, prNumber, reason, "reviewer");
      return { outcome: "skipped", skipReason: reason };
    }

    // Set status to reviewing (lock)
    const oldStatus = state.status;
    this.store.setStatus(owner, repo, prNumber, "reviewing");
    log.info("Status set to reviewing", { phase: "reviewing" });
    // Audit: state changed
    this.auditLogger?.stateChanged(owner, repo, prNumber, oldStatus, "reviewing", "reviewer");

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
      // Audit: review skipped
      this.auditLogger?.reviewSkipped(owner, repo, prNumber, `Diff too large (${lineCount} lines)`, "reviewer");
      return { outcome: "skipped", skipReason: `Diff too large (${lineCount} lines, max ${this.config.review.maxDiffLines})` };
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
    const preFeatureResults = await runFeatures(this.features, "pre_review", featureCtx);
    log.info("Completed pre_review features", { phase: "pre_review_features" });

    // Record auto-description usage if available
    const descResult = preFeatureResults.get("auto_description");
    if (descResult?.data?.usage && this.usageStore && this.config.features.usage.enabled) {
      try {
        const descUsage = descResult.data.usage as ClaudeUsage;
        this.usageStore.record(UsageStore.buildRecord(owner, repo, prNumber, "auto_description", descUsage));
        this.metrics?.recordUsage(descUsage);
      } catch (err) {
        log.warn("Failed to record auto-description usage", { error: String(err) });
      }
    }

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
        // Audit: review failed
        const errMsg = err instanceof Error ? err.message : String(err);
        this.auditLogger?.reviewFailed(owner, repo, prNumber, headSha, errMsg, "clone_prepare", "reviewer");
        return { outcome: "error", error: `Worktree preparation failed: ${errMsg}` };
      }
    }

    // Phase 4: Run Claude review
    log.info("Phase 4: Starting Claude review", { phase: "claude_review", codebaseAccess: !!cwd });
    const reviewResult = await this.runReview(pr, currentState, diffResult.diff, cwd, timings, log, !!diffResult.partial, diffResult.exclusions.patterns);
    if (!reviewResult) {
      log.info("Phase 4: Claude review failed", { phase: "claude_review" });
      // Audit: review failed
      this.auditLogger?.reviewFailed(owner, repo, prNumber, headSha, "Claude review execution failed", "claude_review", "reviewer");
      return { outcome: "error", error: "Claude review failed" };
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
      { pr, state: currentState, log, diff: diffResult.diff, cwd, timings, phaseStart, jiraLink, partial: diffResult.partial, exclusions: diffResult.exclusions },
      reviewResult,
    );
    if (!postResult) {
      log.info("Phase 5: Failed to post review", { phase: "comment_post" });
      // Audit: review failed
      this.auditLogger?.reviewFailed(owner, repo, prNumber, headSha, "Failed to post review results", "comment_post", "reviewer");
      return { outcome: "error", error: "Failed to post review" };
    }
    log.info("Phase 5: Review posted", { phase: "comment_post", verdict: postResult.verdict, reviewId: postResult.reviewId, durationMs: timings.comment_post_ms });

    // Audit: comment posted
    this.auditLogger?.commentPosted(owner, repo, prNumber, postResult.commentId ?? "", postResult.reviewId, "reviewer");

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

    // Audit: review completed
    const reviewDuration = Date.now() - reviewStartTime;
    const findingsCount = reviewResult.structured?.findings?.length ?? 0;
    this.auditLogger?.reviewCompleted(owner, repo, prNumber, headSha, postResult.verdict, findingsCount, reviewDuration, "reviewer");

    return { outcome: "reviewed", verdict: postResult.verdict };
    } finally {
      // Always delete the status comment when review finishes (success or error)
      deleteStatusComment();
    }
  }

  /**
   * Phase 1: Initialize state, sync metadata, check gating conditions.
   * Returns { state, skipReason } - state is null if PR should not be reviewed.
   */
  private initializeState(pr: PullRequest, log: Logger): { state: PRState | null; skipReason?: string } {
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
      const reason = "PR is a draft (skipDrafts is enabled)";
      if (pr.forceReview) {
        log.info(`Ignoring /review trigger: ${reason}`);
      }
      if (freshState.status !== "skipped" || freshState.skipReason !== "draft") {
        const oldStatus = freshState.status;
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "draft", skippedAtSha: null });
        this.metrics?.recordSkip("draft");
        // Audit: state changed
        this.auditLogger?.stateChanged(owner, repo, prNumber, oldStatus, "skipped", "reviewer");
      }
      return { state: null, skipReason: reason };
    }
    if (this.config.review.skipWip && freshState.title.toLowerCase().startsWith("wip")) {
      const reason = "PR title starts with WIP (skipWip is enabled)";
      if (pr.forceReview) {
        log.info(`Ignoring /review trigger: ${reason}`);
      }
      if (freshState.status !== "skipped" || freshState.skipReason !== "wip_title") {
        const oldStatus = freshState.status;
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "wip_title", skippedAtSha: null });
        this.metrics?.recordSkip("wip_title");
        // Audit: state changed
        this.auditLogger?.stateChanged(owner, repo, prNumber, oldStatus, "skipped", "reviewer");
      }
      return { state: null, skipReason: reason };
    }

    // Check if we should review
    const decision = shouldReview(freshState, this.config.review, pr.forceReview);
    if (!decision.shouldReview) {
      log.info("Skipping PR", { reason: decision.reason, status: freshState.status });
      // Debounce/backoff windows are temporary — schedule a re-check so the
      // review happens even if no further webhook event ever arrives
      if (decision.retryAfterMs !== undefined) {
        this.scheduleRetry(pr, decision.retryAfterMs, decision.reason, log);
      }
      return { state: null, skipReason: decision.reason };
    }

    log.info("Reviewing PR", { sha: headSha.slice(0, 7), reason: decision.reason });
    return { state: freshState };
  }

  /**
   * Phase 2: Fetch diff and apply exclusion filters.
   * When the full diff is too large for GitHub to serve, falls back to a partial
   * diff of the most recent commits that fit (marked via `partial`). If even that
   * fails the PR goes to the diff_too_large skip state — retrying can never
   * succeed, so it must not hit the error/backoff path. Returns null on other errors.
   */
  private async fetchDiff(
    pr: PullRequest,
    log: Logger,
  ): Promise<{ diff: string; diffFetchMs: number; partial?: PartialDiffInfo; exclusions: ExclusionInfo } | { skippedTooLarge: string } | null> {
    const { owner, repo, number: prNumber, headSha } = pr;

    let diff: string;
    let diffFetchMs: number;
    let partial: PartialDiffInfo | undefined;
    try {
      const t0 = Date.now();
      diff = await getPRDiff(owner, repo, prNumber);
      diffFetchMs = Date.now() - t0;
    } catch (err) {
      if (!isDiffTooLargeError(err)) {
        this.recordError(owner, repo, prNumber, headSha, err, "diff_fetch", log);
        return null;
      }

      const message = err instanceof Error ? err.message : String(err);
      log.info("Full diff too large to fetch, trying partial diff of recent commits", { error: message });
      const t0 = Date.now();
      let fallback: { diff: string; partial: PartialDiffInfo } | null = null;
      try {
        fallback = await this.fetchLatestCommitsDiff(pr, log);
      } catch (fbErr) {
        log.warn("Partial diff fallback failed", { error: fbErr instanceof Error ? fbErr.message : String(fbErr) });
      }

      if (!fallback) {
        log.info("Skipping: diff too large to fetch", { error: message });
        this.metrics?.recordSkip("diff_too_large");
        this.store.update(owner, repo, prNumber, {
          status: "skipped",
          skipReason: "diff_too_large",
          skipDiffLines: null,
          skippedAtSha: headSha,
        });
        this.auditLogger?.reviewSkipped(owner, repo, prNumber, `Diff too large to fetch: ${message}`, "reviewer");
        return { skippedTooLarge: `Diff too large to fetch (${message})` };
      }

      diff = fallback.diff;
      partial = fallback.partial;
      diffFetchMs = Date.now() - t0;
      log.info("Partial diff fallback succeeded", {
        reviewedCommits: partial.reviewedCommits,
        totalCommits: partial.totalCommits,
        baseSha: partial.baseSha.slice(0, 7),
        durationMs: diffFetchMs,
      });
    }

    // Merge repo-level .claudeignore patterns (if enabled) with configured excludePaths.
    // The file is read from the BASE branch, never from the PR head: otherwise a PR
    // could add or widen .claudeignore in the same push and exclude itself from review.
    let excludePatterns = this.config.review.excludePaths;
    let claudeignoreApplied = false;
    const claudeignoreChangedInPR = extractDiffPaths(diff).includes(".claudeignore");
    if (this.config.review.respectClaudeignore) {
      try {
        const ignoreContent = await getClaudeIgnore(owner, repo, pr.baseBranch);
        if (ignoreContent) {
          excludePatterns = mergeExcludePatterns(excludePatterns, ignoreContent);
          claudeignoreApplied = true;
        }
      } catch (err) {
        log.warn("Failed to fetch .claudeignore, continuing without it", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (claudeignoreChangedInPR) {
      log.warn("PR modifies .claudeignore — exclusions taken from the base branch, not from the PR head", { baseBranch: pr.baseBranch });
    }

    // Filter excluded paths from diff
    let excludedCount = 0;
    if (excludePatterns.length > 0) {
      const result = filterDiff(diff, excludePatterns);
      excludedCount = result.excludedCount;
      if (excludedCount > 0) {
        log.info("Filtered excluded paths from diff", { excludedCount, claudeignoreApplied, patterns: excludePatterns });
        diff = result.filtered;
      }
    }

    return {
      diff,
      diffFetchMs,
      partial,
      exclusions: { patterns: excludePatterns, excludedCount, claudeignoreApplied, claudeignoreChangedInPR },
    };
  }

  /**
   * Fallback when the full PR diff is unfetchable: binary-search for the longest
   * run of trailing commits whose combined compare-diff both fetches successfully
   * and fits within review.maxDiffLines. Returns null when no suffix fits.
   */
  private async fetchLatestCommitsDiff(
    pr: PullRequest,
    log: Logger,
  ): Promise<{ diff: string; partial: PartialDiffInfo } | null> {
    const { owner, repo, number: prNumber, headSha } = pr;

    const commits = await listPRCommits(owner, repo, prNumber);
    // Pin the range to the SHA under review. If it isn't in the list (race with a
    // new push, or a PR beyond the API's 250-commit cap), bail — a diff against a
    // different head would misplace inline comments.
    const headIdx = commits.lastIndexOf(headSha);
    if (headIdx < 0) {
      log.warn("Partial diff fallback unavailable: head SHA not in PR commit list", { commits: commits.length });
      return null;
    }
    const chain = commits.slice(0, headIdx + 1);
    const n = chain.length;
    if (n < 2) return null; // single commit — nothing smaller than the full diff to try

    const maxDiffLines = this.config.review.maxDiffLines;
    let best: { diff: string; count: number; baseSha: string } | null = null;
    let lo = 1;
    let hi = n - 1;
    while (lo <= hi) {
      const count = Math.floor((lo + hi) / 2);
      const baseSha = chain[n - count - 1];
      let fits = false;
      try {
        const diff = await getCompareDiff(owner, repo, baseSha, headSha);
        if (diff && diff.split("\n").length <= maxDiffLines) {
          best = { diff, count, baseSha };
          fits = true;
        }
      } catch (err) {
        if (!isDiffTooLargeError(err)) throw err;
      }
      log.debug("Partial diff probe", { commits: count, fits });
      if (fits) lo = count + 1;
      else hi = count - 1;
    }

    if (!best) return null;
    return {
      diff: best.diff,
      partial: { reviewedCommits: best.count, totalCommits: n, baseSha: best.baseSha },
    };
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
    isPartialDiff = false,
    excludePatterns: string[] = [],
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
    } as import("./claude.js").ReviewContext : undefined;

    // Incremental re-review: shrink the payload to just the delta since the last reviewed SHA.
    // Comment line-validation still runs against the full PR diff, so posting is unaffected.
    let reviewDiffText = diff;
    // Not applicable to partial diffs — their path set is incomplete, so a delta
    // restricted to it could look deceptively empty
    if (this.config.review.incrementalReviews && !isPartialDiff && lastReview && context && cwd && lastReview.sha !== headSha) {
      const delta = await this.computeDeltaDiff(cwd, lastReview.sha, headSha, diff, excludePatterns, log);
      if (delta !== null) {
        if (delta.trim() === "") {
          // Rebase/merge with no reviewable content changes — skip the Claude invocation entirely
          log.info("Incremental re-review: no reviewable changes since last review — carrying verdict forward", {
            previousSha: lastReview.sha.slice(0, 7),
            verdict: lastReview.verdict,
          });
          return {
            success: true,
            body: "",
            structured: {
              verdict: lastReview.verdict,
              summary: `No reviewable changes since previously reviewed commit \`${lastReview.sha.slice(0, 7)}\` (rebase or merge without content changes). Previous verdict carried forward.`,
              findings: [],
            },
          };
        }
        if (delta.length < diff.length) {
          log.info("Incremental re-review: using delta diff", {
            previousSha: lastReview.sha.slice(0, 7),
            deltaBytes: delta.length,
            fullBytes: diff.length,
          });
          reviewDiffText = delta;
          context.incrementalSinceSha = lastReview.sha;
        }
      }
    }

    // Detect security-sensitive paths
    const diffPaths = extractDiffPaths(diff);
    const securityPaths = findSecurityPaths(diffPaths, this.config.review.securityPaths);
    if (securityPaths.length > 0) {
      log.info("Security-sensitive paths detected", { paths: securityPaths });
    }

    // Token-cost tiering: small, non-security diffs go to the cheaper model with a
    // tighter turn cap. Security-sensitive PRs always get the full model.
    const reviewCfg = this.config.review;
    let model = reviewCfg.model || undefined;
    let tierMaxTurns: number | undefined;
    // A previous attempt on this same commit ran out of turns — don't hand it the
    // tighter light-tier budget again, escalate to the full model and turn cap.
    const escalateFromMaxTurns = state.lastError?.kind === "max_turns" && state.lastError.sha === headSha;
    if (escalateFromMaxTurns) {
      log.info("Escalating to full tier — previous attempt on this commit exhausted the turn cap", {
        reviewMaxTurns: reviewCfg.reviewMaxTurns,
      });
    }
    if (!escalateFromMaxTurns && reviewCfg.lightModel && reviewCfg.lightModelMaxDiffLines > 0 && securityPaths.length === 0) {
      const diffLines = reviewDiffText.split("\n").length;
      if (diffLines <= reviewCfg.lightModelMaxDiffLines) {
        model = reviewCfg.lightModel;
        if (reviewCfg.lightModelMaxTurns > 0) tierMaxTurns = reviewCfg.lightModelMaxTurns;
        log.info("Token tiering: light model selected", { model, diffLines, maxDiffLines: reviewCfg.lightModelMaxDiffLines, tierMaxTurns });
      }
    }

    // Run Claude review
    const effectiveMaxTurns = pr.overrides?.maxTurns ?? tierMaxTurns ?? (cwd ? this.config.review.reviewMaxTurns : undefined);

    // Look up a cached session for prompt cache reuse
    const usageCfg = this.config.features.usage;
    const sessionId = (this.usageStore && usageCfg.enabled)
      ? this.usageStore.getSession(owner, repo, usageCfg.sessionTtlSeconds) ?? undefined
      : undefined;

    log.info("Starting Claude review", { phase: "claude_review", timeoutMs: this.config.review.reviewTimeoutMs, maxTurns: effectiveMaxTurns, model: model ?? "default", codebase: !!cwd, focusPaths: pr.overrides?.focusPaths, securityPaths: securityPaths.length > 0 ? securityPaths : undefined, sessionReuse: !!sessionId });

    const claudeT0 = Date.now();
    const result = await reviewDiff({
      diff: reviewDiffText,
      prTitle: title,
      context,
      cwd,
      timeoutMs: this.config.review.reviewTimeoutMs,
      maxTurns: effectiveMaxTurns,
      logger: log,
      focusPaths: pr.overrides?.focusPaths,
      securityPaths: securityPaths.length > 0 ? securityPaths : undefined,
      sessionId,
      model,
      requireTests: this.config.review.requireTests,
      testBlockingImportance: this.config.review.testBlockingImportance,
      // Cap exemptions passed to the prompt to bound its size
      testExemptions: state.testExemptions?.slice(-20),
      extraTools: this.config.review.extraTools.length > 0 ? this.config.review.extraTools : undefined,
      graphify: await this.graphifyAvailable(cwd, log),
    });
    timings.claude_review_ms = Date.now() - claudeT0;

    if (!result.success) {
      log.error("Claude review failed", { phase: "claude_review" });
      this.recordError(owner, repo, prNumber, headSha, new Error(result.body || "Claude review returned unsuccessful"), "claude_review", log);
      return null;
    }

    // Record usage and update session for cache reuse
    if (result.usage && this.usageStore && usageCfg.enabled) {
      try {
        this.usageStore.record(UsageStore.buildRecord(owner, repo, prNumber, "review", result.usage));
        if (result.usage.sessionId) {
          this.usageStore.setSession(owner, repo, result.usage.sessionId);
        }
        this.metrics?.recordUsage(result.usage);
      } catch (err) {
        log.warn("Failed to record usage", { error: String(err), sessionId: result.usage?.sessionId });
      }
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
    const { pr, state, log, diff, jiraLink, timings, partial, exclusions } = phase;
    const { owner, repo, number: prNumber, headSha } = pr;

    const postT0 = Date.now();
    const tag = this.config.review.commentTag;
    // Anything that narrowed the reviewed scope must be visible on the PR — a silent
    // exclusion reads as "Claude looked at this and found nothing".
    const notices: string[] = [];
    if (partial) {
      notices.push(`⚠️ **Partial review** — the full PR diff was too large to fetch, so only the last ${partial.reviewedCommits} of ${partial.totalCommits} commits were reviewed (changes since \`${partial.baseSha.slice(0, 7)}\`). Earlier changes in this PR were not reviewed.`);
    }
    if (exclusions && exclusions.excludedCount > 0) {
      const source = exclusions.claudeignoreApplied ? "`.claudeignore` and the reviewer's exclude patterns" : "the reviewer's exclude patterns";
      notices.push(`ℹ️ **${exclusions.excludedCount} changed file(s) excluded** from this review by ${source}.`);
    }
    if (exclusions?.claudeignoreChangedInPR) {
      notices.push(`⚠️ This PR modifies \`.claudeignore\`. Exclusions were taken from the base branch (\`${pr.baseBranch}\`) — the version proposed in this PR was **not** applied.`);
    }
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

      // Apply confidence filtering
      const confidenceThreshold = this.config.review.confidenceThreshold;
      const filteredFindings = filterByConfidence(structured.findings, confidenceThreshold);
      if (filteredFindings.length < structured.findings.length) {
        log.info("Filtered low-confidence findings", {
          threshold: confidenceThreshold,
          before: structured.findings.length,
          after: filteredFindings.length,
        });
      }
      // Use filtered findings for the rest of the review
      structured.findings = filteredFindings;

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
      const body = formatReviewBody(structured, headSha, tag, orphanFindings, jiraLink, notices);

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
      const noticeBlock = notices.length > 0 ? `${notices.map((n) => `> ${n}`).join("\n\n")}\n\n` : "";
      const body = `${tag}\n\n${noticeBlock}${result.body}\n\n---\n*Reviewed by Claude Code at commit ${headSha.slice(0, 7)}*`;

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

    // Get old status before update
    const currentState = this.store.get(owner, repo, prNumber);
    const oldStatus = currentState?.status ?? "reviewing";

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

    // Audit: state changed to reviewed
    this.auditLogger?.stateChanged(owner, repo, prNumber, oldStatus, "reviewed", "reviewer");

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
      // Audit: state changed
      this.auditLogger?.stateChanged(state.owner, state.repo, state.number, "reviewed", "changes_pushed", "reviewer");
    }

    // skipped + condition cleared → pending_review
    if (state.status === "skipped") {
      let cleared = false;
      if (state.skipReason === "draft" && !state.isDraft) cleared = true;
      if (state.skipReason === "wip_title" && !state.title.toLowerCase().startsWith("wip")) cleared = true;
      if ((state.skipReason === "diff_too_large" || state.skipReason === "empty_diff")
        && state.skippedAtSha && state.headSha !== state.skippedAtSha) {
        cleared = true;
      }

      if (cleared) {
        this.store.update(state.owner, state.repo, state.number, {
          status: "pending_review",
          skipReason: null,
          skipDiffLines: null,
          skippedAtSha: null,
        });
        // Audit: state changed
        this.auditLogger?.stateChanged(state.owner, state.repo, state.number, "skipped", "pending_review", "reviewer");
      }
    }
  }

  /**
   * Whether this review can query a graphify knowledge graph: the feature is on,
   * the checked-out repo ships `graphify-out/graph.json`, and the CLI exists in
   * this image. Any of those missing is a silent no-op — reviews never depend on it.
   */
  private async graphifyAvailable(cwd: string | undefined, log: Logger): Promise<boolean> {
    if (!cwd || !this.config.review.graphify) return false;
    if (!existsSync(join(cwd, "graphify-out", "graph.json"))) return false;

    if (!this.graphifyCliProbe) {
      // The CLI is an optional image component; probe once per process, not per PR.
      this.graphifyCliProbe = promisify(execFile)("graphify", ["--help"], { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
    }
    const cliAvailable = await this.graphifyCliProbe;
    if (!cliAvailable) {
      log.warn("Repo ships a graphify graph but the graphify CLI is missing from this image — continuing without graph access");
      return false;
    }
    log.info("Graphify knowledge graph detected — exposing graphify query tools to the review");
    return true;
  }

  /**
   * Compute the diff between the last reviewed SHA and the current head,
   * restricted to paths in the PR diff (so base-branch merges don't flood it)
   * and filtered by the same exclusion patterns the full diff was filtered with
   * (resolved once in fetchDiff — never re-read from the PR's worktree, which
   * would honour a .claudeignore the PR itself introduced).
   * Returns null when the delta cannot be computed (force-push, git error) —
   * callers fall back to the full PR diff.
   */
  private async computeDeltaDiff(cwd: string, fromSha: string, toSha: string, fullDiff: string, excludePatterns: string[], log: Logger): Promise<string | null> {
    const exec = promisify(execFile);
    try {
      await exec("git", ["cat-file", "-e", `${fromSha}^{commit}`], { cwd, timeout: 10_000 });
    } catch {
      log.info("Incremental re-review unavailable — previous SHA not in clone (force-push?)", { previousSha: fromSha.slice(0, 7) });
      return null;
    }
    try {
      const args = ["diff", `${fromSha}..${toSha}`];
      // Restrict to PR-diff paths; skip the pathspec when it would blow up the arg list
      const paths = extractDiffPaths(fullDiff);
      if (paths.length > 0 && paths.length <= 300) {
        args.push("--", ...paths);
      }
      const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
      const { filtered } = filterDiff(stdout, excludePatterns);
      return filtered;
    } catch (err) {
      log.warn("Incremental diff failed — falling back to full diff", { error: String(err).slice(0, 200) });
      return null;
    }
  }

  /**
   * Schedule a deferred re-check of a PR after a debounce/backoff window.
   * One timer per PR — a newer push replaces (and extends) any pending retry,
   * so a burst of pushes settles into a single review after the quiet period.
   */
  private scheduleRetry(pr: PullRequest, delayMs: number, reason: string, log: Logger): void {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    const existing = this.retryTimers.get(key);
    if (existing) clearTimeout(existing);

    // Small buffer so the re-check lands after the window has actually expired
    const delay = delayMs + 1_000;
    log.info("Scheduled review retry", { pr: key, delaySeconds: Math.round(delay / 1000), reason });
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      // Re-evaluates gating from scratch; forceReview must not survive into the retry
      this.processPR({ ...pr, forceReview: false }).catch((err) => {
        this.logger.error("Scheduled retry failed", { pr: key, error: String(err) });
      });
    }, delay);
    timer.unref();
    this.retryTimers.set(key, timer);
  }

  /** Cancel all pending retry timers (graceful shutdown). */
  stop(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private recordError(owner: string, repo: string, prNumber: number, sha: string, err: unknown, phase: ErrorPhase, log: Logger): void {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyError(err, phase);
    this.metrics?.recordError(phase);
    log.error("Review phase error", { phase, error: message, kind });

    // Notify rate limit guard for global pause
    if ((kind === "rate_limit" || kind === "spending_limit" || kind === "overloaded") && this.rateLimitGuard) {
      const retryAfter = extractRetryAfterSeconds(message);
      const cooldown = kind === "spending_limit"
        ? this.config.rateLimit.spendingLimitCooldownSeconds
        : (retryAfter ?? this.config.rateLimit.defaultCooldownSeconds);
      this.rateLimitGuard.reportRateLimit(kind, cooldown);
    }

    // Re-read fresh state to get current consecutiveErrors
    const freshState = this.store.get(owner, repo, prNumber);
    const currentErrors = freshState?.consecutiveErrors ?? 0;

    // Permanent errors skip retries by immediately setting consecutiveErrors to maxRetries
    // Rate limit / spending limit / overloaded errors are transient — use normal backoff.
    // A repeated max_turns on the same SHA means the escalated (full-tier) attempt also
    // ran out of turns — a third try would burn the same tokens for the same result.
    const repeatedMaxTurns = kind === "max_turns"
      && freshState?.lastError?.kind === "max_turns"
      && freshState.lastError.sha === sha;
    const consecutiveErrors = kind === "permanent" || repeatedMaxTurns
      ? this.config.review.maxRetries
      : currentErrors + 1;
    if (repeatedMaxTurns) {
      log.error("Turn cap exhausted again after tier escalation — giving up on this commit", { phase });
    }

    // Get old status before update
    const oldStatus = freshState?.status ?? "pending_review";

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

    // Audit: state changed to error
    this.auditLogger?.stateChanged(owner, repo, prNumber, oldStatus, "error", "reviewer");

    // Notify Slack about the failure (non-fatal, fire-and-forget)
    if (shouldNotify(this.config.features.slack, "error")) {
      const errored = this.store.get(owner, repo, prNumber);
      if (errored) {
        void sendSlackNotification(
          this.config.features.slack,
          buildErrorNotification(errored, `${phase}: ${message}`),
          log,
        );
      }
    }
  }
}
