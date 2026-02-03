import type { AppConfig, PullRequest, PRState, StructuredReview, FeatureExecution, FeatureName, FeatureStatus } from "../types.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/store.js";

export type FeaturePhase = "pre_review" | "post_review";

export interface FeatureContext {
  pr: PullRequest;
  state: Readonly<PRState>;
  config: AppConfig;
  logger: Logger;
  store: StateStore;
  dryRun: boolean;
  // Available in pre_review phase
  diff?: string;
  // Available in post_review phase
  reviewResult?: StructuredReview;
  verdict?: string;
}

export interface FeatureResult {
  success: boolean;
  error?: string;
  /** Optional data to pass to subsequent features or the main flow */
  data?: Record<string, unknown>;
}

export interface Feature {
  /** Unique identifier matching FeatureName type */
  name: FeatureName;
  /** When this feature runs in the review lifecycle */
  phase: FeaturePhase;
  /** Determine if feature should run given current context */
  shouldRun(ctx: FeatureContext): boolean;
  /** Execute the feature logic */
  execute(ctx: FeatureContext): Promise<FeatureResult>;
}

/**
 * Run all features for a given phase, collecting results.
 * Features are run in order. Errors are caught and recorded but don't stop other features.
 */
export async function runFeatures(
  features: Feature[],
  phase: FeaturePhase,
  ctx: FeatureContext,
): Promise<Map<FeatureName, FeatureResult>> {
  const results = new Map<FeatureName, FeatureResult>();
  const phaseFeatures = features.filter((f) => f.phase === phase);

  for (const feature of phaseFeatures) {
    const featureLog = ctx.logger.child({ feature: feature.name, phase });
    const featureCtx = { ...ctx, logger: featureLog };

    const t0 = Date.now();
    let result: FeatureResult;
    let status: FeatureStatus;

    try {
      if (!feature.shouldRun(featureCtx)) {
        result = { success: true };
        status = "skipped";
        featureLog.debug("Feature skipped");
      } else {
        featureLog.debug("Feature starting");
        result = await feature.execute(featureCtx);
        status = result.success ? "success" : "error";
        featureLog.debug("Feature completed", { success: result.success });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { success: false, error: message };
      status = "error";
      featureLog.warn("Feature threw exception", { error: message });
    }

    const durationMs = Date.now() - t0;
    results.set(feature.name, result);

    // Record execution in state
    recordFeatureExecution(ctx.store, ctx.state, feature.name, status, durationMs, result.error);
  }

  return results;
}

/**
 * Record a feature execution in the PR state.
 * Keeps last 20 executions to avoid unbounded growth.
 */
function recordFeatureExecution(
  store: StateStore,
  state: Readonly<PRState>,
  feature: FeatureName,
  status: FeatureStatus,
  durationMs: number,
  error?: string,
): void {
  const execution: FeatureExecution = {
    feature,
    status,
    durationMs,
    timestamp: new Date().toISOString(),
  };
  if (error) execution.error = error;

  const executions = [...state.featureExecutions, execution].slice(-20);
  store.update(state.owner, state.repo, state.number, { featureExecutions: executions });
  // Note: caller should re-read state after this if needed
}
