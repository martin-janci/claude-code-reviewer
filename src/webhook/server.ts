import { createServer, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig, PullRequest, ReviewOverrides } from "../types.js";
import type { Reviewer } from "../reviewer/reviewer.js";
import type { StateStore } from "../state/store.js";
import type { MetricsCollector } from "../metrics.js";
import type { Logger } from "../logger.js";
import { getPRDetails, postComment } from "../reviewer/github.js";

const execFileAsync = promisify(execFile);

function verifySignature(secret: string, payload: Buffer, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Parse /review comment arguments.
 * Supported: --max-turns=N, --skip-description, --skip-labels, --focus=path1,path2
 */
function parseReviewOverrides(commentBody: string): ReviewOverrides | undefined {
  const overrides: ReviewOverrides = {};
  let hasOverrides = false;

  // --max-turns=N
  const maxTurnsMatch = commentBody.match(/--max-turns=(\d+)/);
  if (maxTurnsMatch) {
    overrides.maxTurns = parseInt(maxTurnsMatch[1], 10);
    hasOverrides = true;
  }

  // --skip-description
  if (/--skip-description\b/.test(commentBody)) {
    overrides.skipDescription = true;
    hasOverrides = true;
  }

  // --skip-labels
  if (/--skip-labels\b/.test(commentBody)) {
    overrides.skipLabels = true;
    hasOverrides = true;
  }

  // --focus=path1,path2,path3
  const focusMatch = commentBody.match(/--focus=([^\s]+)/);
  if (focusMatch) {
    overrides.focusPaths = focusMatch[1].split(",").map((p) => p.trim()).filter(Boolean);
    if (overrides.focusPaths.length > 0) hasOverrides = true;
  }

  return hasOverrides ? overrides : undefined;
}

function sanitizeConfig(config: AppConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    polling: config.polling,
    webhook: {
      port: config.webhook.port,
      path: config.webhook.path,
      secret: config.webhook.secret ? "[REDACTED]" : "(not set)",
    },
    github: {
      token: config.github.token ? "[REDACTED]" : "(not set)",
    },
    repos: config.repos,
    review: {
      ...config.review,
    },
    features: {
      jira: {
        ...config.features.jira,
        token: config.features.jira.token ? "[REDACTED]" : "(not set)",
        email: config.features.jira.email ? "[REDACTED]" : "(not set)",
      },
      autoDescription: config.features.autoDescription,
      autoLabel: config.features.autoLabel,
    },
  };
}

async function checkClaudeAuth(): Promise<{ available: boolean; authenticated: boolean; error?: string }> {
  try {
    // Check if claude CLI is available
    const { stdout } = await execFileAsync("which", ["claude"], { timeout: 2000 });
    if (!stdout.trim()) {
      return { available: false, authenticated: false, error: "claude CLI not found in PATH" };
    }

    // Try to run a simple command to verify authentication
    // The 'code' command should fail if not authenticated
    await execFileAsync("claude", ["code", "--help"], { timeout: 3000 });
    return { available: true, authenticated: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // If claude is available but command fails, it might be auth issue
    if (errMsg.includes("not authenticated") || errMsg.includes("login")) {
      return { available: true, authenticated: false, error: "Not authenticated" };
    }
    return { available: false, authenticated: false, error: errMsg.slice(0, 100) };
  }
}

async function checkGhAuth(): Promise<{ available: boolean; authenticated: boolean; username?: string; error?: string }> {
  try {
    // Check if gh CLI is available and authenticated
    const { stdout } = await execFileAsync("gh", ["auth", "status"], { timeout: 2000 });
    const usernameMatch = stdout.match(/Logged in to github\.com as (\S+)/);
    return {
      available: true,
      authenticated: true,
      username: usernameMatch?.[1],
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { available: false, authenticated: false, error: errMsg.slice(0, 100) };
  }
}

function getImportantSettings(config: AppConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    repos: config.repos.map(r => `${r.owner}/${r.repo}`),
    review: {
      maxDiffLines: config.review.maxDiffLines,
      skipDrafts: config.review.skipDrafts,
      skipWip: config.review.skipWip,
      maxRetries: config.review.maxRetries,
      codebaseAccess: config.review.codebaseAccess,
      maxConcurrentReviews: config.review.maxConcurrentReviews,
      confidenceThreshold: config.review.confidenceThreshold,
      dryRun: config.review.dryRun,
    },
    features: {
      jira: config.features.jira.enabled,
      autoDescription: config.features.autoDescription.enabled,
      autoLabel: config.features.autoLabel.enabled,
      slack: config.features.slack.enabled,
    },
  };
}

// Actions that trigger a full review cycle via processPR
const REVIEW_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];

