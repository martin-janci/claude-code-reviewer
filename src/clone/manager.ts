import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import type { RepoConfig } from "../types.js";

function git(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeout ?? 120_000,
      cwd: options.cwd,
      env: options.env,
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

function ghClone(
  repoSlug: string,
  dest: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["repo", "clone", repoSlug, dest, "--", "--bare"], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout,
      env,
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

export class CloneManager {
  private baseDir: string;
  private env: NodeJS.ProcessEnv;
  private timeoutMs: number;
  // Per-repo mutex to prevent concurrent clone/fetch operations
  private repoLocks = new Map<string, Promise<void>>();

  constructor(baseDir: string, ghToken?: string, timeoutMs?: number) {
    this.baseDir = resolve(baseDir);
    this.timeoutMs = timeoutMs ?? 120_000;
    this.env = { ...process.env };
    if (ghToken) {
      this.env.GH_TOKEN = ghToken;
      // Configure git to use GH_TOKEN for HTTPS auth via header injection.
      // This avoids requiring `gh auth setup-git` or a credential helper.
      this.env.GIT_CONFIG_COUNT = "1";
      this.env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      this.env.GIT_CONFIG_VALUE_0 = `Authorization: token ${ghToken}`;
    }
  }

  /**
   * Bare clone if missing, fetch if exists. Returns clone path.
   * Per-repo mutex prevents concurrent clone/fetch.
   */
  async ensureClone(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`;
    const clonePath = join(this.baseDir, owner, repo);

    // Acquire per-repo lock
    while (this.repoLocks.has(key)) {
      await this.repoLocks.get(key);
    }

    let unlock: () => void;
    const lock = new Promise<void>((resolve) => { unlock = resolve; });
    this.repoLocks.set(key, lock);

    try {
      // Validate existing clone isn't corrupted
      if (existsSync(clonePath)) {
        try {
          await git(["rev-parse", "--git-dir"], { cwd: clonePath, timeout: 10_000 });
        } catch {
          console.warn(`Corrupted bare clone detected at ${clonePath}, removing for re-clone`);
          rmSync(clonePath, { recursive: true, force: true });
        }
      }

      if (existsSync(clonePath)) {
        // Fetch latest
        await git(["fetch", "origin"], {
          cwd: clonePath,
          env: this.env,
          timeout: this.timeoutMs,
        });
      } else {
        // Clone bare
        await ghClone(`${owner}/${repo}`, clonePath, this.env, this.timeoutMs);
      }
      return clonePath;
    } finally {
      this.repoLocks.delete(key);
      unlock!();
    }
  }

  /**
   * Fetch pull/<N>/head, remove stale worktree if exists,
   * git worktree add --detach <path> <sha>. Returns worktree path.
   */
  async prepareForPR(
    owner: string,
    repo: string,
    prNumber: number,
    headSha: string,
  ): Promise<string> {
    const clonePath = await this.ensureClone(owner, repo);
    const worktreePath = join(this.baseDir, `${owner}/${repo}--pr-${prNumber}`);

    // Fetch the PR ref
    await git(["fetch", "origin", `pull/${prNumber}/head`], {
      cwd: clonePath,
      env: this.env,
      timeout: this.timeoutMs,
    });

    // Remove stale worktree if it exists
    if (existsSync(worktreePath)) {
      try {
        await git(["worktree", "remove", "--force", worktreePath], {
          cwd: clonePath,
          timeout: 30_000,
        });
      } catch {
        // Fallback: force remove the directory
        rmSync(worktreePath, { recursive: true, force: true });
        // Prune worktree bookkeeping
        await git(["worktree", "prune"], { cwd: clonePath, timeout: 30_000 });
      }
    }

    // Create worktree at the PR's head SHA
    await git(["worktree", "add", "--detach", worktreePath, headSha], {
      cwd: clonePath,
      timeout: this.timeoutMs,
    });

    return worktreePath;
  }

  /**
   * Remove worktree for a PR. Safe to call even if worktree doesn't exist.
   */
  async cleanupPR(owner: string, repo: string, prNumber: number): Promise<void> {
    const clonePath = join(this.baseDir, owner, repo);
    const worktreePath = join(this.baseDir, `${owner}/${repo}--pr-${prNumber}`);

    if (!existsSync(worktreePath)) return;

    try {
      await git(["worktree", "remove", "--force", worktreePath], {
        cwd: clonePath,
        timeout: 30_000,
      });
    } catch {
      // Fallback: force remove
      rmSync(worktreePath, { recursive: true, force: true });
      if (existsSync(clonePath)) {
        await git(["worktree", "prune"], { cwd: clonePath, timeout: 30_000 }).catch(() => {});
      }
    }
  }

  /**
   * Remove worktrees older than the given threshold.
   * Returns the number of worktrees removed.
   */
  async pruneStaleWorktrees(maxAgeMinutes: number): Promise<number> {
    if (!existsSync(this.baseDir)) return 0;

    const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
    let removed = 0;

    // Worktrees are named owner/repo--pr-N
    for (const ownerDir of safeReaddir(this.baseDir)) {
      const ownerPath = join(this.baseDir, ownerDir);
      if (!isDirectory(ownerPath)) continue;

      for (const entry of safeReaddir(ownerPath)) {
        const match = entry.match(/^(.+)--pr-(\d+)$/);
        if (!match) continue;

        const worktreePath = join(ownerPath, entry);
        if (!isDirectory(worktreePath)) continue;

        const mtime = statSync(worktreePath).mtimeMs;
        if (mtime < cutoff) {
          const repo = match[1];
          const prNumber = parseInt(match[2], 10);
          try {
            await this.cleanupPR(ownerDir, repo, prNumber);
            removed++;
            console.log(`Pruned stale worktree: ${ownerDir}/${entry}`);
          } catch (err) {
            console.error(`Failed to prune worktree ${ownerDir}/${entry}:`, err);
          }
        }
      }
    }

    return removed;
  }

  /**
   * Remove clones for repos no longer in config.
   * Returns the number of clones removed.
   */
  async pruneUntracked(trackedRepos: RepoConfig[]): Promise<number> {
    if (!existsSync(this.baseDir)) return 0;

    const tracked = new Set(trackedRepos.map((r) => `${r.owner}/${r.repo}`));
    let removed = 0;

    for (const ownerDir of safeReaddir(this.baseDir)) {
      const ownerPath = join(this.baseDir, ownerDir);
      if (!isDirectory(ownerPath)) continue;

      for (const entry of safeReaddir(ownerPath)) {
        // Skip worktrees (owner/repo--pr-N)
        if (entry.includes("--pr-")) continue;

        const repoKey = `${ownerDir}/${entry}`;
        if (tracked.has(repoKey)) continue;

        const repoPath = join(ownerPath, entry);
        if (!isDirectory(repoPath)) continue;

        try {
          rmSync(repoPath, { recursive: true, force: true });
          removed++;
          console.log(`Pruned untracked clone: ${repoKey}`);
        } catch (err) {
          console.error(`Failed to prune clone ${repoKey}:`, err);
        }
      }
    }

    return removed;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
