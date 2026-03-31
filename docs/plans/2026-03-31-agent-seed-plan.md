# agent-seed Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold a reusable TypeScript/Node.js base project for Claude-powered automation agents with webhook ingestion, polling, dashboard, hot-reload config, structured logging, job state, and a plugin system.

**Architecture:** Three layers — infrastructure (config, logger), event pipeline (webhook + poller), agent (AgentRunner + Claude CLI + plugins). Each new agent only overrides `AgentRunner.run()`. Everything else is wired and ready.

**Tech Stack:** TypeScript 5, Node.js 20+, `claude` CLI, `yaml`, Vitest + `@vitest/coverage-v8`, Docker (dhi.io/node:20-alpine), conventional commits.

---

## Prerequisites

- `gh` CLI authenticated as `martinjancipapayapos` (papayapos org account)
- Node.js 20+ and npm installed
- Working directory for the new repo (outside the reviewer repo)

---

### Task 1: Create GitHub repo and local project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `commitlint.config.js`
- Create: `.npmrc`

**Step 1: Create the GitHub repo**

```bash
gh repo create papayapos/agent-seed \
  --public \
  --description "General-purpose TypeScript/Node.js scaffold for Claude-powered agents" \
  --clone
cd agent-seed
```

Expected: repo created and cloned, you are in `agent-seed/`

**Step 2: Create `package.json`**

```json
{
  "name": "@papayapos/agent-seed",
  "version": "0.1.0",
  "description": "General-purpose scaffold for Claude-powered automation agents",
  "main": "dist/index.js",
  "type": "commonjs",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "prepare": "simple-git-hooks"
  },
  "simple-git-hooks": {
    "commit-msg": "npx commitlint --edit $1"
  },
  "commitlint": {
    "extends": ["@commitlint/config-conventional"]
  },
  "dependencies": {
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@commitlint/cli": "^19.0.0",
    "@commitlint/config-conventional": "^19.0.0",
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "simple-git-hooks": "^2.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

**Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 4: Create `.gitignore`**

```
node_modules/
dist/
data/
*.js.map
.env
.env.*
```

**Step 5: Create `commitlint.config.js`**

```js
module.exports = { extends: ["@commitlint/config-conventional"] };
```

**Step 6: Create `.npmrc`**

```
save-exact=true
```

**Step 7: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, `package-lock.json` generated.

**Step 8: Commit**

```bash
git add .
git commit -m "chore: initial project scaffold"
```

---

### Task 2: Core types

**Files:**
- Create: `src/types.ts`

No tests — pure TypeScript interfaces. The compiler is the test.

**Step 1: Create `src/types.ts`**

```ts
// --- Config types ---

export interface WebhookConfig {
  port: number;
  path: string;
  secret: string;
}

export interface PollingConfig {
  intervalSeconds: number;
  targets: string[];
}

export interface AgentConfig {
  claudeModel: string;
  maxTurns: number;
  timeoutMs: number;
  maxConcurrent: number;
  maxRetries: number;
  retryBackoffMs: number;
}

export interface DashboardConfig {
  port: number;
  token: string;
}

export interface StateConfig {
  filePath: string;
}

export interface AppConfig {
  mode: "webhook" | "polling" | "both";
  webhook: WebhookConfig;
  polling: PollingConfig;
  agent: AgentConfig;
  dashboard: DashboardConfig;
  state: StateConfig;
  features: Record<string, unknown>;
}

// --- Job state machine ---

export type JobStatus = "pending" | "processing" | "done" | "error" | "failed";

export interface Job {
  id: string;           // stable: deterministic hash of source + payload key
  source: string;       // "webhook" | "poller" | custom string
  payload: unknown;     // raw event data — AgentRunner interprets this
  status: JobStatus;
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
  attempts: number;
  lastError?: string;
  result?: unknown;     // AgentRunner writes here on success
}

export interface StateFileV1 {
  version: 1;
  jobs: Record<string, Job>; // job.id -> Job
}

// --- Claude CLI wrapper ---

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  model: string;
  numTurns: number;
  durationMs: number;
}

export interface ClaudeResult {
  text: string;
  usage?: ClaudeUsage;
}

// --- Plugin system ---

export type PluginPhase = "pre" | "post";

export interface PluginContext {
  job: Job;
  config: AppConfig;
  phase: PluginPhase;
  result?: unknown;     // available in post phase
}

export interface PluginResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}
```

**Step 2: Verify it compiles**

```bash
npm run build
```

Expected: `dist/` created, no errors.

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add core TypeScript types"
```

---

### Task 3: Logger

**Files:**
- Create: `src/logger.ts`
- Create: `tests/unit/logger.test.ts`

**Step 1: Write the failing tests**

Create `tests/unit/logger.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRootLogger } from "../../src/logger.js";

describe("Logger", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes info to stdout as JSON", () => {
    const logger = createRootLogger("info");
    logger.info("hello world");
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const line = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(line.level).toBe("info");
    expect(line.msg).toBe("hello world");
    expect(line.ts).toBeDefined();
  });

  it("writes error to stderr as JSON", () => {
    const logger = createRootLogger("info");
    logger.error("something failed");
    expect(stderrSpy).toHaveBeenCalledOnce();
    const line = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(line.level).toBe("error");
    expect(line.msg).toBe("something failed");
  });

  it("merges context into output", () => {
    const logger = createRootLogger("info");
    logger.info("ctx test", { jobId: "abc123" });
    const line = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(line.jobId).toBe("abc123");
  });

  it("child logger inherits and merges base context", () => {
    const logger = createRootLogger("info");
    const child = logger.child({ source: "webhook" });
    child.info("child msg", { extra: "val" });
    const line = JSON.parse(stdoutSpy.mock.calls[0][0] as string);
    expect(line.source).toBe("webhook");
    expect(line.extra).toBe("val");
    expect(line.msg).toBe("child msg");
  });

  it("respects minimum log level — debug suppressed at info level", () => {
    const logger = createRootLogger("info");
    logger.debug("this should not appear");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("allows debug through at debug level", () => {
    const logger = createRootLogger("debug");
    logger.debug("this should appear");
    expect(stdoutSpy).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/logger.test.ts
```

Expected: FAIL — `createRootLogger` not found

**Step 3: Create `src/logger.ts`**

```ts
export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function createLogger(baseCtx: LogContext = {}, minLevel: LogLevel = "info"): Logger {
  const minPriority = LEVEL_PRIORITY[minLevel];

  function emit(level: LogLevel, msg: string, ctx?: LogContext): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;

    const entry: Record<string, unknown> = {
      level,
      ts: new Date().toISOString(),
      msg,
      ...baseCtx,
      ...ctx,
    };

    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) delete entry[key];
    }

    const line = JSON.stringify(entry) + "\n";

    if (level === "error") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  return {
    debug: (msg, ctx) => emit("debug", msg, ctx),
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    child(ctx: LogContext): Logger {
      return createLogger({ ...baseCtx, ...ctx }, minLevel);
    },
  };
}

export function createRootLogger(minLevel?: LogLevel): Logger {
  const level = (minLevel ?? process.env.LOG_LEVEL ?? "info") as LogLevel;
  return createLogger({}, level);
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/unit/logger.test.ts
```

Expected: PASS (6 tests)

**Step 5: Build check**

```bash
npm run build
```

Expected: clean compile

**Step 6: Commit**

```bash
git add src/logger.ts tests/unit/logger.test.ts
git commit -m "feat: add structured JSON logger with child context"
```

---

### Task 4: Config loader

**Files:**
- Create: `src/config.ts`
- Create: `tests/unit/config.test.ts`
- Create: `config.yaml` (example)

