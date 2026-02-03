import type { Feature, FeatureContext, FeatureResult } from "./plugin.js";
import { computeLabels, applyLabels } from "./auto-label.js";
import { getPRLabels } from "../reviewer/github.js";

/**
 * Auto-label plugin (post_review phase).
 * Applies labels based on review verdict, finding severity, and diff file paths.
 */
export const autoLabelPlugin: Feature = {
  name: "auto_label",
  phase: "post_review",

  shouldRun(ctx: FeatureContext): boolean {
    // Skip if feature is disabled
    if (!ctx.config.features.autoLabel.enabled) return false;

    // Skip in dry-run mode
    if (ctx.dryRun) return false;

    // Skip if override flag is set
    if (ctx.pr.overrides?.skipLabels) return false;

    // Need structured review result and verdict to determine labels
    if (!ctx.reviewResult || !ctx.verdict) return false;

    return true;
  },

  async execute(ctx: FeatureContext): Promise<FeatureResult> {
    const { owner, repo, number: prNumber } = ctx.state;

    // shouldRun guarantees these are present
    const verdict = ctx.verdict!;
    const findings = ctx.reviewResult!.findings;

    // Fetch current labels
    const currentLabels = await getPRLabels(owner, repo, prNumber);

    // Compute label changes
    const labelDecision = computeLabels(
      verdict,
      findings,
      ctx.diff ?? "",
      ctx.config.features.autoLabel,
      currentLabels,
    );

    // Skip if no changes needed
    if (labelDecision.add.length === 0 && labelDecision.remove.length === 0) {
      return { success: true, data: { noChanges: true } };
    }

    // Apply label changes
    await applyLabels(owner, repo, prNumber, labelDecision);
    ctx.logger.info("Labels updated", { add: labelDecision.add, remove: labelDecision.remove });

    // Re-fetch actual labels to confirm state
    const actualLabels = await getPRLabels(owner, repo, prNumber);
    ctx.store.update(owner, repo, prNumber, { labelsApplied: actualLabels });

    return {
      success: true,
      data: {
        added: labelDecision.add,
        removed: labelDecision.remove,
        current: actualLabels,
      },
    };
  },
};
