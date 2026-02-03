import type { Feature, FeatureContext, FeatureResult } from "./plugin.js";
import { sendSlackNotification, shouldNotify, buildReviewNotification } from "./slack.js";

/**
 * Slack notification plugin (post_review phase).
 * Sends notifications based on review verdict.
 */
export const slackPlugin: Feature = {
  name: "slack",
  phase: "post_review",

  shouldRun(ctx: FeatureContext): boolean {
    // Skip if feature is disabled
    if (!ctx.config.features.slack.enabled) return false;

    // Need verdict to determine notification type
    if (!ctx.verdict) return false;

    // Check if we should notify for this verdict
    const slackConfig = ctx.config.features.slack;
    if (ctx.verdict === "APPROVE" && shouldNotify(slackConfig, "approve")) return true;
    if (ctx.verdict === "REQUEST_CHANGES" && shouldNotify(slackConfig, "request_changes")) return true;
    if (shouldNotify(slackConfig, "review_complete")) return true;

    return false;
  },

  async execute(ctx: FeatureContext): Promise<FeatureResult> {
    const notification = buildReviewNotification(
      ctx.state,
      ctx.reviewResult,
      ctx.verdict!,
    );

    await sendSlackNotification(
      ctx.config.features.slack,
      notification,
      ctx.logger,
    );

    return {
      success: true,
      data: { notified: true, verdict: ctx.verdict },
    };
  },
};
