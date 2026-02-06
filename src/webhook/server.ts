import { createServer, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import type { AppConfig, PullRequest, ReviewOverrides } from "../types.js";
import type { Reviewer } from "../reviewer/reviewer.js";
import type { StateStore } from "../state/store.js";
import type { MetricsCollector } from "../metrics.js";
import type { Logger } from "../logger.js";
import type { CloneManager } from "../clone/manager.js";
import { getPRDetails, postComment } from "../reviewer/github.js";
import { executeAutofix } from "../features/autofix.js";
import { PrometheusExporter } from "../prometheus.js";

// Note: execFile is used directly for CLI checks (checkClaudeAuth, checkGhAuth).
// If more endpoints need CLI validation, consider extracting to a shared helper module.

interface AuthStatus {
  available: boolean;
  authenticated: boolean;
  username?: string;
  error?: string;
  lastChecked: number;
}

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

/**
 * Check Claude CLI availability and auth status.
 * Uses direct CLI invocation (no `which`) for Docker compatibility.
 * Note: `--version` doesn't require auth, so this only confirms availability.
 * Auth detection is best-effort via error message heuristics.
 */
function checkClaudeAuth(): Promise<Omit<AuthStatus, "lastChecked">> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) {
        const errMsg = err.message + stderr;
        // ENOENT = command not found
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ available: false, authenticated: false, error: "claude CLI not found" });
          return;
        }
        // Heuristic: error messages containing these strings suggest auth issues
        // This is fragile but claude CLI has no dedicated auth status command
        if (errMsg.includes("not authenticated") || errMsg.includes("login required")) {
          resolve({ available: true, authenticated: false, error: "Not authenticated" });
          return;
        }
        resolve({ available: false, authenticated: false, error: errMsg.slice(0, 100) });
        return;
      }

      // Check stderr for warnings that might indicate broken/incompatible installation
      if (stderr && stderr.trim()) {
        const warning = stderr.slice(0, 100);
        resolve({ available: true, authenticated: true, error: `Warning: ${warning}` });
        return;
      }

      // If --version succeeds without warnings, CLI is available.
      // Auth status is best-effort - we assume authenticated unless proven otherwise.
      resolve({ available: true, authenticated: true });
    });
  });
}

/**
 * Check GitHub CLI availability and auth status.
 * Uses `gh auth status` which reliably reports auth state.
 */
function checkGhAuth(): Promise<Omit<AuthStatus, "lastChecked">> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "status"], { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) {
        // ENOENT = command not found
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ available: false, authenticated: false, error: "gh CLI not found" });
          return;
        }
        // gh auth status exits non-zero if not authenticated
        const output = stdout + stderr;
        resolve({ available: true, authenticated: false, error: output.slice(0, 100) });
        return;
      }
      const usernameMatch = stdout.match(/Logged in to github\.com account (\S+)|as (\S+)/);
      resolve({
        available: true,
        authenticated: true,
        username: usernameMatch?.[1] || usernameMatch?.[2],
      });
    });
  });
}

