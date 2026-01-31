import type { AppConfig, PullRequest, ReviewVerdict, ErrorPhase, PRState } from "../types.js";
import type { StateStore } from "../state/store.js";
import { shouldReview } from "../state/decisions.js";
import { getPRDiff, findExistingComment, postComment, updateComment } from "./github.js";
import { reviewDiff } from "./claude.js";

function parseVerdict(body: string): ReviewVerdict {
  // Scan first 5 non-empty lines for a verdict keyword
  const lines = body.split("\n").filter((l) => l.trim()).slice(0, 5);
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    // Match standalone verdict keywords (with optional markdown formatting)
    if (/\bREQUEST[_\s]CHANGES\b/.test(upper)) return "REQUEST_CHANGES";
    if (/\bAPPROVE[D]?\b/.test(upper)) return "APPROVE";
    if (/\bCOMMENT\b/.test(upper)) return "COMMENT";
  }
  return "unknown";
}

export class Reviewer {
  private locks = new Map<string, Promise<void>>();
  private inflightCount = 0;

  constructor(
    private config: AppConfig,
    private store: StateStore,
  ) {}

  get inflight(): number {
    return this.inflightCount;
  }

  async processPR(pr: PullRequest): Promise<void> {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;

    // Per-PR mutex: wait in a loop until no lock exists for this key.
    // Loop handles 3+ concurrent callers correctly — after waking,
    // re-check in case another waiter acquired the lock first.
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    let unlock: () => void;
    const lock = new Promise<void>((resolve) => { unlock = resolve; });
    this.locks.set(key, lock);
    this.inflightCount++;

    try {
      await this.doProcessPR(pr);
    } finally {
      this.inflightCount--;
      this.locks.delete(key);
      unlock!();
    }
  }

