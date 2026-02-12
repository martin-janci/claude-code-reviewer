import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { parse } from "yaml";
import type { AppConfig } from "./types.js";
import type { Logger } from "./logger.js";
import {
  DEFAULTS,
  SENSITIVE_FIELDS,
  RESTART_REQUIRED_FIELDS,
  ENV_VAR_MAP,
  validateConfig,
  getByPath,
  setByPath,
  getActiveEnvOverrides,
  serializeConfig,
  loadConfig,
} from "./config.js";

export type ConfigChangeCallback = (
  newConfig: AppConfig,
  oldConfig: AppConfig,
  changedPaths: string[],
) => void;

export interface ConfigUpdateResult {
  success: boolean;
  errors?: string[];
  restartRequired?: boolean;
}

export class ConfigManager {
  private config: AppConfig;
  private callbacks: ConfigChangeCallback[] = [];
  private originalYaml: string = "";
  private writeCount = 0;
  private writeWindowStart = 0;
  private static readonly MAX_WRITES_PER_MINUTE = 10;

  constructor(
    private configPath: string,
    private logger: Logger,
  ) {
    // Load config using existing loadConfig (which handles file + env vars + validation)
    this.config = loadConfig(configPath);

    // Store original YAML for serializeConfig to know what was in the file
    try {
      this.originalYaml = readFileSync(configPath, "utf-8");
    } catch {
      this.originalYaml = "";
    }
  }

  /** Returns current in-memory config. */
  getConfig(): AppConfig {
    return this.config;
  }

  /** Returns config with sensitive fields redacted + env override metadata. */
  getRedactedConfig(): {
    config: Record<string, unknown>;
    envOverrides: string[];
    restartRequiredFields: readonly string[];
  } {
    const redacted = JSON.parse(JSON.stringify(this.config));

    for (const field of SENSITIVE_FIELDS) {
      const value = getByPath(redacted, field);
      if (value && value !== "") {
        setByPath(redacted, field, "[REDACTED]");
      }
    }

    return {
      config: redacted,
      envOverrides: [...getActiveEnvOverrides()],
      restartRequiredFields: RESTART_REQUIRED_FIELDS,
    };
  }