**Step 1: Write failing tests**

Create `tests/unit/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, DEFAULTS, validateConfig } from "../../src/config.js";

const TMP = tmpdir();

function writeTmp(name: string, content: string): string {
  const p = join(TMP, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

describe("loadConfig", () => {
  it("returns defaults when no file exists", () => {
    const cfg = loadConfig(join(TMP, "nonexistent-config-xyz.yaml"));
    expect(cfg.mode).toBe("webhook");
    expect(cfg.webhook.port).toBe(3000);
    expect(cfg.agent.maxTurns).toBe(10);
  });

  it("merges YAML file over defaults", () => {
    const p = writeTmp("test-config-1.yaml", "mode: polling\nwebhook:\n  port: 4000\n");
    const cfg = loadConfig(p);
    expect(cfg.mode).toBe("polling");
    expect(cfg.webhook.port).toBe(4000);
    expect(cfg.webhook.path).toBe(DEFAULTS.webhook.path); // default preserved
    unlinkSync(p);
  });

  it("applies env var overrides", () => {
    const p = writeTmp("test-config-2.yaml", "mode: webhook\n");
    process.env.WEBHOOK_PORT = "9999";
    const cfg = loadConfig(p);
    expect(cfg.webhook.port).toBe(9999);
    delete process.env.WEBHOOK_PORT;
    unlinkSync(p);
  });

  it("applies DASHBOARD_TOKEN env var", () => {
    const p = writeTmp("test-config-3.yaml", "mode: webhook\n");
    process.env.DASHBOARD_TOKEN = "supersecret";
    const cfg = loadConfig(p);
    expect(cfg.dashboard.token).toBe("supersecret");
    delete process.env.DASHBOARD_TOKEN;
    unlinkSync(p);
  });
});

describe("validateConfig", () => {
  it("returns no errors for valid defaults", () => {
    const errors = validateConfig(DEFAULTS);
    expect(errors.filter((e) => e.severity === "error")).toHaveLength(0);
  });

  it("returns error when agent.maxTurns < 1", () => {
    const cfg = { ...DEFAULTS, agent: { ...DEFAULTS.agent, maxTurns: 0 } };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.field === "agent.maxTurns" && e.severity === "error")).toBe(true);
  });

  it("returns error when agent.maxConcurrent < 1", () => {
    const cfg = { ...DEFAULTS, agent: { ...DEFAULTS.agent, maxConcurrent: 0 } };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.field === "agent.maxConcurrent" && e.severity === "error")).toBe(true);
  });

  it("returns error for invalid mode", () => {
    const cfg = { ...DEFAULTS, mode: "invalid" as any };
    const errors = validateConfig(cfg);
    expect(errors.some((e) => e.field === "mode" && e.severity === "error")).toBe(true);
  });
});
```

**Step 2: Run to verify failure**

```bash
npm test -- tests/unit/config.test.ts
```

Expected: FAIL — `loadConfig` not found

**Step 3: Create `src/config.ts`**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import type { AppConfig } from "./types.js";

export interface ConfigError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export const DEFAULTS: AppConfig = {
  mode: "webhook",
  webhook: { port: 3000, path: "/webhook", secret: "" },
  polling: { intervalSeconds: 60, targets: [] },
  agent: {
    claudeModel: "",
    maxTurns: 10,
    timeoutMs: 300_000,
    maxConcurrent: 3,
    maxRetries: 3,
    retryBackoffMs: 5_000,
  },
  dashboard: { port: 3001, token: "" },
  state: { filePath: "data/state.json" },
  features: {},
};

/** Dot-paths to config fields that contain secrets — redacted in API responses. */
export const SENSITIVE_FIELDS = ["webhook.secret", "dashboard.token"] as const;

export function validateConfig(config: AppConfig): ConfigError[] {
  const errors: ConfigError[] = [];
  const validModes = ["webhook", "polling", "both"];
  if (!validModes.includes(config.mode)) {
    errors.push({ field: "mode", message: `Must be one of: ${validModes.join(", ")}`, severity: "error" });
  }
  if (config.agent.maxTurns < 1) {
    errors.push({ field: "agent.maxTurns", message: "Must be >= 1", severity: "error" });
  }
  if (config.agent.maxConcurrent < 1) {
    errors.push({ field: "agent.maxConcurrent", message: "Must be >= 1", severity: "error" });
  }
  if (config.agent.maxRetries < 0) {
    errors.push({ field: "agent.maxRetries", message: "Must be >= 0", severity: "error" });
  }
  if (config.agent.timeoutMs < 10_000) {
    errors.push({ field: "agent.timeoutMs", message: "Must be >= 10000 (10s)", severity: "error" });
  }
  if (config.webhook.port < 1 || config.webhook.port > 65535) {
    errors.push({ field: "webhook.port", message: "Must be 1–65535", severity: "error" });
  }
  if (config.dashboard.port < 1 || config.dashboard.port > 65535) {
    errors.push({ field: "dashboard.port", message: "Must be 1–65535", severity: "error" });
  }
  if (config.polling.intervalSeconds < 1) {
    errors.push({ field: "polling.intervalSeconds", message: "Must be >= 1", severity: "error" });
  }
  return errors;
}

/** Get nested value by dot-path. */
export function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((o: any, k) => o?.[k], obj);
}

