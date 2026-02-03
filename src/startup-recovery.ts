import type { AppConfig, PRState, PullRequest } from "./types.js";
import type { StateStore } from "./state/store.js";
import type { Reviewer } from "./reviewer/reviewer.js";
import type { Logger } from "./logger.js";
import { getPRDetails, getPRState } from "./reviewer/github.js";

/**
 * Startup recovery: scan state for PRs that need attention after a restart.
 *
 * Recoverable states:
 * - pending_review: needs initial review
 * - changes_pushed: has new commits since last review
 * - reviewed: check if new commits were pushed while we were down
 * - error: retry if under max retries
 *
 * For each recoverable PR:
 * 1. Fetch current state from GitHub (may be closed/merged now)
 * 2. If still open and needs review, queue it
 */
export async function recoverPendingReviews(
  config: AppConfig,
  store: StateStore,
  reviewer: Reviewer,
  logger: Logger,
): Promise<number> {
  const trackedRepos = new Set(config.repos.map((r) => `${r.owner}/${r.repo}`));
  const entries = store.getAll();

  // Filter to PRs that might need recovery
  const candidates = entries.filter((entry) => {
    // Must be a tracked repo
    if (!trackedRepos.has(`${entry.owner}/${entry.repo}`)) return false;

    // Skip terminal states
    if (entry.status === "closed" || entry.status === "merged") return false;

    // Skip if currently reviewing (crash recovery in store.ts handles this)
    if (entry.status === "reviewing") return false;

    // Recoverable states
    if (entry.status === "pending_review") return true;
    if (entry.status === "changes_pushed") return true;
    if (entry.status === "reviewed") return true; // Check for new commits
    if (entry.status === "error" && entry.consecutiveErrors < config.review.maxRetries) return true;

    // Skip skipped PRs (will be re-evaluated when condition clears)
    return false;
  });

  if (candidates.length === 0) {
    logger.info("Startup recovery: no PRs need recovery");
    return 0;
  }

  logger.info("Startup recovery: checking PRs", { count: candidates.length });

  let queued = 0;
  const MAX_CONCURRENT_RECOVERY = 3;

  // Process in batches to avoid overwhelming GitHub API
  for (let i = 0; i < candidates.length; i += MAX_CONCURRENT_RECOVERY) {
    const batch = candidates.slice(i, i + MAX_CONCURRENT_RECOVERY);

    await Promise.all(batch.map(async (entry) => {
      try {
        const result = await recoverPR(entry, config, store, reviewer, logger);
        if (result) queued++;
      } catch (err) {
        logger.warn("Startup recovery: failed to recover PR", {
          pr: `${entry.owner}/${entry.repo}#${entry.number}`,
          error: String(err),
        });
      }
    }));
  }

  logger.info("Startup recovery complete", { queued, checked: candidates.length });
  return queued;
}

async function recoverPR(
  entry: PRState,
  config: AppConfig,
  store: StateStore,
  reviewer: Reviewer,
  logger: Logger,
): Promise<boolean> {
  const key = `${entry.owner}/${entry.repo}#${entry.number}`;

  // Check current PR state on GitHub
  let prState: { state: string; mergedAt: string | null };
  try {
    prState = await getPRState(entry.owner, entry.repo, entry.number);
  } catch (err) {
    // PR may have been deleted or we don't have access
    logger.warn("Startup recovery: cannot fetch PR state", { pr: key, error: String(err) });
    return false;
  }

  // Handle closed/merged PRs
  if (prState.state === "MERGED") {
    logger.info("Startup recovery: PR is now merged", { pr: key });
    store.update(entry.owner, entry.repo, entry.number, {
      status: "merged",
      closedAt: prState.mergedAt ?? new Date().toISOString(),
    });
    return false;
  }

  if (prState.state === "CLOSED") {
    logger.info("Startup recovery: PR is now closed", { pr: key });
    store.update(entry.owner, entry.repo, entry.number, {
      status: "closed",
      closedAt: new Date().toISOString(),
    });
    return false;
  }

  // PR is still open - fetch full details
  let pr: PullRequest;
  try {
    pr = await getPRDetails(entry.owner, entry.repo, entry.number);
  } catch (err) {
    logger.warn("Startup recovery: cannot fetch PR details", { pr: key, error: String(err) });
    return false;
  }

  // Check if there are new commits since our last review
  const lastReview = entry.reviews.length > 0 ? entry.reviews[entry.reviews.length - 1] : null;
  const hasNewCommits = !lastReview || pr.headSha !== lastReview.sha;

  // Determine if we should queue this PR
  let shouldQueue = false;
  let reason = "";

  if (entry.status === "pending_review") {
    shouldQueue = true;
    reason = "pending_review";
  } else if (entry.status === "changes_pushed") {
    shouldQueue = true;
    reason = "changes_pushed";
  } else if (entry.status === "reviewed" && hasNewCommits) {
    // New commits arrived while we were down
    shouldQueue = true;
    reason = "new_commits_while_down";
    // Update state to reflect new commits
    store.update(entry.owner, entry.repo, entry.number, {
      status: "changes_pushed",
      headSha: pr.headSha,
      lastPushAt: new Date().toISOString(),
    });
  } else if (entry.status === "error" && entry.consecutiveErrors < config.review.maxRetries) {
    shouldQueue = true;
    reason = "error_retry";
  }

  if (!shouldQueue) {
    return false;
  }

  logger.info("Startup recovery: queuing PR for review", {
    pr: key,
    reason,
    sha: pr.headSha.slice(0, 7),
    lastReviewedSha: lastReview?.sha.slice(0, 7) ?? "none",
  });

  // Queue the review (fire-and-forget, reviewer handles its own errors)
  reviewer.processPR(pr).catch((err) => {
    logger.error("Startup recovery: review failed", { pr: key, error: String(err) });
  });

  return true;
}
