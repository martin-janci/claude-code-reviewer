import type { ReviewConfig } from "../types.js";
import type { StateStore } from "../state/store.js";
import { commentExists } from "./github.js";

const MS_PER_MINUTE = 60 * 1000;

export async function verifyComments(store: StateStore, config: ReviewConfig): Promise<number> {
  const intervalMs = config.commentVerifyIntervalMinutes * MS_PER_MINUTE;
  const now = Date.now();
  let requeued = 0;

  for (const entry of store.getAll()) {
    if (entry.status !== "reviewed") continue;
    if (!entry.commentId) continue;

    // Rate-limit verification
    if (entry.commentVerifiedAt) {
      const lastVerified = new Date(entry.commentVerifiedAt).getTime();
      if (now - lastVerified < intervalMs) continue;
    }

    const label = `${entry.owner}/${entry.repo}#${entry.number}`;

    try {
      const exists = await commentExists(entry.owner, entry.repo, entry.commentId);

      // Re-check entry still exists (may have been deleted concurrently in "both" mode)
      if (!store.get(entry.owner, entry.repo, entry.number)) continue;

      if (exists) {
        store.update(entry.owner, entry.repo, entry.number, {
          commentVerifiedAt: new Date().toISOString(),
        });
      } else {
        console.log(`Comment deleted on ${label} — marking for re-review`);
        store.update(entry.owner, entry.repo, entry.number, {
          status: "pending_review",
          commentId: null,
          commentVerifiedAt: null,
        });
        requeued++;
      }
    } catch (err) {
      console.error(`Failed to verify comment on ${label}:`, err);
    }
  }

  return requeued;
}