// Actions that update state directly without review
const LIFECYCLE_ACTIONS = ["closed", "converted_to_draft"];

// "edited" only triggers review if the title changed (WIP detection)
const CONDITIONAL_ACTIONS = ["edited"];

export class WebhookServer {
  private server: Server | null = null;
  private commentTriggerRegex: RegExp;

  constructor(
    private config: AppConfig,
    private reviewer: Reviewer,
    private store: StateStore,
    private logger: Logger,
    private metrics?: MetricsCollector,
    private healthInfo?: { version: string; startTime: number },
  ) {
    try {
      this.commentTriggerRegex = new RegExp(config.review.commentTrigger, "m");
    } catch (err) {
      throw new Error(`Invalid commentTrigger regex "${config.review.commentTrigger}": ${err instanceof Error ? err.message : err}`);
    }
  }

  start(): void {
    const { port, path, secret } = this.config.webhook;

    this.server = createServer((req, res) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        const info = this.healthInfo;
        const baseHealth = info
          ? { status: "ok", version: info.version, uptime: Math.floor((Date.now() - info.startTime) / 1000) }
          : { status: "ok" };

        // Async auth checks - run in background, don't block response
        Promise.all([checkClaudeAuth(), checkGhAuth()])
          .then(([claudeStatus, ghStatus]) => {
            const enhancedHealth = {
              ...baseHealth,
              settings: getImportantSettings(this.config),
              auth: {
                claude: claudeStatus,
                github: ghStatus,
              },
            };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(enhancedHealth, null, 2));
          })
          .catch(() => {
            // Fallback to basic health if checks fail
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(baseHealth));
          });
        return;
      }

      // Metrics endpoint
      if (req.method === "GET" && req.url === "/metrics") {
        if (this.metrics && this.healthInfo) {
          const uptime = Math.floor((Date.now() - this.healthInfo.startTime) / 1000);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.metrics.snapshot(uptime, this.store.getStatusCounts())));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Metrics not configured" }));
        }
        return;
      }

      // Debug/state inspection endpoint
      if (req.method === "GET" && req.url === "/debug") {
        const allPRs = this.store.getAll();
        const statusCounts = this.store.getStatusCounts();
        const uptime = this.healthInfo ? Math.floor((Date.now() - this.healthInfo.startTime) / 1000) : 0;

        const debugInfo = {
          version: this.healthInfo?.version ?? "unknown",
          uptime,
          config: sanitizeConfig(this.config),
          state: {
            totalPRs: allPRs.length,
            byStatus: statusCounts,
            entries: allPRs.map((pr) => ({
              key: `${pr.owner}/${pr.repo}#${pr.number}`,
              status: pr.status,
              headSha: pr.headSha.slice(0, 7),
              lastReviewedSha: pr.lastReviewedSha?.slice(0, 7) ?? null,
              consecutiveErrors: pr.consecutiveErrors,
              lastError: pr.lastError ? {
                phase: pr.lastError.phase,
                kind: pr.lastError.kind,
                message: pr.lastError.message.slice(0, 100),
                occurredAt: pr.lastError.occurredAt,
              } : null,
              reviewCount: pr.reviews.length,
              updatedAt: pr.updatedAt,
              recentFeatures: pr.featureExecutions?.slice(-5).map((fe) => ({
                feature: fe.feature,
                status: fe.status,
                durationMs: fe.durationMs,
                error: fe.error?.slice(0, 50),
              })) ?? [],
            })),
          },
          capacity: {
            inflightReviews: this.reviewer.inflight,
            lockedPRs: this.reviewer.lockKeys,
          },
          metrics: this.metrics && this.healthInfo
            ? this.metrics.snapshot(uptime, statusCounts)
            : null,
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(debugInfo, null, 2));
        return;
      }

      // Webhook endpoint
      if (req.method === "POST" && req.url === path) {
        const MAX_BODY = 1024 * 1024; // 1MB
        const chunks: Buffer[] = [];
        let bodyLen = 0;
        let aborted = false;

        req.on("error", () => { aborted = true; });
        req.on("data", (chunk: Buffer) => {
          if (aborted) return;
          bodyLen += chunk.length;
          if (bodyLen > MAX_BODY) {
            aborted = true;
            res.writeHead(413);
            res.end("Payload too large");
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          if (aborted) return;
          const rawBody = Buffer.concat(chunks);

          // Verify signature if secret is set
          if (secret) {
            const sig = req.headers["x-hub-signature-256"] as string | undefined;
            if (!sig || !verifySignature(secret, rawBody, sig)) {
              res.writeHead(401);
              res.end("Invalid signature");
              return;
            }
          }

          const body = rawBody.toString("utf-8");

          const event = req.headers["x-github-event"] as string;
          if (event !== "pull_request" && event !== "issue_comment" && event !== "push") {
            this.logger.info("Webhook: ignored event type", { event });
            res.writeHead(200);
            res.end("Ignored event");
            return;
          }

          // Push events are accepted but not processed — PR synchronize handles reviews
          if (event === "push") {
            res.writeHead(200);
            res.end("OK");
            return;
          }

          let payload: any;
          try {
            payload = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end("Invalid JSON");
            return;
          }

          // Handle issue_comment events (PR comment triggers)
          if (event === "issue_comment") {
            this.handleIssueComment(payload, res);
            return;
          }

          const action = payload.action;
          const isReviewAction = REVIEW_ACTIONS.includes(action);
          const isLifecycleAction = LIFECYCLE_ACTIONS.includes(action);
          const isConditionalAction = CONDITIONAL_ACTIONS.includes(action);

          if (!isReviewAction && !isLifecycleAction && !isConditionalAction) {
            res.writeHead(200);
            res.end("Ignored action");
            return;
          }

          const prData = payload.pull_request;
          const repoData = payload.repository;
          if (!prData || !repoData?.full_name) {
            res.writeHead(400);
            res.end("Missing pull_request or repository in payload");
            return;
          }
          const [owner, repo] = repoData.full_name.split("/");

          // Check if this repo is in our config
          const isTracked = this.config.repos.some(
            (r) => r.owner === owner && r.repo === repo,
          );
          if (!isTracked) {
            res.writeHead(200);
            res.end("Repo not tracked");
            return;
          }

          this.logger.info("Webhook: PR event", { pr: `${owner}/${repo}#${prData.number}`, action });
          res.writeHead(202);
          res.end("Accepted");

          // Handle lifecycle events directly
          if (isLifecycleAction) {
            try {
              this.handleLifecycleEvent(action, owner, repo, prData);
            } catch (err) {
              this.logger.error("Webhook lifecycle error", { pr: `${owner}/${repo}#${prData.number}`, error: String(err) });
            }
            return;
          }

          // "edited" — only trigger review if the title changed
          if (isConditionalAction) {
            const titleChanged = payload.changes?.title !== undefined;
            if (!titleChanged) {
              return;
            }
          }

          // Validate nested payload fields before accessing
          if (!prData.head?.sha || !prData.base?.ref) {
            this.logger.error("Webhook: malformed PR payload — missing head.sha or base.ref", { pr: `${owner}/${repo}#${prData.number}` });
            return;
          }

          // Handle review actions via processPR
          const pr: PullRequest = {
            number: prData.number,
            title: prData.title,
            headSha: prData.head.sha,
            isDraft: prData.draft,
            baseBranch: prData.base.ref,
            headBranch: prData.head.ref,
            owner,
            repo,
          };

          this.logger.info("Webhook: Triggering review", { pr: `${owner}/${repo}#${pr.number}`, sha: pr.headSha.slice(0, 7), action });
          this.reviewer.processPR(pr).catch((err) => {
            this.logger.error("Webhook review error", { pr: `${owner}/${repo}#${pr.number}`, error: String(err) });
          });
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    this.server.maxConnections = 100;
    this.server.setTimeout(30_000);
    this.server.keepAliveTimeout = 5_000;

    this.server.listen(port, () => {
      this.logger.info("Webhook server listening", { port, path });
    });
  }

  private handleLifecycleEvent(action: string, owner: string, repo: string, prData: any): void {
    const prNumber = prData.number;
    const label = `${owner}/${repo}#${prNumber}`;

    const state = this.store.get(owner, repo, prNumber);
    if (!state) {
      // No state entry — create one for tracking
      this.store.getOrCreate(owner, repo, prNumber, {
        title: prData.title,
        isDraft: prData.draft,
        headSha: prData.head?.sha ?? "",
        baseBranch: prData.base?.ref ?? "",
        headBranch: prData.head?.ref ?? "",
      });
    }

    if (action === "closed") {
      const isMerged = prData.merged === true;
      const now = new Date().toISOString();
      this.logger.info("Webhook: PR lifecycle", { pr: label, status: isMerged ? "merged" : "closed" });
      this.store.update(owner, repo, prNumber, {
        status: isMerged ? "merged" : "closed",
        closedAt: now,
      });
    }

    if (action === "converted_to_draft") {
      this.logger.info("Webhook: PR converted to draft", { pr: label });
      if (this.config.review.skipDrafts) {
        this.store.update(owner, repo, prNumber, {
          status: "skipped",
          isDraft: true,
          skipReason: "draft",
          skippedAtSha: null,
        });
      } else {
        // skipDrafts is disabled — just update the draft flag without skipping
        this.store.update(owner, repo, prNumber, { isDraft: true });
      }
    }
  }

  private handleIssueComment(payload: any, res: any): void {
    // Only handle newly created comments
    if (payload.action !== "created") {
      res.writeHead(200);
      res.end("Ignored comment action");
      return;
    }

    // Only handle comments on PRs (not plain issues)
    if (!payload.issue?.pull_request) {
      res.writeHead(200);
      res.end("Not a PR comment");
      return;
    }

    // Prevent feedback loops from bot comments
    if (payload.comment?.user?.type === "Bot") {
      res.writeHead(200);
      res.end("Ignored bot comment");
      return;
    }

    const repoData = payload.repository;
    if (!repoData?.full_name) {
      res.writeHead(400);
      res.end("Missing repository in payload");
      return;
    }
    const [owner, repo] = repoData.full_name.split("/");

    // Check if this repo is tracked
    const isTracked = this.config.repos.some(
      (r) => r.owner === owner && r.repo === repo,
    );
    if (!isTracked) {
      res.writeHead(200);
      res.end("Repo not tracked");
      return;
    }

    // Match comment body against the configured trigger pattern
    const commentBody = payload.comment?.body ?? "";
    if (!this.commentTriggerRegex.test(commentBody)) {
      res.writeHead(200);
      res.end("No trigger match");
      return;
    }

    const prNumber = payload.issue.number;
    const commenter = payload.comment?.user?.login ?? "unknown";
    const overrides = parseReviewOverrides(commentBody);

    this.logger.info("Webhook: /review trigger", {
      pr: `${owner}/${repo}#${prNumber}`,
      commenter,
      overrides: overrides ?? "none",
    });

    res.writeHead(202);
    res.end("Accepted");

    this.triggerCommentReview(owner, repo, prNumber, overrides).catch((err) => {
      this.logger.error("Webhook comment-trigger error", { pr: `${owner}/${repo}#${prNumber}`, error: String(err) });
    });
  }

  private async triggerCommentReview(owner: string, repo: string, prNumber: number, overrides?: ReviewOverrides): Promise<void> {
    const pr = await getPRDetails(owner, repo, prNumber);
    pr.forceReview = true;
    pr.overrides = overrides;
    const result = await this.reviewer.processPR(pr);

    // If the review was skipped, post a reply comment explaining why
    if (result.outcome === "skipped" && result.skipReason) {
      try {
        const skipMessage = `⏭️ **Review skipped**: ${result.skipReason}`;
        await postComment(owner, repo, prNumber, skipMessage);
        this.logger.info("Posted skip reason comment", { pr: `${owner}/${repo}#${prNumber}`, reason: result.skipReason });
      } catch (err) {
        this.logger.warn("Failed to post skip reason comment", { pr: `${owner}/${repo}#${prNumber}`, error: String(err) });
      }
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info("Webhook server stopped");
          resolve();
        });
        // Drain idle keep-alive connections so close() resolves promptly
        this.server.closeAllConnections();
      } else {
        resolve();
      }
    });
  }
}
