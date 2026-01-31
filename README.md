# Claude Code PR Reviewer

Automated PR code review service that watches GitHub pull requests and posts review comments using [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code). Operates via polling, GitHub webhooks, or both.

## How It Works

1. Detects new or updated PRs via **polling** or **GitHub webhooks**
2. Fetches the PR diff using `gh pr diff`
3. Sends the diff to `claude -p` with a customizable review prompt
4. Posts or updates a review comment on the PR
5. Tracks the full PR lifecycle with a state machine to avoid duplicate reviews and handle edge cases

## Architecture

```
┌──────────────┐     ┌──────────────┐
│   Poller     │     │   Webhook    │
│ (interval)   │     │   Server     │
└──────┬───────┘     └──────┬───────┘
       │                    │
       └────────┬───────────┘
                │
         ┌──────▼──────┐
         │  Reviewer   │  ← per-PR mutex lock
         │ (processPR) │
         └──────┬──────┘
                │
    ┌───────────┼───────────┐
    │           │           │
┌───▼───┐ ┌────▼────┐ ┌────▼────┐
│  gh   │ │ claude  │ │  State  │
│  CLI  │ │  CLI    │ │  Store  │
└───────┘ └─────────┘ └─────────┘
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| Entry point | `src/index.ts` | Wires components, starts services, handles shutdown |
| Config | `src/config.ts` | Loads YAML config with env var overrides |
| Poller | `src/polling/poller.ts` | Non-overlapping poll loop with reconciliation and cleanup |
| Webhook Server | `src/webhook/server.ts` | HTTP server for GitHub webhook events |
| Reviewer | `src/reviewer/reviewer.ts` | Core review logic with state machine transitions |
| State Store | `src/state/store.ts` | JSON file persistence with atomic writes and V1 migration |
| Decisions | `src/state/decisions.ts` | `shouldReview()` function — centralized review gating |
| Cleanup | `src/state/cleanup.ts` | Purges stale closed/merged/error entries |
| GitHub | `src/reviewer/github.ts` | `gh` CLI wrapper for API calls |
| Claude | `src/reviewer/claude.ts` | Claude Code CLI wrapper for reviews |
| Comment Verifier | `src/reviewer/comment-verifier.ts` | Detects deleted review comments |

## PR State Machine

Each tracked PR moves through a lifecycle of states:

```
pending_review → reviewing → reviewed → changes_pushed → pending_review (cycle)
                     ↓
                   error → pending_review (retry) or stuck (max retries)

Any status → closed / merged (terminal)
Any status → skipped (draft, WIP, diff too large)
skipped → pending_review (when condition clears)
```

### States

| Status | Description |
|--------|-------------|
| `pending_review` | Ready for review |
| `reviewing` | Review in progress (lock) |
| `reviewed` | Review complete, comment posted |
| `changes_pushed` | New commits after review — will re-review after debounce |
| `error` | Review failed — retries with exponential backoff |
| `skipped` | Excluded (draft, WIP title, or diff too large) |
| `closed` | PR closed without merge |
| `merged` | PR merged |

### Scenario Coverage

| Scenario | How Handled |
|----------|-------------|
| New PR opened | Creates entry with `pending_review` |
| Already reviewed, no new commits | `shouldReview()` returns false — SHA matches |
| Author pushes after review | SHA change → `changes_pushed` → debounce → `pending_review` |
| Author pushes to fix review comments | Debounce bypassed when last verdict was `REQUEST_CHANGES` |
| Force push | Same as regular push — SHA change is the signal |
| Marked as draft | → `skipped` (draft) |
| Draft becomes ready | `skipped` (draft) + not draft → `pending_review` |
| PR closed | → `closed`, cleaned up after `staleClosedDays` |
| PR merged | → `merged`, cleaned up after `staleClosedDays` |
| PR reopened | Transitions based on whether SHA was already reviewed |
| Claude failed | → `error`, exponential backoff (1m, 2m, 4m), max retries |
| Rapid pushes | Debounce (60s default) — only review after pushes settle |
| WIP title toggled | `skipped` (wip_title) ↔ `pending_review` based on title |
| Service restart | Resets any `reviewing` → `pending_review` (crash recovery) |
| Diff too large | `skipped` (diff_too_large), re-evaluates on new push |
| Review comment deleted | Periodic verification detects deletion, re-queues review |
| `/review` comment posted | Forced re-review bypassing debounce and error backoff |

## Setup

### Prerequisites

- Docker (recommended) or Node.js 20+
- GitHub token with repo access (`GITHUB_TOKEN`)
- Claude Code CLI authenticated (mounted via Docker volume or available on PATH)
- `gh` CLI installed and available

### Configuration

Create or edit `config.yaml`:

```yaml
mode: polling  # "polling" | "webhook" | "both"

