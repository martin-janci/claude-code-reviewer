import { createServer, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig, PullRequest } from "../types.js";
import type { Reviewer } from "../reviewer/reviewer.js";
import type { StateStore } from "../state/store.js";

function verifySignature(secret: string, payload: Buffer, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// Actions that trigger a full review cycle via processPR
const REVIEW_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];

// Actions that update state directly without review
const LIFECYCLE_ACTIONS = ["closed", "converted_to_draft"];

// "edited" only triggers review if the title changed (WIP detection)
const CONDITIONAL_ACTIONS = ["edited"];

export class WebhookServer {
  private server: Server | null = null;

  constructor(
    private config: AppConfig,
    private reviewer: Reviewer,
    private store: StateStore,
  ) {}

  start(): void {
    const { port, path, secret } = this.config.webhook;

    this.server = createServer((req, res) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
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
          if (event !== "pull_request") {
            res.writeHead(200);
            res.end("Ignored event");
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

          console.log(`Webhook: PR #${prData.number} ${action} in ${owner}/${repo}`);
          res.writeHead(202);
          res.end("Accepted");

          // Handle lifecycle events directly
          if (isLifecycleAction) {
            try {
              this.handleLifecycleEvent(action, owner, repo, prData);
            } catch (err) {
              console.error(`Webhook lifecycle error for ${owner}/${repo}#${prData.number}:`, err);
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
            console.error(`Webhook: malformed PR payload for ${owner}/${repo}#${prData.number} — missing head.sha or base.ref`);
            return;
          }

          // Handle review actions via processPR
          const pr: PullRequest = {
            number: prData.number,
            title: prData.title,
            headSha: prData.head.sha,
            isDraft: prData.draft,
            baseBranch: prData.base.ref,
            owner,
            repo,
          };

          this.reviewer.processPR(pr).catch((err) => {
            console.error(`Webhook review error for ${owner}/${repo}#${pr.number}:`, err);
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
      console.log(`Webhook server listening on port ${port} at ${path}`);
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
      });
    }

    if (action === "closed") {
      const isMerged = prData.merged === true;
      const now = new Date().toISOString();
      console.log(`Webhook: ${label} ${isMerged ? "merged" : "closed"}`);
      this.store.update(owner, repo, prNumber, {
        status: isMerged ? "merged" : "closed",
        closedAt: now,
      });
    }

    if (action === "converted_to_draft") {
      console.log(`Webhook: ${label} converted to draft`);
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

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log("Webhook server stopped");
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
