import type { Feature, FeatureContext, FeatureResult } from "./plugin.js";
import { extractJiraKey, validateJiraIssue } from "./jira.js";

/**
 * Jira integration plugin (pre_review phase).
 * Extracts Jira key from PR title/branch and validates against Jira API.
 * Stores jiraKey and jiraValidated in PR state for use in review formatting.
 */
export const jiraPlugin: Feature = {
  name: "jira",
  phase: "pre_review",

  shouldRun(ctx: FeatureContext): boolean {
    // Only run if Jira feature is enabled
    if (!ctx.config.features.jira.enabled) return false;

    // Extract key if not already present
    const currentKey = extractJiraKey(
      ctx.state.title,
      ctx.state.headBranch,
      ctx.config.features.jira.projectKeys,
    );

    // Update state with extracted key if changed
    if (currentKey !== ctx.state.jiraKey) {
      ctx.store.update(ctx.state.owner, ctx.state.repo, ctx.state.number, {
        jiraKey: currentKey,
        jiraValidated: false,
      });
    }

    // Only run validation if we have a key, credentials, and haven't validated yet
    const jiraConfig = ctx.config.features.jira;
    const state = ctx.store.get(ctx.state.owner, ctx.state.repo, ctx.state.number);
    if (!state?.jiraKey) return false;
    if (state.jiraValidated) return false;
    if (!jiraConfig.baseUrl || !jiraConfig.email || !jiraConfig.token) return false;

    return true;
  },

  async execute(ctx: FeatureContext): Promise<FeatureResult> {
    const jiraConfig = ctx.config.features.jira;
    const state = ctx.store.get(ctx.state.owner, ctx.state.repo, ctx.state.number);
    if (!state?.jiraKey) {
      return { success: true, data: { skipped: true, reason: "no_jira_key" } };
    }

    ctx.logger.info("Validating Jira issue", { jiraKey: state.jiraKey });

    const validation = await validateJiraIssue(
      jiraConfig.baseUrl,
      jiraConfig.email,
      jiraConfig.token,
      state.jiraKey,
    );

    ctx.store.update(ctx.state.owner, ctx.state.repo, ctx.state.number, {
      jiraValidated: validation.valid,
    });

    // Return jira link data for use in review formatting
    return {
      success: true,
      data: {
        jiraLink: {
          key: state.jiraKey,
          url: validation.url,
          summary: validation.summary,
          valid: validation.valid,
        },
      },
    };
  },
};
