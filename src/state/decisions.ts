import type { PRState, ReviewConfig, ReviewDecision } from "../types.js";

export function shouldReview(state: PRState, config: ReviewConfig, forceReview?: boolean): ReviewDecision {
  // 1. Terminal states
  if (state.status === "merged") {
    return { shouldReview: false, reason: "PR is merged" };
  }
  if (state.status === "closed") {
    return { shouldReview: false, reason: "PR is closed" };
  }

  // 2. In-progress lock
  if (state.status === "reviewing") {
    return { shouldReview: false, reason: "Review already in progress" };
  }

  // 3. Config-based skips
  if (config.skipDrafts && state.isDraft) {
    return { shouldReview: false, reason: "PR is a draft" };
  }
  if (config.skipWip && state.title.toLowerCase().startsWith("wip")) {
    return { shouldReview: false, reason: "PR title starts with WIP" };
  }

  // 4. Skipped state — evaluateTransitions() clears skip conditions before
  // shouldReview() runs. If we're still skipped here, the reason still applies —
  // except for an explicit /review, whose whole point is to override a skip
  // (e.g. retrying a diff_too_large PR after a reviewer fix or config change).
  if (state.status === "skipped") {
    if (forceReview) {
      return { shouldReview: true, reason: `Forced review of skipped PR (was: ${state.skipReason})` };
    }
    return { shouldReview: false, reason: `Skipped: ${state.skipReason}` };
  }

  // 5. Already reviewed this SHA
  if (state.status === "reviewed" && state.lastReviewedSha === state.headSha) {
    if (forceReview) {
      return { shouldReview: true, reason: "Forced re-review (comment trigger)" };
    }
    return { shouldReview: false, reason: "Already reviewed this SHA" };
  }

  // 6. Debounce — wait for pushes to settle before reviewing.
  // Applies uniformly (including re-reviews after new commits): rapid push bursts
  // collapse into a single review once the window is quiet. Callers schedule a
  // retry via retryAfterMs, so a debounced review is deferred, never lost.
  // Only an explicit force review (comment trigger) bypasses the window.
  if (state.lastPushAt && !forceReview) {
    const pushAge = Date.now() - new Date(state.lastPushAt).getTime();
    const debouncePeriodMs = config.debouncePeriodSeconds * 1000;
    if (pushAge < debouncePeriodMs) {
      return {
        shouldReview: false,
        reason: `Debouncing: push was ${Math.round(pushAge / 1000)}s ago`,
        retryAfterMs: debouncePeriodMs - pushAge,
      };
    }
  }

  // 7. Error backoff — exponential backoff
  if (state.status === "error" && state.lastError && !forceReview) {
    if (state.consecutiveErrors >= config.maxRetries) {
      return { shouldReview: false, reason: `Max retries (${config.maxRetries}) exceeded` };
    }
    const errorAge = Date.now() - new Date(state.lastError.occurredAt).getTime();
    // Exponential backoff: 1m, 2m, 4m, ...
    const backoffMs = 60_000 * Math.pow(2, state.consecutiveErrors - 1);
    if (errorAge < backoffMs) {
      return {
        shouldReview: false,
        reason: `Error backoff: ${Math.round((backoffMs - errorAge) / 1000)}s remaining`,
        retryAfterMs: backoffMs - errorAge,
      };
    }
  }

  // 8. Ready states
  if (
    state.status === "pending_review" ||
    state.status === "changes_pushed" ||
    state.status === "error" ||
    (state.status === "reviewed" && state.lastReviewedSha !== state.headSha)
  ) {
    return { shouldReview: true, reason: `Status: ${state.status}` };
  }

  return { shouldReview: false, reason: `Unhandled status: ${state.status}` };
}
