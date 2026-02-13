import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import type { AppConfig } from "./types.js";

export interface ConfigError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export function validateConfig(config: AppConfig): ConfigError[] {
  const errors: ConfigError[] = [];

  // Numeric range checks
  if (config.review.maxDiffLines < 1) {
    errors.push({ field: "review.maxDiffLines", message: "Must be >= 1", severity: "error" });
  }
  if (config.review.reviewTimeoutMs < 10_000) {
    errors.push({ field: "review.reviewTimeoutMs", message: "Must be >= 10000 (10s)", severity: "error" });
  }
  if (config.review.cloneTimeoutMs < 5_000) {
    errors.push({ field: "review.cloneTimeoutMs", message: "Must be >= 5000 (5s)", severity: "error" });
  }
  if (config.review.maxRetries < 0) {
    errors.push({ field: "review.maxRetries", message: "Must be >= 0", severity: "error" });
  }
  if (config.review.debouncePeriodSeconds < 0) {
    errors.push({ field: "review.debouncePeriodSeconds", message: "Must be >= 0", severity: "error" });
  }
  if (config.review.reviewMaxTurns < 1) {
    errors.push({ field: "review.reviewMaxTurns", message: "Must be >= 1", severity: "error" });
  }
  if (config.review.maxReviewHistory < 1) {
    errors.push({ field: "review.maxReviewHistory", message: "Must be >= 1", severity: "error" });
  }
  if (config.review.staleClosedDays < 1) {
    errors.push({ field: "review.staleClosedDays", message: "Must be >= 1", severity: "warning" });
  }
  if (config.review.staleErrorDays < 1) {
    errors.push({ field: "review.staleErrorDays", message: "Must be >= 1", severity: "warning" });
  }
  if (config.review.commentVerifyIntervalMinutes < 1) {
    errors.push({ field: "review.commentVerifyIntervalMinutes", message: "Must be >= 1", severity: "warning" });
  }
  if (config.polling.intervalSeconds < 1) {
    errors.push({ field: "polling.intervalSeconds", message: "Must be >= 1", severity: "error" });
  }

  // Feature coherence
  if (config.features.jira.enabled) {
    if (!config.features.jira.baseUrl) {
      errors.push({ field: "features.jira.baseUrl", message: "Required when jira.enabled is true", severity: "error" });
    }
  }
  if (config.features.autoDescription.enabled) {
    if (config.features.autoDescription.timeoutMs < 5_000) {
      errors.push({ field: "features.autoDescription.timeoutMs", message: "Must be >= 5000 (5s)", severity: "warning" });
    }
  }

  // Regex validity
  try {
    new RegExp(config.review.commentTrigger);
  } catch {
    errors.push({ field: "review.commentTrigger", message: `Invalid regex: "${config.review.commentTrigger}"`, severity: "error" });
  }

  // Exclude path patterns — warn on suspicious patterns
  if (config.review.excludePaths) {
    for (const p of config.review.excludePaths) {
      if (!p.trim()) {
        errors.push({ field: "review.excludePaths", message: `Empty pattern in excludePaths`, severity: "warning" });
      }
    }
  }

  // Parallel reviews
  if (config.review.maxConcurrentReviews < 1) {
    errors.push({ field: "review.maxConcurrentReviews", message: "Must be >= 1", severity: "error" });
  }
  if (config.review.maxConcurrentReviews > 10) {
    errors.push({ field: "review.maxConcurrentReviews", message: "Should be <= 10 to avoid rate limits", severity: "warning" });
  }

  // Confidence threshold
  if (config.review.confidenceThreshold < 0 || config.review.confidenceThreshold > 100) {
    errors.push({ field: "review.confidenceThreshold", message: "Must be between 0 and 100", severity: "error" });
  }

  // Slack config
  if (config.features.slack.enabled && !config.features.slack.webhookUrl) {
    errors.push({ field: "features.slack.webhookUrl", message: "Required when slack.enabled is true", severity: "error" });
  }

