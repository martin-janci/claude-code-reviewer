# Changelog

## v1.0.0

Initial release of Claude Code PR Reviewer.

### Features

- PR state machine with full lifecycle tracking (8 states, crash recovery)
- Polling and webhook-based PR detection
- Codebase-aware reviews via bare clones and git worktrees
- Structured JSON output with Conventional Comments format
- Inline review comments via GitHub Pull Request Reviews API
- Comment-triggered review via `/review` PR comment
- Diff parser with line number validation and snapping
- Review verification — detects deleted/dismissed reviews
- Pre-warming of repo clones on startup
- Configurable debounce, backoff, and retry logic

### Documentation

- Comprehensive README with architecture diagrams
- CLAUDE.md project context for Claude Code
- Review prompt template at `.claude/skills/code-review/skill.md`