/** Set nested value by dot-path, creating intermediate objects. */
export function setByPath(obj: any, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => {
    if (o[k] === undefined || o[k] === null) o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}

export function loadConfig(path: string = "config.yaml"): AppConfig {
  let fileConfig: Partial<AppConfig> = {};

  try {
    const raw = readFileSync(path, "utf-8");
    fileConfig = parse(raw) ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // File not found — use defaults
  }

  const fileFeatures = (fileConfig as any).features as Partial<AppConfig> | undefined;

  const config: AppConfig = {
    mode: fileConfig.mode ?? DEFAULTS.mode,
    webhook: { ...DEFAULTS.webhook, ...fileConfig.webhook },
    polling: { ...DEFAULTS.polling, ...fileConfig.polling },
    agent: { ...DEFAULTS.agent, ...fileConfig.agent },
    dashboard: { ...DEFAULTS.dashboard, ...fileConfig.dashboard },
    state: { ...DEFAULTS.state, ...fileConfig.state },
    features: fileConfig.features ?? {},
  };

  // Environment variable overrides
  if (process.env.WEBHOOK_SECRET) config.webhook.secret = process.env.WEBHOOK_SECRET;
  if (process.env.WEBHOOK_PORT) {
    const port = parseInt(process.env.WEBHOOK_PORT, 10);
    if (!Number.isNaN(port)) config.webhook.port = port;
  }
  if (process.env.DASHBOARD_TOKEN) config.dashboard.token = process.env.DASHBOARD_TOKEN;
  if (process.env.DASHBOARD_PORT) {
    const port = parseInt(process.env.DASHBOARD_PORT, 10);
    if (!Number.isNaN(port)) config.dashboard.port = port;
  }
  if (process.env.MODE && ["webhook", "polling", "both"].includes(process.env.MODE)) {
    config.mode = process.env.MODE as AppConfig["mode"];
  }
  if (process.env.CLAUDE_MODEL) config.agent.claudeModel = process.env.CLAUDE_MODEL;

  const fatalErrors = validateConfig(config).filter((e) => e.severity === "error");
  if (fatalErrors.length > 0) {
    const details = fatalErrors.map((e) => `  ${e.field}: ${e.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }

  return config;
}
```

**Step 4: Create example `config.yaml`**

```yaml
# agent-seed configuration
# All fields shown with defaults. Sensitive values can be set via env vars.

mode: webhook  # webhook | polling | both

webhook:
  port: 3000
  path: /webhook
  secret: ""        # env: WEBHOOK_SECRET — HMAC-SHA256 verification

polling:
  intervalSeconds: 60
  targets: []       # List of identifiers/URLs your poller will fetch

agent:
  claudeModel: ""   # Optional model override, e.g. "claude-opus-4-5-20251101"
  maxTurns: 10
  timeoutMs: 300000
  maxConcurrent: 3
  maxRetries: 3
  retryBackoffMs: 5000

dashboard:
  port: 3001
  token: ""         # env: DASHBOARD_TOKEN — Bearer token for /api/* routes

state:
  filePath: data/state.json

features: {}        # Reserved for custom plugins
```

**Step 5: Run tests to verify they pass**

```bash
npm test -- tests/unit/config.test.ts
```

Expected: PASS

**Step 6: Build check**

```bash
npm run build
```

**Step 7: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts config.yaml
git commit -m "feat: add YAML config loader with env overrides and validation"
```

---

### Task 5: Config manager (hot-reload)

**Files:**
- Create: `src/config-manager.ts`

No unit tests — behavior tested via integration. The change callback contract is simple and verified by TypeScript.

**Step 1: Create `src/config-manager.ts`**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import type { AppConfig } from "./types.js";
import type { Logger } from "./logger.js";
import {
  DEFAULTS,
  SENSITIVE_FIELDS,
  validateConfig,
  getByPath,
  setByPath,
  loadConfig,
} from "./config.js";

export const REDACTED_SENTINEL = "$$REDACTED$$";

export type ConfigChangeCallback = (
  newConfig: AppConfig,
  oldConfig: AppConfig,
  changedPaths: string[],
) => void;

export interface ConfigUpdateResult {
  success: boolean;
  errors?: string[];
  warnings?: string[];
  restartRequired?: boolean;
}

/** Fields that require a full restart — they are bound at startup. */
export const RESTART_REQUIRED_FIELDS = [
  "mode",
  "webhook.port",
  "webhook.path",
  "webhook.secret",
] as const;

export class ConfigManager {
  private config: AppConfig;
  private callbacks: ConfigChangeCallback[] = [];
  private static readonly MAX_WRITES_PER_MINUTE = 10;
  private writeCount = 0;
  private writeWindowStart = Date.now();

  constructor(
    private configPath: string,
    private logger: Logger,
  ) {
    this.config = loadConfig(configPath);
  }

  getConfig(): AppConfig {
    return this.config;
  }

  onChange(cb: ConfigChangeCallback): void {
    this.callbacks.push(cb);
  }

  /**
   * Update a single config field by dot-path. Validates, persists, and fires callbacks.
   * Returns errors/warnings so the caller can surface them to the user.
   */
  update(path: string, value: unknown): ConfigUpdateResult {
    // Rate limit writes
    const now = Date.now();
    if (now - this.writeWindowStart > 60_000) {
      this.writeCount = 0;
      this.writeWindowStart = now;
    }
    if (this.writeCount >= ConfigManager.MAX_WRITES_PER_MINUTE) {
      return { success: false, errors: ["Rate limit: too many config updates per minute"] };
    }

    const oldConfig = this.config;
    const draft = JSON.parse(JSON.stringify(oldConfig)) as AppConfig;

    setByPath(draft, path, value);

    const allErrors = validateConfig(draft);
    const errors = allErrors.filter((e) => e.severity === "error").map((e) => `${e.field}: ${e.message}`);
    const warnings = allErrors.filter((e) => e.severity === "warning").map((e) => `${e.field}: ${e.message}`);

    if (errors.length > 0) {
      return { success: false, errors, warnings };
    }

    const restartRequired = (RESTART_REQUIRED_FIELDS as readonly string[]).includes(path);

    this.config = draft;
    this.writeCount++;

    // Persist (don't persist secrets from env-only sources)
    try {
      this.persist();
    } catch (err) {
      this.logger.error("Failed to persist config", { error: String(err) });
    }

    // Fire callbacks
    for (const cb of this.callbacks) {
      try {
        cb(this.config, oldConfig, [path]);
      } catch (err) {
        this.logger.error("Config onChange callback threw", { error: String(err) });
      }
    }

    return { success: true, warnings: warnings.length > 0 ? warnings : undefined, restartRequired };
  }

  /** Returns config with sensitive fields redacted for API responses. */
  getRedacted(): AppConfig {
    const copy = JSON.parse(JSON.stringify(this.config)) as AppConfig;
    for (const field of SENSITIVE_FIELDS) {
      const val = getByPath(copy, field);
      if (val) setByPath(copy, field, REDACTED_SENTINEL);
    }
    return copy;
  }

  private persist(): void {
    const copy = JSON.parse(JSON.stringify(this.config)) as AppConfig;
    // Blank out secrets so they're not written to disk (they came from env)
    for (const field of SENSITIVE_FIELDS) {
      setByPath(copy, field, "");
    }
    const yaml = require("yaml").stringify(copy, { lineWidth: 120 });
    writeFileSync(this.configPath, yaml, "utf-8");
  }
}
```

**Step 2: Build check**

```bash
npm run build
```

**Step 3: Commit**

```bash
git add src/config-manager.ts
git commit -m "feat: add hot-reload config manager with change callbacks"
```

---

### Task 6: State store

**Files:**
- Create: `src/state/store.ts`
- Create: `tests/unit/state-store.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/state-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../../src/state/store.js";
import type { Job } from "../../src/types.js";

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-seed-test-"));
  storePath = join(tmpDir, "state.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("creates a job and retrieves it", () => {
    const store = new StateStore(storePath);
    const job = store.create("webhook", { event: "push" });
    expect(job.id).toBeTruthy();
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(store.get(job.id)).toEqual(job);
  });

  it("updates job status", () => {
    const store = new StateStore(storePath);
    const job = store.create("webhook", { x: 1 });
    const updated = store.setStatus(job.id, "processing");
    expect(updated?.status).toBe("processing");
    expect(store.get(job.id)?.status).toBe("processing");
  });

  it("records error and increments attempts", () => {
    const store = new StateStore(storePath);
    const job = store.create("poller", {});
    store.recordError(job.id, "timeout");
    const updated = store.get(job.id)!;
    expect(updated.status).toBe("error");
    expect(updated.attempts).toBe(1);
    expect(updated.lastError).toBe("timeout");
  });

  it("marks job done with result", () => {
    const store = new StateStore(storePath);
    const job = store.create("webhook", {});
    store.complete(job.id, { verdict: "ok" });
    const updated = store.get(job.id)!;
    expect(updated.status).toBe("done");
    expect(updated.result).toEqual({ verdict: "ok" });
  });

  it("lists all jobs", () => {
    const store = new StateStore(storePath);
    store.create("webhook", { a: 1 });
    store.create("webhook", { b: 2 });
    expect(store.list().length).toBe(2);
  });

  it("lists jobs filtered by status", () => {
    const store = new StateStore(storePath);
    const j1 = store.create("webhook", { a: 1 });
    const j2 = store.create("webhook", { b: 2 });
    store.setStatus(j1.id, "done");
    expect(store.list("done").length).toBe(1);
    expect(store.list("pending").length).toBe(1);
  });

  it("persists state across store instances", () => {
    const store1 = new StateStore(storePath);
    const job = store1.create("webhook", { persistent: true });
    const store2 = new StateStore(storePath);
    expect(store2.get(job.id)?.payload).toEqual({ persistent: true });
  });

  it("marks failed after max retries exceeded", () => {
    const store = new StateStore(storePath);
    const job = store.create("webhook", {});
    store.recordError(job.id, "err1");
    store.recordError(job.id, "err2");
    store.recordError(job.id, "err3");
    store.markFailed(job.id);
    expect(store.get(job.id)?.status).toBe("failed");
  });
});
```

**Step 2: Run to verify failure**

```bash
npm test -- tests/unit/state-store.test.ts
```

Expected: FAIL — `StateStore` not found

**Step 3: Create `src/state/store.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Job, JobStatus, StateFileV1 } from "../types.js";

export class StateStore {
  private state: StateFileV1;

  constructor(private filePath: string) {
    this.state = this.load();
  }

  /** Create a new job and persist immediately. */
  create(source: string, payload: unknown): Job {
    const id = createHash("sha256")
      .update(`${source}:${randomUUID()}`)
      .digest("hex")
      .slice(0, 16);

    const now = new Date().toISOString();
    const job: Job = {
      id,
      source,
      payload,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };

    this.state.jobs[id] = job;
    this.persist();
    return job;
  }

  get(id: string): Job | undefined {
    return this.state.jobs[id];
  }

  list(status?: JobStatus): Job[] {
    const all = Object.values(this.state.jobs);
    return status ? all.filter((j) => j.status === status) : all;
  }

  setStatus(id: string, status: JobStatus): Job | undefined {
    const job = this.state.jobs[id];
    if (!job) return undefined;
    job.status = status;
    job.updatedAt = new Date().toISOString();
    this.persist();
    return job;
  }

  recordError(id: string, message: string): Job | undefined {
    const job = this.state.jobs[id];
    if (!job) return undefined;
    job.status = "error";
    job.lastError = message;
    job.attempts++;
    job.updatedAt = new Date().toISOString();
    this.persist();
    return job;
  }

  complete(id: string, result: unknown): Job | undefined {
    const job = this.state.jobs[id];
    if (!job) return undefined;
    job.status = "done";
    job.result = result;
    job.updatedAt = new Date().toISOString();
    this.persist();
    return job;
  }

  markFailed(id: string): Job | undefined {
    const job = this.state.jobs[id];
    if (!job) return undefined;
    job.status = "failed";
    job.updatedAt = new Date().toISOString();
    this.persist();
    return job;
  }

  getStatusCounts(): Partial<Record<JobStatus, number>> {
    const counts: Partial<Record<JobStatus, number>> = {};
    for (const job of Object.values(this.state.jobs)) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
    }
    return counts;
  }

  private load(): StateFileV1 {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      // V1 format check
      if (parsed.version === 1 && parsed.jobs) return parsed as StateFileV1;
      // Unknown format — start fresh
      return { version: 1, jobs: {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, jobs: {} };
      }
      throw err;
    }
  }

  /** Atomic write: write to temp file then rename (crash-safe). */
  private persist(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    renameSync(tmp, this.filePath);
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/unit/state-store.test.ts
```

Expected: PASS (8 tests)

**Step 5: Build check**

```bash
npm run build
```

**Step 6: Commit**

```bash
git add src/state/store.ts tests/unit/state-store.test.ts
git commit -m "feat: add atomic JSON state store with job lifecycle"
```

---

### Task 7: EventSource interface + Webhook server

**Files:**
- Create: `src/events/source.ts`
- Create: `src/events/webhook.ts`
- Create: `tests/integration/webhook.test.ts`

**Step 1: Create `src/events/source.ts`**

```ts
import type { AppConfig } from "../types.js";

export interface EventSource {
  start(): void;
  stop(): Promise<void>;
  updateConfig(config: AppConfig): void;
}
```

**Step 2: Write failing integration test**

Create `tests/integration/webhook.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { WebhookServer } from "../../src/events/webhook.js";
import { StateStore } from "../../src/state/store.js";
import { createRootLogger } from "../../src/logger.js";
import { DEFAULTS } from "../../src/config.js";

const PORT = 13100 + Math.floor(Math.random() * 100);
let tmpDir: string;
let server: WebhookServer;
let store: StateStore;

function makeConfig(secret: string) {
  return {
    ...DEFAULTS,
    webhook: { port: PORT, path: "/webhook", secret },
  };
}

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

async function post(body: string, sig?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sig) headers["x-hub-signature-256"] = sig;
  return fetch(`http://localhost:${PORT}/webhook`, {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-seed-webhook-"));
  store = new StateStore(join(tmpDir, "state.json"));
  const logger = createRootLogger("error");
  server = new WebhookServer(makeConfig("testsecret"), store, logger, async (_job) => {});
  await new Promise<void>((res) => { server.start(); setTimeout(res, 50); });
});

afterEach(async () => {
  await server.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("WebhookServer", () => {
  it("returns 202 and creates a job for a valid signed request", async () => {
    const body = JSON.stringify({ event: "push" });
    const res = await post(body, sign(body, "testsecret"));
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.list().length).toBe(1);
    expect(store.list()[0].source).toBe("webhook");
  });

  it("returns 401 for a bad signature", async () => {
    const body = JSON.stringify({ event: "push" });
    const res = await post(body, "sha256=badsig");
    expect(res.status).toBe(401);
    expect(store.list().length).toBe(0);
  });

  it("returns 401 when signature header is missing and secret is set", async () => {
    const body = JSON.stringify({ event: "push" });
    const res = await post(body);
    expect(res.status).toBe(401);
  });

  it("accepts requests without signature when secret is empty", async () => {
    await server.stop();
    const logger = createRootLogger("error");
    server = new WebhookServer(makeConfig(""), store, logger, async (_job) => {});
    await new Promise<void>((res) => { server.start(); setTimeout(res, 50); });
    const body = JSON.stringify({ event: "push" });
    const res = await post(body);
    expect(res.status).toBe(202);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://localhost:${PORT}/unknown`);
    expect(res.status).toBe(404);
  });
});
```

**Step 3: Run to verify failure**

```bash
npm test -- tests/integration/webhook.test.ts
```

Expected: FAIL — `WebhookServer` not found

**Step 4: Create `src/events/webhook.ts`**

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig, Job } from "../types.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import type { EventSource } from "./source.js";

export type JobDispatcher = (job: Job) => Promise<void>;

export class WebhookServer implements EventSource {
  private server: Server | null = null;

  constructor(
    private config: AppConfig,
    private store: StateStore,
    private logger: Logger,
    private dispatch: JobDispatcher,
  ) {}

  start(): void {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error("Webhook request error", { error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
    });
    this.server.listen(this.config.webhook.port, () => {
      this.logger.info("Webhook server listening", { port: this.config.webhook.port, path: this.config.webhook.path });
      if (!this.config.webhook.secret) {
        this.logger.warn("No webhook secret configured — accepting all requests (dev mode)");
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server.closeAllConnections();
      } else {
        resolve();
      }
    });
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "POST" && url.pathname === this.config.webhook.path) {
      const body = await readBody(req);

      if (this.config.webhook.secret) {
        const sig = req.headers["x-hub-signature-256"] as string | undefined;
        if (!sig || !this.verifySignature(body, sig)) {
          res.writeHead(401);
          res.end();
          return;
        }
      }

      // Respond immediately before processing
      res.writeHead(202);
      res.end();

      let payload: unknown = body;
      try { payload = JSON.parse(body); } catch {}

      const job = this.store.create("webhook", payload);
      this.logger.info("Webhook job created", { jobId: job.id });

      this.dispatch(job).catch((err) => {
        this.logger.error("Webhook dispatch error", { jobId: job.id, error: String(err) });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private verifySignature(body: string, signature: string): boolean {
    try {
      const expected = "sha256=" + createHmac("sha256", this.config.webhook.secret).update(body).digest("hex");
      const a = Buffer.from(signature.padEnd(71));
      const b = Buffer.from(expected.padEnd(71));
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
```

**Step 5: Run tests to verify they pass**

```bash
npm test -- tests/integration/webhook.test.ts
```

Expected: PASS (5 tests)

**Step 6: Build check**

```bash
npm run build
```

**Step 7: Commit**

```bash
git add src/events/source.ts src/events/webhook.ts tests/integration/webhook.test.ts
git commit -m "feat: add webhook server with HMAC-SHA256 signature verification"
```

---

### Task 8: Poller

**Files:**
- Create: `src/events/poller.ts`

No dedicated test — poller is abstract; concrete implementations are tested by extending.

**Step 1: Create `src/events/poller.ts`**

```ts
import type { AppConfig, Job } from "../types.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import type { EventSource } from "./source.js";
import type { JobDispatcher } from "./webhook.js";

export abstract class Poller implements EventSource {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    protected config: AppConfig,
    protected store: StateStore,
    protected logger: Logger,
    protected dispatch: JobDispatcher,
  ) {}

  /** Override this to return new jobs to process. Deduplicate by job ID if needed. */
  abstract poll(): Promise<Job[]>;

  start(): void {
    this.logger.info("Poller starting", { intervalSeconds: this.config.polling.intervalSeconds });
    this.scheduleNext();
  }

  stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return Promise.resolve();
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => this.tick(), this.config.polling.intervalSeconds * 1000);
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn("Poll tick skipped — previous run still in progress");
      this.scheduleNext();
      return;
    }

    this.running = true;
    try {
      const jobs = await this.poll();
      for (const job of jobs) {
        const existing = this.store.get(job.id);
        if (existing && existing.status !== "error") continue; // deduplicate
        this.dispatch(job).catch((err) => {
          this.logger.error("Poller dispatch error", { jobId: job.id, error: String(err) });
        });
      }
    } catch (err) {
      this.logger.error("Poll error", { error: String(err) });
    } finally {
      this.running = false;
    }

    this.scheduleNext();
  }
}
```

**Step 2: Build check**

```bash
npm run build
```

**Step 3: Commit**

```bash
git add src/events/poller.ts
git commit -m "feat: add abstract non-overlapping Poller with deduplication"
```

---

### Task 9: Plugin system

**Files:**
- Create: `src/agent/plugin.ts`
- Create: `tests/unit/plugin-runner.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/plugin-runner.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runPlugins } from "../../src/agent/plugin.js";
import type { Plugin, PluginContext } from "../../src/types.js";
import { DEFAULTS } from "../../src/config.js";

function makeCtx(phase: "pre" | "post"): PluginContext {
  return {
    phase,
    config: DEFAULTS,
    job: {
      id: "test-job",
      source: "webhook",
      payload: {},
      status: "processing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 0,
    },
  };
}

describe("runPlugins", () => {
  it("runs pre-phase plugins", async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const plugin: Plugin = {
      name: "test-plugin",
      phase: "pre",
      shouldRun: () => true,
      execute,
    };
    await runPlugins([plugin], "pre", makeCtx("pre"));
    expect(execute).toHaveBeenCalledOnce();
  });

  it("skips post-phase plugins during pre phase", async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const plugin: Plugin = {
      name: "post-plugin",
      phase: "post",
      shouldRun: () => true,
      execute,
    };
    await runPlugins([plugin], "pre", makeCtx("pre"));
    expect(execute).not.toHaveBeenCalled();
  });

  it("skips plugin when shouldRun returns false", async () => {
    const execute = vi.fn().mockResolvedValue({ success: true });
    const plugin: Plugin = {
      name: "skip-plugin",
      phase: "pre",
      shouldRun: () => false,
      execute,
    };
    await runPlugins([plugin], "pre", makeCtx("pre"));
    expect(execute).not.toHaveBeenCalled();
  });

  it("isolates plugin errors — other plugins still run", async () => {
    const failPlugin: Plugin = {
      name: "fail-plugin",
      phase: "pre",
      shouldRun: () => true,
      execute: async () => { throw new Error("plugin exploded"); },
    };
    const okExecute = vi.fn().mockResolvedValue({ success: true });
    const okPlugin: Plugin = {
      name: "ok-plugin",
      phase: "pre",
      shouldRun: () => true,
      execute: okExecute,
    };
    // Should not throw even though failPlugin throws
    await expect(runPlugins([failPlugin, okPlugin], "pre", makeCtx("pre"))).resolves.not.toThrow();
    expect(okExecute).toHaveBeenCalledOnce();
  });

  it("returns results map keyed by plugin name", async () => {
    const plugin: Plugin = {
      name: "my-plugin",
      phase: "post",
      shouldRun: () => true,
      execute: async () => ({ success: true, data: { foo: "bar" } }),
    };
    const results = await runPlugins([plugin], "post", makeCtx("post"));
    expect(results.get("my-plugin")?.data?.foo).toBe("bar");
  });
});
```

**Step 2: Run to verify failure**

```bash
npm test -- tests/unit/plugin-runner.test.ts
```

Expected: FAIL

**Step 3: Create `src/agent/plugin.ts`**

```ts
import type { Plugin, PluginContext, PluginPhase, PluginResult } from "../types.js";

/**
 * Run all plugins for a given phase in order.
 * Errors are caught and recorded — a failing plugin never stops the pipeline.
 */
export async function runPlugins(
  plugins: Plugin[],
  phase: PluginPhase,
  ctx: PluginContext,
): Promise<Map<string, PluginResult>> {
  const results = new Map<string, PluginResult>();
  const phasePlugins = plugins.filter((p) => p.phase === phase);

  for (const plugin of phasePlugins) {
    if (!plugin.shouldRun(ctx)) {
      results.set(plugin.name, { success: true });
      continue;
    }

    try {
      const result = await plugin.execute(ctx);
      results.set(plugin.name, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.set(plugin.name, { success: false, error: message });
    }
  }

  return results;
}

export type { Plugin, PluginContext, PluginResult, PluginPhase };
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/unit/plugin-runner.test.ts
```

Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/agent/plugin.ts tests/unit/plugin-runner.test.ts
git commit -m "feat: add plugin runner with phase dispatch and error isolation"
```

---

### Task 10: Claude CLI wrapper

**Files:**
- Create: `src/agent/claude.ts`
- Create: `tests/unit/claude.test.ts`

**Step 1: Write failing tests**

Create `tests/unit/claude.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseClaudeOutput, extractUsage } from "../../src/agent/claude.js";

describe("parseClaudeOutput", () => {
  it("parses direct JSON output", () => {
    const output = JSON.stringify({ result: "done", verdict: "ok" });
    expect(parseClaudeOutput(output)).toEqual({ result: "done", verdict: "ok" });
  });

  it("extracts JSON from markdown fence", () => {
    const output = "Here is the result:\n```json\n{\"verdict\": \"ok\"}\n```\nDone.";
    expect(parseClaudeOutput(output)).toEqual({ verdict: "ok" });
  });

  it("extracts trailing JSON from prose", () => {
    const output = "Some explanation here.\n{\"verdict\": \"ok\"}";
    expect(parseClaudeOutput(output)).toEqual({ verdict: "ok" });
  });

  it("returns null for plain text with no JSON", () => {
    expect(parseClaudeOutput("This is just plain text.")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseClaudeOutput("")).toBeNull();
  });
});

describe("extractUsage", () => {
  it("extracts usage from Claude CLI envelope format", () => {
    const envelope = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      },
      cost_usd: 0.001,
      model: "claude-opus-4-6",
      num_turns: 3,
      duration_ms: 5000,
      duration_api_ms: 4000,
    };
    const usage = extractUsage(envelope);
    expect(usage?.inputTokens).toBe(100);
    expect(usage?.outputTokens).toBe(50);
    expect(usage?.totalCostUsd).toBe(0.001);
    expect(usage?.model).toBe("claude-opus-4-6");
    expect(usage?.numTurns).toBe(3);
  });

  it("returns undefined for missing envelope", () => {
    expect(extractUsage(undefined)).toBeUndefined();
    expect(extractUsage(null)).toBeUndefined();
    expect(extractUsage({})).toBeUndefined();
  });
});
```

**Step 2: Run to verify failure**

```bash
npm test -- tests/unit/claude.test.ts
```

Expected: FAIL

**Step 3: Create `src/agent/claude.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClaudeResult, ClaudeUsage } from "../types.js";

