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
  },
};

export function loadConfig(path: string = "config.yaml"): AppConfig {
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

  const config: AppConfig = {
    mode: fileConfig.mode ?? DEFAULTS.mode,
    polling: { ...DEFAULTS.polling, ...fileConfig.polling },
    webhook: { ...DEFAULTS.webhook, ...fileConfig.webhook },
    github: { ...DEFAULTS.github, ...fileConfig.github },
    repos: fileConfig.repos ?? DEFAULTS.repos,
    review: { ...DEFAULTS.review, ...fileConfig.review },
  };

  // Environment variable overrides
  if (process.env.GITHUB_TOKEN) {
    config.github.token = process.env.GITHUB_TOKEN;
  }
  if (process.env.WEBHOOK_SECRET) {
    config.webhook.secret = process.env.WEBHOOK_SECRET;
  }
  if (process.env.WEBHOOK_PORT) {
    config.webhook.port = parseInt(process.env.WEBHOOK_PORT, 10);
  }
  if (process.env.POLLING_INTERVAL) {
    config.polling.intervalSeconds = parseInt(process.env.POLLING_INTERVAL, 10);
  }
  if (process.env.MODE) {
    config.mode = process.env.MODE as AppConfig["mode"];
  }

  if (config.repos.length === 0) {
    throw new Error("No repos configured. Add repos to config.yaml or check your configuration.");
  }

  return config;
}
