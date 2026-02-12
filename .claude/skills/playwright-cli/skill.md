---
name: playwright-cli
description: Browser automation using Playwright CLI for testing, debugging, code generation, and web interactions. Includes both @playwright/cli (agent-focused) and npx playwright (testing framework).
user-invocable: true
arguments: "[command] [options] (e.g., 'codegen https://example.com' or 'test --headed')"
---

# Playwright CLI

Comprehensive browser automation using Playwright's command-line interface. Supports two primary tools:

1. **@playwright/cli** — Token-efficient CLI for AI agents (browser control, interactions, state management)
2. **npx playwright** — Full testing framework (test execution, debugging, reporting)

## Installation

```bash
# Install Playwright testing framework
npm init playwright@latest

# Install agent-focused CLI
npm install -g @playwright/cli@latest
playwright-cli install --skills

# Install browsers for testing framework
npx playwright install
npx playwright install --with-deps  # includes system dependencies
```

## Agent-Focused CLI (@playwright/cli)

Token-efficient browser automation designed for coding agents. Optimized for headless operation with persistent sessions.

### Browser Management

```bash
# Launch browser (headless by default)
playwright-cli open [url]
playwright-cli open --headed  # show browser window

# Session management
playwright-cli list  # show all active sessions
playwright-cli close  # close current page
playwright-cli close-all  # shutdown all browsers
playwright-cli kill-all  # force terminate processes

# Multi-session support
playwright-cli -s=session1 open https://example.com
PLAYWRIGHT_CLI_SESSION=session2 playwright-cli goto https://test.com
```

### Navigation

```bash
playwright-cli goto <url>        # navigate to URL
playwright-cli go-back           # browser back button
playwright-cli go-forward        # browser forward button
playwright-cli reload            # refresh page
```

### Element Interaction

```bash
# Clicking
playwright-cli click <ref>       # left click element by reference
playwright-cli click <ref> right # right click

# Text input
playwright-cli type <text>       # type into focused element
playwright-cli fill <ref> <text> # fill text field

# Form controls
playwright-cli check <ref>       # toggle checkbox/radio
playwright-cli select <ref> <val> # dropdown selection
playwright-cli hover <ref>       # hover over element
```

### Capture & Output

```bash
playwright-cli screenshot [ref]  # capture page or element
playwright-cli pdf              # export page as PDF
playwright-cli snapshot         # record page state with element refs
```

### State Management

```bash
# Storage state (cookies, localStorage)
playwright-cli state-save [filename]  # persist state to file
playwright-cli state-load <filename>  # load saved state

# Cookies
playwright-cli cookie-list       # display all cookies
playwright-cli cookie-set <name> <value>
playwright-cli cookie-clear

# Local/Session Storage
playwright-cli localstorage-set <key> <value>
playwright-cli localstorage-get <key>
playwright-cli localstorage-clear
playwright-cli sessionstorage-clear
```

### Configuration

Create `playwright-cli.json` in your project:

```json
{
  "browserType": "chromium",
  "timeout": 30000,
  "headless": true,
  "viewport": {
    "width": 1280,
    "height": 720
  },
  "locale": "en-US",
  "timezone": "America/New_York"
}
```

Or use `--config <file.json>` flag.

## Testing Framework (npx playwright)

Full-featured testing framework with parallel execution, debugging, and reporting.

### Running Tests

```bash
# Run all tests
npx playwright test

# Run specific tests
npx playwright test tests/login.spec.ts
npx playwright test tests/login.spec.ts:42  # specific line
npx playwright test -g "user login"         # filter by title

# Run options
npx playwright test --headed                # show browser
npx playwright test --ui                    # interactive UI mode
npx playwright test --debug                 # debug mode with inspector
npx playwright test --project=chromium      # specific browser
npx playwright test --workers=4             # parallel workers

# Retry and filtering
npx playwright test --last-failed           # only failed tests
npx playwright test --only-changed=main     # changed files vs branch
npx playwright test --retries=2             # retry failed tests
```

### Code Generation (Codegen)

Record browser interactions and generate test code:

```bash
# Basic codegen
npx playwright codegen                      # start recording
npx playwright codegen https://example.com  # record from URL

# Target language
npx playwright codegen --target=python
npx playwright codegen --target=csharp
npx playwright codegen --target=java

# Save storage state (auth)
npx playwright codegen --save-storage=auth.json

# Load storage state
npx playwright codegen --load-storage=auth.json

# Device emulation
npx playwright codegen --device="iPhone 13"
npx playwright codegen --viewport-size=800,600

# Timezone and locale
npx playwright codegen --timezone="Europe/Rome"
npx playwright codegen --lang="de-DE"
```

### Debugging & Tracing

```bash
# Debug mode
npx playwright test --debug                 # opens Playwright Inspector
npx playwright test --debug tests/login.spec.ts:42

# Tracing
npx playwright test --trace=on              # always trace
npx playwright test --trace=retain-on-failure
npx playwright test --trace=on-first-retry

# View traces
npx playwright show-trace trace.zip
npx playwright show-trace path/to/trace-dir
```

### Reporting

```bash
# Generate reports
npx playwright test --reporter=html
npx playwright test --reporter=json
npx playwright test --reporter=junit
npx playwright test --reporter=list

# Multiple reporters
npx playwright test --reporter=html,json

# View HTML report
npx playwright show-report
npx playwright show-report report-folder --port=9323
```

### Advanced Commands

