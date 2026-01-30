import type { PRState, ReviewConfig, ReviewDecision } from "../types.js";

export function shouldReview(state: PRState, config: ReviewConfig): ReviewDecision {
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

  // 4. Skipped state — check if skip reason still applies
  if (state.status === "skipped") {
    if (state.skipReason === "draft" && !state.isDraft) {
      // Draft cleared — allow review
      return { shouldReview: true, reason: "PR is no longer a draft" };
    }
    if (state.skipReason === "wip_title" && !state.title.toLowerCase().startsWith("wip")) {
      return { shouldReview: true, reason: "WIP removed from title" };
    }
    // diff_too_large stays skipped until new push changes headSha
    // (which would transition to changes_pushed before this check)
    return { shouldReview: false, reason: `Skipped: ${state.skipReason}` };
  }

  // 5. Already reviewed this SHA
  if (state.status === "reviewed" && state.lastReviewedSha === state.headSha) {
    return { shouldReview: false, reason: "Already reviewed this SHA" };
  }

  // 6. Debounce — wait for pushes to settle
  // Skip debounce when the last review requested changes — author is fixing comments
  const lastReview = state.reviews.length > 0 ? state.reviews[state.reviews.length - 1] : null;
  const isFixingComments = lastReview?.verdict === "REQUEST_CHANGES" && state.headSha !== lastReview.sha;

  if (state.lastPushAt && !isFixingComments) {
    const pushAge = Date.now() - new Date(state.lastPushAt).getTime();
    const debouncePeriodMs = config.debouncePeriodSeconds * 1000;
    if (pushAge < debouncePeriodMs) {
      return { shouldReview: false, reason: `Debouncing: push was ${Math.round(pushAge / 1000)}s ago` };
    }
  }

  // 7. Error backoff — exponential backoff
  if (state.status === "error" && state.lastError) {
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
