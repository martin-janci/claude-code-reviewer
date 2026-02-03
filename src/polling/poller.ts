import type { AppConfig } from "../types.js";
import type { Reviewer } from "../reviewer/reviewer.js";
import type { StateStore } from "../state/store.js";
import type { CloneManager } from "../clone/manager.js";
import type { Logger } from "../logger.js";
import { listOpenPRs, getPRState } from "../reviewer/github.js";
import { verifyReviews } from "../reviewer/comment-verifier.js";
import { cleanupStaleEntries } from "../state/cleanup.js";
import { StateStore as StoreClass } from "../state/store.js";

export class Poller {
  private running = false;
  private stopRequested = false;
  private wakeResolve: (() => void) | null = null;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private config: AppConfig,
    private reviewer: Reviewer,
    private store: StateStore,
    private logger: Logger,
    private cloneManager?: CloneManager,
  ) {}

  start(): void {
    this.logger.info("Polling started", { intervalSeconds: this.config.polling.intervalSeconds });
    this.running = true;
    this.stopRequested = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    if (this.running) {
      this.stopRequested = true;
      this.running = false;
      // Wake the sleep so it exits immediately
      if (this.sleepTimer) {
        clearTimeout(this.sleepTimer);
        this.sleepTimer = null;
      }
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
      // Wait for the current poll cycle to finish
      if (this.loopPromise) {
        await this.loopPromise;
        this.loopPromise = null;
      }
      this.logger.info("Polling stopped");
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      await this.poll();
      if (this.stopRequested) break;
      await this.sleep(this.config.polling.intervalSeconds * 1000);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeResolve = resolve;
      this.sleepTimer = setTimeout(() => {
        this.wakeResolve = null;
        this.sleepTimer = null;
        resolve();
      }, ms);
    });
  }

  private async poll(): Promise<void> {
    this.logger.info("Polling repos", { count: this.config.repos.length });

    // Collect all open PR keys for reconciliation
    const openPRKeys = new Set<string>();

    for (const { owner, repo } of this.config.repos) {
      try {
        const prs = await listOpenPRs(owner, repo);
        this.logger.info("Found open PRs", { repo: `${owner}/${repo}`, count: prs.length });

        for (const pr of prs) {
          openPRKeys.add(StoreClass.prKey(pr.owner, pr.repo, pr.number));
          await this.reviewer.processPR(pr);
        }
      } catch (err) {
        this.logger.error("Error polling repo", { repo: `${owner}/${repo}`, error: String(err) });
      }
    }

    // Reconcile closed PRs — any state entry not in open PR list
    await this.reconcileClosedPRs(openPRKeys);

    // Verify comments on reviewed PRs
    try {
      const requeued = await verifyReviews(this.store, this.config.review);
      if (requeued > 0) {
        this.logger.info("Comment verification", { requeued });
      }
    } catch (err) {
      this.logger.error("Error during comment verification", { error: String(err) });
    }

    // Cleanup stale entries
    try {
      const removed = cleanupStaleEntries(this.store, this.config.review);
      if (removed > 0) {
        this.logger.info("Cleanup: removed stale state entries", { removed });
      }
    } catch (err) {
      this.logger.error("Error during cleanup", { error: String(err) });
    }

    // Prune stale worktrees and untracked clones
    if (this.cloneManager) {
      try {
        const pruned = await this.cloneManager.pruneStaleWorktrees(this.config.review.staleWorktreeMinutes);
        if (pruned > 0) {
          this.logger.info("Worktree cleanup: pruned stale worktrees", { pruned });
        }
      } catch (err) {
        this.logger.error("Error pruning stale worktrees", { error: String(err) });
      }

      try {
        const pruned = await this.cloneManager.pruneUntracked(this.config.repos);
        if (pruned > 0) {
          this.logger.info("Clone cleanup: pruned untracked clones", { pruned });
        }
      } catch (err) {
        this.logger.error("Error pruning untracked clones", { error: String(err) });
      }
    }
  }

  private async reconcileClosedPRs(openPRKeys: Set<string>): Promise<void> {
    const MAX_RECONCILE_PER_CYCLE = 5;
    let reconciled = 0;

    for (const entry of this.store.getAll()) {
      if (reconciled >= MAX_RECONCILE_PER_CYCLE) break;

      const key = StoreClass.prKey(entry.owner, entry.repo, entry.number);

      // Skip if PR is in the open list
      if (openPRKeys.has(key)) continue;

      // Skip if already in terminal state
      if (entry.status === "closed" || entry.status === "merged") continue;

      // Check if this repo is one we're tracking
      const isTracked = this.config.repos.some(
        (r) => r.owner === entry.owner && r.repo === entry.repo,
      );
      if (!isTracked) continue;

      // Query GitHub for actual state
      try {
        const prState = await getPRState(entry.owner, entry.repo, entry.number);
        reconciled++;

        // Re-check entry still exists (may have been deleted concurrently in "both" mode)
        if (!this.store.get(entry.owner, entry.repo, entry.number)) continue;

        if (prState.state === "MERGED") {
          this.logger.info("Reconciled: PR is merged", { pr: key });
          this.store.update(entry.owner, entry.repo, entry.number, {
            status: "merged",
            closedAt: prState.mergedAt ?? new Date().toISOString(),
          });
        } else if (prState.state === "CLOSED") {
          this.logger.info("Reconciled: PR is closed", { pr: key });
          this.store.update(entry.owner, entry.repo, entry.number, {
            status: "closed",
            closedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        reconciled++; // Count failed attempts to avoid infinite retries on persistent errors
        this.logger.error("Failed to reconcile", { pr: key, error: String(err) });
      }
    }
  }
}
