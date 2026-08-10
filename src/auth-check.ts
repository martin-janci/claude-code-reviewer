import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuthStatus {
  available: boolean;
  authenticated: boolean;
  username?: string;
  error?: string;
  warning?: string;
  lastChecked: number;
}

/**
 * Check Claude CLI availability and auth status.
 * Availability comes from invoking the CLI directly (no `which`) for Docker compatibility.
 * Auth status comes from inspecting the OAuth credentials file — `--version` succeeds even
 * when the session is expired, so it cannot be trusted for auth.
 */
export async function checkClaudeAuth(): Promise<Omit<AuthStatus, "lastChecked">> {
  const cli = await checkClaudeCli();
  if (!cli.available) return cli;

  // A long-lived token via env bypasses the OAuth credentials file entirely
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { ...cli, authenticated: true, username: "token (CLAUDE_CODE_OAUTH_TOKEN)" };
  }

  const credsPath = join(homedir(), ".claude", ".credentials.json");
  let raw: string;
  try {
    raw = await readFile(credsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // macOS stores credentials in the Keychain — a missing file proves nothing there
      if (process.platform === "darwin") {
        return { ...cli, authenticated: true, warning: "Credentials in macOS Keychain — auth not verifiable from file" };
      }
      return {
        ...cli,
        authenticated: false,
        error: "No Claude credentials (~/.claude/.credentials.json missing) — run `claude login` or set CLAUDE_CODE_OAUTH_TOKEN",
      };
    }
    return { ...cli, authenticated: true, warning: `Could not inspect credentials: ${(err as Error).message?.slice(0, 80)}` };
  }

  try {
    const creds = JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: number } };
    const expiresAt = creds.claudeAiOauth?.expiresAt;
    if (typeof expiresAt !== "number" || expiresAt <= 0) {
      return {
        ...cli,
        authenticated: false,
        error: "OAuth session invalidated — re-login required (`claude login` or CLAUDE_CODE_OAUTH_TOKEN)",
      };
    }
    if (expiresAt < Date.now()) {
      // Expired access token is normal between runs (the CLI refreshes on demand),
      // but a long-expired one suggests refresh is failing.
      const hoursAgo = Math.round((Date.now() - expiresAt) / 3_600_000);
      if (hoursAgo >= 24) {
        return {
          ...cli,
          authenticated: false,
          error: `OAuth token expired ${hoursAgo}h ago and was not refreshed — re-login likely required`,
        };
      }
      return { ...cli, authenticated: true, warning: `OAuth token expired ${hoursAgo}h ago — CLI will attempt refresh on next review` };
    }
    return { ...cli, authenticated: true };
  } catch {
    return { ...cli, authenticated: false, error: "Claude credentials file is not valid JSON — re-login required" };
  }
}

/** CLI availability probe via `--version` (does not require auth). */
function checkClaudeCli(): Promise<Omit<AuthStatus, "lastChecked">> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 3000 }, (err, _stdout, stderr) => {
      if (err) {
        const errMsg = err.message + stderr;
        const code = (err as NodeJS.ErrnoException).code;
        // ENOENT = command not found
        if (code === "ENOENT") {
          resolve({ available: false, authenticated: false, error: "claude CLI not found" });
          return;
        }
        // EACCES = permission denied (exists but not executable)
        if (code === "EACCES") {
          resolve({ available: false, authenticated: false, error: "claude CLI not executable (permission denied)" });
          return;
        }
        resolve({ available: false, authenticated: false, error: errMsg.slice(0, 100) });
        return;
      }

      // Check stderr for warnings that might indicate broken/incompatible installation
      if (stderr && stderr.trim()) {
        resolve({ available: true, authenticated: true, warning: stderr.slice(0, 100) });
        return;
      }

      resolve({ available: true, authenticated: true });
    });
  });
}

/**
 * Check GitHub auth status.
 * Tries (in order):
 *   1. `gh auth status` CLI (if installed)
 *   2. GITHUB_TOKEN / GH_TOKEN env var validated against GitHub API
 */
export function checkGhAuth(): Promise<Omit<AuthStatus, "lastChecked">> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "status"], { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // gh CLI not available — fall back to token-based check
        if (code === "ENOENT" || code === "EACCES") {
          checkGhToken().then(resolve);
          return;
        }
        // gh auth status exits non-zero if not authenticated
        const output = stdout + stderr;
        resolve({ available: true, authenticated: false, error: output.slice(0, 100) });
        return;
      }
      const usernameMatch = stdout.match(/Logged in to github\.com account (\S+)|as (\S+)/);
      resolve({
        available: true,
        authenticated: true,
        username: usernameMatch?.[1] || usernameMatch?.[2],
      });
    });
  });
}

/**
 * Validate a GitHub token (from GITHUB_TOKEN or GH_TOKEN env) against the API.
 */
async function checkGhToken(): Promise<Omit<AuthStatus, "lastChecked">> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    return { available: false, authenticated: false, error: "gh CLI not found and no GITHUB_TOKEN set" };
  }
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}`, "User-Agent": "claude-code-reviewer" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { login?: string };
      return { available: true, authenticated: true, username: data.login };
    }
    return { available: true, authenticated: false, error: `Token invalid (HTTP ${res.status})` };
  } catch (e) {
    return { available: true, authenticated: false, error: `Token check failed: ${(e as Error).message?.slice(0, 80)}` };
  }
}
