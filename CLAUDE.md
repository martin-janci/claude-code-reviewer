# Claude Code PR Reviewer

## Project Overview

Automated PR code review service using Claude Code CLI. Watches GitHub PRs via polling and/or webhooks, fetches diffs, runs Claude review, and posts/updates comments.

**Tech Stack:** TypeScript, Node.js 20+, `gh` CLI, `claude` CLI, Docker

## Repository Structure

```
src/
├── index.ts                     # Entry point, wiring, graceful shutdown
├── config.ts                    # YAML config loading + env var overrides
├── types.ts                     # All TypeScript interfaces and types
├── polling/
│   └── poller.ts                # Non-overlapping poll loop with reconciliation
├── reviewer/
│   ├── reviewer.ts              # Core review orchestration, per-PR mutex, state machine
│   ├── github.ts                # gh CLI wrapper (list PRs, diffs, comments)
│   ├── claude.ts                # claude CLI wrapper with skill path resolution
│   └── comment-verifier.ts      # Detects deleted review comments
├── state/
│   ├── store.ts                 # JSON file persistence, atomic writes, V1→V2 migration
│   ├── decisions.ts             # shouldReview() — centralized review gating logic
│   └── cleanup.ts               # Purges stale closed/merged/error entries
└── webhook/
    └── server.ts                # HTTP server for GitHub webhook events

.claude/skills/code-review/skill.md  # Review prompt template for Claude
config.yaml                     # Runtime configuration
```

## Key Architecture Decisions

- **Per-PR mutex** in `Reviewer` prevents concurrent reviews of the same PR
- **State machine** with 8 states tracks full PR lifecycle (`types.ts:PRStatus`)
- **Atomic writes** for state persistence (temp file + rename in `store.ts`)
- **Two event sources** (poller + webhook) share the same `Reviewer` and `StateStore`
- **Lifecycle events** (close/merge/draft) bypass the per-PR mutex for immediate state updates
- **`shouldReview()`** is the single decision point — all review gating logic lives in `decisions.ts`

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
| Configuration | `config.ts`, `types.ts` (AppConfig, ReviewConfig) |
| Claude integration | `reviewer/claude.ts`, `.claude/skills/code-review/skill.md` |
| GitHub API calls | `reviewer/github.ts` |

## Patterns and Conventions

- **Error handling:** Errors are recorded with phase (`diff_fetch`, `claude_review`, `comment_post`) and use exponential backoff
- **Logging:** `console.log` for normal operations, `console.error` for errors, `console.warn` for config warnings
- **State mutations:** Always go through `store.update()` or `store.setStatus()` — never mutate state directly
- **Webhook responses:** Send HTTP response immediately (202), then process asynchronously
- **Config defaults:** All defaults live in `DEFAULTS` constant in `config.ts`
- **CLI wrappers:** Both `gh` and `claude` are invoked via `child_process.execFile` with timeouts

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
- **`claude` CLI** must be authenticated (Docker mounts `.claude` volume)
- **Webhook signature** verification uses HMAC-SHA256 with timing-safe comparison — don't weaken this
