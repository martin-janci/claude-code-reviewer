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
  // shouldReview() runs. If we're still skipped here, the reason still applies.
  if (state.status === "skipped") {
    return { shouldReview: false, reason: `Skipped: ${state.skipReason}` };
  }

  // 5. Already reviewed this SHA
  if (state.status === "reviewed" && state.lastReviewedSha === state.headSha) {
    if (forceReview) {
      return { shouldReview: true, reason: "Forced re-review (comment trigger)" };
    }
    return { shouldReview: false, reason: "Already reviewed this SHA" };
  }

  // 6. Debounce — wait for pushes to settle
  // Skip debounce when:
  // - The last review requested changes (author is fixing comments)
  // - The last review was APPROVE but new commits were pushed (author added more changes)
  // - Force review was requested
  const lastReview = state.reviews.length > 0 ? state.reviews[state.reviews.length - 1] : null;
  const hasNewCommitsSinceReview = lastReview && state.headSha !== lastReview.sha;
  const skipDebounce = hasNewCommitsSinceReview || forceReview;

  if (state.lastPushAt && !skipDebounce) {
    const pushAge = Date.now() - new Date(state.lastPushAt).getTime();
    const debouncePeriodMs = config.debouncePeriodSeconds * 1000;
    if (pushAge < debouncePeriodMs) {
      return { shouldReview: false, reason: `Debouncing: push was ${Math.round(pushAge / 1000)}s ago` };
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
      return { shouldReview: false, reason: `Error backoff: ${Math.round((backoffMs - errorAge) / 1000)}s remaining` };
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