polling:
  intervalSeconds: 300

webhook:
  port: 3000
  secret: ""       # or WEBHOOK_SECRET env var
  path: /webhook

github:
  token: ""        # or GITHUB_TOKEN env var

repos:
  - owner: your-org
    repo: your-repo

review:
  maxDiffLines: 5000                 # skip diffs larger than this
  skipDrafts: true                   # skip draft PRs
  skipWip: true                      # skip PRs with "WIP" title prefix
  commentTag: "<!-- claude-code-review -->"
  maxRetries: 3                      # max consecutive errors before giving up
  debouncePeriodSeconds: 60          # wait for pushes to settle before reviewing
  staleClosedDays: 7                 # purge closed/merged PR state after N days
  staleErrorDays: 30                 # purge max-retries error state after N days
  commentVerifyIntervalMinutes: 60   # how often to check if review comment exists
  maxReviewHistory: 20               # max review records to keep per PR
  commentTrigger: "^\\s*/review\\s*$"  # regex to match PR comments that trigger a review
```

### Environment Variables

All config values can be overridden with environment variables:

| Variable | Overrides | Description |
|----------|-----------|-------------|
| `GITHUB_TOKEN` | `github.token` | GitHub personal access token |
| `WEBHOOK_SECRET` | `webhook.secret` | GitHub webhook signature secret |
| `WEBHOOK_PORT` | `webhook.port` | HTTP server port |
| `POLLING_INTERVAL` | `polling.intervalSeconds` | Polling interval in seconds |
| `MODE` | `mode` | Operating mode: `polling`, `webhook`, or `both` |

### Run with Docker Compose

```bash
export GITHUB_TOKEN=ghp_xxx
docker compose up -d
```

### Run with Docker

```bash
# Build
docker build -t claude-code-reviewer .

# Polling mode
docker run -d \
  -e GITHUB_TOKEN=ghp_xxx \
  -v claude-auth:/home/node/.claude \
  -v ./config.yaml:/app/config.yaml:ro \
  -v reviewer-data:/app/data \
  claude-code-reviewer

# Webhook mode
docker run -d \
  -e GITHUB_TOKEN=ghp_xxx \
  -e WEBHOOK_SECRET=your-secret \
  -v claude-auth:/home/node/.claude \
  -v ./config.yaml:/app/config.yaml:ro \
  -v reviewer-data:/app/data \
  -p 3000:3000 \
  claude-code-reviewer
```

### Run Locally (Development)

```bash
npm install
npm run build
GITHUB_TOKEN=ghp_xxx node dist/index.js

# Or with tsx for development
GITHUB_TOKEN=ghp_xxx npm run dev
```

## Webhook Setup

To use webhook mode, configure a GitHub webhook on your repository:

1. Go to **Settings** > **Webhooks** > **Add webhook**
2. Set **Payload URL** to `https://your-host:3000/webhook`
3. Set **Content type** to `application/json`
4. Set **Secret** to match your `WEBHOOK_SECRET`
5. Select events: **Pull requests** and **Issue comments**
6. Save

### Handled Webhook Events

| Action | Behavior |
|--------|----------|
| `opened` | Triggers review |
| `synchronize` | Triggers review (new push) |
| `reopened` | Triggers review |
| `ready_for_review` | Triggers review (draft → ready) |
| `edited` | Triggers review only if title changed (WIP detection) |
| `closed` | Sets state to `closed` or `merged` directly |
| `converted_to_draft` | Sets state to `skipped` (draft) directly |
| `issue_comment` (created) | Triggers review if comment matches `commentTrigger` regex |

### Comment-Triggered Review

Post `/review` as a comment on a PR to trigger an immediate review. This is useful for:

