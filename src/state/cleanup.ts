import type { ReviewConfig } from "../types.js";
import type { StateStore } from "./store.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function cleanupStaleEntries(store: StateStore, config: ReviewConfig): number {
  const now = Date.now();
  let removed = 0;

  for (const entry of store.getAll()) {
    // Cleanup closed/merged entries older than staleClosedDays
    if (entry.status === "closed" || entry.status === "merged") {
      const closedAt = entry.closedAt ? new Date(entry.closedAt).getTime() : new Date(entry.updatedAt).getTime();
      const ageDays = (now - closedAt) / MS_PER_DAY;
      if (ageDays > config.staleClosedDays) {
        store.delete(entry.owner, entry.repo, entry.number);
        console.log(`Cleaned up stale ${entry.status} PR: ${entry.owner}/${entry.repo}#${entry.number} (${Math.round(ageDays)}d old)`);
        removed++;
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
        store.delete(entry.owner, entry.repo, entry.number);
        console.log(`Cleaned up stale error PR: ${entry.owner}/${entry.repo}#${entry.number} (${Math.round(ageDays)}d old)`);
        removed++;
      }
    }
  }

  return removed;
}
