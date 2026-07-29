# Mandatory Test Coverage in Code Reviews — Design

**Date:** 2026-07-29
**Status:** Approved for implementation (autonomous session — decisions documented below)

## Goal

Every PR review must assess test coverage:

1. **Rate how important tests are for the PR** (per-PR value, based on what the PR changes).
2. **Exempt non-behavioral PRs** — comment-only, docs, formatting, and similar changes require no tests.
3. **Flag missing tests as high/critical findings** at the exact location where coverage is missing.
4. **Guide the developer** — every missing-test finding tells the developer *which* tests to write (concrete cases, edge conditions).
5. **Debate flow** — when the PR author replies to a test finding claiming a test is not required, the bot evaluates the justification: if the test is a must-have, it pushes back with arguments; if the author is right, it concedes, resolves the thread, and remembers the exemption.

## Approaches Considered

| Approach | Verdict |
|----------|---------|
| **A. Prompt + schema extension; missing tests as first-class findings; webhook debate module** | **Chosen** — reuses the entire existing pipeline (inline comments, blocking→verdict, resolution tracking, thread resolution) |
| B. Deterministic test detection in diff-parser code | Rejected — cannot judge importance, exemptions, or which tests to suggest; heavy heuristics for little value (the model already sees the diff) |
| C. Separate post-review "test audit" Claude call | Rejected — doubles cost/latency; findings outside the main review cannot cleanly drive the verdict |
| Debate via full re-review on reply | Rejected — expensive, slow, cannot reply in-thread |

## Design

### 1. Severity mapping

"High critical" maps to this codebase's Conventional Comments vocabulary:

- Missing test where importance is at/above the blocking threshold → `severity: "issue"`, `blocking: true` → forces `REQUEST_CHANGES` (existing verdict rule).
- Importance `medium` → non-blocking `suggestion`. Importance `low`/`none` → no finding.
- New per-PR value: `testCoverage.importance`: `none | low | medium | high | critical`.

### 2. Structured output extension (`StructuredReview`)

```ts
type TestImportance = "none" | "low" | "medium" | "high" | "critical";

interface TestCoverage {
  importance: TestImportance;  // how important tests are for THIS PR ("none" = exempt)
  rationale: string;           // one-line why (or why exempt)
  testsIncluded: boolean;      // PR already adds/updates tests
  suggestedTests?: string[];   // concrete tests the developer should add
}
```

`ReviewFinding` gains `testRelated?: boolean` (mirrors `securityRelated`). Missing-test findings ride the existing pipeline: inline placement via diff-parser snapping, confidence filtering, re-review `resolutions` tracking, thread auto-resolution, autofix eligibility.

### 3. Review prompt (skill.md)

New mandatory "Test Coverage" section:

- **Importance rubric**: critical (auth/payments/data-integrity logic, bug fixes needing regression tests), high (new features, branching logic, public API changes, state machines, concurrency), medium (behavior-preserving refactors, partial existing coverage), low (logging, trivial wiring), none (exempt).
- **Exemptions**: comments-only, docs, formatting/whitespace, pure renames, lockfiles/generated files, dependency bumps without code changes, CI config, test-only PRs.
- **Repo without any test infrastructure**: cap importance at `medium` (non-blocking suggestion) — nudge without noise; note it in the rationale.
- **Codebase access**: use Glob/Grep to discover the repo's test conventions and check whether claimed coverage exists.
- **Finding body contract**: why the test is needed + `Suggested tests:` bullet list of concrete cases (scenario, input, expected outcome, edge cases).

### 4. Rendering (formatter.ts)

- Review body: "🧪 Test Coverage" section after PR Overview — importance badge (⚪🟢🟡🟠🔴), tests-included status, rationale, suggested tests as a `- [ ]` checklist.
- Inline comments: 🧪 marker for `testRelated` findings + invisible marker `<!-- claude-review:test-finding -->` (drives debate detection).

### 5. Debate flow (webhook + features/test-debate.ts)

New `pull_request_review_comment` (action `created`) handling:

