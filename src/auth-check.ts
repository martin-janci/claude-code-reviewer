import { execFile } from "node:child_process";

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
 * Uses direct CLI invocation (no `which`) for Docker compatibility.
 * Note: `--version` doesn't require auth, so this only confirms availability.
 * Auth detection is best-effort via error message heuristics.
 */
export function checkClaudeAuth(): Promise<Omit<AuthStatus, "lastChecked">> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 3000 }, (err, stdout, stderr) => {
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
        // Heuristic: error messages containing these strings suggest auth issues
        // This is fragile but claude CLI has no dedicated auth status command
        if (errMsg.includes("not authenticated") || errMsg.includes("login required")) {
          resolve({ available: true, authenticated: false, error: "Not authenticated" });
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

      // If --version succeeds without warnings, CLI is available.
      // Auth status is best-effort - we assume authenticated unless proven otherwise.
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
