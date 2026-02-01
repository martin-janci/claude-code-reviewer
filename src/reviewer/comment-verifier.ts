import type { ReviewConfig } from "../types.js";
import type { StateStore } from "../state/store.js";
import { commentExists, reviewExists } from "./github.js";

const MS_PER_MINUTE = 60 * 1000;

export async function verifyReviews(store: StateStore, config: ReviewConfig): Promise<number> {
  const intervalMs = config.commentVerifyIntervalMinutes * MS_PER_MINUTE;
  const now = Date.now();
  let requeued = 0;

  for (const entry of store.getAll()) {
    if (entry.status !== "reviewed") continue;

    const label = `${entry.owner}/${entry.repo}#${entry.number}`;

    // New path: check PR review via Reviews API
    if (entry.reviewId) {
      // Rate-limit verification
      if (entry.reviewVerifiedAt) {
        const lastVerified = new Date(entry.reviewVerifiedAt).getTime();
        if (now - lastVerified < intervalMs) continue;
      }

      try {
        const result = await reviewExists(entry.owner, entry.repo, entry.number, entry.reviewId);

        // Re-check entry still exists (may have been deleted concurrently in "both" mode)
        if (!store.get(entry.owner, entry.repo, entry.number)) continue;

        if (result.exists && !result.dismissed) {
          store.update(entry.owner, entry.repo, entry.number, {
            reviewVerifiedAt: new Date().toISOString(),
          });
        } else {
          const reason = result.dismissed ? "dismissed" : "deleted";
          console.log(`Review ${reason} on ${label} — marking for re-review`);
          store.update(entry.owner, entry.repo, entry.number, {
            status: "pending_review",
            reviewId: null,
            reviewVerifiedAt: null,
          });
          requeued++;
        }
      } catch (err) {
        console.error(`Failed to verify review on ${label}:`, err);
      }
      continue;
    }

    // Legacy path: check issue comment
    if (entry.commentId) {
      // Rate-limit verification
      if (entry.commentVerifiedAt) {
        const lastVerified = new Date(entry.commentVerifiedAt).getTime();
        if (now - lastVerified < intervalMs) continue;
      }

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
  }

  return requeued;
}
