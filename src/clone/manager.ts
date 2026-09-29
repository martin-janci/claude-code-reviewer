import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import type { RepoConfig } from "../types.js";
import { selectEvictions, type CacheEntry } from "./retention.js";

const MIN_IDLE_MS = 10 * 60 * 1000; // never evict anything used in the last 10 min
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  staleWorktreeMinutes: number;
  cloneRetentionDays: number; // 0 = keep idle clones forever
  maxCacheMb: number; // 0 = unlimited
}

export interface RetentionResult {
  worktrees: number;
  idleClones: number;
  untracked: number;
  evicted: number;
}

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

export class CloneManager {
  private baseDir: string;
  private ghToken: string | undefined;
  private timeoutMs: number;
  private maxCacheMb = 0;
  private sizeCapRunning = false;
  // Per-repo mutex to prevent concurrent clone/fetch operations
  private repoLocks = new Map<string, Promise<void>>();

  constructor(baseDir: string, ghToken?: string, timeoutMs?: number) {
    this.baseDir = resolve(baseDir);
    this.ghToken = ghToken;
    this.timeoutMs = timeoutMs ?? 120_000;
  }

  /** Hot-reload: update token and timeout from new config. */
  updateConfig(ghToken?: string, timeoutMs?: number, maxCacheMb?: number): void {
    if (ghToken !== undefined) this.ghToken = ghToken;
    if (timeoutMs !== undefined) this.timeoutMs = timeoutMs;
    if (maxCacheMb !== undefined) this.maxCacheMb = maxCacheMb;
  }

  /** Redact token from error messages to prevent credential leakage in logs */
  private redactToken(message: string): string {
    if (!this.ghToken) return message;
    return message.replaceAll(this.ghToken, "***");
  }

