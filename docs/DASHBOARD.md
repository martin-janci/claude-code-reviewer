# Admin Dashboard

The admin dashboard provides a browser-based UI for viewing and editing the service configuration at runtime, without restarting the service.

## Quick Start

The dashboard starts automatically on port `3001` (configurable). Open `http://localhost:3001` in a browser.

```yaml
# config.yaml
dashboard:
  port: 3001
  token: "my-secret-token"   # optional — enables bearer auth
```

Or via environment variables:

```bash
DASHBOARD_PORT=3001
DASHBOARD_TOKEN=my-secret-token
```

## Architecture

The dashboard runs on a **separate HTTP server** from the webhook endpoint (port `3000`). This keeps the public webhook isolated from the admin interface.

```
┌──────────────────┐     ┌──────────────────┐
│  Webhook Server  │     │ Dashboard Server  │
│   port 3000      │     │   port 3001       │
│                  │     │                   │
│  POST /webhook   │     │  GET  /           │  ← HTML dashboard
│  GET  /health    │     │  GET  /api/config │  ← read config
│  GET  /metrics   │     │  PUT  /api/config │  ← update config
│                  │     │  POST /api/config/validate │
│                  │     │  GET  /api/health  │
│                  │     │  GET  /api/claude/version │
│                  │     │  POST /api/claude/update  │
└──────────────────┘     └──────────────────┘
         │                        │
         └────────┬───────────────┘
                  │
           ConfigManager
          (shared in-memory)
```

### Components

| File | Purpose |
|------|---------|
| `src/config-manager.ts` | Config lifecycle: load, validate, persist, hot-reload, change notification |
| `src/dashboard/server.ts` | HTTP server with REST API and auth |
| `src/dashboard/html.ts` | Embedded single-page dashboard UI (vanilla HTML/CSS/JS) |

## API Endpoints

### `GET /api/config`

Returns the current config with sensitive fields redacted, plus metadata.

```json
{
  "config": { ... },
  "envOverrides": ["github.token", "webhook.secret"],
  "restartRequiredFields": ["mode", "webhook.port", "webhook.path", "webhook.secret", "github.token"]
}
```

### `PUT /api/config`

Apply a partial config update. Only include fields you want to change.

```bash
curl -X PUT http://localhost:3001/api/config \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret-token" \
  -d '{"polling": {"intervalSeconds": 120}}'
```

Response:

```json
{
  "success": true,
  "restartRequired": false,
  "warnings": []
}
```

### `POST /api/config/validate`

Dry-run validation without persisting changes.

```bash
curl -X POST http://localhost:3001/api/config/validate \
  -H "Content-Type: application/json" \
  -d '{"review": {"maxDiffLines": -1}}'
```

Response:

```json
{
  "valid": false,
  "errors": ["review.maxDiffLines: Must be >= 1"]
}
```

### `GET /api/health`

Returns service health, uptime, PR state counts, and metrics snapshot.

### `GET /api/claude/version`

Returns the current Claude CLI version.

```bash
curl http://localhost:3001/api/claude/version \
  -H "Authorization: Bearer my-secret-token"
```

Response:

```json
{
  "version": "1.0.16 (Claude Code)"
}
```

### `POST /api/claude/update`

Runs `npm install -g @anthropic-ai/claude-code` to update the Claude CLI. Returns before/after version. Only one update can run at a time (concurrent requests get `409 Conflict`).

```bash
curl -X POST http://localhost:3001/api/claude/update \
  -H "Authorization: Bearer my-secret-token"
```

Response:

```json
{
  "before": "1.0.15 (Claude Code)",
  "after": "1.0.16 (Claude Code)"
}
```

## Dashboard UI

The UI has five tabs:

| Tab | Contents |
|-----|----------|
| **General** | Mode, polling interval, webhook port/path/secret, GitHub token |
| **Review** | All `review.*` fields — behavior, limits, timeouts, paths |
| **Features** | Jira, auto-description, auto-label, Slack, audit, autofix (each with enable/disable toggle) |
| **Repos** | Dynamic list of owner/repo entries with add/remove |
| **Status** | Read-only health, uptime, PR state counts, metrics, Claude CLI version + update button |

