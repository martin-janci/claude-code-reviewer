import { readFileSync } from "node:fs";
import { parse } from "yaml";
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

  return errors;
}

const DEFAULTS: AppConfig = {
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
  },
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
    },
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