const execFileAsync = promisify(execFile);

export interface ClaudeRunOptions {
  prompt: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  systemPrompt?: string;
  allowedTools?: string[];
  workdir?: string;
}

/**
 * Invoke Claude CLI and return the result.
 * Uses `--output-format json` to get structured output with usage stats.
 */
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeResult> {
  const args: string[] = [
    "--print",
    "--output-format", "json",
    "--max-turns", String(opts.maxTurns ?? 10),
  ];

  if (opts.model) args.push("--model", opts.model);
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));

  args.push(opts.prompt);

  const { stdout } = await execFileAsync("claude", args, {
    timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    cwd: opts.workdir,
    env: process.env,
  });

  // Claude CLI JSON output envelope
  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    // Fallback: treat raw stdout as text
    return { text: stdout };
  }

  const text = envelope?.result ?? envelope?.content ?? stdout;
  const usage = extractUsage(envelope);

  return { text: typeof text === "string" ? text : JSON.stringify(text), usage };
}

/** Parse JSON from Claude's text output — tries multiple extraction strategies. */
export function parseClaudeOutput(text: string): unknown | null {
  if (!text?.trim()) return null;

  // Strategy 1: direct JSON
  try {
    return JSON.parse(text.trim());
  } catch {}

  // Strategy 2: JSON inside markdown fence
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // Strategy 3: trailing JSON blob
  const trailingMatch = text.match(/(\{[\s\S]*\})\s*$/);
  if (trailingMatch) {
    try { return JSON.parse(trailingMatch[1]); } catch {}
  }

  return null;
}