  // Audit config
  if (config.features.audit.enabled) {
    if (config.features.audit.maxEntries < 100) {
      errors.push({ field: "features.audit.maxEntries", message: "Should be >= 100 for useful history", severity: "warning" });
    }
    if (config.features.audit.maxEntries > 100000) {
      errors.push({ field: "features.audit.maxEntries", message: "Should be <= 100000 to avoid large files", severity: "warning" });
    }
    if (!config.features.audit.filePath) {
      errors.push({ field: "features.audit.filePath", message: "File path is required", severity: "error" });
    }
  }

  // Autofix config
  if (config.features.autofix.enabled) {
    if (config.features.autofix.maxTurns < 1) {
      errors.push({ field: "features.autofix.maxTurns", message: "Must be >= 1", severity: "error" });
    }
    if (config.features.autofix.timeoutMs < 10_000) {
      errors.push({ field: "features.autofix.timeoutMs", message: "Must be >= 10000 (10s)", severity: "error" });
    }
    try {
      new RegExp(config.features.autofix.commandTrigger);
    } catch {
      errors.push({ field: "features.autofix.commandTrigger", message: `Invalid regex: "${config.features.autofix.commandTrigger}"`, severity: "error" });
    }
  }

  // Rate limit config
  if (config.rateLimit.defaultCooldownSeconds < 10) {
    errors.push({ field: "rateLimit.defaultCooldownSeconds", message: "Must be >= 10", severity: "error" });
  }
  if (config.rateLimit.spendingLimitCooldownSeconds < 60) {
    errors.push({ field: "rateLimit.spendingLimitCooldownSeconds", message: "Must be >= 60", severity: "error" });
  }
  if (config.rateLimit.maxEventHistory < 1) {
    errors.push({ field: "rateLimit.maxEventHistory", message: "Must be >= 1", severity: "error" });
  }

  // Usage tracking config
  if (config.features.usage.enabled) {
    if (!config.features.usage.dbPath) {
      errors.push({ field: "features.usage.dbPath", message: "Database path is required", severity: "error" });
    }
    if (config.features.usage.retentionDays < 1) {
      errors.push({ field: "features.usage.retentionDays", message: "Must be >= 1", severity: "error" });
    }
    if (config.features.usage.sessionTtlSeconds < 0) {
      errors.push({ field: "features.usage.sessionTtlSeconds", message: "Must be >= 0", severity: "error" });
    }
  }

  return errors;
}

/** Dot-paths to config fields that contain secrets and must be redacted. */
export const SENSITIVE_FIELDS = [
  "github.token",
  "webhook.secret",
  "features.jira.token",
  "features.jira.email",
  "features.slack.webhookUrl",
  "dashboard.token",
] as const;

/** Map of environment variable names to the config dot-paths they override. */
export const ENV_VAR_MAP: Record<string, string> = {
  GITHUB_TOKEN: "github.token",
  WEBHOOK_SECRET: "webhook.secret",
  WEBHOOK_PORT: "webhook.port",
  POLLING_INTERVAL: "polling.intervalSeconds",
  MODE: "mode",
  JIRA_TOKEN: "features.jira.token",
  JIRA_EMAIL: "features.jira.email",
  JIRA_BASE_URL: "features.jira.baseUrl",
  DRY_RUN: "review.dryRun",
  SLACK_WEBHOOK_URL: "features.slack.webhookUrl",
  DASHBOARD_PORT: "dashboard.port",
  DASHBOARD_TOKEN: "dashboard.token",
};

/** Fields that require a full restart to take effect (bound at startup). */
export const RESTART_REQUIRED_FIELDS = [
  "mode",
  "webhook.port",
  "webhook.path",
  "webhook.secret",
  "github.token",
] as const;

