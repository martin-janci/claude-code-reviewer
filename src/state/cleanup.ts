import type { ReviewConfig } from "../types.js";
import type { StateStore } from "./store.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function cleanupStaleEntries(store: StateStore, config: ReviewConfig): number {
  const now = Date.now();
  const toDelete: Array<{ owner: string; repo: string; number: number; reason: string }> = [];

  for (const entry of store.getAll()) {
    // Cleanup closed/merged entries older than staleClosedDays
    if (entry.status === "closed" || entry.status === "merged") {
      const closedAt = entry.closedAt ? new Date(entry.closedAt).getTime() : new Date(entry.updatedAt).getTime();
      const ageDays = (now - closedAt) / MS_PER_DAY;
      if (ageDays > config.staleClosedDays) {
        toDelete.push({ owner: entry.owner, repo: entry.repo, number: entry.number, reason: `stale ${entry.status} (${Math.round(ageDays)}d old)` });
        continue;
      }
    }

    // Cleanup error entries (stuck with max retries) older than staleErrorDays
    if (entry.status === "error" && entry.consecutiveErrors >= config.maxRetries) {
      const errorAt = entry.lastError
        ? new Date(entry.lastError.occurredAt).getTime()
        : new Date(entry.updatedAt).getTime();
      const ageDays = (now - errorAt) / MS_PER_DAY;
      if (ageDays > config.staleErrorDays) {
        toDelete.push({ owner: entry.owner, repo: entry.repo, number: entry.number, reason: `stale error (${Math.round(ageDays)}d old)` });
      }
    }
  }

  if (toDelete.length === 0) return 0;

  for (const { owner, repo, number, reason } of toDelete) {
    console.log(`Cleaned up ${reason} PR: ${owner}/${repo}#${number}`);
  }

  return store.deleteMany(toDelete);
}
