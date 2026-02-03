import type { Feature, FeatureContext, FeatureResult } from "./plugin.js";
import { generateDescription } from "./auto-description.js";
import { getPRBody, updatePRBody } from "../reviewer/github.js";

/**
 * Auto-description plugin (pre_review phase).
 * Generates PR description from diff using Claude CLI if body is empty
 * (or if overwriteExisting is enabled).
 */
export const autoDescriptionPlugin: Feature = {
  name: "auto_description",
  phase: "pre_review",

  shouldRun(ctx: FeatureContext): boolean {
    // Skip if feature is disabled
    if (!ctx.config.features.autoDescription.enabled) return false;

    // Skip if already generated for this PR
    if (ctx.state.descriptionGenerated) return false;

    // Skip if override flag is set
    if (ctx.pr.overrides?.skipDescription) return false;

    // Need diff to generate description
    if (!ctx.diff) return false;

    return true;
  },

  async execute(ctx: FeatureContext): Promise<FeatureResult> {
    const { owner, repo, number: prNumber } = ctx.state;

    // Check if PR already has a body
    const currentBody = await getPRBody(owner, repo, prNumber);
    const hasBody = currentBody.trim().length > 0;

    // Skip if has body and overwrite is disabled
    if (hasBody && !ctx.config.features.autoDescription.overwriteExisting) {
      ctx.store.update(owner, repo, prNumber, { descriptionGenerated: true });
      return { success: true, data: { skipped: true, reason: "has_existing_body" } };
    }

    ctx.logger.info("Generating PR description");

    const description = await generateDescription(
      ctx.diff!,
      ctx.state.title,
      ctx.config.features.autoDescription.timeoutMs,
    );

    if (!description) {
      return { success: false, error: "Claude returned empty description" };
    }

    if (ctx.dryRun) {
      ctx.logger.info("Dry run: skipping PR description update");
      ctx.store.update(owner, repo, prNumber, { descriptionGenerated: true });
      return { success: true, data: { dryRun: true } };
    }

    await updatePRBody(owner, repo, prNumber, description);
    ctx.logger.info("PR description posted");

    ctx.store.update(owner, repo, prNumber, { descriptionGenerated: true });

    return { success: true };
  },
};
