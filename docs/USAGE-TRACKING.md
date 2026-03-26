# Usage Tracking

Claude Code Reviewer tracks token usage, cost, model name, and session metrics for every review. This data powers the dashboard's usage view and helps monitor API spend.

## How It Works

The Claude CLI is invoked with `--output-format json`, which wraps the review output in a JSON envelope containing usage metadata. The reviewer extracts this envelope after each review and stores the metrics.

```
claude -p --output-format json --dangerously-skip-permissions < prompt.txt
```

The JSON envelope includes token counts, cost, timing, session ID, and model information.

## JSON Response Formats

The Claude CLI has shipped two different JSON output formats. The reviewer handles both transparently.

### Single Object Format (CLI v2.1.84+)

Older CLI versions return a single JSON object — the result item directly:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "Review text here",
  "session_id": "abc-123",
  "total_cost_usd": 0.05,
  "num_turns": 3,
  "duration_ms": 5000,
  "duration_api_ms": 4000,
  "usage": {
    "input_tokens": 100,
    "output_tokens": 500,
    "cache_creation_input_tokens": 1000,
    "cache_read_input_tokens": 5000
  },
  "modelUsage": {
    "claude-sonnet-4-6": {
      "inputTokens": 100,
      "outputTokens": 500,
      "cacheReadInputTokens": 5000,
      "cacheCreationInputTokens": 1000,
      "costUSD": 0.05
    }
  }
}
```

### Array Format (Newer CLI)

Newer CLI versions return an array of message objects. The first item is a `system` object with the model name, followed by assistant messages, and ending with a `result` item:

```json
[
  {"type": "system", "model": "claude-opus-4-5-20251101"},
  {"type": "assistant", "message": {"role": "assistant"}},
  {
    "type": "result",
    "subtype": "success",
    "result": "Review text here",
    "session_id": "def-456",
    "total_cost_usd": 0.08,
    "usage": {
      "input_tokens": 200,
      "output_tokens": 800,
      "cache_creation_input_tokens": 2000,
      "cache_read_input_tokens": 10000
    }
  }
]
```

### How Both Formats Are Handled

The parsing logic in `src/reviewer/claude.ts` normalizes both formats:

1. Parse the stdout as JSON
2. If the result is an array, find the item with `type: "result"` (envelope)
3. If the result is a single object, use it directly as the envelope
4. For the array format, merge the `model` field from the `system` item into the envelope
5. Extract usage via `extractUsage(envelope)`

## Fields Captured

The `extractUsage()` function maps the snake_case CLI fields to camelCase `ClaudeUsage`:

| CLI Field (snake_case) | ClaudeUsage Field (camelCase) | Description |
|------------------------|-------------------------------|-------------|
| `usage.input_tokens` | `inputTokens` | Non-cached input tokens |
| `usage.output_tokens` | `outputTokens` | Generated output tokens |
| `usage.cache_creation_input_tokens` | `cacheCreationInputTokens` | Tokens written to prompt cache |
| `usage.cache_read_input_tokens` | `cacheReadInputTokens` | Tokens read from prompt cache |
| `total_cost_usd` | `totalCostUsd` | Total API cost in USD |
| `model` | `model` | Model name (e.g. `claude-sonnet-4-6`) |
| `num_turns` | `numTurns` | Number of agentic turns |
| `duration_ms` | `durationMs` | Wall-clock duration |
| `duration_api_ms` | `durationApiMs` | API call duration |
| `session_id` | `sessionId` | Claude session ID for reuse |

Missing numeric fields default to `0`. Missing model defaults to `"unknown"`. If `session_id` is absent, `extractUsage()` returns `undefined` (no usage tracked).

## Model Name Extraction (`modelUsage` Fallback)

The model name is resolved in priority order:

1. **System item** (array format): `items.find(i => i.type === "system").model`
2. **Top-level `model` field** on the envelope
3. **`modelUsage` keys** (single object format): When neither of the above is available, the model is extracted from the keys of the `modelUsage` object. If multiple models are present (e.g. routing between haiku and sonnet), the model with the **most output tokens** is selected as the primary model.

Example with multi-model `modelUsage`:

```json
{
  "modelUsage": {
    "claude-haiku-4-5-20251001": {"outputTokens": 20},
    "claude-sonnet-4-6": {"outputTokens": 800}
  }
}
```

Selected model: `claude-sonnet-4-6` (800 > 20 output tokens).

## Session Reuse

### How `--resume` Works

The reviewer stores the `sessionId` from each review's usage data. On re-reviews (same PR, new commits), it passes `--resume <sessionId>` to the Claude CLI. This enables:

- **Prompt cache reuse** — the system prompt and skill file are cached, reducing input tokens on subsequent reviews
- **Conversation continuity** — Claude has context from the previous review

### Stale Session Detection and Recovery

Sessions expire after some time. When a stale session is used with `--resume`, the Claude CLI returns an error containing:

```
No conversation found with session ID: <id>
```

The reviewer detects this error string in the CLI output and automatically retries **without** the `--resume` flag, starting a fresh session. This recovery is transparent — no manual intervention needed.

## Dashboard API

### `GET /api/usage/recent`

Returns recent usage records for display in the web dashboard. Each record includes all fields from `ClaudeUsage` plus metadata about which PR was reviewed.

## Cache Hit Rate

The usage log includes a calculated cache hit rate:

```
cacheHitRate = cacheReadInputTokens / (inputTokens + cacheCreationInputTokens + cacheReadInputTokens)
```

A high cache hit rate (>80%) on re-reviews indicates prompt caching is working effectively.