```bash
# Merge reports (sharding)
npx playwright merge-reports blob-report-dir

# Clear cache
npx playwright clear-cache

# Install browsers
npx playwright install chromium
npx playwright install --force  # reinstall
npx playwright install --dry-run  # preview only
```

## Common Workflows

### Record and Save Authentication

```bash
# Step 1: Record login and save state
npx playwright codegen --save-storage=auth.json https://example.com/login
# Perform login in browser, then close

# Step 2: Use saved state in tests
npx playwright test --load-storage=auth.json
```

Or in agent-focused CLI:

```bash
playwright-cli open https://example.com/login
# Interact with page to login
playwright-cli state-save auth.json
playwright-cli close

# Later, reuse state
playwright-cli state-load auth.json
playwright-cli goto https://example.com/dashboard
```

### Cross-Browser Testing

```bash
# Run tests on all configured browsers
npx playwright test --project=chromium --project=firefox --project=webkit

# Or configure in playwright.config.ts
npx playwright test  # runs all projects
```

### Debug Failing Test

```bash
# Step 1: Run with trace on failure
npx playwright test --trace=retain-on-failure

# Step 2: View the trace
npx playwright show-trace test-results/example-chromium/trace.zip
```

### Mobile Emulation Testing

```bash
# Using codegen
npx playwright codegen --device="iPhone 13 Pro"

# Using test command with specific viewport
npx playwright test --project="Mobile Chrome"
```

### Multi-Session Browser Automation

```bash
# Session 1: Login as user A
playwright-cli -s=userA open https://app.com/login
playwright-cli -s=userA fill "input[name=email]" "usera@example.com"
playwright-cli -s=userA fill "input[name=password]" "password123"
playwright-cli -s=userA click "button[type=submit]"
playwright-cli -s=userA state-save userA-auth.json

# Session 2: Login as user B
playwright-cli -s=userB open https://app.com/login
playwright-cli -s=userB fill "input[name=email]" "userb@example.com"
playwright-cli -s=userB fill "input[name=password]" "password456"
playwright-cli -s=userB click "button[type=submit]"
playwright-cli -s=userB state-save userB-auth.json

# Verify both sessions
playwright-cli -s=userA screenshot
playwright-cli -s=userB screenshot
```

## Best Practices

### For AI Agents (@playwright/cli)

1. **Use headless by default** — only add `--headed` for debugging
2. **Save state for auth** — avoid re-authenticating on every session
3. **Use named sessions** — manage multiple contexts with `-s=name`
4. **Element references** — use `snapshot` to get stable element refs
5. **Token efficiency** — CLI is optimized for low token consumption

### For Testing (npx playwright)

1. **Always use Page Object Model** — organize selectors and actions
2. **Enable tracing on CI** — `--trace=on-first-retry` for debugging
3. **Parallelize tests** — use `--workers` for faster execution
4. **Use codegen for exploration** — generate initial test structure
5. **Isolate test state** — ensure tests can run independently
6. **Version control auth.json** — store in secure location, not in git

## Troubleshooting

### Browser not installed
```bash
npx playwright install chromium
playwright-cli install
```

### Timeout issues
```bash
# Increase timeout
npx playwright test --timeout=60000

# Or in config
playwright-cli --timeout=60000 open https://slow-site.com
```

### Element not found
```bash
# Use codegen to find correct selector
npx playwright codegen https://example.com

# Or use snapshot for element refs (agent CLI)
playwright-cli snapshot
```

### Authentication not persisting
```bash
# Verify state is saved
playwright-cli state-save auth.json
cat auth.json  # should contain cookies

# Load state explicitly
playwright-cli state-load auth.json
playwright-cli goto https://protected-page.com
```

### Headless vs Headed mode issues
```bash
# Some sites detect headless, try headed mode
npx playwright test --headed
playwright-cli open --headed https://example.com
```

## Key Differences: Agent CLI vs Testing Framework

| Feature | @playwright/cli (Agent) | npx playwright (Testing) |
|---------|------------------------|--------------------------|
| **Purpose** | Browser automation for agents | Test execution framework |
| **Token usage** | Optimized for low token count | Higher token usage |
| **Sessions** | Persistent, named sessions | Test isolation per run |
| **State** | Manual state save/load | Automatic fixtures |
| **Assertions** | None (manual verification) | Built-in expect() |
| **Parallelism** | Multi-session support | Worker-based parallelism |
| **Reporting** | None | HTML, JSON, JUnit |
| **Best for** | Interactive automation, AI workflows | Test suites, CI/CD |

## Help & Reference

```bash
# Get help
npx playwright --help
npx playwright test --help
playwright-cli --help
playwright-cli <command> --help

# Check version
npx playwright --version
playwright-cli --version
```

## Environment Variables

```bash
# Agent CLI session
export PLAYWRIGHT_CLI_SESSION=mySession

# Testing framework
export PLAYWRIGHT_BROWSERS_PATH=/custom/path
export DEBUG=pw:api  # enable debug logging
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

## Sources

For more information, refer to:
- [Command line | Playwright](https://playwright.dev/docs/test-cli)
- [GitHub - microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)
- [Playwright CLI | BrowserStack](https://www.browserstack.com/guide/playwright-cli)
- [Deep Dive into Playwright CLI | TestDino](https://testdino.com/blog/playwright-cli/)
- [Top 5 Playwright CLI Features | Checkly](https://www.checklyhq.com/blog/five-playwright-cli-features-you-should-know/)