export const DEFAULTS: AppConfig = {
  mode: "polling",
  polling: { intervalSeconds: 300 },
  webhook: { port: 3000, secret: "", path: "/webhook" },
  github: { token: "" },
  repos: [],
  review: {
    maxDiffLines: 5000,
    skipDrafts: true,
    skipWip: true,
    commentTag: "<!-- claude-code-review -->",
    maxRetries: 3,
    debouncePeriodSeconds: 60,
    staleClosedDays: 7,
    staleErrorDays: 30,
    commentVerifyIntervalMinutes: 60,
    maxReviewHistory: 20,
    commentTrigger: "^\\s*/review\\s*$",
    codebaseAccess: true,
    cloneDir: "data/clones",
    cloneTimeoutMs: 120_000,
    reviewTimeoutMs: 600_000,
    reviewMaxTurns: 15,
    staleWorktreeMinutes: 60,
    excludePaths: [],
    dryRun: false,
    maxConcurrentReviews: 3,
    confidenceThreshold: 0, // 0 = show all findings, 80 = filter low-confidence
    securityPaths: ["**/auth/**", "**/crypto/**", "**/security/**", "**/*.env*", "**/secrets/**"],
  },
  features: {
    jira: { enabled: false, baseUrl: "", token: "", email: "", projectKeys: [] },
    autoDescription: { enabled: false, overwriteExisting: false, timeoutMs: 120_000 },
    autoLabel: { enabled: false, verdictLabels: {}, severityLabels: {}, diffLabels: [] },
    slack: { enabled: false, webhookUrl: "", notifyOn: ["error", "request_changes"] },
    audit: { enabled: false, maxEntries: 10000, filePath: "data/audit.json", includeMetadata: true, minSeverity: "info" },
    autofix: { enabled: false, commandTrigger: "^\\s*/fix\\s*$", autoApply: false, maxTurns: 10, timeoutMs: 300_000 },
    usage: { enabled: true, dbPath: "data/usage.db", retentionDays: 90, sessionTtlSeconds: 270 },
  },
  dashboard: { port: 3001 },
  rateLimit: { defaultCooldownSeconds: 120, spendingLimitCooldownSeconds: 3600, maxEventHistory: 50 },
};

