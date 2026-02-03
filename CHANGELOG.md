# Changelog

## v1.12.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.11.0...v1.12.0)

### 🚀 Enhancements

- Enhance review formatting with icons and better structure ([#10](https://github.com/martin-janci/claude-code-reviewer/pull/10))

### ❤️ Contributors

- Martin Janči ([@martin-janci](http://github.com/martin-janci))

## v1.11.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.10.0...v1.11.0)

### 🚀 Enhancements

- Add audit logging for operational tracking ([#9](https://github.com/martin-janci/claude-code-reviewer/pull/9))

### ❤️ Contributors

- Martin Janči ([@martin-janci](http://github.com/martin-janci))

## v1.10.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.9.1...v1.10.0)

### 🚀 Enhancements

- Enhance /health endpoint with settings and auth status ([#8](https://github.com/martin-janci/claude-code-reviewer/pull/8))

### ❤️ Contributors

- Martin Janči ([@martin-janci](http://github.com/martin-janci))

## v1.9.1

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.9.0...v1.9.1)

### 🩹 Fixes

- Improve reliability and observability ([743f4e0](https://github.com/martin-janci/claude-code-reviewer/commit/743f4e0))

### ❤️ Contributors

- Martin-janci ([@martin-janci](http://github.com/martin-janci))

## v1.9.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.8.0...v1.9.0)

### 🚀 Enhancements

- Implement feature plugin architecture (Phase 3) ([#7](https://github.com/martin-janci/claude-code-reviewer/pull/7))

### ❤️ Contributors

- Martin Janči ([@martin-janci](http://github.com/martin-janci))

## v1.8.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.7.4...v1.8.0)

### 🚀 Enhancements

- Add observability and review quality improvements (Phase 1 & 2) ([8da9e53](https://github.com/martin-janci/claude-code-reviewer/commit/8da9e53))

### ❤️ Contributors

- Martin-janci ([@martin-janci](http://github.com/martin-janci))

## v1.7.4

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.5.0...v1.7.4)

### 🩹 Fixes

- Bug fixes, Docker reliability, and review false positive reduction ([#6](https://github.com/martin-janci/claude-code-reviewer/pull/6))

### ❤️ Contributors

- Martin Janči ([@martin-janci](http://github.com/martin-janci))

## v1.5.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.4.0...v1.5.0)

### 🚀 Enhancements

- Add operator skills and intelligent PR management features ([#5](https://github.com/martin-janci/claude-code-reviewer/pull/5))

### ❤️ Contributors

- Martin Janči ([@martin-janci](http://github.com/martin-janci))

## v1.4.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.3.0...v1.4.0)

### 🚀 Enhancements

- Structured PR reviews with inline comments and resolution tracking ([#4](https://github.com/martin-janci/claude-code-reviewer/pull/4))

### ❤️ Contributors

- Martin Janči ([@martin-janci](http://github.com/martin-janci))

## v1.3.0

[compare changes](https://github.com/martin-janci/claude-code-reviewer/compare/v1.2.0...v1.3.0)

### 🚀 Enhancements

- Add structured PR reviews with inline comments via Reviews API ([bc82784](https://github.com/martin-janci/claude-code-reviewer/commit/bc82784))
- Add one-shot CLI review mode via --pr flag ([43c74ea](https://github.com/martin-janci/claude-code-reviewer/commit/43c74ea))

### 🩹 Fixes

- Address review findings on formatter and diff parser ([a2b1656](https://github.com/martin-janci/claude-code-reviewer/commit/a2b1656))
- Backfill new fields on V2 state load and remove dead code ([31d973b](https://github.com/martin-janci/claude-code-reviewer/commit/31d973b))

### ❤️ Contributors

- Martin-janci ([@martin-janci](http://github.com/martin-janci))

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
