# Changelog

## v1.2.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.1.0...v1.2.0)

### 🚀 Enhancements

- Add metrics collector for review statistics ([8de7f69](https://github.com/martin-janci/claude-code-reviewer/commit/8de7f69))
- Expose /metrics endpoint with review statistics ([3d358a7](https://github.com/martin-janci/claude-code-reviewer/commit/3d358a7))

### 🩹 Fixes

- Include version and uptime in health endpoint response ([70d0d6e](https://github.com/martin-janci/claude-code-reviewer/commit/70d0d6e))
- Address review findings on metrics implementation ([cf26945](https://github.com/martin-janci/claude-code-reviewer/commit/cf26945))

### 🤖 CI

- Remove Docker job from release workflow ([e2f6d53](https://github.com/martin-janci/claude-code-reviewer/commit/e2f6d53))

### ❤️ Contributors

- Martin-janci ([@martin-janci](http://github.com/martin-janci))

## v1.1.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.0.0...v1.1.0)

### 🚀 Enhancements

- Add changelog and release automation ([5ae0b4e](https://github.com/martin-janci/claude-code-reviewer/commit/5ae0b4e))

### ❤️ Contributors

- Martin-janci ([@martin-janci](http://github.com/martin-janci))

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