  private async doProcessPR(pr: PullRequest): Promise<void> {
    const { owner, repo, number: prNumber, title, headSha, isDraft, baseBranch } = pr;
    const label = `${owner}/${repo}#${prNumber}`;

    // 1. Get or create state entry
    const state = this.store.getOrCreate(owner, repo, prNumber, {
      title,
      isDraft,
      headSha,
      baseBranch,
    });

    // 2. Sync metadata — detect changes
    this.syncMetadata(state, pr);

    // 3. Evaluate transitions
    this.evaluateTransitions(state);

    // 4. Persist skip status for draft/WIP so we don't re-evaluate every cycle.
    //    Also update skip reason if already skipped for a different reason (e.g. diff_too_large → draft).
    if (this.config.review.skipDrafts && state.isDraft) {
      if (state.status !== "skipped" || state.skipReason !== "draft") {
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "draft", skippedAtSha: null });
        Object.assign(state, { status: "skipped", skipReason: "draft", skippedAtSha: null });
      }
      return;
    }
    if (this.config.review.skipWip && state.title.toLowerCase().startsWith("wip")) {
      if (state.status !== "skipped" || state.skipReason !== "wip_title") {
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "wip_title", skippedAtSha: null });
        Object.assign(state, { status: "skipped", skipReason: "wip_title", skippedAtSha: null });
      }
      return;
    }

    // 5. Check if we should review
    const decision = shouldReview(state, this.config.review, pr.forceReview);
    if (!decision.shouldReview) {
      return;
    }

    console.log(`Reviewing ${label} (${headSha.slice(0, 7)}) — reason: ${decision.reason}`);

    // 5. Set status to reviewing (lock)
    this.store.setStatus(owner, repo, prNumber, "reviewing");

    // 6. Fetch diff
    let diff: string;
    try {
      diff = await getPRDiff(owner, repo, prNumber);
    } catch (err) {
      this.recordError(state, headSha, err, "diff_fetch");
      return;
    }

    // 7. Check diff size
    const lineCount = diff.split("\n").length;
    if (lineCount > this.config.review.maxDiffLines) {
      console.log(`Skipping ${label}: diff too large (${lineCount} lines > ${this.config.review.maxDiffLines} max)`);
      this.store.update(owner, repo, prNumber, {
        status: "skipped",
        skipReason: "diff_too_large",
        skipDiffLines: lineCount,
        skippedAtSha: headSha,
      });
      return;
    }

    // 8. Build re-review context if applicable
    const lastReview = state.reviews.length > 0 ? state.reviews[state.reviews.length - 1] : null;
    const context = lastReview ? {
      previousVerdict: lastReview.verdict,
      previousSha: lastReview.sha,
    } : undefined;

    // 9. Run Claude review
    const result = await reviewDiff(diff, title, context);
    if (!result.success) {
      this.recordError(state, headSha, new Error(result.body || "Claude review returned unsuccessful"), "claude_review");
      return;
    }

    // 10. Parse verdict
    const verdict = parseVerdict(result.body);

    // 11. Build comment body
    const tag = this.config.review.commentTag;
    const body = `${tag}\n\n${result.body}\n\n---\n*Reviewed by Claude Code at commit ${headSha.slice(0, 7)}*`;

    // 12. Post or update comment
    let commentId: string;
    try {
      const existingId = state.commentId ?? await findExistingComment(owner, repo, prNumber, tag);
      if (existingId) {
        console.log(`Updating existing comment on ${label}`);
        await updateComment(owner, repo, existingId, body);
        commentId = existingId;
      } else {
        console.log(`Posting new comment on ${label}`);
        commentId = await postComment(owner, repo, prNumber, body);
      }
    } catch (err) {
      this.recordError(state, headSha, err, "comment_post");
      return;
    }

    // 13. Record review and transition to reviewed.
    //     Re-read state to check for concurrent lifecycle events (e.g. webhook closed/merged
    //     the PR while the review was in progress — lifecycle events bypass the per-PR mutex).
    const current = this.store.get(owner, repo, prNumber);
    if (current && (current.status === "closed" || current.status === "merged")) {
      console.log(`Review complete for ${label} but PR is now ${current.status} — not overwriting terminal state`);
      return;
    }

    const now = new Date().toISOString();
    const maxHistory = this.config.review.maxReviewHistory;
    const reviews = [...state.reviews, {
      sha: headSha,
      reviewedAt: now,
      commentId,
      verdict,
      posted: true,
    }].slice(-maxHistory);

    this.store.update(owner, repo, prNumber, {
      status: "reviewed",
      reviews,
      lastReviewedSha: headSha,
      lastReviewedAt: now,
      commentId,
      commentVerifiedAt: now,
      lastError: null,
      consecutiveErrors: 0,
      skipReason: null,
      skipDiffLines: null,
      skippedAtSha: null,
    });

    console.log(`Review complete for ${label} — verdict: ${verdict}`);
  }

  private syncMetadata(state: PRState, pr: PullRequest): void {
    const updates: Partial<PRState> = {};
    let changed = false;

    if (state.title !== pr.title) {
      updates.title = pr.title;
      changed = true;
    }
    if (state.isDraft !== pr.isDraft) {
      updates.isDraft = pr.isDraft;
      changed = true;
    }
    if (state.baseBranch !== pr.baseBranch) {
      updates.baseBranch = pr.baseBranch;
      changed = true;
    }
    if (state.headSha !== pr.headSha) {
      updates.headSha = pr.headSha;
      updates.lastPushAt = new Date().toISOString();
      changed = true;
    }

    if (changed) {
      this.store.update(state.owner, state.repo, state.number, updates);
      Object.assign(state, updates);
    }
  }

  private evaluateTransitions(state: PRState): void {
    // Note: store.update() mutates the live state object via Object.assign,
    // so the `state` reference is updated in-place — no manual sync needed.

    // reviewed + new SHA → changes_pushed
    if (state.status === "reviewed" && state.lastReviewedSha && state.headSha !== state.lastReviewedSha) {
      this.store.setStatus(state.owner, state.repo, state.number, "changes_pushed");
    }

    // skipped + condition cleared → pending_review
    if (state.status === "skipped") {
      let cleared = false;
      if (state.skipReason === "draft" && !state.isDraft) cleared = true;
      if (state.skipReason === "wip_title" && !state.title.toLowerCase().startsWith("wip")) cleared = true;
      if (state.skipReason === "diff_too_large" && state.skippedAtSha && state.headSha !== state.skippedAtSha) {
        cleared = true;
      }

      if (cleared) {
        this.store.update(state.owner, state.repo, state.number, {
          status: "pending_review",
          skipReason: null,
          skipDiffLines: null,
          skippedAtSha: null,
        });
      }
    }
  }

  private recordError(state: PRState, sha: string, err: unknown, phase: ErrorPhase): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error in ${phase} for ${state.owner}/${state.repo}#${state.number}:`, message);

    this.store.update(state.owner, state.repo, state.number, {
      status: "error",
      lastError: {
        occurredAt: new Date().toISOString(),
        sha,
        message,
        phase,
      },
      consecutiveErrors: state.consecutiveErrors + 1,
    });
  }
}
