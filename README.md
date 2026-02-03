# Claude Code PR Reviewer

Automated PR code review service that watches GitHub pull requests and posts review comments using [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code). Operates via polling, GitHub webhooks, or both.

## How It Works

1. Detects new or updated PRs via **polling** or **GitHub webhooks**
2. Fetches the PR diff using `gh pr diff`
3. Clones the repository (bare clone with git worktrees for isolation)
4. Sends the diff to `claude -p` with read-only codebase access (`Read`, `Grep`, `Glob` tools)
5. Parses Claude's structured JSON output into inline comments with [Conventional Comments](https://conventionalcomments.org/) labels
6. Posts a PR review via the GitHub Pull Request Reviews API with inline comments on specific diff lines
7. Cleans up the worktree after review
8. Tracks the full PR lifecycle with a state machine to avoid duplicate reviews and handle edge cases

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
    ┌───────┬───┼───────┬──────────┐
    │       │   │       │          │
┌───▼───┐ ┌─▼───▼──┐ ┌─▼──────┐ ┌─▼──────┐
│  gh   │ │ clone  │ │ claude │ │ State  │
│  CLI  │ │ manager│ │  CLI   │ │ Store  │
└───────┘ └────────┘ └────────┘ └────────┘
              │
        bare clones +
        git worktrees
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| Entry point | `src/index.ts` | Wires components, starts services, handles shutdown |
| Config | `src/config.ts` | Loads YAML config with env var overrides |
| Poller | `src/polling/poller.ts` | Non-overlapping poll loop with reconciliation and cleanup |
| Webhook Server | `src/webhook/server.ts` | HTTP server for GitHub webhook events |
| Reviewer | `src/reviewer/reviewer.ts` | Core review logic with state machine transitions |
| Clone Manager | `src/clone/manager.ts` | Bare clones and git worktrees for codebase access |
| State Store | `src/state/store.ts` | JSON file persistence with atomic writes and V1 migration |
| Decisions | `src/state/decisions.ts` | `shouldReview()` function — centralized review gating |
| Cleanup | `src/state/cleanup.ts` | Purges stale closed/merged/error entries |
| GitHub | `src/reviewer/github.ts` | `gh` CLI wrapper for API calls (PRs, diffs, reviews) |
| Claude | `src/reviewer/claude.ts` | Claude Code CLI wrapper with structured JSON parsing |
| Diff Parser | `src/reviewer/diff-parser.ts` | Parses unified diffs for commentable line detection |
| Formatter | `src/reviewer/formatter.ts` | Review body and inline comment formatting |
| Review Verifier | `src/reviewer/comment-verifier.ts` | Detects deleted/dismissed reviews and comments |

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

## Codebase Access

By default, reviews include full codebase access — Claude can read any file in the repository, not just the diff. This enables deeper reviews that check callers, verify interface contracts, and understand architectural patterns.

**How it works:**
- Each repo is **bare-cloned** once to `data/clones/owner/repo/`
- Each PR gets an isolated **git worktree** at `data/clones/owner/repo--pr-N/`
- Claude receives read-only tools (`Read`, `Grep`, `Glob`) scoped to the worktree
- Worktrees are cleaned up after review; stale ones are pruned each poll cycle
- Clones share a single object store, so disk overhead is minimal

**Configuration:**

```yaml
review:
  codebaseAccess: true          # set false for diff-only reviews
  cloneDir: data/clones         # stored in the reviewer-data Docker volume
  cloneTimeoutMs: 120000        # timeout for git clone/fetch
  reviewTimeoutMs: 600000       # timeout for claude review (10 min)
  reviewMaxTurns: 15            # max agentic turns for codebase exploration
  staleWorktreeMinutes: 60      # auto-cleanup threshold
```

Set `codebaseAccess: false` to revert to diff-only reviews. Clone failures are treated as errors (not fallback to diff-only) to ensure consistent review quality.

