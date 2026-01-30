# Claude Code PR Reviewer

Standalone service that watches GitHub PRs and posts automated code reviews using Claude Code CLI.

## How It Works

1. Detects new/updated PRs via **polling** or **GitHub webhooks**
2. Fetches the PR diff using `gh pr diff`
3. Sends the diff to `claude -p` with a code review prompt
4. Posts (or updates) a review comment on the PR
5. Tracks reviewed SHAs to avoid duplicate reviews

## Setup

### Prerequisites

- Docker
- GitHub token with repo access (`GITHUB_TOKEN`)
- Claude Code authentication (mounted via volume)

### Configuration

Edit `config.yaml`:

```yaml
mode: polling  # "polling" | "webhook" | "both"

polling:
  intervalSeconds: 300

webhook:
  port: 3000
  secret: ""       # or WEBHOOK_SECRET env var
  path: /webhook

repos:
  - owner: martin-janci
    repo: my-project

review:
  maxDiffLines: 5000
  skipDrafts: true
  skipWip: true
```

Environment variables override config file values:
- `GITHUB_TOKEN` — GitHub access token
- `WEBHOOK_SECRET` — webhook signature secret
- `WEBHOOK_PORT` — webhook server port
- `POLLING_INTERVAL` — polling interval in seconds
- `MODE` — operating mode

### Run with Docker Compose

```bash
export GITHUB_TOKEN=ghp_xxx
docker compose up -d
```

### Run with Docker

```bash
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
  -e WEBHOOK_SECRET=secret \
  -v claude-auth:/home/node/.claude \
  -v ./config.yaml:/app/config.yaml:ro \
  -v reviewer-data:/app/data \
  -p 3000:3000 \
  claude-code-reviewer
```

## Comment Deduplication

The service uses a hidden HTML tag (`<!-- claude-code-review -->`) to identify its own comments. When a PR receives a new push, the existing review comment is updated instead of posting a duplicate.

## Review Prompt

The review skill prompt lives at `.claude/skills/code-review.md`. Edit it to customize review focus areas, severity levels, and output format.
