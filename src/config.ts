import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { AppConfig } from "./types.js";

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
  },
  features: {
    jira: { enabled: false, baseUrl: "", token: "", email: "", projectKeys: [] },
    autoDescription: { enabled: false, overwriteExisting: false, timeoutMs: 120_000 },
    autoLabel: { enabled: false, verdictLabels: {}, severityLabels: {}, diffLabels: [] },
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

  if (config.repos.length === 0 && !allowEmptyRepos) {
    throw new Error("No repos configured. Add repos to config.yaml. If running in Docker, ensure config.yaml is mounted to /app/config.yaml.");
  }

  if (!config.github.token) {
    console.warn("WARNING: No GITHUB_TOKEN configured. GitHub API calls will fail. Set github.token in config.yaml or GITHUB_TOKEN env var.");
  }

  if ((config.mode === "webhook" || config.mode === "both") && !config.webhook.secret) {
    console.warn("WARNING: No webhook secret configured. Webhook signature verification is disabled — any request will be accepted. Set webhook.secret in config.yaml or WEBHOOK_SECRET env var.");
  }

  return config;
}