- Re-reviewing a PR that was already reviewed at the same SHA
- Bypassing the debounce period after a push
- Retrying after errors (bypasses backoff and max retries)

The trigger is configurable via `review.commentTrigger` (default: `^\s*/review\s*$`). The regex is tested per-line (`m` flag), so `/review` can appear in a multi-line comment.

**What gets bypassed:** already-reviewed check, debounce, error backoff/max retries.

**What is NOT bypassed (policy/safety):** terminal states (closed/merged), reviewing lock (prevents duplicates), draft/WIP skip, diff size limit.

Bot comments are ignored to prevent feedback loops.

## Health Check

The service exposes a health endpoint at `GET /health` that returns:

```json
{"status": "ok"}
```

This is used by Docker's `HEALTHCHECK` and is available in all modes.

## State Persistence

State is persisted to `data/state.json` using atomic writes (write to temp file, then rename). The state file uses a versioned format:

```json
{
  "version": 2,
  "prs": {
    "owner/repo#1": {
      "status": "reviewed",
      "headSha": "abc1234",
      "lastReviewedSha": "abc1234",
      "reviews": [...],
      ...
    }
  }
}
```

### V1 Migration

If a V1 state file (simple `"owner/repo#N" → SHA` map) is detected, it is automatically migrated to V2 format on startup.

### Crash Recovery

On startup, any entries with `"reviewing"` status are reset to `"pending_review"` to recover from unclean shutdowns.

## Review Prompt

The review skill prompt lives at `.claude/skills/code-review/skill.md`. It instructs Claude to:

- Start with a verdict line: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`
- Group findings by severity: Critical, Warning, Suggestion
- Reference specific files and lines
- Avoid inventing problems

Edit this file to customize review focus areas, severity levels, and output format.

### Re-review Context

When a PR is re-reviewed after new commits, the prompt includes context about the previous verdict and SHA, asking Claude to focus on what changed.

## Comment Deduplication

The service identifies its own comments using a hidden HTML tag (`<!-- claude-code-review -->`). When a PR receives new commits, the existing review comment is updated in place rather than posting a duplicate.

### Comment Verification

Periodically (configurable via `commentVerifyIntervalMinutes`), the service checks whether its review comments still exist. If a comment was deleted, the PR is re-queued for review.

## Concurrency

- **Per-PR mutex**: Only one `processPR` call runs per PR at a time, preventing race conditions between polling and webhooks in `"both"` mode
- **Non-overlapping polls**: The poll loop waits for the current cycle to complete before sleeping and starting the next one
- **Graceful shutdown**: Waits up to 60 seconds for in-flight reviews to complete before exiting

## Error Handling

- **Exponential backoff**: Failed reviews retry after 1m, 2m, 4m (configurable via `maxRetries`)
- **Phase tracking**: Errors record which phase failed (`diff_fetch`, `claude_review`, `comment_post`)
- **Stale cleanup**: Error entries stuck at max retries are purged after `staleErrorDays`
- **Corrupt state recovery**: If the state file is corrupted, the service starts fresh with an empty state

## Project Structure

```
claude-code-reviewer/
├── src/
│   ├── index.ts                     # Entry point
│   ├── config.ts                    # Config loading with validation
│   ├── types.ts                     # TypeScript type definitions
│   ├── polling/
│   │   └── poller.ts                # Poll loop with reconciliation
│   ├── reviewer/
│   │   ├── claude.ts                # Claude CLI wrapper
│   │   ├── github.ts                # GitHub CLI wrapper
│   │   ├── reviewer.ts              # Core review state machine
│   │   └── comment-verifier.ts      # Deleted comment detection
│   ├── state/
│   │   ├── store.ts                 # State persistence (CRUD, migration)
│   │   ├── decisions.ts             # shouldReview() decision function
│   │   └── cleanup.ts              # Stale entry cleanup
│   └── webhook/
│       └── server.ts                # GitHub webhook HTTP server
├── .claude/
│   └── skills/
│       └── code-review/
│           └── skill.md             # Review prompt template
├── config.yaml                      # Configuration file
├── Dockerfile                       # Multi-stage Docker build
├── docker-compose.yaml              # Docker Compose setup
├── package.json
└── tsconfig.json
```
