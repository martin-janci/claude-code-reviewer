import type { AppConfig, PullRequest, ReviewVerdict, ReviewFinding, ErrorPhase, PRState } from "../types.js";
import type { StateStore } from "../state/store.js";
import type { CloneManager } from "../clone/manager.js";
import type { MetricsCollector } from "../metrics.js";
import type { ReviewComment } from "./github.js";
import { shouldReview } from "../state/decisions.js";
import { getPRDiff, getPRBody, updatePRBody, getPRLabels, postReview, postComment, updateComment, findExistingComment, getReviewThreads, resolveReviewThread } from "./github.js";
import { reviewDiff } from "./claude.js";
import { parseCommentableLines, findNearestCommentableLine } from "./diff-parser.js";
import { formatReviewBody, formatInlineComment, type JiraLink } from "./formatter.js";
import { extractJiraKey, validateJiraIssue } from "../features/jira.js";
import { generateDescription } from "../features/auto-description.js";
import { computeLabels, applyLabels } from "../features/auto-label.js";

function parseLegacyVerdict(body: string): ReviewVerdict {
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
    private cloneManager?: CloneManager,
    private metrics?: MetricsCollector,
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
    const { owner, repo, number: prNumber, title, headSha, isDraft, baseBranch, headBranch } = pr;
    const label = `${owner}/${repo}#${prNumber}`;

    // 1. Get or create state entry
    const state = this.store.getOrCreate(owner, repo, prNumber, {
      title,
      isDraft,
      headSha,
      baseBranch,
      headBranch,
    });

    // 2. Sync metadata — detect changes
    this.syncMetadata(state, pr);

    // 2b. Jira key extraction (after metadata sync so title/branch are current)
    if (this.config.features.jira.enabled) {
      const currentKey = extractJiraKey(
        state.title,
        state.headBranch,
        this.config.features.jira.projectKeys,
      );
      if (currentKey !== state.jiraKey) {
        this.store.update(owner, repo, prNumber, {
          jiraKey: currentKey,
          jiraValidated: false,
        });
        Object.assign(state, { jiraKey: currentKey, jiraValidated: false });
      }
    }

    // 3. Evaluate transitions
    this.evaluateTransitions(state);

    // 4. Persist skip status for draft/WIP so we don't re-evaluate every cycle.
    //    Also update skip reason if already skipped for a different reason (e.g. diff_too_large → draft).
    if (this.config.review.skipDrafts && state.isDraft) {
      if (pr.forceReview) {
        console.log(`Ignoring /review trigger on ${label}: PR is a draft (skipDrafts is enabled)`);
      }
      if (state.status !== "skipped" || state.skipReason !== "draft") {
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "draft", skippedAtSha: null });
        Object.assign(state, { status: "skipped", skipReason: "draft", skippedAtSha: null });
        this.metrics?.recordSkip("draft");
      }
      return;
    }
    if (this.config.review.skipWip && state.title.toLowerCase().startsWith("wip")) {
      if (pr.forceReview) {
        console.log(`Ignoring /review trigger on ${label}: PR title starts with WIP (skipWip is enabled)`);
      }
      if (state.status !== "skipped" || state.skipReason !== "wip_title") {
        this.store.update(owner, repo, prNumber, { status: "skipped", skipReason: "wip_title", skippedAtSha: null });
        Object.assign(state, { status: "skipped", skipReason: "wip_title", skippedAtSha: null });
        this.metrics?.recordSkip("wip_title");
      }
      return;
    }

    // 5. Check if we should review
    const decision = shouldReview(state, this.config.review, pr.forceReview);
    if (!decision.shouldReview) {
      console.log(`Skipping ${label}: ${decision.reason} (status: ${state.status})`);
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
      this.metrics?.recordSkip("diff_too_large");
      this.store.update(owner, repo, prNumber, {
        status: "skipped",
        skipReason: "diff_too_large",
        skipDiffLines: lineCount,
        skippedAtSha: headSha,
      });
      return;
    }

    // 7b. Auto-generate PR description if enabled and body is empty
    if (this.config.features.autoDescription.enabled && !state.descriptionGenerated) {
      try {
        const currentBody = await getPRBody(owner, repo, prNumber);
        const hasBody = currentBody.trim().length > 0;
        if (!hasBody || this.config.features.autoDescription.overwriteExisting) {
          console.log(`Generating PR description for ${label}`);
          const description = await generateDescription(
            diff, title, this.config.features.autoDescription.timeoutMs,
          );
          if (description) {
            await updatePRBody(owner, repo, prNumber, description);
            console.log(`PR description posted for ${label}`);
          }
        }
        this.store.update(owner, repo, prNumber, { descriptionGenerated: true });
        Object.assign(state, { descriptionGenerated: true });
      } catch (err) {
        // Non-fatal: log and continue with review
        console.warn(`Auto-description failed for ${label}:`, err instanceof Error ? err.message : err);
        this.metrics?.recordError("description_generate");
      }
    }

    // 8. Build re-review context if applicable
    const lastReview = state.reviews.length > 0 ? state.reviews[state.reviews.length - 1] : null;

    // Collect unique findings from ALL previous reviews for thread resolution.
    // Each review iteration may rephrase the same finding, creating different thread
    // bodies on GitHub. We need every unique body to match threads correctly.
    // Deduplicate by path:line:body to avoid exact duplicates while keeping rephrased ones.
    const allPreviousFindings: ReviewFinding[] = [];
    if (state.reviews.length > 0) {
      const seen = new Set<string>();
      for (const rev of state.reviews) {
        for (const f of rev.findings ?? []) {
          const key = `${f.path}:${f.line}:${f.body}`;
          if (!seen.has(key)) {
            seen.add(key);
            allPreviousFindings.push(f);
          }
        }
      }
    }

    const context = lastReview ? {
      previousVerdict: lastReview.verdict,
      previousSha: lastReview.sha,
      previousFindings: allPreviousFindings,
    } : undefined;

    // 8b. Prepare codebase worktree if enabled
    let cwd: string | undefined;
    if (this.cloneManager) {
      try {
        cwd = await this.cloneManager.prepareForPR(owner, repo, prNumber, headSha);
        console.log(`Worktree ready for ${label} at ${cwd}`);
      } catch (err) {
        this.recordError(state, headSha, err, "clone_prepare");
        return;
      }
    }

    // 9. Run Claude review
    console.log(`Starting Claude review for ${label} (timeout: ${this.config.review.reviewTimeoutMs}ms, maxTurns: ${cwd ? this.config.review.reviewMaxTurns : "n/a"}, codebase: ${cwd ? "yes" : "no"})`);
    const result = await reviewDiff({
      diff,
      prTitle: title,
      context,
      cwd,
      timeoutMs: this.config.review.reviewTimeoutMs,
      maxTurns: cwd ? this.config.review.reviewMaxTurns : undefined,
    });

    // 9b. Cleanup worktree (fire-and-forget)
    if (this.cloneManager) {
      this.cloneManager.cleanupPR(owner, repo, prNumber).catch((err) => {
        console.error(`Worktree cleanup failed for ${label}:`, err);
      });
    }

    if (!result.success) {
      console.error(`Claude review failed for ${label}`);
      this.recordError(state, headSha, new Error(result.body || "Claude review returned unsuccessful"), "claude_review");
      return;
    }
    console.log(`Claude review succeeded for ${label} (structured: ${result.structured ? "yes" : "no"})`);


    // 9c. Jira validation (after Claude review, before posting)
    let jiraLink: JiraLink | undefined;
    if (this.config.features.jira.enabled && state.jiraKey) {
      const jiraConfig = this.config.features.jira;
      if (jiraConfig.baseUrl && jiraConfig.email && jiraConfig.token && !state.jiraValidated) {
        try {
          const validation = await validateJiraIssue(
            jiraConfig.baseUrl, jiraConfig.email, jiraConfig.token, state.jiraKey,
          );
          jiraLink = {
            key: state.jiraKey,
            url: validation.url,
            summary: validation.summary,
            valid: validation.valid,
          };
          this.store.update(owner, repo, prNumber, { jiraValidated: validation.valid });
          Object.assign(state, { jiraValidated: validation.valid });
        } catch (err) {
          // Non-fatal: skip Jira link if validation fails
          console.warn(`Jira validation failed for ${state.jiraKey} on ${label}:`, err instanceof Error ? err.message : err);
          this.metrics?.recordError("jira_validate");
          jiraLink = {
            key: state.jiraKey,
            url: `${jiraConfig.baseUrl}/browse/${state.jiraKey}`,
            valid: false,
          };
        }
      } else if (jiraConfig.baseUrl) {
        // Already validated or missing credentials — link without summary
        jiraLink = {
          key: state.jiraKey,
          url: `${jiraConfig.baseUrl}/browse/${state.jiraKey}`,
          valid: state.jiraValidated,
        };
      }
    }

    // 10. Post review — structured (PR Reviews API) or legacy (issue comment)
    const tag = this.config.review.commentTag;
    let verdict: ReviewVerdict;
    let reviewId: string | null = null;
    let commentId: string | null = state.commentId;

    if (result.structured) {
      // Structured path: PR Reviews API with inline comments
      const structured = result.structured;
      verdict = structured.verdict;

      // Auto-escalate verdict if any previous blocking finding is still open
      if (structured.resolutions?.length && context?.previousFindings?.length) {
        const hasOpenBlocking = context.previousFindings.some((pf) => {
          if (!pf.blocking) return false;
          const resolution = structured.resolutions?.find(
            (r) => r.path === pf.path && r.line === pf.line,
          );
          return !resolution || resolution.resolution === "open";
        });
        if (hasOpenBlocking && verdict !== "REQUEST_CHANGES") {
          console.log(`Escalating verdict to REQUEST_CHANGES — unresolved blocking finding(s) on ${label}`);
          verdict = "REQUEST_CHANGES";
        }
      }

      // Parse commentable lines from the diff
      const commentable = parseCommentableLines(diff);

      // Build inline comments, collecting orphans
      const inlineComments: ReviewComment[] = [];
      const orphanFindings: ReviewFinding[] = [];

      for (const finding of structured.findings) {
        const snappedLine = findNearestCommentableLine(commentable, finding.path, finding.line);
        if (snappedLine != null) {
          inlineComments.push({
            path: finding.path,
            line: snappedLine,
            body: formatInlineComment(finding),
          });
        } else {
          orphanFindings.push(finding);
        }
      }

      if (orphanFindings.length > 0) {
        console.log(`${orphanFindings.length} finding(s) could not be placed inline — promoted to review body on ${label}`);
      }

      // Build top-level review body
      const body = formatReviewBody(structured, headSha, tag, orphanFindings, jiraLink);

      try {
        console.log(`Posting PR review on ${label} (${inlineComments.length} inline comment(s), ${orphanFindings.length} orphan(s))`);
        reviewId = await postReview(owner, repo, prNumber, body, headSha, inlineComments);
      } catch (err) {
        this.recordError(state, headSha, err, "comment_post");
        return;
      }

      // 10b. Resolve review threads for findings marked as resolved.
      //
      // A single conceptual issue may span multiple threads across review iterations
      // (e.g. "matching logic is flawed" → "matching logic is still flawed" → fixed).
      // Each iteration creates a new thread with slightly different body text.
      // For each resolved finding, collect ALL previous findings at the same path:line
      // (across all reviews) and resolve any thread whose body matches any of them.
      const resolvedResolutions = structured.resolutions?.filter((r) => r.resolution === "resolved") ?? [];
      if (resolvedResolutions.length > 0 && context?.previousFindings?.length) {
        try {
          console.log(`Fetching review threads for ${label} to resolve ${resolvedResolutions.length} resolved finding(s)`);
          const threads = await getReviewThreads(owner, repo, prNumber);
          console.log(`Found ${threads.length} thread(s) (${threads.filter(t => !t.isResolved).length} unresolved) on ${label}`);
          const unresolvedThreads = threads.filter((t) => !t.isResolved);
          const resolvedIds = new Set<string>();

          for (const resolution of resolvedResolutions) {
            // Find ALL previous findings at this path:line (across review iterations)
            const relatedFindings = context.previousFindings.filter(
              (pf) => pf.path === resolution.path && pf.line === resolution.line,
            );
            if (relatedFindings.length === 0) continue;

            // Resolve any unresolved thread whose body matches any related finding
            for (const thread of unresolvedThreads) {
              if (resolvedIds.has(thread.id)) continue;
              if (thread.path !== resolution.path) continue;
              const matches = relatedFindings.some((pf) => thread.body.includes(pf.body));
              if (matches) {
                await resolveReviewThread(thread.id);
                resolvedIds.add(thread.id);
              }
            }
          }

          if (resolvedIds.size > 0) {
            console.log(`Resolved ${resolvedIds.size} review thread(s) on ${label}`);
          }
        } catch (err) {
          // Non-fatal — thread resolution is best-effort
          console.warn(`Failed to resolve review threads on ${label}:`, err instanceof Error ? err.message : err);
        }
      }
    } else {
      // Fallback path: legacy issue comment
      verdict = parseLegacyVerdict(result.body);
      const body = `${tag}\n\n${result.body}\n\n---\n*Reviewed by Claude Code at commit ${headSha.slice(0, 7)}*`;

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
    }

    // 10c. Auto-labeling (after review is posted)
    if (this.config.features.autoLabel.enabled && result.structured) {
      let labelsMutated = false;
      try {
        const currentLabels = await getPRLabels(owner, repo, prNumber);
        const labelDecision = computeLabels(
          verdict, result.structured.findings, diff,
          this.config.features.autoLabel, currentLabels,
        );
        if (labelDecision.add.length > 0 || labelDecision.remove.length > 0) {
          labelsMutated = true;
          await applyLabels(owner, repo, prNumber, labelDecision);
          console.log(`Labels updated on ${label}: +[${labelDecision.add.join(",")}] -[${labelDecision.remove.join(",")}]`);
        }
      } catch (err) {
        // Non-fatal: log and continue
        console.warn(`Auto-labeling failed for ${label}:`, err instanceof Error ? err.message : err);
        this.metrics?.recordError("label_apply");
      } finally {
        // Always re-fetch from GitHub after any mutation attempt so state
        // reflects reality even on partial failures (e.g. add succeeds, remove fails)
        if (labelsMutated) {
          try {
            const actualLabels = await getPRLabels(owner, repo, prNumber);
            this.store.update(owner, repo, prNumber, { labelsApplied: actualLabels });
            Object.assign(state, { labelsApplied: actualLabels });
          } catch {
            // Best-effort — label state may be stale but review still proceeds
          }
        }
      }
    }

    // 11. Record review and transition to reviewed.
    //     Re-read state to check for concurrent lifecycle events (e.g. webhook closed/merged
    //     the PR while the review was in progress — lifecycle events bypass the per-PR mutex).
    const current = this.store.get(owner, repo, prNumber);
    if (current && (current.status === "closed" || current.status === "merged")) {
      console.log(`Review complete for ${label} but PR is now ${current.status} — not overwriting terminal state`);
      return;
    }

    this.metrics?.recordReview(verdict);

    const now = new Date().toISOString();
    const maxHistory = this.config.review.maxReviewHistory;
    const reviews = [...state.reviews, {
      sha: headSha,
      reviewedAt: now,
      commentId,
      reviewId,
      verdict,
      posted: true,
      findings: result.structured?.findings ?? [],
    }].slice(-maxHistory);

    this.store.update(owner, repo, prNumber, {
      status: "reviewed",
      reviews,
      lastReviewedSha: headSha,
      lastReviewedAt: now,
      commentId,
      commentVerifiedAt: commentId ? now : null,
      reviewId,
      reviewVerifiedAt: reviewId ? now : null,
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
    if (state.headBranch !== pr.headBranch) {
      updates.headBranch = pr.headBranch;
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
    this.metrics?.recordError(phase);
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
