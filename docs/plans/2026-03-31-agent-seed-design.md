# agent-seed Design

**Date:** 2026-03-31
**Status:** Approved
**Target repo:** papayapos/agent-seed (new)

## Overview

A general-purpose TypeScript/Node.js scaffold for building Claude-powered automation agents. Extracted from the battle-tested `claude-code-reviewer` project, stripped to the essential bones. Provides webhook ingestion, polling, dashboard, hot-reload config, structured logging, job state tracking, and a plugin system — so each new agent only needs to implement business logic.

## Approach

Layered scaffold (Approach C): three clean layers of infrastructure → event pipeline → agent. Opinionated enough to be productive, lean enough to understand in an hour. Vitest for tests with 80% coverage enforcement.

---

## Section 1 — Structure

```
src/
├── index.ts                  # Entry point, wiring, graceful shutdown
├── types.ts                  # All TypeScript interfaces
├── config.ts                 # YAML loading, env overrides, validation, defaults
├── config-manager.ts         # Hot-reload lifecycle, onChange callbacks
├── logger.ts                 # Structured JSON logger, child loggers
│
├── events/
│   ├── source.ts             # EventSource interface (webhook | poller)
│   ├── webhook.ts            # HTTP server, HMAC-SHA256 signature verify
│   └── poller.ts             # Interval loop, non-overlapping
│
├── state/
│   ├── store.ts              # Atomic file persistence, job CRUD
│   └── types.ts              # JobStatus state machine
│
├── agent/
│   ├── runner.ts             # Abstract AgentRunner — override run(job)
│   ├── claude.ts             # Claude CLI wrapper (execFile, JSON parsing, usage)
│   └── plugin.ts             # Plugin interface (pre/post hooks, non-fatal)
│
└── dashboard/
    ├── server.ts             # Admin HTTP server (separate port, token auth)
    └── html.ts               # Embedded SPA dashboard

tests/
├── unit/                     # config, logger, state/store, plugin runner, claude
└── integration/              # webhook handler, agent runner (mock Claude)

config.yaml                   # Example config with all fields documented
Dockerfile                    # Multi-stage build
docker-compose.yml            # Local dev
```

---

## Section 2 — Configuration & Types

### config.yaml shape

```yaml
mode: webhook          # webhook | polling | both
webhook:
  port: 3000
  path: /webhook
  secret: ""           # HMAC-SHA256 — env: WEBHOOK_SECRET

polling:
  intervalSeconds: 60
  targets: []          # pluggable: list of URLs/identifiers to poll

agent:
  claudeModel: ""      # optional model override
  maxTurns: 10
  timeoutMs: 300000
  maxConcurrent: 3
  maxRetries: 3
  retryBackoffMs: 5000

dashboard:
  port: 3001
  token: ""            # env: DASHBOARD_TOKEN

state:
  filePath: data/state.json

features: {}           # reserved for plugins
```

### Environment variable overrides

| Env var | Config path |
|---------|-------------|
| `WEBHOOK_SECRET` | `webhook.secret` |
| `WEBHOOK_PORT` | `webhook.port` |
| `DASHBOARD_TOKEN` | `dashboard.token` |
| `DASHBOARD_PORT` | `dashboard.port` |
| `MODE` | `mode` |
| `CLAUDE_MODEL` | `agent.claudeModel` |

### Key types

```ts
type JobStatus = "pending" | "processing" | "done" | "error" | "failed"

interface Job {
  id: string           // stable: hash of source + payload key
  source: string       // "webhook" | "poller" | custom
  payload: unknown     // raw event data — agent interprets this
  status: JobStatus
  createdAt: string
  updatedAt: string
  attempts: number
  lastError?: string
  result?: unknown     // agent writes here on success
}

// To implement an agent — override one method:
abstract class AgentRunner {
  abstract run(job: Job, claude: ClaudeClient): Promise<unknown>
}

// To add a hook — implement one interface:
interface Plugin {
  name: string
  phase: "pre" | "post"
  shouldRun(ctx: PluginContext): boolean
  execute(ctx: PluginContext): Promise<PluginResult>
}
```

---

## Section 3 — Event Pipeline & Dashboard