/** Extract usage stats from Claude CLI JSON envelope. */
export function extractUsage(envelope: any): ClaudeUsage | undefined {
  if (!envelope?.usage || !envelope?.model) return undefined;

  return {
    inputTokens: envelope.usage.input_tokens ?? 0,
    outputTokens: envelope.usage.output_tokens ?? 0,
    cacheCreationInputTokens: envelope.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: envelope.usage.cache_read_input_tokens ?? 0,
    totalCostUsd: envelope.cost_usd ?? 0,
    model: envelope.model ?? "",
    numTurns: envelope.num_turns ?? 0,
    durationMs: envelope.duration_ms ?? 0,
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/unit/claude.test.ts
```

Expected: PASS (8 tests)

**Step 5: Commit**

```bash
git add src/agent/claude.ts tests/unit/claude.test.ts
git commit -m "feat: add Claude CLI wrapper with multi-strategy JSON parsing"
```

---

### Task 11: AgentRunner + integration test

**Files:**
- Create: `src/agent/runner.ts`
- Create: `tests/integration/agent-runner.test.ts`

**Step 1: Write failing integration test**

Create `tests/integration/agent-runner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRunner } from "../../src/agent/runner.js";
import { StateStore } from "../../src/state/store.js";
import { createRootLogger } from "../../src/logger.js";
import { DEFAULTS } from "../../src/config.js";
import type { Job, ClaudeResult } from "../../src/types.js";

// Concrete test runner
class EchoRunner extends AgentRunner {
  async run(job: Job): Promise<unknown> {
    return { echoed: job.payload };
  }
}

// Runner that always throws
class FailRunner extends AgentRunner {
  async run(_job: Job): Promise<unknown> {
    throw new Error("agent failed");
  }
}

let tmpDir: string;
let store: StateStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-seed-runner-"));
  store = new StateStore(join(tmpDir, "state.json"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("AgentRunner", () => {
  it("processes a job and marks it done", async () => {
    const runner = new EchoRunner(DEFAULTS, store, createRootLogger("error"), []);
    const job = store.create("test", { hello: "world" });
    await runner.process(job);
    const updated = store.get(job.id)!;
    expect(updated.status).toBe("done");
    expect((updated.result as any).echoed).toEqual({ hello: "world" });
  });

  it("records error on agent failure", async () => {
    const runner = new FailRunner(DEFAULTS, store, createRootLogger("error"), []);
    const job = store.create("test", {});
    await runner.process(job);
    const updated = store.get(job.id)!;
    expect(updated.status).toBe("error");
    expect(updated.lastError).toContain("agent failed");
    expect(updated.attempts).toBe(1);
  });

  it("marks job failed after maxRetries exceeded", async () => {
    const config = { ...DEFAULTS, agent: { ...DEFAULTS.agent, maxRetries: 2 } };
    const runner = new FailRunner(config, store, createRootLogger("error"), []);
    const job = store.create("test", {});

    // Exhaust retries
    for (let i = 0; i <= config.agent.maxRetries; i++) {
      await runner.process(store.get(job.id)!);
    }

    expect(store.get(job.id)?.status).toBe("failed");
  });

  it("sets status to processing at start", async () => {
    const statuses: string[] = [];
    class ObserverRunner extends AgentRunner {
      async run(job: Job): Promise<unknown> {
        statuses.push(store.get(job.id)!.status);
        return {};
      }
    }
    const runner = new ObserverRunner(DEFAULTS, store, createRootLogger("error"), []);
    const job = store.create("test", {});
    await runner.process(job);
    expect(statuses[0]).toBe("processing");
  });
});
```

**Step 2: Run to verify failure**

```bash
npm test -- tests/integration/agent-runner.test.ts
```

Expected: FAIL

**Step 3: Create `src/agent/runner.ts`**

```ts
import type { AppConfig, Job, Plugin, PluginContext } from "../types.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import { runPlugins } from "./plugin.js";

export abstract class AgentRunner {
  constructor(
    protected config: AppConfig,
    protected store: StateStore,
    protected logger: Logger,
    protected plugins: Plugin[] = [],
  ) {}

  /** Override this to implement your agent logic. Return the result to store. */
  abstract run(job: Job): Promise<unknown>;

  /** Called by webhook/poller dispatch. Handles state transitions, retries, plugins. */
  async process(job: Job): Promise<void> {
    const jobLog = this.logger.child({ jobId: job.id, source: job.source });

    this.store.setStatus(job.id, "processing");

    const ctx: PluginContext = {
      job,
      config: this.config,
      phase: "pre",
    };

    // Pre-hooks
    await runPlugins(this.plugins, "pre", ctx);

    try {
      jobLog.info("Agent running");
      const result = await this.run(job);

      this.store.complete(job.id, result);
      jobLog.info("Job completed", { status: "done" });

      // Post-hooks
      const postCtx: PluginContext = { ...ctx, phase: "post", result };
      await runPlugins(this.plugins, "post", postCtx);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jobLog.error("Job failed", { error: message });

      const updated = this.store.recordError(job.id, message);

      if (updated && updated.attempts > this.config.agent.maxRetries) {
        this.store.markFailed(job.id);
        jobLog.warn("Job marked as permanently failed", { attempts: updated.attempts });
      }
    }
  }

  updateConfig(config: AppConfig): void {
    this.config = config;
  }
}
```

**Step 4: Run tests**

```bash
npm test -- tests/integration/agent-runner.test.ts
```

Expected: PASS (4 tests)

**Step 5: Build check**

```bash
npm run build
```

**Step 6: Commit**

```bash
git add src/agent/runner.ts tests/integration/agent-runner.test.ts
git commit -m "feat: add abstract AgentRunner with retry logic and plugin hooks"
```

---

### Task 12: Dashboard

**Files:**
- Create: `src/dashboard/html.ts`
- Create: `src/dashboard/server.ts`

No unit tests — dashboard is a thin HTTP layer over ConfigManager and StateStore, both already tested.

**Step 1: Create `src/dashboard/html.ts`**

```ts
/** Returns the embedded single-page admin dashboard HTML. */
export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Seed Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .header { background: #1e293b; border-bottom: 1px solid #334155; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 18px; font-weight: 600; color: #f8fafc; }
    .badge { background: #7c3aed; color: white; font-size: 11px; padding: 2px 8px; border-radius: 9999px; }
    .main { padding: 24px; max-width: 1200px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
    .card .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .card .value { font-size: 28px; font-weight: 700; color: #f8fafc; }
    .section { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    .section h2 { font-size: 14px; font-weight: 600; color: #94a3b8; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.05em; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 12px; color: #64748b; font-weight: 500; border-bottom: 1px solid #334155; }
    td { padding: 8px 12px; border-bottom: 1px solid #1e293b; }
    .status { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .status-pending { background: #1e3a5f; color: #60a5fa; }
    .status-processing { background: #3b1f6b; color: #a78bfa; }
    .status-done { background: #14532d; color: #4ade80; }
    .status-error { background: #450a0a; color: #f87171; }
    .status-failed { background: #292524; color: #a8a29e; }
    .login { max-width: 360px; margin: 100px auto; background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 32px; }
    .login h2 { margin-bottom: 20px; color: #f8fafc; }
    input { width: 100%; padding: 10px 14px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 14px; margin-bottom: 12px; }
    button { width: 100%; padding: 10px; background: #7c3aed; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #6d28d9; }
    #error { color: #f87171; font-size: 13px; margin-top: 8px; }
    #app { display: none; }
    .retry-btn { padding: 4px 10px; background: #1d4ed8; color: white; border: none; border-radius: 4px; font-size: 12px; cursor: pointer; }
  </style>
</head>
<body>
  <div id="login-page">
    <div class="login">
      <h2>Agent Dashboard</h2>
      <input type="password" id="token-input" placeholder="Dashboard token" />
      <button onclick="login()">Sign in</button>
      <div id="error"></div>
    </div>
  </div>

  <div id="app">
    <div class="header">
      <h1>Agent Seed Dashboard</h1>
      <span class="badge" id="version-badge">v0.1.0</span>
    </div>
    <div class="main">
      <div class="grid">
        <div class="card"><div class="label">Uptime</div><div class="value" id="uptime">—</div></div>
        <div class="card"><div class="label">Total Jobs</div><div class="value" id="total-jobs">—</div></div>
        <div class="card"><div class="label">Active</div><div class="value" id="active-jobs">—</div></div>
        <div class="card"><div class="label">Failed</div><div class="value" id="failed-jobs">—</div></div>
      </div>
      <div class="section">
        <h2>Recent Jobs</h2>
        <table>
          <thead><tr><th>ID</th><th>Source</th><th>Status</th><th>Attempts</th><th>Updated</th><th></th></tr></thead>
          <tbody id="jobs-table"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let token = '';

    async function login() {
      token = document.getElementById('token-input').value;
      const res = await fetch('/api/status', { headers: { Authorization: 'Bearer ' + token } });
      if (res.ok) {
        document.getElementById('login-page').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        loadData();
        setInterval(loadData, 5000);
      } else {
        document.getElementById('error').textContent = 'Invalid token';
      }
    }

    async function loadData() {
      try {
        const [statusRes, jobsRes] = await Promise.all([
          fetch('/api/status', { headers: { Authorization: 'Bearer ' + token } }),
          fetch('/api/jobs', { headers: { Authorization: 'Bearer ' + token } }),
        ]);
        const status = await statusRes.json();
        const jobs = await jobsRes.json();

        document.getElementById('version-badge').textContent = 'v' + (status.version || '?');
        document.getElementById('uptime').textContent = formatUptime(status.uptime || 0);
        document.getElementById('total-jobs').textContent = jobs.length;
        document.getElementById('active-jobs').textContent = jobs.filter(j => j.status === 'processing').length;
        document.getElementById('failed-jobs').textContent = jobs.filter(j => j.status === 'failed').length;

        const tbody = document.getElementById('jobs-table');
        tbody.innerHTML = jobs.slice(-50).reverse().map(j => \`
          <tr>
            <td><code>\${j.id}</code></td>
            <td>\${j.source}</td>
            <td><span class="status status-\${j.status}">\${j.status}</span></td>
            <td>\${j.attempts}</td>
            <td>\${new Date(j.updatedAt).toLocaleString()}</td>
            <td>\${j.status === 'failed' || j.status === 'error' ? '<button class="retry-btn" onclick="retry(\\'' + j.id + '\\')">Retry</button>' : ''}</td>
          </tr>
        \`).join('');
      } catch(e) { console.error(e); }
    }

    async function retry(id) {
      await fetch('/api/jobs/' + id + '/retry', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
      loadData();
    }

    function formatUptime(s) {
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s/60) + 'm';
      return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
    }
  </script>
</body>
</html>`;
}
```

**Step 2: Create `src/dashboard/server.ts`**

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ConfigManager } from "../config-manager.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import type { AgentRunner } from "../agent/runner.js";
import { getDashboardHtml } from "./html.js";

const VERSION_START = Date.now();

export class DashboardServer {
  private server: Server | null = null;

  constructor(
    private configManager: ConfigManager,
    private store: StateStore,
    private logger: Logger,
    private runner: AgentRunner,
    private version: string = "0.1.0",
  ) {}

  start(port: number): void {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error("Dashboard error", { error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });
    this.server.listen(port, () => {
      this.logger.info("Dashboard listening", { port });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server.closeAllConnections();
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml());
      return;
    }

    if (req.method === "GET" && path === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    // All /api/* routes require auth
    if (!this.isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (req.method === "GET" && path === "/api/status") {
      const uptime = Math.floor((Date.now() - VERSION_START) / 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: this.version, uptime }));
      return;
    }

    if (req.method === "GET" && path === "/api/jobs") {
      const status = url.searchParams.get("status") ?? undefined;
      const jobs = this.store.list(status as any);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jobs));
      return;
    }

    if (req.method === "GET" && path === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.configManager.getRedacted()));
      return;
    }

    if (req.method === "PATCH" && path === "/api/config") {
      const body = await readBody(req);
      let updates: Record<string, unknown>;
      try {
        updates = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const results: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(updates)) {
        results[field] = this.configManager.update(field, value);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
      return;
    }

    const retryMatch = path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
    if (req.method === "POST" && retryMatch) {
      const id = retryMatch[1];
      const job = this.store.get(id);
      if (!job) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Job not found" }));
        return;
      }
      this.store.setStatus(id, "pending");
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ queued: true }));
      // Re-dispatch
      const refreshed = this.store.get(id)!;
      this.runner.process(refreshed).catch((err) => {
        this.logger.error("Retry dispatch error", { jobId: id, error: String(err) });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const token = this.configManager.getConfig().dashboard.token;
    if (!token) return true; // No token configured — open (dev mode)

    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return false;

    const provided = auth.slice(7);
    try {
      const a = Buffer.from(provided.padEnd(64));
      const b = Buffer.from(token.padEnd(64));
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
```

**Step 3: Build check**

```bash
npm run build
```

**Step 4: Commit**

```bash
git add src/dashboard/html.ts src/dashboard/server.ts
git commit -m "feat: add admin dashboard with Bearer token auth and job management"
```

---

### Task 13: Entry point (index.ts)

**Files:**
- Create: `src/index.ts`

**Step 1: Create `src/index.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRootLogger } from "./logger.js";
import { ConfigManager } from "./config-manager.js";
import { StateStore } from "./state/store.js";
import { WebhookServer } from "./events/webhook.js";
import { DashboardServer } from "./dashboard/server.js";
import { AgentRunner } from "./agent/runner.js";

// Read version from package.json
let VERSION = "unknown";
try {
  VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;
} catch {}

/**
 * Entry point.
 *
 * To use this scaffold:
 * 1. Extend AgentRunner and implement run(job): place your logic there
 * 2. Optionally add Plugins for pre/post hooks
 * 3. Wire your runner below where indicated
 */
function main(): void {
  const logger = createRootLogger();
  const configManager = new ConfigManager("config.yaml", logger);
  const config = configManager.getConfig();
  const store = new StateStore(config.state.filePath);

  logger.info(`Agent Seed v${VERSION} starting`, {
    mode: config.mode,
    webhookPort: config.webhook.port,
    dashboardPort: config.dashboard.port,
  });

  // ----------------------------------------------------------------
  // TODO: Replace this stub with your concrete AgentRunner subclass
  // ----------------------------------------------------------------
  // Example:
  //   import { MyAgent } from "./agent/my-agent.js";
  //   const runner = new MyAgent(config, store, logger, plugins);
  // ----------------------------------------------------------------
  class StubRunner extends AgentRunner {
    async run(job: import("./types.js").Job): Promise<unknown> {
      this.logger.info("Stub agent received job — override run() to implement your logic", {
        jobId: job.id,
        source: job.source,
      });
      return { handled: false, note: "Replace StubRunner with your implementation" };
    }
  }
  const runner = new StubRunner(config, store, logger, []);

  // Register hot-reload
  configManager.onChange((newConfig) => {
    runner.updateConfig(newConfig);
    logger.info("Config hot-reloaded");
  });

  let webhook: WebhookServer | null = null;
  let dashboard: DashboardServer | null = null;

  if (config.mode === "webhook" || config.mode === "both") {
    webhook = new WebhookServer(config, store, logger, (job) => runner.process(job));
    webhook.start();
  }

  // Dashboard always starts
  dashboard = new DashboardServer(configManager, store, logger, runner, VERSION);
  dashboard.start(config.dashboard.port);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    await webhook?.stop();
    await dashboard?.stop();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
```

**Step 2: Build check**

```bash
npm run build
```

Expected: clean compile

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entry point with stub runner and graceful shutdown"
```

---

### Task 14: Vitest config and coverage enforcement

**Files:**
- Create: `vitest.config.ts`

**Step 1: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/dashboard/html.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
});
```

**Step 2: Run full test suite with coverage**

```bash
npm run test:coverage
```

Expected: all tests pass, coverage report printed, thresholds met

**Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "test: add vitest config with 80% coverage enforcement"
```

---

### Task 15: Docker and docker-compose

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

**Step 1: Create `Dockerfile`**

```dockerfile
# Build stage
FROM dhi.io/node:20-alpine3.22-dev AS build
WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
RUN apk add --no-cache python3 make g++ && npm ci
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM dhi.io/node:20-alpine3.22-dev

LABEL org.opencontainers.image.source="https://github.com/papayapos/agent-seed"
LABEL org.opencontainers.image.description="General-purpose scaffold for Claude-powered agents"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.title="Agent Seed"
LABEL org.opencontainers.image.vendor="PapayaPOS"

USER root
RUN apk add --no-cache github-cli git su-exec

# Install Claude CLI globally under node user
ENV NPM_CONFIG_PREFIX=/home/node/.local
ARG CLAUDE_CLI_VERSION=latest
RUN mkdir -p /home/node/.local && chown node:node /home/node/.local \
    && su-exec node npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
    && su-exec node npm cache clean --force

WORKDIR /app
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=build /build/dist ./dist/
COPY --from=build /build/node_modules ./node_modules/
COPY --from=build /build/package.json ./

EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q --spider http://localhost:3000/health || exit 1

USER node
CMD ["node", "dist/index.js"]
```

**Step 2: Create `docker-compose.yml`**

```yaml
services:
  agent:
    build: .
    ports:
      - "3000:3000"
      - "3001:3001"
    volumes:
      - ./config.yaml:/app/config.yaml:ro
      - ./data:/app/data
      - claude-auth:/home/node/.claude
    environment:
      - LOG_LEVEL=info
      # Uncomment and set these, or use config.yaml:
      # - WEBHOOK_SECRET=your-secret
      # - DASHBOARD_TOKEN=your-token
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  claude-auth:
    # Mount Claude credentials here:
    # docker run --rm -v agent-seed_claude-auth:/home/node/.claude \
    #   -it ghcr.io/papayapos/agent-seed claude auth login
```

**Step 3: Create `.dockerignore`**

```
node_modules/
dist/
data/
.git/
tests/
*.md
.env*
```

**Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "chore: add Docker multi-stage build and docker-compose"
```

---

### Task 16: README

**Files:**
- Create: `README.md`

**Step 1: Create `README.md`**

Write a README covering:
1. What it is (1 paragraph)
2. Quick start (`npm install`, `npm run dev`)
3. How to implement an agent (extend `AgentRunner`, override `run()`)
4. How to add a plugin (implement `Plugin` interface)
5. Config reference (link to `config.yaml`)
6. Docker usage
7. Environment variables table

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with quick start and extension guide"
```

---

### Task 17: Final verification

**Step 1: Clean build**

```bash
rm -rf dist/ && npm run build
```

Expected: clean compile, no errors

**Step 2: Full test suite with coverage**

```bash
npm run test:coverage
```

Expected: all tests pass, coverage ≥ 80%

**Step 3: Verify entry point starts**

```bash
# Start with no config file — should use defaults and start webhook + dashboard
timeout 3 npm run dev || true
```

Expected: sees "Agent Seed v... starting" log before exit

**Step 4: Push to GitHub**

```bash
git push -u origin main
```

Expected: all commits pushed to `papayapos/agent-seed`

---

## Implementation Notes

- **`moduleResolution: node`** in tsconfig means imports use `.js` extension (CommonJS interop with TypeScript). If you see "Cannot find module" errors, check import paths end in `.js`.
- **Plugin errors** must never propagate — the `runPlugins` function swallows all exceptions. Verify this in `plugin-runner.test.ts`.
- **State file** is versioned V1 from day one. If you add fields to `Job`, add them as optional (`?`) and handle missing values in `StateStore.load()`.
- **Dashboard auth** — if `dashboard.token` is empty, all API routes are open. This is intentional for local dev. Always set a token in production.
- **Claude CLI** is not invoked in tests — mock it at the process level using Vitest's `vi.mock` or by injecting a mock `runClaude` function. Never call real `claude` in CI.
- **Poller** is abstract — to use it, extend it and implement `poll()`. The poller handles scheduling, deduplication, and error recovery. You only provide the data-fetching logic.