## Setup

**For complete setup instructions, see [SETUP.md](SETUP.md)**

The setup guide covers:
- Prerequisites (GitHub token, Claude CLI, deployment environment)
- GitHub Personal Access Token creation
- Claude CLI installation and authentication
- Three deployment options (Docker Compose, Kubernetes, Local)
- Configuration for all features (Jira, Slack, autofix, audit logging)
- GitHub webhook setup
- Verification and health checks
- Troubleshooting common issues
- Security best practices

### Quick Start (Docker Compose)

1. Clone the repository:
```bash
git clone https://github.com/martin-janci/claude-code-reviewer.git
cd claude-code-reviewer
```

2. Create configuration:
```bash
cp config.yaml.example config.yaml
# Edit config.yaml with your repos and settings
```

3. Set credentials:
```bash
cat > .env << EOF
GITHUB_TOKEN=ghp_your_token_here
WEBHOOK_SECRET=$(openssl rand -hex 32)
EOF
```

4. Copy Claude credentials:
```bash
mkdir -p .claude
cp -r ~/.claude/* .claude/
```

5. Start the service:
```bash
docker compose up -d
```

6. Verify it's running:
```bash
curl http://localhost:3000/health
```

For Kubernetes deployment, local development, and detailed configuration, see [SETUP.md](SETUP.md).

## Features

### Core Features
- ✅ **Automatic PR Review** — Reviews new and updated PRs via polling or webhooks
- ✅ **Full Codebase Access** — Claude can explore the entire repository, not just the diff
- ✅ **Inline Comments** — Posts review comments directly on specific lines in the "Files changed" tab
- ✅ **Conventional Comments** — Uses standard labels (`issue`, `suggestion`, `nitpick`, `question`, `praise`)
- ✅ **State Machine** — Tracks full PR lifecycle with intelligent state transitions
- ✅ **Manual Trigger** — Post `/review` comment to force re-review
- ✅ **Review Verification** — Detects deleted/dismissed reviews and re-queues
- ✅ **Graceful Error Handling** — Exponential backoff and retry logic

### Optional Features
- 🔧 **Autofix** — `/fix` command to automatically apply fixes to review findings
- 🎯 **Jira Integration** — Extracts and validates Jira issue keys from PR titles/branches
- 📝 **Auto-Description** — Generates PR descriptions from diffs using Claude
- 🏷️ **Auto-Labeling** — Applies labels based on review verdict, severity, and file paths
- 💬 **Slack Notifications** — Sends notifications for review events
- 📊 **Audit Logging** — Comprehensive operational audit trail with structured logging

### Deployment Options
- 🐳 **Docker Compose** — Simple single-command deployment
- ☸️ **Kubernetes** — Production-ready manifests with health checks, PVCs, and security contexts
- 💻 **Local Development** — Native Node.js execution for development

## Webhook Setup