export function loadConfig(path: string = "config.yaml", allowEmptyRepos = false): AppConfig {
  let fileConfig: Partial<AppConfig> = {};

  try {
    const raw = readFileSync(path, "utf-8");
    fileConfig = parse(raw) ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    console.warn(`Config file not found at ${path}, using defaults + env vars`);
  }

  const fileFeatures = (fileConfig as any).features as Partial<AppConfig["features"]> | undefined;
  const config: AppConfig = {
    mode: fileConfig.mode ?? DEFAULTS.mode,
    polling: { ...DEFAULTS.polling, ...fileConfig.polling },
    webhook: { ...DEFAULTS.webhook, ...fileConfig.webhook },
    github: { ...DEFAULTS.github, ...fileConfig.github },
    repos: fileConfig.repos ?? DEFAULTS.repos,
    review: { ...DEFAULTS.review, ...fileConfig.review },
    features: {
      jira: { ...DEFAULTS.features.jira, ...fileFeatures?.jira },
      autoDescription: { ...DEFAULTS.features.autoDescription, ...fileFeatures?.autoDescription },
      autoLabel: { ...DEFAULTS.features.autoLabel, ...fileFeatures?.autoLabel },
      slack: { ...DEFAULTS.features.slack, ...fileFeatures?.slack },
      audit: { ...DEFAULTS.features.audit, ...fileFeatures?.audit },
      autofix: { ...DEFAULTS.features.autofix, ...fileFeatures?.autofix },
      usage: { ...DEFAULTS.features.usage, ...fileFeatures?.usage },
    },
    dashboard: { ...DEFAULTS.dashboard!, ...fileConfig.dashboard },
    rateLimit: { ...DEFAULTS.rateLimit, ...fileConfig.rateLimit },
  };

  // Environment variable overrides
  if (process.env.GITHUB_TOKEN) {
    config.github.token = process.env.GITHUB_TOKEN;
  }
  if (process.env.WEBHOOK_SECRET) {
    config.webhook.secret = process.env.WEBHOOK_SECRET;
  }
  if (process.env.WEBHOOK_PORT) {
    const port = parseInt(process.env.WEBHOOK_PORT, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid WEBHOOK_PORT: "${process.env.WEBHOOK_PORT}" (must be 1-65535)`);
    }
    config.webhook.port = port;
  }
  if (process.env.POLLING_INTERVAL) {
    const interval = parseInt(process.env.POLLING_INTERVAL, 10);
    if (Number.isNaN(interval) || interval < 1) {
      throw new Error(`Invalid POLLING_INTERVAL: "${process.env.POLLING_INTERVAL}" (must be >= 1)`);
    }
    config.polling.intervalSeconds = interval;
  }
  if (process.env.MODE) {
    const validModes = ["polling", "webhook", "both"];
    if (!validModes.includes(process.env.MODE)) {
      throw new Error(`Invalid MODE: "${process.env.MODE}". Must be one of: ${validModes.join(", ")}`);
    }
    config.mode = process.env.MODE as AppConfig["mode"];
  }
  if (process.env.JIRA_TOKEN) {
    config.features.jira.token = process.env.JIRA_TOKEN;
  }
  if (process.env.JIRA_EMAIL) {
    config.features.jira.email = process.env.JIRA_EMAIL;
  }
  if (process.env.JIRA_BASE_URL) {
    config.features.jira.baseUrl = process.env.JIRA_BASE_URL;
  }
  if (process.env.DRY_RUN) {
    config.review.dryRun = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
  }
  if (process.env.SLACK_WEBHOOK_URL) {
    config.features.slack.webhookUrl = process.env.SLACK_WEBHOOK_URL;
    config.features.slack.enabled = true;
  }
  if (process.env.DASHBOARD_PORT) {
    const port = parseInt(process.env.DASHBOARD_PORT, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid DASHBOARD_PORT: "${process.env.DASHBOARD_PORT}" (must be 1-65535)`);
    }
    if (!config.dashboard) config.dashboard = { port: 3001 };
    config.dashboard.port = port;
  }
  if (process.env.DASHBOARD_TOKEN) {
    if (!config.dashboard) config.dashboard = { port: 3001 };
    config.dashboard.token = process.env.DASHBOARD_TOKEN;
  }

  if (config.repos.length === 0 && !allowEmptyRepos) {
    throw new Error("No repos configured. Add repos to config.yaml. If running in Docker, ensure config.yaml is mounted to /app/config.yaml.");
  }

  if (!config.github.token) {
    console.warn("WARNING: No GITHUB_TOKEN configured. GitHub API calls will fail. Set github.token in config.yaml or GITHUB_TOKEN env var.");
  }

  if ((config.mode === "webhook" || config.mode === "both") && !config.webhook.secret) {
    console.warn("WARNING: No webhook secret configured. Webhook signature verification is disabled — any request will be accepted. Set webhook.secret in config.yaml or WEBHOOK_SECRET env var.");
  }

  // Validate config
  const validationErrors = validateConfig(config);
  const fatalErrors = validationErrors.filter((e) => e.severity === "error");
  const warnings = validationErrors.filter((e) => e.severity === "warning");

  for (const w of warnings) {
    console.warn(`Config warning: ${w.field} — ${w.message}`);
  }
  if (fatalErrors.length > 0) {
    const details = fatalErrors.map((e) => `  ${e.field}: ${e.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }

  return config;
}

/** Get a value from a nested object by dot-path. */
export function getByPath(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

/** Set a value in a nested object by dot-path. */
export function setByPath(obj: any, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => {
    if (o[k] === undefined || o[k] === null) o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}

/** Returns the set of config dot-paths currently overridden by env vars. */
export function getActiveEnvOverrides(): Set<string> {
  const active = new Set<string>();
  for (const [envVar, dotPath] of Object.entries(ENV_VAR_MAP)) {
    if (process.env[envVar]) {
      active.add(dotPath);
    }
  }
  return active;
}

/**
 * Serialize config to YAML for persistence.
 * Omits sensitive fields whose values came only from env vars (not from the original file).
 */
export function serializeConfig(config: AppConfig, originalYaml?: string): string {
  // Parse the original file to know which sensitive fields were explicitly set
  let originalConfig: any = {};
  if (originalYaml) {
    try {
      originalConfig = parse(originalYaml) ?? {};
    } catch {
      // If the original YAML is malformed, serialize everything non-sensitive
    }
  }

  // Deep clone config for serialization
  const output = JSON.parse(JSON.stringify(config));

  // Remove sensitive fields that weren't in the original file
  for (const field of SENSITIVE_FIELDS) {
    const originalValue = getByPath(originalConfig, field);
    if (originalValue === undefined || originalValue === null || originalValue === "") {
      // This sensitive field wasn't in the original file — don't leak it
      setByPath(output, field, "");
    }
  }

  // Remove dashboard config if it only has defaults
  if (output.dashboard && !originalConfig.dashboard) {
    delete output.dashboard;
  }

  return stringify(output, { lineWidth: 120 });
}
