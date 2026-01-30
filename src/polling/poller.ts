import type { AppConfig } from "../types.js";
import type { Reviewer } from "../reviewer/reviewer.js";
import type { StateStore } from "../state/store.js";
import { listOpenPRs, getPRState } from "../reviewer/github.js";
import { verifyComments } from "../reviewer/comment-verifier.js";
import { cleanupStaleEntries } from "../state/cleanup.js";
import { StateStore as StoreClass } from "../state/store.js";

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: AppConfig,
    private reviewer: Reviewer,
    private store: StateStore,
  ) {}

  start(): void {
    const intervalMs = this.config.polling.intervalSeconds * 1000;
    console.log(`Polling started (every ${this.config.polling.intervalSeconds}s)`);

    // Run immediately on start
    this.poll();

    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("Polling stopped");
    }
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
    for (const entry of this.store.getAll()) {
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
        console.error(`Failed to reconcile ${key}:`, err);
      }
    }
  }
}