For webhook mode, configure a GitHub webhook on your repository. See [SETUP.md](SETUP.md#github-webhook-setup-webhook-mode) for detailed instructions.

**Quick steps:**
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

## Review Output

Reviews are posted using the **GitHub Pull Request Reviews API** — not issue comments. This means:

- **Inline comments** appear directly on the "Files changed" tab at specific lines
- **Top-level summary** appears in the PR conversation as a collapsible review
- **Always `COMMENT` event** — the bot never approves or blocks via the API; severity is in the content

### Conventional Comments

Inline comments use [Conventional Comments](https://conventionalcomments.org/) format:

| Label | Meaning | Blocking? |
|-------|---------|-----------|
| `issue` | Real problem — bugs, security, broken logic | Yes (default) |
| `suggestion` | Improvement idea — better approach, refactoring | Only if fixing a real problem |
| `nitpick` | Minor style preference | No |
| `question` | Request for clarification | No |
| `praise` | Acknowledgment of good work | No |

Example inline comment:
```
**issue (blocking):** SQL injection risk. The query uses string concatenation...
```

### Structured JSON Output

Claude is prompted to output a JSON object with verdict, summary, and per-file findings. The parser has a two-tier fallback:

1. **Direct JSON parse** — Claude outputs raw JSON
2. **Fence extraction** — Claude wraps JSON in ` ```json ``` `
3. **Freeform fallback** — invalid JSON gracefully degrades to a legacy issue comment

### Line Number Validation

Claude may reference lines that aren't in the diff. The diff parser builds a map of commentable lines (RIGHT side) and snaps each finding to the nearest valid line (within 3 lines). Findings that can't be placed inline appear in the "Additional Findings" section of the top-level review body.

### Review Prompt

The review skill prompt lives at `.claude/skills/code-review/skill.md`. Edit this file to customize review focus areas, severity labels, and output format.

### Re-review Context

When a PR is re-reviewed after new commits, the prompt includes context about the previous verdict and SHA, asking Claude to focus on what changed.

### Review Identification

The service identifies its own reviews using a hidden HTML tag (`<!-- claude-code-review -->`). Each review is a new `COMMENT` event — old reviews remain as history in the PR conversation.

### Review Verification

Periodically (configurable via `commentVerifyIntervalMinutes`), the service checks whether its reviews still exist. If a review was deleted or dismissed, the PR is re-queued for review. Legacy issue comments are also verified for backward compatibility.

## Concurrency

- **Per-PR mutex**: Only one `processPR` call runs per PR at a time, preventing race conditions between polling and webhooks in `"both"` mode
- **Non-overlapping polls**: The poll loop waits for the current cycle to complete before sleeping and starting the next one
- **Graceful shutdown**: Waits up to 60 seconds for in-flight reviews to complete before exiting

## Error Handling

- **Exponential backoff**: Failed reviews retry after 1m, 2m, 4m (configurable via `maxRetries`)
- **Phase tracking**: Errors record which phase failed (`diff_fetch`, `claude_review`, `comment_post`)
- **Stale cleanup**: Error entries stuck at max retries are purged after `staleErrorDays`
- **Corrupt state recovery**: If the state file is corrupted, the service starts fresh with an empty state

## Releasing

This project uses [Conventional Commits](https://www.conventionalcommits.org/) and automated releases.

### Commit Format

```
type(scope): description

# Examples:
feat: add support for monorepo reviews
fix(webhook): handle missing signature header
docs: update setup instructions
feat!: require Node.js 22 (breaking change)
```

**Types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `ci`, `style`, `test`

Commits are validated by commitlint via a git hook — non-conforming messages are rejected.

### Auto-Release (CI)

Every push to `main` with at least one `feat`, `fix`, or `perf` commit triggers:

1. Version bump (semver based on commit types)
2. `CHANGELOG.md` update
3. Git tag + push
4. GitHub Release with generated notes

### Manual Release (Local)

```bash
npm run release    # bump version, update CHANGELOG, tag, push, create GitHub Release
npm run changelog  # preview changelog without releasing
```

## Project Structure

```
claude-code-reviewer/
├── src/
│   ├── index.ts                     # Entry point
│   ├── config.ts                    # Config loading with validation
│   ├── types.ts                     # TypeScript type definitions
│   ├── clone/
│   │   └── manager.ts               # Bare clones + git worktrees
│   ├── polling/
│   │   └── poller.ts                # Poll loop with reconciliation
│   ├── reviewer/
│   │   ├── claude.ts                # Claude CLI wrapper with JSON parsing
│   │   ├── github.ts                # GitHub CLI wrapper (PRs, reviews API)
│   │   ├── reviewer.ts              # Core review state machine
│   │   ├── diff-parser.ts           # Unified diff → commentable lines
│   │   ├── formatter.ts             # Review body + inline comment formatting
│   │   └── comment-verifier.ts      # Review/comment verification
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
