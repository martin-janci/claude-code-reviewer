# Claude Code PR Reviewer

## Project Overview

Automated PR code review service using Claude Code CLI. Watches GitHub PRs via polling and/or webhooks, fetches diffs, runs Claude review, and posts/updates comments.

**Tech Stack:** TypeScript, Node.js 20+, `gh` CLI, `claude` CLI, Docker

## Repository Structure

```
src/
├── index.ts                     # Entry point, wiring, graceful shutdown
├── config.ts                    # YAML config loading + env var overrides
├── config-manager.ts            # Hot-reload config lifecycle (persistence, validation, callbacks)
├── types.ts                     # All TypeScript interfaces and types
├── clone/
│   └── manager.ts               # Bare clones + git worktrees for codebase access
├── dashboard/
│   ├── server.ts                # Admin dashboard HTTP server (separate port)
│   └── html.ts                  # Embedded single-page dashboard UI
├── features/
│   ├── jira.ts                  # Jira key extraction + REST API validation
│   ├── auto-description.ts      # PR description generation via Claude CLI
│   └── auto-label.ts            # Label computation from verdict/severity/diff paths
├── polling/
│   └── poller.ts                # Non-overlapping poll loop with reconciliation
├── reviewer/
│   ├── reviewer.ts              # Core review orchestration, per-PR mutex, state machine
│   ├── github.ts                # gh CLI wrapper (PRs, diffs, comments, reviews API)
│   ├── claude.ts                # claude CLI wrapper with structured JSON parsing
│   ├── diff-parser.ts           # Unified diff parser for commentable line detection
│   ├── formatter.ts             # Review body and inline comment formatting
│   └── comment-verifier.ts      # Detects deleted reviews and comments
├── state/
│   ├── store.ts                 # JSON file persistence, atomic writes, V1→V2 migration
│   ├── decisions.ts             # shouldReview() — centralized review gating logic
│   └── cleanup.ts               # Purges stale closed/merged/error entries
└── webhook/
    └── server.ts                # HTTP server for GitHub webhook events

.claude/skills/code-review/skill.md              # Review prompt template (Conventional Comments + JSON)
.claude/skills/auto-description-prompt/skill.md  # System prompt for auto-description (not user-invocable)
.claude/skills/generate-pr-description/skill.md  # Manual PR description generation skill
.claude/skills/jira-lookup/skill.md              # Manual Jira issue lookup skill
config.yaml                                      # Runtime configuration
```

## Key Architecture Decisions

- **Per-PR mutex** in `Reviewer` prevents concurrent reviews of the same PR
- **State machine** with 8 states tracks full PR lifecycle (`types.ts:PRStatus`)
- **Atomic writes** for state persistence (temp file + rename in `store.ts`)
- **Two event sources** (poller + webhook) share the same `Reviewer` and `StateStore`
- **Lifecycle events** (close/merge/draft) bypass the per-PR mutex for immediate state updates
- **`shouldReview()`** is the single decision point — all review gating logic lives in `decisions.ts`
- **Codebase access** via bare clones + git worktrees (`clone/manager.ts`). Each PR gets an isolated worktree sharing the same object store. Claude receives read-only tools (`Read`, `Grep`, `Glob`) scoped to the worktree.
- **PR Reviews API** — reviews are posted via `POST /pulls/{n}/reviews` with `event: "COMMENT"` (never approve/block from the bot). Inline comments use Conventional Comments format.
- **Structured JSON output** from Claude with three-tier fallback parsing (direct → fence extraction → trailing JSON extraction → freeform legacy). Invalid JSON gracefully degrades to issue comment posting.
- **Admin dashboard** runs on a separate port (default `3001`) from the webhook server. Config changes are applied via hot-reload where possible; fields that require restart are clearly marked. See `docs/DASHBOARD.md`.
- **Diff parser** validates line numbers — Claude's line references are snapped to the nearest commentable line or promoted to the top-level review body.

## PR State Flow

```
pending_review → reviewing → reviewed → changes_pushed → (cycle)
                    ↓
                  error → retry (exponential backoff) or stuck (max retries)
Any → closed / merged (terminal)
Any → skipped (draft, WIP, diff_too_large) → pending_review (when cleared)
```

## Development