  /** Build authenticated HTTPS URL for GitHub repos */
  private repoUrl(owner: string, repo: string): string {
    if (this.ghToken) {
      return `https://x-access-token:${this.ghToken}@github.com/${owner}/${repo}.git`;
    }
    return `https://github.com/${owner}/${repo}.git`;
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
          await git(["rev-parse", "--git-dir"], { cwd: clonePath, timeout: 5_000 });
        } catch {
          console.warn(`Corrupted bare clone detected at ${clonePath}, removing for re-clone`);
          rmSync(clonePath, { recursive: true, force: true });
        }
      }

      const url = this.repoUrl(owner, repo);

      // -c credential.helper= disables any credential helpers that might
      // override the token embedded in the URL (e.g. stale gh auth config).
      try {
        if (existsSync(clonePath)) {
          // Update remote URL in case token changed, then fetch
          await git(["remote", "set-url", "origin", url], { cwd: clonePath, timeout: 10_000 });
          await git(["-c", "credential.helper=", "fetch", "origin"], { cwd: clonePath, timeout: this.timeoutMs });
        } else {
          mkdirSync(dirname(clonePath), { recursive: true });
          await git(["-c", "credential.helper=", "clone", "--bare", url, clonePath], { timeout: this.timeoutMs });
        }
      } catch (err) {
        // Redact token from error messages to prevent credential leakage in logs
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(this.redactToken(message));
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
    // Make room first so a burst of PRs can't fill the volume mid-review
    if (this.maxCacheMb > 0) {
      await this.enforceSizeCap(this.maxCacheMb).catch((err) => {
        console.error("Cache size enforcement failed:", err);
      });
    }

    const clonePath = await this.ensureClone(owner, repo);
    const worktreePath = join(this.baseDir, `${owner}/${repo}--pr-${prNumber}`);

    // Fetch the PR ref (remote URL already has auth token from ensureClone)
    try {
      await git(["-c", "credential.helper=", "fetch", "origin", `pull/${prNumber}/head`], {
        cwd: clonePath,
        timeout: this.timeoutMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(this.redactToken(message));
    }

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

  /**
   * Apply the whole retention policy: stale worktrees, untracked clones,
   * idle clones, then the size cap. Returns how much was removed.
   */
  async applyRetention(policy: RetentionPolicy, trackedRepos: RepoConfig[]): Promise<RetentionResult> {
    this.maxCacheMb = policy.maxCacheMb;
    const worktrees = await this.pruneStaleWorktrees(policy.staleWorktreeMinutes);
    const untracked = await this.pruneUntracked(trackedRepos);
    const idleClones = policy.cloneRetentionDays > 0 ? await this.pruneIdleClones(policy.cloneRetentionDays) : 0;
    const evicted = policy.maxCacheMb > 0 ? await this.enforceSizeCap(policy.maxCacheMb) : 0;
    return { worktrees, idleClones, untracked, evicted };
  }

  /** Remove bare clones that haven't been fetched for `days` and have no worktrees. */
  async pruneIdleClones(days: number): Promise<number> {
    const cutoff = Date.now() - days * DAY_MS;
    let removed = 0;
    for (const { owner, repo, path, hasWorktrees } of this.listClones()) {
      if (hasWorktrees || this.repoLocks.has(`${owner}/${repo}`)) continue;
      if (this.cloneLastUsed(path) >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
      console.log(`Pruned idle clone (>${days}d): ${owner}/${repo}`);
    }
    return removed;
  }

  /**
   * If the clone cache exceeds `maxMb`, evict the oldest worktrees first,
   * then the least recently fetched bare clones. Returns the number evicted.
   */
  async enforceSizeCap(maxMb: number): Promise<number> {
    if (maxMb <= 0 || !existsSync(this.baseDir) || this.sizeCapRunning) return 0;
    this.sizeCapRunning = true;
    try {
      const capKb = maxMb * 1024;
      let totalKb = await dirSizeKb(this.baseDir);
      if (totalKb <= capKb) return 0;

      let evicted = 0;
      const now = Date.now();

      // Pass 1: worktrees (cheapest to recreate)
      const worktrees: CacheEntry[] = [];
      for (const { path } of this.listWorktrees()) {
        worktrees.push({ path, kind: "worktree", sizeKb: await dirSizeKb(path), lastUsedMs: statSync(path).mtimeMs });
      }
      for (const w of selectEvictions(worktrees, totalKb, capKb, now, MIN_IDLE_MS)) {
        rmSync(w.path, { recursive: true, force: true });
        totalKb -= w.sizeKb;
        evicted++;
        console.log(`Cache over ${maxMb}MB — evicted worktree: ${w.path}`);
      }
      if (evicted > 0) await this.pruneWorktreeMetadata();

      // Pass 2: bare clones, only those without remaining worktrees and not being fetched
      if (totalKb > capKb) {
        const clones: CacheEntry[] = [];
        for (const { owner, repo, path, hasWorktrees } of this.listClones()) {
          if (hasWorktrees || this.repoLocks.has(`${owner}/${repo}`)) continue;
          clones.push({ path, kind: "clone", sizeKb: await dirSizeKb(path), lastUsedMs: this.cloneLastUsed(path) });
        }
        for (const c of selectEvictions(clones, totalKb, capKb, now, MIN_IDLE_MS)) {
          rmSync(c.path, { recursive: true, force: true });
          totalKb -= c.sizeKb;
          evicted++;
          console.log(`Cache over ${maxMb}MB — evicted clone: ${c.path}`);
        }
      }

      if (totalKb > capKb) {
        console.warn(`Clone cache still ${Math.round(totalKb / 1024)}MB, over the ${maxMb}MB cap (remaining entries are in use)`);
      }
      return evicted;
    } finally {
      this.sizeCapRunning = false;
    }
  }

  /** Last time a bare clone was fetched (FETCH_HEAD mtime), falling back to the directory mtime. */
  private cloneLastUsed(clonePath: string): number {
    try {
      return statSync(join(clonePath, "FETCH_HEAD")).mtimeMs;
    } catch {
      try { return statSync(clonePath).mtimeMs; } catch { return 0; }
    }
  }

  private listWorktrees(): { owner: string; path: string }[] {
    const out: { owner: string; path: string }[] = [];
    for (const owner of safeReaddir(this.baseDir)) {
      const ownerPath = join(this.baseDir, owner);
      if (!isDirectory(ownerPath)) continue;
      for (const entry of safeReaddir(ownerPath)) {
        if (/^(.+)--pr-(\d+)$/.test(entry) && isDirectory(join(ownerPath, entry))) {
          out.push({ owner, path: join(ownerPath, entry) });
        }
      }
    }
    return out;
  }

  private listClones(): { owner: string; repo: string; path: string; hasWorktrees: boolean }[] {
    const out: { owner: string; repo: string; path: string; hasWorktrees: boolean }[] = [];
    for (const owner of safeReaddir(this.baseDir)) {
      const ownerPath = join(this.baseDir, owner);
      if (!isDirectory(ownerPath)) continue;
      const entries = safeReaddir(ownerPath);
      for (const repo of entries) {
        if (repo.includes("--pr-") || !isDirectory(join(ownerPath, repo))) continue;
        const hasWorktrees = entries.some((e) => e.startsWith(`${repo}--pr-`));
        out.push({ owner, repo, path: join(ownerPath, repo), hasWorktrees });
      }
    }
    return out;
  }

  /** Drop git's bookkeeping for worktrees whose directories were removed. */
  private async pruneWorktreeMetadata(): Promise<void> {
    for (const { path } of this.listClones()) {
      await git(["worktree", "prune"], { cwd: path, timeout: 30_000 }).catch(() => {});
    }
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

function dirSizeKb(path: string): Promise<number> {
  return new Promise((resolve) => {
    execFile("du", ["-sk", path], { encoding: "utf-8", timeout: 120_000 }, (err, stdout) => {
      if (err && !stdout) return resolve(0);
      const kb = parseInt(stdout.split(/\s+/)[0], 10);
      resolve(Number.isFinite(kb) ? kb : 0);
    });
  });
}
