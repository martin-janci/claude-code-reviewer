export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Reviewer - Dashboard</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #242836;
    --border: #2e3347;
    --text: #e1e4ed;
    --text-muted: #8b90a0;
    --accent: #6c8cff;
    --accent-hover: #8aa4ff;
    --danger: #ff6b6b;
    --success: #51cf66;
    --warning: #fcc419;
    --orange: #ff922b;
    --radius: 8px;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
  }

  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .header h1 {
    font-size: 18px;
    font-weight: 600;
    flex: 1;
  }

  .header .version {
    color: var(--text-muted);
    font-size: 13px;
    font-family: var(--mono);
  }

  .tabs {
    display: flex;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 0 24px;
    gap: 0;
  }

  .tab {
    padding: 12px 20px;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
    user-select: none;
  }

  .tab:hover { color: var(--text); }
  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .content {
    max-width: 900px;
    margin: 0 auto;
    padding: 24px;
  }

  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  .section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 20px;
    overflow: hidden;
  }

  .section-header {
    padding: 14px 20px;
    font-size: 14px;
    font-weight: 600;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .section-body { padding: 20px; }

  .field {
    display: grid;
    grid-template-columns: 200px 1fr;
    align-items: start;
    gap: 8px;
    margin-bottom: 16px;
  }

  .field:last-child { margin-bottom: 0; }

  .field label {
    font-size: 13px;
    color: var(--text-muted);
    padding-top: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .field label .lock {
    color: var(--warning);
    font-size: 12px;
    cursor: help;
  }

  .field label .restart-badge {
    background: var(--orange);
    color: #000;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: 600;
  }

  input[type="text"],
  input[type="number"],
  input[type="password"],
  select,
  textarea {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 13px;
    font-family: var(--mono);
    padding: 8px 12px;
    width: 100%;
    transition: border-color 0.15s;
  }

  input:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  input:disabled, select:disabled, textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  input.error { border-color: var(--danger); }

  .error-msg {
    color: var(--danger);
    font-size: 12px;
    margin-top: 4px;
  }

  .password-wrap {
    position: relative;
  }

  .password-wrap input {
    padding-right: 40px;
  }

  .password-wrap .toggle-vis {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 13px;
    padding: 4px;
  }

  .toggle-switch {
    position: relative;
    width: 44px;
    height: 24px;
    display: inline-block;
  }

  .toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: 0.2s;
  }

  .toggle-slider:before {
    content: "";
    position: absolute;
    height: 18px;
    width: 18px;
    left: 2px;
    bottom: 2px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: 0.2s;
  }

  .toggle-switch input:checked + .toggle-slider {
    background: var(--accent);
    border-color: var(--accent);
  }

  .toggle-switch input:checked + .toggle-slider:before {
    transform: translateX(20px);
    background: #fff;
  }

  .feature-content {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .feature-content.hidden { display: none; }

  .repos-list { display: flex; flex-direction: column; gap: 8px; }

  .repo-entry {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .repo-entry input { flex: 1; }

  .btn {
    padding: 8px 16px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
    font-family: var(--font);
  }

  .btn:hover { background: var(--border); }

  .btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 500;
  }

  .btn-primary:hover { background: var(--accent-hover); }

  .btn-danger {
    color: var(--danger);
    border-color: var(--danger);
  }

  .btn-danger:hover {
    background: var(--danger);
    color: #fff;
  }

  .btn-sm {
    padding: 4px 10px;
    font-size: 12px;
  }

  .actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    padding: 20px 0 0;
  }

  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    padding: 12px 20px;
    border-radius: var(--radius);
    font-size: 14px;
    z-index: 1000;
    animation: slideIn 0.3s ease;
    max-width: 400px;
  }

  .toast.success {
    background: #1a3a2a;
    border: 1px solid var(--success);
    color: var(--success);
  }

  .toast.error {
    background: #3a1a1a;
    border: 1px solid var(--danger);
    color: var(--danger);
  }

  @keyframes slideIn {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .banner {
    background: #3a2a0a;
    border: 1px solid var(--orange);
    color: var(--orange);
    padding: 12px 20px;
    border-radius: var(--radius);
    margin-bottom: 20px;
    font-size: 14px;
    display: none;
  }

  .banner.visible { display: block; }

  .status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }

  .status-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    text-align: center;
  }

  .status-card .value {
    font-size: 28px;
    font-weight: 700;
    font-family: var(--mono);
  }

  .status-card .label {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .diff-labels-list { display: flex; flex-direction: column; gap: 8px; }

  .diff-label-entry {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .diff-label-entry input { flex: 1; }

  textarea {
    min-height: 60px;
    resize: vertical;
    font-family: var(--mono);
  }
</style>
</head>
<body>

<div class="header">
  <h1>Claude Code Reviewer</h1>
  <span class="version" id="version"></span>
</div>

<div class="tabs">
  <div class="tab active" data-tab="general">General</div>
  <div class="tab" data-tab="review">Review</div>
  <div class="tab" data-tab="features">Features</div>
  <div class="tab" data-tab="repos">Repos</div>
  <div class="tab" data-tab="usage">Usage</div>
  <div class="tab" data-tab="status">Status</div>
</div>

<div class="content">
  <div class="banner" id="restart-banner">
    Some changes require a service restart to take effect.
  </div>

  <!-- General Tab -->
  <div class="tab-panel active" id="panel-general">
    <div class="section">
      <div class="section-header">Service Mode</div>
      <div class="section-body">
        <div class="field">
          <label>Mode</label>
          <select id="cfg-mode">
            <option value="polling">Polling</option>
            <option value="webhook">Webhook</option>
            <option value="both">Both</option>
          </select>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Polling</div>
      <div class="section-body">
        <div class="field">
          <label>Interval (seconds)</label>
          <input type="number" id="cfg-polling-intervalSeconds" min="1">
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Webhook</div>
      <div class="section-body">
        <div class="field">
          <label>Port</label>
          <input type="number" id="cfg-webhook-port" min="1" max="65535">
        </div>
        <div class="field">
          <label>Path</label>
          <input type="text" id="cfg-webhook-path">
        </div>
        <div class="field">
          <label>Secret</label>
          <div class="password-wrap">
            <input type="password" id="cfg-webhook-secret">
            <button class="toggle-vis" onclick="togglePassword('cfg-webhook-secret')">show</button>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">GitHub</div>
      <div class="section-body">
        <div class="field">
          <label>Token</label>
          <div class="password-wrap">
            <input type="password" id="cfg-github-token">
            <button class="toggle-vis" onclick="togglePassword('cfg-github-token')">show</button>
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" onclick="saveConfig()">Save Changes</button>
    </div>
  </div>

  <!-- Review Tab -->
  <div class="tab-panel" id="panel-review">
    <div class="section">
      <div class="section-header">Behavior</div>
      <div class="section-body">
        <div class="field">
          <label>Skip Drafts</label>
          <label class="toggle-switch">
            <input type="checkbox" id="cfg-review-skipDrafts">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="field">
          <label>Skip WIP</label>
          <label class="toggle-switch">
            <input type="checkbox" id="cfg-review-skipWip">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="field">
          <label>Dry Run</label>
          <label class="toggle-switch">
            <input type="checkbox" id="cfg-review-dryRun">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="field">
          <label>Codebase Access</label>
          <label class="toggle-switch">
            <input type="checkbox" id="cfg-review-codebaseAccess">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Limits</div>
      <div class="section-body">
        <div class="field">
          <label>Max Diff Lines</label>
          <input type="number" id="cfg-review-maxDiffLines" min="1">
        </div>
        <div class="field">
          <label>Max Retries</label>
          <input type="number" id="cfg-review-maxRetries" min="0">
        </div>
        <div class="field">
          <label>Max Concurrent Reviews</label>
          <input type="number" id="cfg-review-maxConcurrentReviews" min="1" max="10">
        </div>
        <div class="field">
          <label>Confidence Threshold</label>
          <input type="number" id="cfg-review-confidenceThreshold" min="0" max="100">
        </div>
        <div class="field">
          <label>Max Review History</label>
          <input type="number" id="cfg-review-maxReviewHistory" min="1">
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Timeouts</div>
      <div class="section-body">
        <div class="field">
          <label>Review Timeout (ms)</label>
          <input type="number" id="cfg-review-reviewTimeoutMs" min="10000">
        </div>
        <div class="field">
          <label>Clone Timeout (ms)</label>
          <input type="number" id="cfg-review-cloneTimeoutMs" min="5000">
        </div>
        <div class="field">
          <label>Review Max Turns</label>
          <input type="number" id="cfg-review-reviewMaxTurns" min="1">
        </div>
        <div class="field">
          <label>Debounce Period (s)</label>
          <input type="number" id="cfg-review-debouncePeriodSeconds" min="0">
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Paths &amp; Patterns</div>
      <div class="section-body">
        <div class="field">
          <label>Clone Directory</label>
          <input type="text" id="cfg-review-cloneDir">
        </div>
        <div class="field">
          <label>Comment Tag</label>
          <input type="text" id="cfg-review-commentTag">
        </div>
        <div class="field">
          <label>Comment Trigger (regex)</label>
          <input type="text" id="cfg-review-commentTrigger">
        </div>
        <div class="field">
          <label>Exclude Paths</label>
          <textarea id="cfg-review-excludePaths" placeholder="One glob pattern per line"></textarea>
        </div>
        <div class="field">
          <label>Security Paths</label>
          <textarea id="cfg-review-securityPaths" placeholder="One glob pattern per line"></textarea>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Cleanup</div>
      <div class="section-body">
        <div class="field">
          <label>Stale Closed Days</label>
          <input type="number" id="cfg-review-staleClosedDays" min="1">
        </div>
        <div class="field">
          <label>Stale Error Days</label>
          <input type="number" id="cfg-review-staleErrorDays" min="1">
        </div>
        <div class="field">
          <label>Stale Worktree (min)</label>
          <input type="number" id="cfg-review-staleWorktreeMinutes" min="1">
        </div>
        <div class="field">
          <label>Comment Verify (min)</label>
          <input type="number" id="cfg-review-commentVerifyIntervalMinutes" min="1">
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" onclick="saveConfig()">Save Changes</button>
    </div>
  </div>

  <!-- Features Tab -->
  <div class="tab-panel" id="panel-features">
    <!-- Jira -->
    <div class="section">
      <div class="section-header">
        Jira Integration
        <label class="toggle-switch" style="margin-left:auto">
          <input type="checkbox" id="cfg-features-jira-enabled" onchange="toggleFeature('jira')">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="section-body">
        <div id="feature-jira" class="feature-content hidden">
          <div class="field">
            <label>Base URL</label>
            <input type="text" id="cfg-features-jira-baseUrl" placeholder="https://company.atlassian.net">
          </div>
          <div class="field">
            <label>Token</label>
            <div class="password-wrap">
              <input type="password" id="cfg-features-jira-token">
              <button class="toggle-vis" onclick="togglePassword('cfg-features-jira-token')">show</button>
            </div>
          </div>
          <div class="field">
            <label>Email</label>
            <div class="password-wrap">
              <input type="password" id="cfg-features-jira-email">
              <button class="toggle-vis" onclick="togglePassword('cfg-features-jira-email')">show</button>
            </div>
          </div>
          <div class="field">
            <label>Project Keys</label>
            <input type="text" id="cfg-features-jira-projectKeys" placeholder="PROJ, ENG (comma-separated)">
          </div>
        </div>
      </div>
    </div>

    <!-- Auto Description -->
    <div class="section">
      <div class="section-header">
        Auto Description
        <label class="toggle-switch" style="margin-left:auto">
          <input type="checkbox" id="cfg-features-autoDescription-enabled" onchange="toggleFeature('autoDescription')">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="section-body">
        <div id="feature-autoDescription" class="feature-content hidden">
          <div class="field">
            <label>Overwrite Existing</label>
            <label class="toggle-switch">
              <input type="checkbox" id="cfg-features-autoDescription-overwriteExisting">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="field">
            <label>Timeout (ms)</label>
            <input type="number" id="cfg-features-autoDescription-timeoutMs" min="5000">
          </div>
        </div>
      </div>
    </div>

    <!-- Auto Label -->
    <div class="section">
      <div class="section-header">
        Auto Label
        <label class="toggle-switch" style="margin-left:auto">
          <input type="checkbox" id="cfg-features-autoLabel-enabled" onchange="toggleFeature('autoLabel')">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="section-body">
        <div id="feature-autoLabel" class="feature-content hidden">
          <div class="field">
            <label>Verdict Labels (JSON)</label>
            <textarea id="cfg-features-autoLabel-verdictLabels" placeholder='{"APPROVE": ["approved"]}'></textarea>
          </div>
          <div class="field">
            <label>Severity Labels (JSON)</label>
            <textarea id="cfg-features-autoLabel-severityLabels" placeholder='{"issue": ["has-issues"]}'></textarea>
          </div>
          <div class="field">
            <label>Diff Labels (JSON)</label>
            <textarea id="cfg-features-autoLabel-diffLabels" placeholder='[{"pattern":"src/api/**","label":"api"}]'></textarea>
          </div>
        </div>
      </div>
    </div>

    <!-- Slack -->
    <div class="section">
      <div class="section-header">
        Slack Notifications
        <label class="toggle-switch" style="margin-left:auto">
          <input type="checkbox" id="cfg-features-slack-enabled" onchange="toggleFeature('slack')">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="section-body">
        <div id="feature-slack" class="feature-content hidden">
          <div class="field">
            <label>Webhook URL</label>
            <div class="password-wrap">
              <input type="password" id="cfg-features-slack-webhookUrl">
              <button class="toggle-vis" onclick="togglePassword('cfg-features-slack-webhookUrl')">show</button>
            </div>
          </div>
          <div class="field">
            <label>Notify On</label>
            <input type="text" id="cfg-features-slack-notifyOn" placeholder="error, request_changes (comma-separated)">
          </div>
          <div class="field">
            <label>Channel</label>
            <input type="text" id="cfg-features-slack-channel" placeholder="Optional override">
          </div>
        </div>
      </div>
    </div>

    <!-- Audit -->
    <div class="section">
      <div class="section-header">
        Audit Logging
        <label class="toggle-switch" style="margin-left:auto">
          <input type="checkbox" id="cfg-features-audit-enabled" onchange="toggleFeature('audit')">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="section-body">
        <div id="feature-audit" class="feature-content hidden">
          <div class="field">
            <label>Max Entries</label>
            <input type="number" id="cfg-features-audit-maxEntries" min="100">
          </div>
          <div class="field">
            <label>File Path</label>
            <input type="text" id="cfg-features-audit-filePath">
          </div>
          <div class="field">
            <label>Include Metadata</label>
            <label class="toggle-switch">
              <input type="checkbox" id="cfg-features-audit-includeMetadata">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="field">
            <label>Min Severity</label>
            <select id="cfg-features-audit-minSeverity">
              <option value="info">info</option>
              <option value="warning">warning</option>
              <option value="error">error</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- Autofix -->
    <div class="section">
      <div class="section-header">
        Autofix
        <label class="toggle-switch" style="margin-left:auto">
          <input type="checkbox" id="cfg-features-autofix-enabled" onchange="toggleFeature('autofix')">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="section-body">
        <div id="feature-autofix" class="feature-content hidden">
          <div class="field">
            <label>Command Trigger (regex)</label>
            <input type="text" id="cfg-features-autofix-commandTrigger">
          </div>
          <div class="field">
            <label>Auto Apply</label>
            <label class="toggle-switch">
              <input type="checkbox" id="cfg-features-autofix-autoApply">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="field">
            <label>Max Turns</label>
            <input type="number" id="cfg-features-autofix-maxTurns" min="1">
          </div>
          <div class="field">
            <label>Timeout (ms)</label>
            <input type="number" id="cfg-features-autofix-timeoutMs" min="10000">
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" onclick="saveConfig()">Save Changes</button>
    </div>
  </div>

  <!-- Repos Tab -->
  <div class="tab-panel" id="panel-repos">
    <div class="section">
      <div class="section-header">Tracked Repositories</div>
      <div class="section-body">
        <div class="repos-list" id="repos-list"></div>
        <div style="margin-top: 12px">
          <button class="btn btn-sm" onclick="addRepo()">+ Add Repository</button>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" onclick="saveConfig()">Save Changes</button>
    </div>
  </div>

  <!-- Usage Tab -->
  <div class="tab-panel" id="panel-usage">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
      <span style="color:var(--text-muted);font-size:13px">Time range:</span>
      <select id="usage-range" style="width:auto;padding:6px 12px" onchange="loadUsage()">
        <option value="7">7 days</option>
        <option value="30" selected>30 days</option>
        <option value="90">90 days</option>
        <option value="365">1 year</option>
      </select>
      <button class="btn btn-sm" onclick="loadUsage()" style="margin-left:auto">Refresh</button>
    </div>

    <div class="status-grid" id="usage-summary-grid"></div>

    <div class="section">
      <div class="section-header">Usage by Repository</div>
      <div class="section-body" style="padding:0;overflow-x:auto">
        <table id="usage-repo-table" style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid var(--border);text-align:left">
              <th style="padding:10px 16px;color:var(--text-muted);font-weight:500">Repository</th>
              <th style="padding:10px 12px;color:var(--text-muted);font-weight:500;text-align:right">Reviews</th>
              <th style="padding:10px 12px;color:var(--text-muted);font-weight:500;text-align:right">Input Tokens</th>
              <th style="padding:10px 12px;color:var(--text-muted);font-weight:500;text-align:right">Output Tokens</th>
              <th style="padding:10px 12px;color:var(--text-muted);font-weight:500">Cache Hit Rate</th>
              <th style="padding:10px 12px;color:var(--text-muted);font-weight:500;text-align:right">Total Cost</th>
              <th style="padding:10px 16px;color:var(--text-muted);font-weight:500;text-align:right">Avg Cost</th>
            </tr>
          </thead>
          <tbody id="usage-repo-tbody"></tbody>
        </table>
        <div id="usage-repo-empty" style="padding:24px;text-align:center;color:var(--text-muted);display:none">No usage data yet</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Recent Invocations</div>
      <div class="section-body" style="padding:0;overflow-x:auto">
        <table id="usage-recent-table" style="width:100%;border-collapse:collapse;font-size:12px;font-family:var(--mono)">
          <thead>
            <tr style="border-bottom:1px solid var(--border);text-align:left">
              <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Time</th>
              <th style="padding:8px 12px;color:var(--text-muted);font-weight:500">Repo</th>
              <th style="padding:8px 8px;color:var(--text-muted);font-weight:500;text-align:right">PR</th>
              <th style="padding:8px 8px;color:var(--text-muted);font-weight:500">Source</th>
              <th style="padding:8px 8px;color:var(--text-muted);font-weight:500;text-align:right">In</th>
              <th style="padding:8px 8px;color:var(--text-muted);font-weight:500;text-align:right">Out</th>
              <th style="padding:8px 8px;color:var(--text-muted);font-weight:500;text-align:right">Cache</th>
              <th style="padding:8px 12px;color:var(--text-muted);font-weight:500;text-align:right">Cost</th>
            </tr>
          </thead>
          <tbody id="usage-recent-tbody"></tbody>
        </table>
        <div id="usage-recent-empty" style="padding:24px;text-align:center;color:var(--text-muted);display:none">No usage data yet</div>
      </div>
    </div>
  </div>

  <!-- Status Tab -->
  <div class="tab-panel" id="panel-status">
    <div id="rate-limit-banner" style="display:none;padding:14px 20px;border-radius:var(--radius);margin-bottom:20px;font-size:14px;font-weight:500;display:none">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span id="rate-limit-banner-text"></span>
        <button class="btn btn-sm" onclick="resumeRateLimit()" id="rate-limit-resume-btn">Resume Now</button>
      </div>
    </div>
    <div class="status-grid" id="status-grid"></div>
    <div class="section" id="rate-limit-section" style="display:none">
      <div class="section-header">Rate Limit Guard</div>
      <div class="section-body">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px">
          <div><span style="color:var(--text-muted);font-size:12px">State</span><br><strong id="rl-state">active</strong></div>
          <div><span style="color:var(--text-muted);font-size:12px">Queue Depth</span><br><strong id="rl-queue">0</strong></div>
          <div><span style="color:var(--text-muted);font-size:12px">Total Pauses</span><br><strong id="rl-pauses">0</strong></div>
        </div>
        <div id="rl-events-wrap" style="display:none">
          <div style="font-size:13px;font-weight:500;margin-bottom:8px;color:var(--text-muted)">Event History</div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px;font-family:var(--mono)">
              <thead>
                <tr style="border-bottom:1px solid var(--border);text-align:left">
                  <th style="padding:6px 8px;color:var(--text-muted);font-weight:500">Time</th>
                  <th style="padding:6px 8px;color:var(--text-muted);font-weight:500">Kind</th>
                  <th style="padding:6px 8px;color:var(--text-muted);font-weight:500;text-align:right">Cooldown</th>
                  <th style="padding:6px 8px;color:var(--text-muted);font-weight:500">Resumed At</th>
                  <th style="padding:6px 8px;color:var(--text-muted);font-weight:500">Resumed By</th>
                </tr>
              </thead>
              <tbody id="rl-events-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    <div class="section">
      <div class="section-header">Claude CLI</div>
      <div class="section-body">
        <div class="field">
          <label>Version</label>
          <div style="display:flex;gap:8px;align-items:center">
            <code id="claude-version" style="font-family:var(--mono);font-size:13px;color:var(--text-muted)">Loading...</code>
            <button class="btn btn-sm" id="claude-update-btn" onclick="updateClaudeCli()">Update CLI</button>
          </div>
        </div>
        <div id="claude-update-status" style="display:none;margin-top:12px;padding:12px;background:var(--surface2);border-radius:6px;font-size:13px;font-family:var(--mono)"></div>
      </div>
    </div>
    <div class="section">
      <div class="section-header">Service Info</div>
      <div class="section-body">
        <pre id="status-json" style="font-family:var(--mono);font-size:12px;white-space:pre-wrap;color:var(--text-muted)">Loading...</pre>
      </div>
    </div>
    <div class="actions">
      <button class="btn" onclick="loadStatus()">Refresh</button>
    </div>
  </div>
</div>

<script>
(function() {
  let currentConfig = null;
  let envOverrides = new Set();
  let restartRequiredFields = [];
  let dirty = false;

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'status') loadStatus();
      if (tab.dataset.tab === 'usage') loadUsage();
    });
  });

  // Unsaved changes warning
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Mark dirty on input changes
  document.addEventListener('input', () => { dirty = true; });
  document.addEventListener('change', () => { dirty = true; });

  // Load config on page load
  loadConfig();

  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      currentConfig = data.config;
      envOverrides = new Set(data.envOverrides || []);
      restartRequiredFields = data.restartRequiredFields || [];
      populateForm(currentConfig);
      dirty = false;
    } catch (err) {
      showToast('Failed to load config: ' + err.message, 'error');
    }
  }

  function populateForm(cfg) {
    // General
    setVal('cfg-mode', cfg.mode);
    setVal('cfg-polling-intervalSeconds', cfg.polling?.intervalSeconds);
    setVal('cfg-webhook-port', cfg.webhook?.port);
    setVal('cfg-webhook-path', cfg.webhook?.path);
    setVal('cfg-webhook-secret', cfg.webhook?.secret);
    setVal('cfg-github-token', cfg.github?.token);

    // Review
    setChecked('cfg-review-skipDrafts', cfg.review?.skipDrafts);
    setChecked('cfg-review-skipWip', cfg.review?.skipWip);
    setChecked('cfg-review-dryRun', cfg.review?.dryRun);
    setChecked('cfg-review-codebaseAccess', cfg.review?.codebaseAccess);
    setVal('cfg-review-maxDiffLines', cfg.review?.maxDiffLines);
    setVal('cfg-review-maxRetries', cfg.review?.maxRetries);
    setVal('cfg-review-maxConcurrentReviews', cfg.review?.maxConcurrentReviews);
    setVal('cfg-review-confidenceThreshold', cfg.review?.confidenceThreshold);
    setVal('cfg-review-maxReviewHistory', cfg.review?.maxReviewHistory);
    setVal('cfg-review-reviewTimeoutMs', cfg.review?.reviewTimeoutMs);
    setVal('cfg-review-cloneTimeoutMs', cfg.review?.cloneTimeoutMs);
    setVal('cfg-review-reviewMaxTurns', cfg.review?.reviewMaxTurns);
    setVal('cfg-review-debouncePeriodSeconds', cfg.review?.debouncePeriodSeconds);
    setVal('cfg-review-cloneDir', cfg.review?.cloneDir);
    setVal('cfg-review-commentTag', cfg.review?.commentTag);
    setVal('cfg-review-commentTrigger', cfg.review?.commentTrigger);
    setVal('cfg-review-excludePaths', (cfg.review?.excludePaths || []).join('\\n'));
    setVal('cfg-review-securityPaths', (cfg.review?.securityPaths || []).join('\\n'));
    setVal('cfg-review-staleClosedDays', cfg.review?.staleClosedDays);
    setVal('cfg-review-staleErrorDays', cfg.review?.staleErrorDays);
    setVal('cfg-review-staleWorktreeMinutes', cfg.review?.staleWorktreeMinutes);
    setVal('cfg-review-commentVerifyIntervalMinutes', cfg.review?.commentVerifyIntervalMinutes);

    // Features
    setChecked('cfg-features-jira-enabled', cfg.features?.jira?.enabled);
    setVal('cfg-features-jira-baseUrl', cfg.features?.jira?.baseUrl);
    setVal('cfg-features-jira-token', cfg.features?.jira?.token);
    setVal('cfg-features-jira-email', cfg.features?.jira?.email);
    setVal('cfg-features-jira-projectKeys', (cfg.features?.jira?.projectKeys || []).join(', '));
    toggleFeature('jira');

    setChecked('cfg-features-autoDescription-enabled', cfg.features?.autoDescription?.enabled);
    setChecked('cfg-features-autoDescription-overwriteExisting', cfg.features?.autoDescription?.overwriteExisting);
    setVal('cfg-features-autoDescription-timeoutMs', cfg.features?.autoDescription?.timeoutMs);
    toggleFeature('autoDescription');

    setChecked('cfg-features-autoLabel-enabled', cfg.features?.autoLabel?.enabled);
    setVal('cfg-features-autoLabel-verdictLabels', JSON.stringify(cfg.features?.autoLabel?.verdictLabels || {}, null, 2));
    setVal('cfg-features-autoLabel-severityLabels', JSON.stringify(cfg.features?.autoLabel?.severityLabels || {}, null, 2));
    setVal('cfg-features-autoLabel-diffLabels', JSON.stringify(cfg.features?.autoLabel?.diffLabels || [], null, 2));
    toggleFeature('autoLabel');

    setChecked('cfg-features-slack-enabled', cfg.features?.slack?.enabled);
    setVal('cfg-features-slack-webhookUrl', cfg.features?.slack?.webhookUrl);
    setVal('cfg-features-slack-notifyOn', (cfg.features?.slack?.notifyOn || []).join(', '));
    setVal('cfg-features-slack-channel', cfg.features?.slack?.channel || '');
    toggleFeature('slack');

    setChecked('cfg-features-audit-enabled', cfg.features?.audit?.enabled);
    setVal('cfg-features-audit-maxEntries', cfg.features?.audit?.maxEntries);
    setVal('cfg-features-audit-filePath', cfg.features?.audit?.filePath);
    setChecked('cfg-features-audit-includeMetadata', cfg.features?.audit?.includeMetadata);
    setVal('cfg-features-audit-minSeverity', cfg.features?.audit?.minSeverity);
    toggleFeature('audit');

    setChecked('cfg-features-autofix-enabled', cfg.features?.autofix?.enabled);
    setVal('cfg-features-autofix-commandTrigger', cfg.features?.autofix?.commandTrigger);
    setChecked('cfg-features-autofix-autoApply', cfg.features?.autofix?.autoApply);
    setVal('cfg-features-autofix-maxTurns', cfg.features?.autofix?.maxTurns);
    setVal('cfg-features-autofix-timeoutMs', cfg.features?.autofix?.timeoutMs);
    toggleFeature('autofix');

    // Repos
    renderRepos(cfg.repos || []);

    // Apply env override indicators
    applyEnvOverrides();
  }

  function applyEnvOverrides() {
    const fieldMap = {
      'github.token': 'cfg-github-token',
      'webhook.secret': 'cfg-webhook-secret',
      'webhook.port': 'cfg-webhook-port',
      'polling.intervalSeconds': 'cfg-polling-intervalSeconds',
      'mode': 'cfg-mode',
      'features.jira.token': 'cfg-features-jira-token',
      'features.jira.email': 'cfg-features-jira-email',
      'features.jira.baseUrl': 'cfg-features-jira-baseUrl',
      'review.dryRun': 'cfg-review-dryRun',
      'features.slack.webhookUrl': 'cfg-features-slack-webhookUrl',
    };

    for (const [dotPath, elId] of Object.entries(fieldMap)) {
      const el = document.getElementById(elId);
      if (!el) continue;

      if (envOverrides.has(dotPath)) {
        el.disabled = true;
        const label = el.closest('.field')?.querySelector('label');
        if (label && !label.querySelector('.lock')) {
          const envName = Object.entries({
            'github.token': 'GITHUB_TOKEN',
            'webhook.secret': 'WEBHOOK_SECRET',
            'webhook.port': 'WEBHOOK_PORT',
            'polling.intervalSeconds': 'POLLING_INTERVAL',
            'mode': 'MODE',
            'features.jira.token': 'JIRA_TOKEN',
            'features.jira.email': 'JIRA_EMAIL',
            'features.jira.baseUrl': 'JIRA_BASE_URL',
            'review.dryRun': 'DRY_RUN',
            'features.slack.webhookUrl': 'SLACK_WEBHOOK_URL',
          }).find(([k]) => k === dotPath)?.[1] || dotPath;
          label.innerHTML += ' <span class="lock" title="Set by env var ' + envName + '">&#128274;</span>';
        }
      }

      if (restartRequiredFields.includes(dotPath)) {
        const label = el.closest('.field')?.querySelector('label');
        if (label && !label.querySelector('.restart-badge')) {
          label.innerHTML += ' <span class="restart-badge">restart</span>';
        }
      }
    }
  }

  function renderRepos(repos) {
    const list = document.getElementById('repos-list');
    list.innerHTML = '';
    repos.forEach((r, i) => {
      const div = document.createElement('div');
      div.className = 'repo-entry';
      div.innerHTML =
        '<input type="text" placeholder="owner" value="' + (r.owner || '') + '" data-repo-idx="' + i + '" data-repo-field="owner">' +
        '<span style="color:var(--text-muted)">/</span>' +
        '<input type="text" placeholder="repo" value="' + (r.repo || '') + '" data-repo-idx="' + i + '" data-repo-field="repo">' +
        '<button class="btn btn-danger btn-sm" onclick="removeRepo(' + i + ')">Remove</button>';
      list.appendChild(div);
    });
  }

  // Build config from form
  function buildConfig() {
    const cfg = {};

    cfg.mode = getVal('cfg-mode');
    cfg.polling = { intervalSeconds: getNum('cfg-polling-intervalSeconds') };
    cfg.webhook = {
      port: getNum('cfg-webhook-port'),
      path: getVal('cfg-webhook-path'),
      secret: getVal('cfg-webhook-secret'),
    };
    cfg.github = { token: getVal('cfg-github-token') };

    cfg.review = {
      skipDrafts: getChecked('cfg-review-skipDrafts'),
      skipWip: getChecked('cfg-review-skipWip'),
      dryRun: getChecked('cfg-review-dryRun'),
      codebaseAccess: getChecked('cfg-review-codebaseAccess'),
      maxDiffLines: getNum('cfg-review-maxDiffLines'),
      maxRetries: getNum('cfg-review-maxRetries'),
      maxConcurrentReviews: getNum('cfg-review-maxConcurrentReviews'),
      confidenceThreshold: getNum('cfg-review-confidenceThreshold'),
      maxReviewHistory: getNum('cfg-review-maxReviewHistory'),
      reviewTimeoutMs: getNum('cfg-review-reviewTimeoutMs'),
      cloneTimeoutMs: getNum('cfg-review-cloneTimeoutMs'),
      reviewMaxTurns: getNum('cfg-review-reviewMaxTurns'),
      debouncePeriodSeconds: getNum('cfg-review-debouncePeriodSeconds'),
      cloneDir: getVal('cfg-review-cloneDir'),
      commentTag: getVal('cfg-review-commentTag'),
      commentTrigger: getVal('cfg-review-commentTrigger'),
      excludePaths: getVal('cfg-review-excludePaths').split('\\n').map(s => s.trim()).filter(Boolean),
      securityPaths: getVal('cfg-review-securityPaths').split('\\n').map(s => s.trim()).filter(Boolean),
      staleClosedDays: getNum('cfg-review-staleClosedDays'),
      staleErrorDays: getNum('cfg-review-staleErrorDays'),
      staleWorktreeMinutes: getNum('cfg-review-staleWorktreeMinutes'),
      commentVerifyIntervalMinutes: getNum('cfg-review-commentVerifyIntervalMinutes'),
    };

    // Features
    cfg.features = {};

    cfg.features.jira = {
      enabled: getChecked('cfg-features-jira-enabled'),
      baseUrl: getVal('cfg-features-jira-baseUrl'),
      token: getVal('cfg-features-jira-token'),
      email: getVal('cfg-features-jira-email'),
      projectKeys: getVal('cfg-features-jira-projectKeys').split(',').map(s => s.trim()).filter(Boolean),
    };

    cfg.features.autoDescription = {
      enabled: getChecked('cfg-features-autoDescription-enabled'),
      overwriteExisting: getChecked('cfg-features-autoDescription-overwriteExisting'),
      timeoutMs: getNum('cfg-features-autoDescription-timeoutMs'),
    };

    cfg.features.autoLabel = {
      enabled: getChecked('cfg-features-autoLabel-enabled'),
    };
    try {
      cfg.features.autoLabel.verdictLabels = JSON.parse(getVal('cfg-features-autoLabel-verdictLabels') || '{}');
    } catch { cfg.features.autoLabel.verdictLabels = {}; }
    try {
      cfg.features.autoLabel.severityLabels = JSON.parse(getVal('cfg-features-autoLabel-severityLabels') || '{}');
    } catch { cfg.features.autoLabel.severityLabels = {}; }
    try {
      cfg.features.autoLabel.diffLabels = JSON.parse(getVal('cfg-features-autoLabel-diffLabels') || '[]');
    } catch { cfg.features.autoLabel.diffLabels = []; }

    cfg.features.slack = {
      enabled: getChecked('cfg-features-slack-enabled'),
      webhookUrl: getVal('cfg-features-slack-webhookUrl'),
      notifyOn: getVal('cfg-features-slack-notifyOn').split(',').map(s => s.trim()).filter(Boolean),
    };
    const slackChannel = getVal('cfg-features-slack-channel');
    if (slackChannel) cfg.features.slack.channel = slackChannel;

    cfg.features.audit = {
      enabled: getChecked('cfg-features-audit-enabled'),
      maxEntries: getNum('cfg-features-audit-maxEntries'),
      filePath: getVal('cfg-features-audit-filePath'),
      includeMetadata: getChecked('cfg-features-audit-includeMetadata'),
      minSeverity: getVal('cfg-features-audit-minSeverity'),
    };

    cfg.features.autofix = {
      enabled: getChecked('cfg-features-autofix-enabled'),
      commandTrigger: getVal('cfg-features-autofix-commandTrigger'),
      autoApply: getChecked('cfg-features-autofix-autoApply'),
      maxTurns: getNum('cfg-features-autofix-maxTurns'),
      timeoutMs: getNum('cfg-features-autofix-timeoutMs'),
    };

    // Repos
    cfg.repos = [];
    const entries = document.querySelectorAll('.repo-entry');
    entries.forEach(entry => {
      const owner = entry.querySelector('[data-repo-field="owner"]').value.trim();
      const repo = entry.querySelector('[data-repo-field="repo"]').value.trim();
      if (owner && repo) cfg.repos.push({ owner, repo });
    });

    return cfg;
  }

  // Expose to window for onclick handlers
  window.saveConfig = async function() {
    const cfg = buildConfig();
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const result = await res.json();
      if (result.success) {
        dirty = false;
        const warnings = result.warnings || [];
        if (warnings.length > 0) {
          showToast('Saved with warnings: ' + warnings.join('; '), 'success');
        } else {
          showToast('Configuration saved successfully', 'success');
        }
        if (result.restartRequired) {
          document.getElementById('restart-banner').classList.add('visible');
        } else {
          document.getElementById('restart-banner').classList.remove('visible');
        }
        // Reload to get fresh state
        await loadConfig();
      } else {
        showToast('Save failed: ' + (result.errors || []).join(', '), 'error');
      }
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    }
  };

  window.togglePassword = function(id) {
    const el = document.getElementById(id);
    const btn = el.nextElementSibling;
    if (el.type === 'password') {
      el.type = 'text';
      btn.textContent = 'hide';
    } else {
      el.type = 'password';
      btn.textContent = 'show';
    }
  };

  window.toggleFeature = function(name) {
    const cb = document.getElementById('cfg-features-' + name + '-enabled');
    const content = document.getElementById('feature-' + name);
    if (content) {
      content.classList.toggle('hidden', !cb.checked);
    }
  };

  window.addRepo = function() {
    const list = document.getElementById('repos-list');
    const idx = list.children.length;
    const div = document.createElement('div');
    div.className = 'repo-entry';
    div.innerHTML =
      '<input type="text" placeholder="owner" data-repo-idx="' + idx + '" data-repo-field="owner">' +
      '<span style="color:var(--text-muted)">/</span>' +
      '<input type="text" placeholder="repo" data-repo-idx="' + idx + '" data-repo-field="repo">' +
      '<button class="btn btn-danger btn-sm" onclick="removeRepo(this)">Remove</button>';
    list.appendChild(div);
    dirty = true;
  };

  window.removeRepo = function(arg) {
    if (typeof arg === 'number') {
      const list = document.getElementById('repos-list');
      if (list.children[arg]) {
        list.children[arg].remove();
        dirty = true;
      }
    } else {
      // Called from button with 'this'
      arg.closest('.repo-entry').remove();
      dirty = true;
    }
  };

  window.loadUsage = async function() {
    const days = document.getElementById('usage-range').value || '30';
    try {
      const [summaryRes, recentRes] = await Promise.all([
        fetch('/api/usage/summary?days=' + days),
        fetch('/api/usage/recent?limit=50'),
      ]);

      if (!summaryRes.ok || !recentRes.ok) {
        const grid = document.getElementById('usage-summary-grid');
        grid.innerHTML = '<div class="status-card"><div class="value" style="font-size:14px;color:var(--text-muted)">Usage tracking not enabled</div></div>';
        return;
      }

      const summary = await summaryRes.json();
      const recent = await recentRes.json();

      // Summary cards
      const grid = document.getElementById('usage-summary-grid');
      grid.innerHTML = '';
      const cards = [
        { label: 'Total Cost', value: '$' + summary.totalCostUsd.toFixed(2) },
        { label: 'Cache Hit Rate', value: Math.round(summary.cacheHitRate * 100) + '%' },
        { label: 'Total Reviews', value: summary.totalReviews },
        { label: 'Avg Cost/Review', value: '$' + summary.avgCostPerReview.toFixed(3) },
        { label: 'Input Tokens', value: fmtNum(summary.totalInputTokens) },
        { label: 'Output Tokens', value: fmtNum(summary.totalOutputTokens) },
      ];
      cards.forEach(c => {
        const card = document.createElement('div');
        card.className = 'status-card';
        card.innerHTML = '<div class="value">' + c.value + '</div><div class="label">' + c.label + '</div>';
        grid.appendChild(card);
      });

      // Repo table
      const tbody = document.getElementById('usage-repo-tbody');
      const emptyRepo = document.getElementById('usage-repo-empty');
      tbody.innerHTML = '';
      if (!summary.repos || summary.repos.length === 0) {
        emptyRepo.style.display = 'block';
      } else {
        emptyRepo.style.display = 'none';
        summary.repos.forEach(r => {
          const hitPct = Math.round(r.cacheHitRate * 100);
          const barColor = hitPct > 60 ? 'var(--success)' : hitPct > 30 ? 'var(--warning)' : 'var(--danger)';
          const tr = document.createElement('tr');
          tr.style.cssText = 'border-bottom:1px solid var(--border)';
          tr.innerHTML =
            '<td style="padding:10px 16px">' + esc(r.owner) + '/' + esc(r.repo) + '</td>' +
            '<td style="padding:10px 12px;text-align:right">' + r.reviews + '</td>' +
            '<td style="padding:10px 12px;text-align:right;font-family:var(--mono)">' + fmtNum(r.inputTokens) + '</td>' +
            '<td style="padding:10px 12px;text-align:right;font-family:var(--mono)">' + fmtNum(r.outputTokens) + '</td>' +
            '<td style="padding:10px 12px"><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;background:var(--surface2);border-radius:3px;overflow:hidden"><div style="width:' + hitPct + '%;height:100%;background:' + barColor + ';border-radius:3px"></div></div><span style="font-size:12px;font-family:var(--mono);color:var(--text-muted);min-width:36px;text-align:right">' + hitPct + '%</span></div></td>' +
            '<td style="padding:10px 12px;text-align:right;font-family:var(--mono)">$' + r.totalCostUsd.toFixed(2) + '</td>' +
            '<td style="padding:10px 16px;text-align:right;font-family:var(--mono)">$' + r.avgCostPerReview.toFixed(3) + '</td>';
          tbody.appendChild(tr);
        });
      }

      // Recent records table
      const recentTbody = document.getElementById('usage-recent-tbody');
      const emptyRecent = document.getElementById('usage-recent-empty');
      recentTbody.innerHTML = '';
      if (!recent || recent.length === 0) {
        emptyRecent.style.display = 'block';
      } else {
        emptyRecent.style.display = 'none';
        recent.forEach(r => {
          const ts = new Date(r.timestamp);
          const timeStr = ts.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
          const cacheTokens = r.cacheReadTokens + r.cacheCreationTokens + r.inputTokens;
          const cacheRate = cacheTokens > 0 ? Math.round(r.cacheReadTokens / cacheTokens * 100) : 0;
          const tr = document.createElement('tr');
          tr.style.cssText = 'border-bottom:1px solid var(--border)';
          tr.innerHTML =
            '<td style="padding:6px 12px;white-space:nowrap">' + esc(timeStr) + '</td>' +
            '<td style="padding:6px 12px">' + esc(r.owner) + '/' + esc(r.repo) + '</td>' +
            '<td style="padding:6px 8px;text-align:right">#' + r.prNumber + '</td>' +
            '<td style="padding:6px 8px">' + esc(r.source) + '</td>' +
            '<td style="padding:6px 8px;text-align:right">' + fmtNum(r.inputTokens) + '</td>' +
            '<td style="padding:6px 8px;text-align:right">' + fmtNum(r.outputTokens) + '</td>' +
            '<td style="padding:6px 8px;text-align:right">' + cacheRate + '%</td>' +
            '<td style="padding:6px 12px;text-align:right">$' + r.totalCostUsd.toFixed(4) + '</td>';
          recentTbody.appendChild(tr);
        });
      }
    } catch (err) {
      const grid = document.getElementById('usage-summary-grid');
      grid.innerHTML = '<div class="status-card"><div class="value" style="font-size:14px;color:var(--danger)">' + esc(err.message) + '</div></div>';
    }
  };

  function fmtNum(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  window.loadStatus = async function() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      document.getElementById('version').textContent = 'v' + (data.version || 'unknown');

      // Status grid
      const grid = document.getElementById('status-grid');
      grid.innerHTML = '';

      const cards = [
        { label: 'Uptime', value: formatUptime(data.uptime || 0) },
        { label: 'Total PRs', value: data.state?.totalPRs ?? 0 },
        { label: 'Reviewing', value: data.state?.byStatus?.reviewing ?? 0 },
        { label: 'Reviewed', value: data.state?.byStatus?.reviewed ?? 0 },
        { label: 'Errors', value: data.state?.byStatus?.error ?? 0 },
        { label: 'Skipped', value: data.state?.byStatus?.skipped ?? 0 },
      ];

      cards.forEach(c => {
        const card = document.createElement('div');
        card.className = 'status-card';
        card.innerHTML = '<div class="value">' + c.value + '</div><div class="label">' + c.label + '</div>';
        grid.appendChild(card);
      });

      document.getElementById('status-json').textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      document.getElementById('status-json').textContent = 'Error: ' + err.message;
    }

    // Also load Claude CLI version and rate limit status
    loadClaudeVersion();
    loadRateLimitStatus();
  };

  async function loadRateLimitStatus() {
    const banner = document.getElementById('rate-limit-banner');
    const bannerText = document.getElementById('rate-limit-banner-text');
    const section = document.getElementById('rate-limit-section');
    try {
      const res = await fetch('/api/rate-limit');
      const data = await res.json();

      // Update banner
      if (data.state !== 'active') {
        const isSpending = data.state === 'paused_spending_limit';
        banner.style.display = 'block';
        banner.style.background = isSpending ? 'rgba(255,107,107,0.15)' : 'rgba(252,196,25,0.15)';
        banner.style.border = '1px solid ' + (isSpending ? 'var(--danger)' : 'var(--warning)');
        banner.style.color = isSpending ? 'var(--danger)' : 'var(--warning)';
        const label = isSpending ? 'Spending limit reached' : 'Rate limited';
        const resumeAt = data.resumesAt ? new Date(data.resumesAt).toLocaleTimeString() : 'unknown';
        bannerText.textContent = label + ' — auto-resuming at ' + resumeAt + ' (queue: ' + data.queueDepth + ')';
      } else {
        banner.style.display = 'none';
      }

      // Update section (always show if there are events)
      const hasEvents = data.events && data.events.length > 0;
      section.style.display = (data.state !== 'active' || hasEvents) ? 'block' : 'none';
      document.getElementById('rl-state').textContent = data.state;
      document.getElementById('rl-state').style.color = data.state === 'active' ? 'var(--success)' : 'var(--warning)';
      document.getElementById('rl-queue').textContent = data.queueDepth;
      document.getElementById('rl-pauses').textContent = data.pauseCount;

      // Event history
      const eventsWrap = document.getElementById('rl-events-wrap');
      const tbody = document.getElementById('rl-events-tbody');
      if (hasEvents) {
        eventsWrap.style.display = 'block';
        tbody.innerHTML = '';
        data.events.slice().reverse().forEach(function(ev) {
          const tr = document.createElement('tr');
          tr.style.borderBottom = '1px solid var(--border)';
          const kindColor = ev.kind === 'spending_limit' ? 'var(--danger)' : ev.kind === 'overloaded' ? 'var(--orange)' : 'var(--warning)';
          tr.innerHTML = '<td style="padding:6px 8px">' + new Date(ev.timestamp).toLocaleString() + '</td>'
            + '<td style="padding:6px 8px;color:' + kindColor + '">' + ev.kind + '</td>'
            + '<td style="padding:6px 8px;text-align:right">' + ev.retryAfterSeconds + 's</td>'
            + '<td style="padding:6px 8px">' + (ev.resumedAt ? new Date(ev.resumedAt).toLocaleTimeString() : (ev.resumed ? '-' : 'pending')) + '</td>'
            + '<td style="padding:6px 8px">' + (ev.resumedBy || '-') + '</td>';
          tbody.appendChild(tr);
        });
      } else {
        eventsWrap.style.display = 'none';
      }
    } catch (err) {
      banner.style.display = 'none';
      section.style.display = 'none';
    }
  }

  window.resumeRateLimit = async function() {
    const btn = document.getElementById('rate-limit-resume-btn');
    btn.disabled = true;
    btn.textContent = 'Resuming...';
    try {
      const res = await fetch('/api/rate-limit/resume', { method: 'POST' });
      if (res.ok) {
        showToast('Rate limit guard resumed', 'success');
        loadRateLimitStatus();
      } else {
        showToast('Failed to resume', 'error');
      }
    } catch (err) {
      showToast('Resume failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Resume Now';
    }
  };

  async function loadClaudeVersion() {
    const el = document.getElementById('claude-version');
    try {
      const res = await fetch('/api/claude/version');
      const data = await res.json();
      el.textContent = data.version || 'unknown';
      el.style.color = 'var(--text)';
    } catch {
      el.textContent = 'unavailable';
      el.style.color = 'var(--text-muted)';
    }
  }

  window.updateClaudeCli = async function() {
    const btn = document.getElementById('claude-update-btn');
    const statusEl = document.getElementById('claude-update-status');
    btn.disabled = true;
    btn.textContent = 'Updating...';
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--text-muted)';
    statusEl.textContent = 'Running npm install -g @anthropic-ai/claude-code ...';

    try {
      const res = await fetch('/api/claude/update', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        statusEl.style.color = 'var(--danger)';
        statusEl.textContent = 'Update failed: ' + (data.error || 'Unknown error');
        showToast('Claude CLI update failed', 'error');
      } else {
        const changed = data.before !== data.after;
        statusEl.style.color = changed ? 'var(--success)' : 'var(--text)';
        statusEl.textContent = changed
          ? 'Updated: ' + data.before + ' -> ' + data.after
          : 'Already up to date: ' + data.after;
        showToast(changed ? 'Claude CLI updated' : 'Claude CLI already up to date', 'success');
        document.getElementById('claude-version').textContent = data.after;
        document.getElementById('claude-version').style.color = 'var(--text)';
      }
    } catch (err) {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = 'Update failed: ' + err.message;
      showToast('Claude CLI update failed', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Update CLI';
    }
  };

  function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function showToast(message, type) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function setVal(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value ?? '';
  }

  function setChecked(id, checked) {
    const el = document.getElementById(id);
    if (el) el.checked = !!checked;
  }

  function getVal(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  function getNum(id) {
    const el = document.getElementById(id);
    const n = el ? parseInt(el.value, 10) : 0;
    return isNaN(n) ? 0 : n;
  }

  function getChecked(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
  }

  // Auto-load status tab version info
  loadStatus();
})();
</script>
</body>
</html>`;
}