  /**
   * Apply a partial config update.
   * - Deep-merges with current config
   * - Treats "[REDACTED]" values as "no change" for sensitive fields
   * - Re-applies env var overrides (env vars always win)
   * - Validates the result
   * - Persists to config.yaml via atomic write
   * - Fires onChange callbacks
   */
  applyUpdate(partial: Record<string, unknown>): ConfigUpdateResult {
    // Rate limiting
    const now = Date.now();
    if (now - this.writeWindowStart > 60_000) {
      this.writeCount = 0;
      this.writeWindowStart = now;
    }
    if (this.writeCount >= ConfigManager.MAX_WRITES_PER_MINUTE) {
      return { success: false, errors: ["Rate limit exceeded (max 10 writes per minute)"] };
    }

    const oldConfig = this.config;
    const candidate = JSON.parse(JSON.stringify(oldConfig)) as AppConfig;

    // Collect changed paths for callback notification
    const changedPaths: string[] = [];

    // Deep-merge the partial update
    this.deepMerge(candidate, partial, "", changedPaths);

    // Re-apply env var overrides (env vars always win)
    this.applyEnvOverrides(candidate);

    // Validate
    const errors = validateConfig(candidate);
    const fatalErrors = errors.filter((e) => e.severity === "error");
    if (fatalErrors.length > 0) {
      return {
        success: false,
        errors: fatalErrors.map((e) => `${e.field}: ${e.message}`),
      };
    }

    // Persist to config.yaml via atomic write
    try {
      this.persistConfig(candidate);
    } catch (err) {
      return {
        success: false,
        errors: [`Failed to write config file: ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    this.writeCount++;

    // Check if any changed paths require restart
    const restartRequired = changedPaths.some((p) =>
      (RESTART_REQUIRED_FIELDS as readonly string[]).includes(p),
    );

    // Update in-memory config
    this.config = candidate;

    // Fire callbacks
    for (const cb of this.callbacks) {
      try {
        cb(candidate, oldConfig, changedPaths);
      } catch (err) {
        this.logger.error("ConfigManager onChange callback error", { error: String(err) });
      }
    }

    this.logger.info("Config updated", { changedPaths, restartRequired });

    return { success: true, restartRequired };
  }

  /** Validate a partial config update without saving (dry-run). */
  validateUpdate(partial: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const candidate = JSON.parse(JSON.stringify(this.config)) as AppConfig;
    this.deepMerge(candidate, partial, "", []);
    this.applyEnvOverrides(candidate);

    const errors = validateConfig(candidate);
    const fatalErrors = errors.filter((e) => e.severity === "error");
    if (fatalErrors.length > 0) {
      return { valid: false, errors: fatalErrors.map((e) => `${e.field}: ${e.message}`) };
    }
    return { valid: true };
  }

  /** Register a callback for config changes. */
  onChange(callback: ConfigChangeCallback): void {
    this.callbacks.push(callback);
  }

  private deepMerge(
    target: any,
    source: any,
    prefix: string,
    changedPaths: string[],
  ): void {
    if (source === null || source === undefined) return;

    for (const key of Object.keys(source)) {
      const dotPath = prefix ? `${prefix}.${key}` : key;
      const sourceValue = source[key];
      const targetValue = target[key];

      // Handle "[REDACTED]" — skip sensitive fields that weren't actually changed
      if (sourceValue === "[REDACTED]" && SENSITIVE_FIELDS.includes(dotPath as any)) {
        continue;
      }

      // If source is an array, replace entirely
      if (Array.isArray(sourceValue)) {
        if (JSON.stringify(targetValue) !== JSON.stringify(sourceValue)) {
          changedPaths.push(dotPath);
        }
        target[key] = sourceValue;
        continue;
      }

      // If source is an object and target is also an object, recurse
      if (
        typeof sourceValue === "object" &&
        sourceValue !== null &&
        typeof targetValue === "object" &&
        targetValue !== null &&
        !Array.isArray(targetValue)
      ) {
        this.deepMerge(targetValue, sourceValue, dotPath, changedPaths);
        continue;
      }

      // Primitive value — set directly
      if (targetValue !== sourceValue) {
        changedPaths.push(dotPath);
      }
      target[key] = sourceValue;
    }
  }

  private applyEnvOverrides(config: AppConfig): void {
    if (process.env.GITHUB_TOKEN) config.github.token = process.env.GITHUB_TOKEN;
    if (process.env.WEBHOOK_SECRET) config.webhook.secret = process.env.WEBHOOK_SECRET;
    if (process.env.WEBHOOK_PORT) {
      const port = parseInt(process.env.WEBHOOK_PORT, 10);
      if (!Number.isNaN(port) && port >= 1 && port <= 65535) config.webhook.port = port;
    }
    if (process.env.POLLING_INTERVAL) {
      const interval = parseInt(process.env.POLLING_INTERVAL, 10);
      if (!Number.isNaN(interval) && interval >= 1) config.polling.intervalSeconds = interval;
    }
    if (process.env.MODE) {
      const validModes = ["polling", "webhook", "both"];
      if (validModes.includes(process.env.MODE)) config.mode = process.env.MODE as AppConfig["mode"];
    }
    if (process.env.JIRA_TOKEN) config.features.jira.token = process.env.JIRA_TOKEN;
    if (process.env.JIRA_EMAIL) config.features.jira.email = process.env.JIRA_EMAIL;
    if (process.env.JIRA_BASE_URL) config.features.jira.baseUrl = process.env.JIRA_BASE_URL;
    if (process.env.DRY_RUN) config.review.dryRun = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
    if (process.env.SLACK_WEBHOOK_URL) {
      config.features.slack.webhookUrl = process.env.SLACK_WEBHOOK_URL;
      config.features.slack.enabled = true;
    }
    if (process.env.DASHBOARD_PORT) {
      const port = parseInt(process.env.DASHBOARD_PORT, 10);
      if (!Number.isNaN(port) && port >= 1 && port <= 65535) {
        if (!config.dashboard) config.dashboard = { port: 3001 };
        config.dashboard.port = port;
      }
    }
    if (process.env.DASHBOARD_TOKEN) {
      if (!config.dashboard) config.dashboard = { port: 3001 };
      config.dashboard.token = process.env.DASHBOARD_TOKEN;
    }
  }

  private persistConfig(config: AppConfig): void {
    const yaml = serializeConfig(config, this.originalYaml);
    const tmpPath = this.configPath + ".tmp";
    writeFileSync(tmpPath, yaml, "utf-8");
    renameSync(tmpPath, this.configPath);
    // Update stored original YAML to reflect what's now on disk
    this.originalYaml = yaml;
  }
}
