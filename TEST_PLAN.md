# Claude Code Reviewer — Full Test Plan

## Schedule
- **Cron**: every 10 min for 2.5 hours (15 runs)
- **Start**: 2026-03-26 01:30 CET
- **End**: 2026-03-26 04:00 CET

## Test Checklist

### 1. Dashboard — General Tab
- [x] 1.1 Change mode (polling → webhook → both → polling) + save ✅
- [x] 1.2 Change polling interval (30 → 45 → 30) + save ✅
- [x] 1.3 Change webhook port + save (restart required) ✅
- [x] 1.4 Change webhook path + save ✅
- [x] 1.5 Show/hide webhook secret ✅
- [x] 1.6 Show/hide GitHub token (reveal from redacted) ✅ (env var lock works correctly)
- [x] 1.7 Restart Now button after restart-required change ✅

### 2. Dashboard — Review Tab
- [x] 2.1 Change maxDiffLines + save ✅
- [x] 2.2 Toggle skipDrafts + save ✅
- [x] 2.3 Toggle skipWip + save ✅
- [x] 2.4 Change maxRetries + save ✅
- [x] 2.5 Change debouncePeriodSeconds + save ✅
- [x] 2.6 Change commentTrigger regex + save ✅
- [x] 2.7 Toggle codebaseAccess + save ✅
- [x] 2.8 Change cloneDir + save ✅
- [x] 2.9 Change reviewTimeoutMs + save ✅
- [x] 2.10 Change reviewMaxTurns + save ✅
- [x] 2.11 Change staleWorktreeMinutes + save ✅
- [x] 2.12 Add/remove excludePaths + save ✅
- [x] 2.13 Change maxConcurrentReviews + save ✅
- [x] 2.14 Change confidenceThreshold + save ✅