1. **Guards**: ignore bot users, ignore bodies containing our markers (self-loop prevention), require `in_reply_to_id`, per-thread in-flight lock, skip if exemption already recorded for that path+line.
2. **Detection**: fetch the thread root comment; it must contain `<!-- claude-review:test-finding -->`.
3. **Round cap**: count our replies (`<!-- claude-review:test-debate -->`) in the thread; stop after `maxRounds`.
4. **Judgment**: one-shot Claude CLI call (pattern: autofix) with the original finding, full thread history, the diff hunk, and — when codebase access is on — a read-only worktree (`Read,Grep,Glob`) so it can *verify* author claims ("covered by integration tests" → Grep for them). Output JSON: `{ decision: "concede" | "hold", reply, confidence }`.
   - Default stance: the finding existed for a reason — concede only for genuinely valid justifications (coverage exists elsewhere — verified; truly non-behavioral; dev-only tooling; framework-guaranteed behavior).
   - Push back concretely: name the risk scenario and restate the smallest test that would cover it. Stay respectful and non-dogmatic.
5. **Concede** → post acknowledging reply, resolve the thread (existing GraphQL mutation), persist `{path, line, reason, concededAt}` into `PRState.testExemptions` (optional field — no state migration needed). Future reviews receive exemptions in the prompt and must not re-flag unless the code materially changed (treat as `wont_fix`).
6. **Hold** → post reasoned counter-argument; finding stays open, so existing resolution tracking keeps the verdict at `REQUEST_CHANGES` on re-reviews.
7. Polling-only deployments never receive the event — feature is inert there (documented).

### 6. Configuration

```yaml
review:
  requireTests: true              # mandatory test coverage assessment (this feature's core)
  testBlockingImportance: high    # importance at/above which missing tests are blocking issues

features:
  testDebate:
    enabled: true                 # respond to author replies on test findings (webhook mode)
    maxRounds: 2                  # max bot replies per thread
    timeoutMs: 120000
```

Deviation note: `testDebate` defaults **enabled** (features are usually opt-in) because the user explicitly requested mandatory behavior; it is inert without webhook mode and non-fatal on errors like all features.

### 7. GitHub API additions (github.ts)

- `getReviewComment(owner, repo, commentId)` — GET `/pulls/comments/{id}`
- `listReviewCommentReplies(owner, repo, prNumber, rootId)` — GET `/pulls/{n}/comments` (paginated), filtered by `in_reply_to_id`
- `replyToReviewComment(owner, repo, prNumber, commentId, body)` — POST `/pulls/{n}/comments/{id}/replies`

### 8. Files touched

| File | Change |
|------|--------|
| `.claude/skills/code-review/skill.md` | Test Coverage section + JSON schema |
| `src/types.ts` | `TestImportance`, `TestCoverage`, `testRelated`, config types, `PRState.testExemptions` |
| `src/reviewer/claude.ts` | Schema constant, validation, prompt wiring (threshold + exemptions) |
| `src/reviewer/formatter.ts` | Markers, 🧪 section, inline marker |
| `src/reviewer/reviewer.ts` | Pass config + exemptions into `reviewDiff` |
| `src/reviewer/github.ts` | Three review-comment helpers |
| `src/features/test-debate.ts` | **New** — debate judgment via Claude CLI |
| `src/webhook/server.ts` | `pull_request_review_comment` handling + debate orchestration |
| `src/config.ts` | Defaults + validation |
| `config.yaml` | Documentation |
| `CLAUDE.md` | Repo map + feature row |

### Error handling

Debate is non-fatal end-to-end (feature convention): every failure is logged and swallowed; no review-pipeline state is touched on failure. Claude output parse failure → no reply posted (silence beats a broken reply). Thread-resolution failure after a concede reply → logged, exemption still recorded (the prompt-side exemption is what prevents re-flagging).

### Testing / verification

Project has no test framework (per CLAUDE.md constraints): verification is `npm run build` (strict TS), plus manual reasoning over state transitions and webhook response ordering (202 before async work — matches existing convention).