### Webhook server (`events/webhook.ts`)
- Listens on configured port/path
- HMAC-SHA256 signature verification (timing-safe)
- Responds HTTP 202 immediately, processes async
- Calls `store.createJob()` then dispatches to `AgentRunner`
- If secret is empty: logs warning, accepts all requests (dev mode)

### Poller (`events/poller.ts`)
- Non-overlapping interval loop (won't start next tick if previous still running)
- Abstract `poll(): Promise<Job[]>` — implementor fetches from any external API
- Deduplicates by job ID before enqueuing

### EventSource interface (`events/source.ts`)
```ts
interface EventSource {
  start(): void
  stop(): Promise<void>
  updateConfig(config: AppConfig): void
}
```
Both webhook and poller implement this. `index.ts` starts whichever `mode` is configured.

### Dashboard (`dashboard/server.ts`)
- Separate port (default 3001)
- Bearer token auth on all `/api/*` routes
- Endpoints:
  - `GET /api/status` — health + version + uptime
  - `GET /api/jobs` — list jobs with status filter
  - `GET /api/config` — current config (secrets redacted)
  - `PATCH /api/config` — hot-reload field updates
  - `POST /api/jobs/:id/retry` — re-enqueue a failed job
- Embedded SPA (`html.ts`) — no build step

### Health endpoint (webhook port)
- `GET /health` → `{ status, version, uptime }`
- `GET /metrics` → job counts by status, active count, error rate

---

## Section 4 — Testing Strategy

**Framework:** Vitest + `@vitest/coverage-v8`, 80% line coverage threshold enforced

### Unit tests (`tests/unit/`)

| File | What it tests |
|------|---------------|
| `config.test.ts` | YAML loading, env overrides, validation errors, defaults |
| `logger.test.ts` | JSON output shape, child context merging, level filtering |
| `state-store.test.ts` | job CRUD, atomic writes, status transitions, retry counting |
| `plugin-runner.test.ts` | pre/post phase dispatch, error isolation |
| `claude.test.ts` | JSON parsing (direct, fence, trailing, freeform fallback), usage extraction |

### Integration tests (`tests/integration/`)

| File | What it tests |
|------|---------------|
| `webhook.test.ts` | valid sig → 202 + job created; bad sig → 401; no secret → warning path |
| `agent-runner.test.ts` | full pipeline: job created → agent runs → result written → status = done |

### Conventions
- Claude CLI mocked with a factory returning fixture JSON — no real subprocesses
- State store uses per-test `tmp` directories (Vitest `beforeEach`/`afterEach`)
- Integration tests spin real HTTP servers on random ports, tear down after
- `vitest.config.ts` enforces coverage thresholds

```json
"test":          "vitest run",
"test:watch":    "vitest",
"test:coverage": "vitest run --coverage"
```

---

## Section 5 — Deployment

### Dockerfile (multi-stage)
- Build: `dhi.io/node:20-alpine` + TypeScript compile
- Runtime: `github-cli` + `git` + Claude CLI via npm global
- Claude auth via init container (k8s) or volume mount (Docker)
- `EXPOSE 3000 3001`, health check on `GET /health`

### docker-compose.yml (local dev)
```yaml
services:
  agent:
    build: .
    ports: ["3000:3000", "3001:3001"]
    volumes:
      - ./config.yaml:/app/config.yaml
      - ./data:/app/data
      - claude-auth:/home/node/.claude
volumes:
  claude-auth:
```

### TypeScript
- Strict mode, `moduleResolution: bundler`, `outDir: dist`
- `npm run build` must compile cleanly before any commit

### Dependencies
```
dependencies:   yaml
devDependencies: typescript, tsx, vitest, @vitest/coverage-v8,
                 @types/node, @commitlint/cli, @commitlint/config-conventional,
                 simple-git-hooks
```

### Commit conventions
Conventional Commits enforced via `commitlint` + `simple-git-hooks` (same as reviewer).

---

## Implementation Notes

- **State file format** is versioned (V1) from day one — changes must add migration logic
- **Plugin errors** are always caught and logged; never propagate to kill the main job pipeline
- **`AgentRunner.run()`** is the single extension point — return `unknown`, store handles persistence
- **Sensitive fields** (`webhook.secret`, `dashboard.token`) are redacted in all API responses and logs
- **Graceful shutdown**: drain in-flight jobs up to 60s before `process.exit(0)`