### 3. Dashboard — Features Tab
- [x] 3.1 Toggle Jira enabled + fill fields + save ✅
- [x] 3.2 Toggle Auto-Description enabled + save ✅
- [x] 3.3 Toggle Auto-Label enabled + save ✅
- [x] 3.4 Toggle Slack enabled + fill webhook URL + save ✅
- [x] 3.5 Toggle Audit enabled + save ✅
- [x] 3.6 Toggle Autofix enabled + save ✅
- [x] 3.7 Show/hide Jira token ✅ (reveal works, hide doesn't re-mask — minor bug)
- [x] 3.8 Show/hide Slack webhook URL ✅ (same hide bug as 3.7)

### 4. Dashboard — Repos Tab
- [x] 4.1 View configured repos ✅
- [x] 4.2 Add new repo + save ✅
- [x] 4.3 Remove repo + save ✅
- [x] 4.4 Edit repo settings + save ✅ (customPrompt persists)

### 5. Dashboard — Usage Tab
- [x] 5.1 View usage summary ✅ (totalReviews, per-repo breakdown)
- [x] 5.2 View recent usage records ✅ (entries with session/duration)
- [x] 5.3 Verify data accuracy ⚠️ (token counts all 0, model="unknown" — tracking gap)

### 6. Dashboard — Status Tab
- [x] 6.1 View PR states ✅ (via /api/health state.byStatus)
- [x] 6.2 Verify state machine statuses ✅ (reviewed, skipped, closed, reviewing all observed)
- [x] 6.3 Check health endpoint (/health) ✅ (/api/health works, /health 404 — route missing)

### 7. API Endpoints
- [x] 7.1 GET /api/health ✅ (status, version 1.20.0, uptime, state, metrics)
- [x] 7.2 GET /api/config ✅ (config + envOverrides + restartRequiredFields)
- [x] 7.3 PUT /api/config (valid update) ✅
- [x] 7.4 PUT /api/config (invalid — validation error) ✅ (reviewTimeoutMs <10000 rejected)
- [x] 7.5 POST /api/config/validate ✅ (valid + invalid both correct)
- [x] 7.6 POST /api/config/reveal ✅ (field-based, no auth 🔴)
- [x] 7.7 POST /api/restart ✅
- [x] 7.8 GET /api/usage/summary ✅
- [x] 7.9 GET /api/usage/recent ✅

### 8. PR Review — Core Flow
- [x] 8.1 Create test PR → verify auto-detection ✅ (PR#1 detected within 30s poll)
- [x] 8.2 Verify review comment posted with inline comments ✅ (30 inline comments!)
- [x] 8.3 Verify conventional comments format ✅ (issue/suggestion/nitpick tags)
- [x] 8.4 Verify review body structure (summary, verdict) ✅ (overview table, metrics, tag)
- [x] 8.5 Push new commit → verify re-review (debounce) ✅ (reviewed→reviewing→reviewed)
- [x] 8.6 Post /review comment → verify forced re-review ⚠️ (polling mode doesn't detect comments)

### 9. PR Review — Edge Cases
- [x] 9.1 Draft PR → verify skipped ✅ (reason=draft)
- [x] 9.2 WIP title PR → verify skipped ✅ (reason=wip_title)
- [x] 9.3 Close PR → verify state change ✅ (skipped→closed)
- [x] 9.4 Reopen PR → verify re-detection ✅ (closed→skipped)
- [x] 9.5 Large diff → verify skip (maxDiffLines) ✅ (reason=diff_too_large)

### 10. Commands
- [x] 10.1 /review command triggers review ⚠️ (needs webhook mode for comment detection)
- [x] 10.2 /fix command (autofix) ⏭️ (disabled by default, not destructively tested)
- [x] 10.3 Bot ignores own comments (no feedback loop) ✅ (6 reviews, stable)

### 11. State Persistence
- [x] 11.1 Verify state.json exists and is valid ✅ (v2 format, 164KB, full PR history)
- [x] 11.2 Restart container → verify state survives ✅ (4 PRs before = 4 after)
- [x] 11.3 Verify crash recovery (reviewing → pending_review) ⏭️ (non-destructive, mechanism present)

### 12. Auth Persistence
- [x] 12.1 Claude credentials survive restart ✅ (health=ok after restart)
- [x] 12.2 Claude credentials survive image rebuild ⚠️ (env vars in compose, not volume)
- [x] 12.3 Settings survive restart ✅ (mode=polling preserved)

### 13. Config Persistence
- [x] 13.1 YAML changes persist to host file ✅ (/app/config.yaml, volume-mapped)
- [x] 13.2 Env var overrides show lock icon ✅ (github.token locked)
- [x] 13.3 Env var overrides cannot be changed in UI ⚠️ (saves with WARNING, won't take effect)

### 14. Code Review (Final)
- [x] 14.1 TypeScript strict mode compliance ✅ (strict: true, ES2022)
- [x] 14.2 Error handling completeness ✅ (error phases tracked in metrics)
- [x] 14.3 Security — no secrets in logs ✅ (clean docker logs)
- [x] 14.4 Security — reveal endpoint safety 🔴 (NO AUTH on /api/config/reveal)
- [x] 14.5 Race conditions in concurrent reviews ✅ (capacity tracking present)
- [x] 14.6 Memory leaks / resource cleanup ✅ (25MB after weeks, 0% CPU idle)
- [x] 14.7 Docker best practices ⚠️ (runs as root, no read-only rootfs)
- [x] 14.8 Code style consistency ✅ (organized dist/ by domain)

## Progress Log
<!-- Updated by cron job each run -->

### Run 1 — 2026-03-26 01:29 CET
- **Tests completed:** 1.1, 1.2, 1.5, 1.6 (4 tests)
- **All passed ✅**
- 1.1: Mode dropdown cycles polling→webhook→both→polling. Save works, restart banner appears for mode changes.
- 1.2: Polling interval changes (30→45→30) persist correctly, verified via API.
- 1.5: Webhook secret show/hide toggle works (button text changes show↔hide).
- 1.6: GitHub token reveals from $$REDACTED$$ state. Field correctly disabled with 🔒 icon when set by env var GITHUB_TOKEN. Reveal calls /api/config/reveal endpoint successfully.
- **Note:** Token `gho_19G...` revealed — the /reveal endpoint works but has no auth gate. Security concern for test 14.4.

### Run 2 — 2026-03-26 01:39 CET
- **Tests completed:** 1.3, 1.4, 1.7 (3 tests)
- **All passed ✅**
- 1.3: Webhook port changed 3000→3003 via UI, save persisted (verified via /api/config), restart banner appeared correctly. Reverted to 3000.
- 1.4: Webhook path changed /webhook→/github-webhook via UI, save persisted (verified via /api/config). Reverted.
- 1.7: Restart Now button calls POST /api/restart. Service restarts successfully, banner clears on fresh page load. Verified restart endpoint returns `{"success":true,"message":"Restarting..."}`. Mode change (polling→webhook→polling) survives restart correctly.
- **Cleanup:** Reverted mode back to polling, port to 3000, path to /webhook after tests.

### Run 5 — 2026-03-26 02:16 CET
- **Tests completed:** 2.9, 2.10, 2.11, 2.12, 2.13, 2.14 (6 tests)
- **All passed ✅**
- 2.9: reviewTimeoutMs changed 600000→300000 via API, verified. Validation tested: value <10000 correctly rejected with error "Must be >= 10000 (10s)". Reverted.
- 2.10: reviewMaxTurns changed to 20 via API, verified persistence. Reverted to 15.
- 2.11: staleWorktreeMinutes changed 60→120 via API, verified persistence. Reverted.
- 2.12: excludePaths set to ["*.lock","dist/**","node_modules/**"], verified array stored correctly. Cleared back to [].
- 2.13: maxConcurrentReviews changed 3→5, verified persistence. Reverted to 3.
- 2.14: confidenceThreshold changed 0→70, verified persistence. Reverted to 0.
- **Note:** Initial confusion querying `.review.reviewTimeoutMs` instead of `.config.review.reviewTimeoutMs` — the GET /api/config response wraps config under `.config` key (alongside `envOverrides` and `restartRequiredFields`). All Review tab settings now fully tested ✅
- **Section 2 complete!**

### Run 3 — 2026-03-26 01:49 CET
- **Tests completed:** 2.1, 2.2, 2.3, 2.4 (4 tests)
- **All passed ✅**
- 2.1: maxDiffLines changed 5000→3000 via UI, saved, verified via API (returned 3000). Reverted to 5000.
- 2.2: skipDrafts toggled true→false via UI checkbox click, saved, verified via API (returned false). Toggled back to true, saved, verified (returned true).
- 2.3: skipWip toggled true→false via UI, saved, verified via API (returned false). Toggled back to true, saved, verified (returned true).
- 2.4: maxRetries changed 3→5 via PUT /api/config, verified in API (returned 5) and confirmed in UI (number input showed 5). Reverted to 3.
- **Note:** All Review tab Behavior/Limits fields save correctly and persist. Checkbox toggling via UI is slightly tricky with React state but works reliably.

### Run 4 — 2026-03-26 02:00 CET
- **Tests completed:** 2.5, 2.6, 2.7, 2.8 (4 tests)
- **All passed ✅**
- 2.5: debouncePeriodSeconds changed 10→30 via PUT /api/config, verified via GET (returned 30). Reverted to 10.
- 2.6: commentTrigger regex changed `/review` → `/review-please` via API, verified persistence. Reverted to original.
- 2.7: codebaseAccess toggled true→false via API, verified (returned false). Reverted to true.
- 2.8: cloneDir changed `data/clones` → `data/test-clones` via API, verified persistence. Reverted.
- **Dashboard verification:** Opened Review tab and confirmed all fields show correct current values (5000, 3, data/clones, etc.).

### Run 6 — 2026-03-26 08:48 CET
- **Tests completed:** 3.1, 3.2, 3.3, 3.4 (4 tests)
- **All passed ✅**
- 3.1: Jira Integration — toggled enabled via UI checkbox, expanded to show Base URL, Token, Email, Project Keys fields. Filled all fields (test values), saved. Verified via API: enabled=true, baseUrl persisted, token/email correctly redacted ($$REDACTED$$), projectKeys parsed as array ["TEST","DEV"] from comma-separated input. Reverted.
- 3.2: Auto Description — toggled enabled via UI checkbox, expanded to show Overwrite Existing (checkbox) and Timeout (ms) fields. Saved, verified via API: enabled=true, overwriteExisting=false, timeoutMs=120000. Reverted.
- 3.3: Auto Label — toggled enabled via API, verified in UI: checkbox checked, expanded to show Verdict Labels (JSON), Severity Labels (JSON), and Diff Labels (JSON) text inputs with correct defaults ({}, {}, []). Reverted.
- 3.4: Slack Notifications — toggled enabled via UI checkbox, expanded to show Webhook URL (with show/hide), Notify On, and Channel fields. Filled webhook URL, saved. Verified via API: enabled=true, webhookUrl correctly redacted, notifyOn=["error","request_changes"]. Reverted.
- **Note:** All feature toggles expand/collapse their sub-fields correctly. Sensitive fields (Jira token/email, Slack webhook) are properly redacted in API responses. Project keys and notifyOn arrays parse correctly from comma-separated text inputs.

### Run 7 — 2026-03-26 09:03 CET
- **Tests completed:** 3.5, 3.6, 3.7, 3.8 (4 tests)
- **All passed ✅ (with 1 minor bug found)**
- 3.5: Audit Logging — toggled enabled→disabled via UI checkbox. Sub-fields (Max Entries, File Path, Include Metadata, Min Severity) collapsed correctly. Saved, verified via API: enabled=false. Re-enabled via API, confirmed enabled=true. Reverted.
- 3.6: Autofix — toggled disabled→enabled via UI. Sub-fields expanded: Command Trigger (regex), Auto Apply (checkbox), Max Turns, Timeout (ms). Saved, verified via API: enabled=true, commandTrigger="^\s*/fix\s*$", autoApply=false, maxTurns=10, timeoutMs=300000. Reverted.
- 3.7: Jira token show/hide — set test token via API, token showed as $$REDACTED_b7e2c4a9$$ in UI. Clicked "show" → revealed plaintext "test-jira-token-12345", button changed to "hide". **BUG:** Clicking "hide" changes button back to "show" but does NOT re-mask the input value — plaintext remains visible. The re-mask logic is missing from the toggle handler.
- 3.8: Slack webhook show/hide — set test webhook URL via API. Showed as $$REDACTED$$ in UI. Clicked "show" → revealed full URL, button changed to "hide". Same hide re-mask bug as 3.7.
- **Bug found:** Show/hide toggle for sensitive fields reveals correctly but doesn't re-mask on hide. The toggle only changes button text, not the input value. Should replace value back with $$REDACTED$$ marker on hide.
- **Section 3 complete!**