function getImportantSettings(config: AppConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    repos: config.repos.map(r => `${r.owner}/${r.repo}`),
    polling: {
      intervalSeconds: config.polling.intervalSeconds,
    },
    webhook: {
      port: config.webhook.port,
      path: config.webhook.path,
    },
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
  private authCache: { claude: AuthStatus; github: AuthStatus } | null = null;
  private authRefreshInterval: NodeJS.Timeout | null = null;
  private readonly AUTH_CACHE_TTL_MS = 60_000; // 60 seconds
  private prometheusExporter?: PrometheusExporter;

  constructor(
    private config: AppConfig,
    private reviewer: Reviewer,
    private store: StateStore,
    private logger: Logger,
    private cloneManager?: CloneManager,
    private metrics?: MetricsCollector,
    private auditLogger?: import("../audit/logger.js").AuditLogger,
    private healthInfo?: { version: string; startTime: number },
  ) {
    try {
      this.commentTriggerRegex = new RegExp(config.review.commentTrigger, "m");
    } catch (err) {
      throw new Error(`Invalid commentTrigger regex "${config.review.commentTrigger}": ${err instanceof Error ? err.message : err}`);
    }

    // Initialize Prometheus exporter if metrics are enabled
    if (this.metrics) {
      this.prometheusExporter = new PrometheusExporter();
    }
  }

  private async refreshAuthCache(): Promise<void> {
    const [claudeStatus, ghStatus] = await Promise.all([checkClaudeAuth(), checkGhAuth()]);
    const now = Date.now();
    this.authCache = {
      claude: { ...claudeStatus, lastChecked: now },
      github: { ...ghStatus, lastChecked: now },
    };

    // Audit auth status
    this.auditLogger?.authCheck("claude", claudeStatus.available, claudeStatus.authenticated, claudeStatus.error);
    this.auditLogger?.authCheck("github", ghStatus.available, ghStatus.authenticated, ghStatus.error);
  }

  start(): void {
    const { port, path, secret } = this.config.webhook;

    // Initial auth check (non-blocking)
    this.refreshAuthCache().catch((err) => {
      this.logger.warn("Initial auth check failed", { error: String(err) });
    });

    // Refresh auth cache every 60 seconds
    this.authRefreshInterval = setInterval(() => {
      this.refreshAuthCache().catch((err) => {
        this.logger.warn("Auth cache refresh failed", { error: String(err) });
      });
    }, this.AUTH_CACHE_TTL_MS);

    this.server = createServer((req, res) => {
      // Health check - returns immediately with cached auth status
      if (req.method === "GET" && req.url === "/health") {
        const info = this.healthInfo;
        const baseHealth = info
          ? { status: "ok", version: info.version, uptime: Math.floor((Date.now() - info.startTime) / 1000) }
          : { status: "ok" };

        const enhancedHealth = {
          ...baseHealth,
          settings: getImportantSettings(this.config),
          auth: this.authCache ?? {
            claude: { available: false, authenticated: false, error: "Not yet checked", lastChecked: 0 },
            github: { available: false, authenticated: false, error: "Not yet checked", lastChecked: 0 },
          },
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(enhancedHealth, null, 2));
        return;
      }

      // Metrics endpoint - supports both Prometheus and JSON formats
      if (req.method === "GET" && (req.url === "/metrics" || req.url?.startsWith("/metrics?"))) {
        if (this.metrics && this.healthInfo) {
          const uptime = Math.floor((Date.now() - this.healthInfo.startTime) / 1000);
          const snapshot = this.metrics.snapshot(uptime, this.store.getStatusCounts());

          // Check Accept header or query parameter for format preference
          const acceptHeader = req.headers["accept"] || "";
          const url = new URL(req.url || "", `http://${req.headers.host}`);
          const format = url.searchParams.get("format") || "";

          // Prefer Prometheus format (for Prometheus scraping)
          // Also serve Prometheus if explicitly requested via Accept header or format param
          if (
            this.prometheusExporter &&
            (acceptHeader.includes("text/plain") ||
              acceptHeader.includes("application/openmetrics-text") ||
              format === "prometheus" ||
              !acceptHeader.includes("application/json"))
          ) {
            // Update Prometheus metrics from snapshot
            this.prometheusExporter.updateMetrics(snapshot);

            // Return Prometheus text format (async)
            this.prometheusExporter.getMetrics().then((prometheusText) => {
              res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
              res.end(prometheusText);
            }).catch((err) => {
              this.logger.error("Failed to generate Prometheus metrics", { error: String(err) });
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Failed to generate metrics" }));
            });
          } else {
            // Return JSON format (for debugging, dashboards, etc.)
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(snapshot, null, 2));
          }
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
          this.auditLogger?.webhookReceived(action, owner, repo, prData.number);
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
      const newStatus = isMerged ? "merged" : "closed";
      this.logger.info("Webhook: PR lifecycle", { pr: label, status: newStatus });

      // Get old status before update
      const oldStatus = state?.status ?? "pending_review";

      this.store.update(owner, repo, prNumber, {
        status: newStatus,
        closedAt: now,
      });

      // Audit: state changed
      this.auditLogger?.stateChanged(owner, repo, prNumber, oldStatus, newStatus, "webhook");
    }

    if (action === "converted_to_draft") {
      this.logger.info("Webhook: PR converted to draft", { pr: label });

      // Get old status before update
      const oldStatus = state?.status ?? "pending_review";

      if (this.config.review.skipDrafts) {
        this.store.update(owner, repo, prNumber, {
          status: "skipped",
          isDraft: true,
          skipReason: "draft",
          skippedAtSha: null,
        });
        // Audit: state changed to skipped
        this.auditLogger?.stateChanged(owner, repo, prNumber, oldStatus, "skipped", "webhook");
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

    // Match comment body against configured trigger patterns
    const commentBody = payload.comment?.body ?? "";
    const prNumber = payload.issue.number;
    const commenter = payload.comment?.user?.login ?? "unknown";

    // Check for /fix trigger
    if (this.config.features.autofix.enabled) {
      const autofixRegex = new RegExp(this.config.features.autofix.commandTrigger);
      if (autofixRegex.test(commentBody)) {
        this.logger.info("Webhook: /fix trigger", { pr: `${owner}/${repo}#${prNumber}`, commenter });
        res.writeHead(202);
        res.end("Accepted");

        this.triggerAutofix(owner, repo, prNumber, commenter).catch((err) => {
          this.logger.error("Webhook autofix-trigger error", { pr: `${owner}/${repo}#${prNumber}`, error: String(err) });
        });
        return;
      }
    }

    // Check for /review trigger
    if (!this.commentTriggerRegex.test(commentBody)) {
      res.writeHead(200);
      res.end("No trigger match");
      return;
    }

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

  private async pushToPRBranch(
    owner: string,
    repo: string,
    prNumber: number,
    headBranch: string,
    commitSha: string,
    filesChanged: number,
    worktreePath: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      // Use -c credential.helper= to disable credential helpers that might override token
      execFile("git", ["-c", "credential.helper=", "push", "origin", headBranch], { cwd: worktreePath }, (pushErr) => {
        if (pushErr) {
          const pushErrorMsg = `⚠️ **Autofix completed** but push failed: ${String(pushErr)}\n\nCommit SHA: \`${commitSha}\``;
          postComment(owner, repo, prNumber, pushErrorMsg).catch((commentErr) => {
            this.logger.error("Failed to post push error comment", { pr: `${owner}/${repo}#${prNumber}`, error: String(commentErr) });
          });
          this.logger.error("Autofix push failed", { pr: `${owner}/${repo}#${prNumber}`, error: String(pushErr) });
        } else {
          const successMsg = `✅ **Autofix applied successfully**\n\n📦 Commit: [\`${commitSha.slice(0, 7)}\`](../../commit/${commitSha})\n📁 Files changed: ${filesChanged}\n\nFixes have been pushed to the PR branch.`;
          postComment(owner, repo, prNumber, successMsg).catch((commentErr) => {
            this.logger.error("Failed to post success comment", { pr: `${owner}/${repo}#${prNumber}`, error: String(commentErr) });
          });
          this.logger.info("Autofix completed and pushed", { pr: `${owner}/${repo}#${prNumber}`, sha: commitSha, filesChanged });
        }
        resolve();
      });
    });
  }

  private async createAndPushFixBranch(
    owner: string,
    repo: string,
    prNumber: number,
    fixBranch: string,
    commitSha: string,
    filesChanged: number,
    worktreePath: string,
  ): Promise<void> {
    this.logger.info("Creating fix branch", { pr: `${owner}/${repo}#${prNumber}`, branch: fixBranch });

    return new Promise((resolve) => {
      // Create new branch from current commit
      execFile("git", ["checkout", "-b", fixBranch], { cwd: worktreePath }, (checkoutErr) => {
        if (checkoutErr) {
          // Branch might already exist, try to switch to it and reset
          execFile("git", ["checkout", fixBranch], { cwd: worktreePath }, (switchErr) => {
            if (switchErr) {
              const branchErrorMsg = `⚠️ **Autofix completed** but failed to create branch \`${fixBranch}\`: ${String(checkoutErr)}`;
              postComment(owner, repo, prNumber, branchErrorMsg).catch((commentErr) => {
                this.logger.error("Failed to post branch error comment", { pr: `${owner}/${repo}#${prNumber}`, error: String(commentErr) });
              });
              this.logger.error("Failed to create fix branch", { pr: `${owner}/${repo}#${prNumber}`, error: String(checkoutErr) });
              resolve();
              return;
            }
            // Reset to the fix commit
            execFile("git", ["reset", "--hard", commitSha], { cwd: worktreePath }, (resetErr) => {
              if (resetErr) {
                const resetErrorMsg = `⚠️ **Autofix completed** but failed to reset branch: ${String(resetErr)}`;
                postComment(owner, repo, prNumber, resetErrorMsg).catch((commentErr) => {
                  this.logger.error("Failed to post reset error comment", { pr: `${owner}/${repo}#${prNumber}`, error: String(commentErr) });
                });
                resolve();
                return;
              }
              this.pushFixBranchToRemote(owner, repo, prNumber, fixBranch, commitSha, filesChanged, worktreePath).then(resolve);
            });
          });
          return;
        }

        // Successfully created branch, now push it
        this.pushFixBranchToRemote(owner, repo, prNumber, fixBranch, commitSha, filesChanged, worktreePath).then(resolve);
      });
    });
  }

  private async pushFixBranchToRemote(
    owner: string,
    repo: string,
    prNumber: number,
    fixBranch: string,
    commitSha: string,
    filesChanged: number,
    worktreePath: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      // Use -c credential.helper= to disable credential helpers that might override token
      execFile("git", ["-c", "credential.helper=", "push", "-f", "origin", fixBranch], { cwd: worktreePath }, (pushErr) => {
        if (pushErr) {
          const pushErrorMsg = `⚠️ **Autofix completed** but push to \`${fixBranch}\` failed: ${String(pushErr)}\n\nCommit SHA: \`${commitSha}\``;
          postComment(owner, repo, prNumber, pushErrorMsg).catch((commentErr) => {
            this.logger.error("Failed to post push error comment", { pr: `${owner}/${repo}#${prNumber}`, error: String(commentErr) });
          });
          this.logger.error("Fix branch push failed", { pr: `${owner}/${repo}#${prNumber}`, branch: fixBranch, error: String(pushErr) });
        } else {
          const compareUrl = `../../compare/${fixBranch}`;
          const successMsg = `✅ **Autofix completed and pushed to separate branch**\n\n🌿 Branch: [\`${fixBranch}\`](../../tree/${fixBranch})\n📦 Commit: [\`${commitSha.slice(0, 7)}\`](../../commit/${commitSha})\n📁 Files changed: ${filesChanged}\n🔍 [View changes](${compareUrl})\n\n**Next steps:**\n1. Review the changes in the [\`${fixBranch}\`](../../tree/${fixBranch}) branch\n2. If satisfied, merge into this PR: \`git merge ${fixBranch}\`\n3. Or cherry-pick specific commits: \`git cherry-pick ${commitSha.slice(0, 7)}\``;
          postComment(owner, repo, prNumber, successMsg).catch((commentErr) => {
            this.logger.error("Failed to post success comment", { pr: `${owner}/${repo}#${prNumber}`, error: String(commentErr) });
          });
          this.logger.info("Autofix completed and pushed to fix branch", { pr: `${owner}/${repo}#${prNumber}`, branch: fixBranch, sha: commitSha, filesChanged });
        }
        resolve();
      });
    });
  }

  private async triggerAutofix(owner: string, repo: string, prNumber: number, commenter: string): Promise<void> {
    if (!this.cloneManager) {
      const errorMsg = "🚫 **Autofix unavailable**: Codebase access is disabled. Enable `review.codebaseAccess` in config.yaml.";
      await postComment(owner, repo, prNumber, errorMsg);
      this.logger.warn("Autofix requires codebaseAccess", { pr: `${owner}/${repo}#${prNumber}` });
      return;
    }

    try {
      // Post "working on it" comment
      const workingMsg = `🔧 **Autofix started** by @${commenter}\n\nAnalyzing review findings and applying fixes...`;
      await postComment(owner, repo, prNumber, workingMsg);

      // Fetch PR details
      const pr = await getPRDetails(owner, repo, prNumber);

      // Prepare worktree for this PR
      const worktreePath = await this.cloneManager.prepareForPR(owner, repo, prNumber, pr.headSha);

      // Execute autofix
      const result = await executeAutofix(this.config, pr, worktreePath, this.logger);

      if (!result.success) {
        const errorMsg = `❌ **Autofix failed**: ${result.error ?? "Unknown error"}`;
        await postComment(owner, repo, prNumber, errorMsg);
        this.logger.error("Autofix failed", { pr: `${owner}/${repo}#${prNumber}`, error: result.error });
        return;
      }

      // Handle pushing the fix commit
      if (this.config.features.autofix.autoApply && result.commitSha) {
        // autoApply enabled: push directly to PR branch
        await this.pushToPRBranch(owner, repo, prNumber, pr.headBranch, result.commitSha, result.filesChanged, worktreePath);
      } else if (result.fixBranch && result.commitSha) {
        // autoApply disabled: create and push to separate fix branch
        await this.createAndPushFixBranch(owner, repo, prNumber, result.fixBranch, result.commitSha, result.filesChanged, worktreePath);
      } else {
        // No commit created or no fix branch specified
        const noChangesMsg = `ℹ️ **Autofix completed** but no changes were made.\n\nNo fixable issues were found in the review findings.`;
        await postComment(owner, repo, prNumber, noChangesMsg);
        this.logger.info("Autofix completed with no changes", { pr: `${owner}/${repo}#${prNumber}` });
      }
    } catch (err) {
      const errorMsg = `❌ **Autofix error**: ${err instanceof Error ? err.message : String(err)}`;
      await postComment(owner, repo, prNumber, errorMsg);
      this.logger.error("Autofix execution error", { pr: `${owner}/${repo}#${prNumber}`, error: String(err) });
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Clear auth refresh interval
      if (this.authRefreshInterval) {
        clearInterval(this.authRefreshInterval);
        this.authRefreshInterval = null;
      }

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
