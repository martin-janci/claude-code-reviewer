import type { AppConfig } from "../types.js";
import type { Reviewer } from "../reviewer/reviewer.js";
import type { StateStore } from "../state/store.js";
import { listOpenPRs, getPRState } from "../reviewer/github.js";
import { verifyComments } from "../reviewer/comment-verifier.js";
import { cleanupStaleEntries } from "../state/cleanup.js";
import { StateStore as StoreClass } from "../state/store.js";

export class Poller {
  private running = false;
  private stopRequested = false;
  private wakeResolve: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private config: AppConfig,
    private reviewer: Reviewer,
    private store: StateStore,
  ) {}

  start(): void {
    console.log(`Polling started (every ${this.config.polling.intervalSeconds}s)`);
    this.running = true;
    this.stopRequested = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    if (this.running) {
      this.stopRequested = true;
      this.running = false;
      // Wake the sleep so it exits immediately
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
      // Wait for the current poll cycle to finish
      if (this.loopPromise) {
        await this.loopPromise;
        this.loopPromise = null;
      }
      console.log("Polling stopped");
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
      setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, ms);
    });
  }

  private async poll(): Promise<void> {
    console.log(`Polling ${this.config.repos.length} repo(s)...`);

    // Collect all open PR keys for reconciliation
    const openPRKeys = new Set<string>();

    for (const { owner, repo } of this.config.repos) {
      try {
        const prs = await listOpenPRs(owner, repo);
        console.log(`Found ${prs.length} open PR(s) in ${owner}/${repo}`);

        for (const pr of prs) {
          openPRKeys.add(StoreClass.prKey(pr.owner, pr.repo, pr.number));
          await this.reviewer.processPR(pr);
        }
      } catch (err) {
        console.error(`Error polling ${owner}/${repo}:`, err);
      }
    }

    // Reconcile closed PRs — any state entry not in open PR list
    await this.reconcileClosedPRs(openPRKeys);

    // Verify comments on reviewed PRs
    try {
      const requeued = await verifyComments(this.store, this.config.review);
      if (requeued > 0) {
        console.log(`Comment verification: ${requeued} PR(s) requeued for re-review`);
      }
    } catch (err) {
      console.error("Error during comment verification:", err);
    }

    // Cleanup stale entries
    try {
      const removed = cleanupStaleEntries(this.store, this.config.review);
      if (removed > 0) {
        console.log(`Cleanup: removed ${removed} stale state entries`);
      }
    } catch (err) {
      console.error("Error during cleanup:", err);
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
        if (prState.state === "MERGED") {
          console.log(`Reconciled: ${key} is merged`);
          this.store.update(entry.owner, entry.repo, entry.number, {
            status: "merged",
            closedAt: prState.mergedAt ?? new Date().toISOString(),
          });
        } else if (prState.state === "CLOSED") {
          console.log(`Reconciled: ${key} is closed`);
          this.store.update(entry.owner, entry.repo, entry.number, {
            status: "closed",
            closedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        reconciled++; // Count failed attempts to avoid infinite retries on persistent errors
        console.error(`Failed to reconcile ${key}:`, err);
      }
    }
  }
}