```bash
npm install
npm run build          # TypeScript compilation
npm run dev            # Run with tsx (development)
GITHUB_TOKEN=ghp_xxx node dist/index.js  # Production
```

## Key Files to Understand

| When working on... | Read these first |
|---------------------|-----------------|
| Review logic | `reviewer/reviewer.ts`, `state/decisions.ts` |
| Adding webhook events | `webhook/server.ts`, `types.ts` |
| State persistence | `state/store.ts`, `types.ts` (PRState, StateFileV2) |
| Configuration | `config.ts`, `types.ts` (AppConfig, ReviewConfig, FeaturesConfig) |
| Claude integration | `reviewer/claude.ts`, `.claude/skills/code-review/skill.md` |
| GitHub API calls | `reviewer/github.ts` |
| Codebase access | `clone/manager.ts`, `reviewer/reviewer.ts`, `reviewer/claude.ts` |
| Inline comments | `reviewer/diff-parser.ts`, `reviewer/formatter.ts`, `reviewer/reviewer.ts` |
| Review verification | `reviewer/comment-verifier.ts` (handles both review and legacy comment paths) |
| Jira integration | `features/jira.ts`, `reviewer/formatter.ts` (JiraLink), `reviewer/reviewer.ts` |
| Auto-description | `features/auto-description.ts`, `.claude/skills/auto-description-prompt/skill.md` |
| Auto-labeling | `features/auto-label.ts`, `reviewer/reviewer.ts` |
| Dashboard | `dashboard/server.ts`, `dashboard/html.ts`, `config-manager.ts` |
| Claude CLI update | `dashboard/server.ts` (`/api/claude/*`), `entrypoint.sh` (auto-update) |
| Hot-reload | `config-manager.ts`, `index.ts` (onChange callbacks) |

## Commit Conventions

This project enforces [Conventional Commits](https://www.conventionalcommits.org/) via commitlint.

**Required format:** `type(scope): description`

**Types:**
- `feat` — new feature (triggers minor version bump)
- `fix` — bug fix (triggers patch version bump)
- `perf` — performance improvement (triggers patch version bump)
- `chore` — maintenance, dependencies
- `docs` — documentation only
- `refactor` — code restructuring without behavior change
- `ci` — CI/CD changes
- `style` — formatting, whitespace
- `test` — adding or updating tests

**Breaking changes:** Use `feat!:` or `fix!:` prefix, or add a `BREAKING CHANGE:` footer. Triggers major version bump.

**Scope is optional:** `feat(webhook): ...` or `feat: ...` are both valid.

## Patterns and Conventions

- **Error handling:** Errors are recorded with phase (`diff_fetch`, `claude_review`, `comment_post`) and use exponential backoff
- **Logging:** `console.log` for normal operations, `console.error` for errors, `console.warn` for config warnings
- **State mutations:** Always go through `store.update()` or `store.setStatus()` — never mutate state directly
- **Webhook responses:** Send HTTP response immediately (202), then process asynchronously
- **Config defaults:** All defaults live in `DEFAULTS` constant in `config.ts`
- **CLI wrappers:** Both `gh` and `claude` are invoked via `child_process.execFile` with timeouts
- **Features:** Optional features (Jira, auto-description, auto-label) are disabled by default and configured under `features:` in `config.yaml`. Each feature is non-fatal — errors are logged but never block the review pipeline.

## Testing

Before committing changes:
1. `npm run build` — must compile cleanly (strict TypeScript)
2. Verify state transitions are consistent (check `decisions.ts` and `reviewer.ts` together)
3. Ensure webhook handlers always send an HTTP response before async processing
4. Check that new config fields have defaults in `config.ts` and are documented in `config.yaml`

## Important Constraints

- **No test framework** — project relies on TypeScript strict mode and manual verification
- **State file format** is versioned (V2) — changes to `PRState` must be backward-compatible or add migration logic in `store.ts`
- **`gh` CLI** must be available on PATH with a valid `GH_TOKEN`
- **`claude` CLI** is installed via npm at build time (`Dockerfile`). In Kubernetes, auth is injected via an init container from a Secret into a writable PVC. Set `CLAUDE_AUTO_UPDATE=true` to auto-update on startup
- **Webhook signature** verification uses HMAC-SHA256 with timing-safe comparison — don't weaken this