### UI Features

- **Env-var locks**: Fields overridden by environment variables are disabled with a lock icon showing which env var takes precedence
- **Restart badges**: Fields requiring a restart show an orange "restart required" badge
- **Secret inputs**: Password fields with show/hide toggle; secrets display as `$$REDACTED_b7e2c4a9$$` sentinel value
- **Inline validation**: Errors shown immediately on save
- **Env-override warnings**: If you edit a field that's overridden by an env var, the save response includes a warning explaining the change is saved to `config.yaml` but won't take effect until the env var is removed

## Hot-Reload Behavior

### Immediately Effective

These fields take effect on the next poll cycle or review without restart:

- `polling.intervalSeconds` — checked each loop iteration
- `repos` — iterated each poll cycle
- All `review.*` fields — read per-review
- All `features.*` fields — checked per-feature invocation
- `review.commentTrigger` — regex recompiled in onChange callback
- `review.cloneTimeoutMs` — propagated to CloneManager

### Requires Restart

These fields are structural and bound at startup:

| Field | Reason |
|-------|--------|
| `mode` | Determines which servers are instantiated |
| `webhook.port` | Server already listening |
| `webhook.path` | Hardcoded in route matching |
| `webhook.secret` | Must coordinate with GitHub webhook config |
| `github.token` | Used for `setGhToken()` at startup |

The dashboard UI marks these fields with an orange badge, and the save response includes `"restartRequired": true` when any are changed.

## Security

### Bearer Token Auth

If `dashboard.token` (or `DASHBOARD_TOKEN` env var) is set, all dashboard routes require:

```
Authorization: Bearer <token>
```

Token comparison uses `crypto.timingSafeEqual` to prevent timing-based enumeration attacks. If no token is configured, the dashboard is unaccessible without auth (open access for local development).

### Secret Handling

- `GET /api/config` replaces sensitive field values with `$$REDACTED_b7e2c4a9$$`
- `PUT /api/config` treats the sentinel value as "no change" — sensitive fields are only updated when a real value is provided
- `serializeConfig()` never writes env-var-only secrets to `config.yaml` — only secrets that were originally in the file are persisted

### Rate Limiting

Config writes are rate-limited to **10 per minute** (in-memory counter) to prevent accidental rapid-fire updates.

### Request Limits

- Request body: max **1 MB**
- Body read timeout: **10 seconds**
- Config file size: max **512 KB** for serialization tracking

## Environment Variables

| Variable | Config Path | Description |
|----------|------------|-------------|
| `DASHBOARD_PORT` | `dashboard.port` | Dashboard server port (default: `3001`) |
| `DASHBOARD_TOKEN` | `dashboard.token` | Bearer token for dashboard auth |
| `CLAUDE_AUTO_UPDATE` | — | Set to `true` to auto-update Claude CLI on startup |

Environment variable overrides always take precedence over config file values. The dashboard UI shows which fields are overridden and by which env var.

## Docker

When running in Docker, expose the dashboard port alongside the webhook port:

```bash
docker run -p 3000:3000 -p 3001:3001 \
  -e DASHBOARD_TOKEN=my-secret-token \
  -v ./config.yaml:/app/config.yaml \
  ghcr.io/martin-janci/claude-code-reviewer
```

Or in `docker-compose.yaml`:

```yaml
services:
  reviewer:
    image: ghcr.io/martin-janci/claude-code-reviewer
    ports:
      - "3000:3000"   # webhook
      - "3001:3001"   # dashboard
    environment:
      - DASHBOARD_TOKEN=my-secret-token
```

## Kubernetes

Add the dashboard port to your Service and Deployment:

```yaml
# In Deployment container ports
ports:
  - containerPort: 3000
    name: webhook
  - containerPort: 3001
    name: dashboard

# In Service
ports:
  - port: 3000
    targetPort: webhook
    name: webhook
  - port: 3001
    targetPort: dashboard
    name: dashboard
```

Set `DASHBOARD_TOKEN` via a Kubernetes Secret:

```yaml
env:
  - name: DASHBOARD_TOKEN
    valueFrom:
      secretKeyRef:
        name: reviewer-secrets
        key: dashboard-token
```
