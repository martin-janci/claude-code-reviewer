import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import type { ConfigManager } from "../config-manager.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import type { MetricsCollector } from "../metrics.js";
import type { UsageStore } from "../usage/store.js";
import type { RateLimitGuard } from "../rate-limit-guard.js";
import { getDashboardHtml } from "./html.js";
import { checkClaudeAuth, checkGhAuth } from "../auth-check.js";

export class DashboardServer {
  private server: Server | null = null;
  private updateInProgress = false;

  constructor(
    private configManager: ConfigManager,
    private logger: Logger,
    private store?: StateStore,
    private metrics?: MetricsCollector,
    private healthInfo?: { version: string; startTime: number },
    private usageStore?: UsageStore,
    private rateLimitGuard?: RateLimitGuard,
  ) {}

  start(port: number): void {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error("Dashboard request error", { error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });

    this.server.listen(port, () => {
      this.logger.info("Dashboard server listening", { port });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info("Dashboard server stopped");
          resolve();
        });
        this.server.closeAllConnections();
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth check — reject early before any further processing
    if (!this.isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // Serve dashboard page
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml());
      return;
    }

    // GET /api/config — return redacted config + metadata
    if (req.method === "GET" && path === "/api/config") {
      const data = this.configManager.getRedactedConfig();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    // PUT /api/config — apply partial update
    if (req.method === "PUT" && path === "/api/config") {
      const body = await this.readBody(req);
      if (!body) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Empty request body" }));
        return;
      }

      let partial: Record<string, unknown>;
      try {
        partial = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const result = this.configManager.applyUpdate(partial);
      const status = result.success ? 200 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/config/validate — dry-run validation
    if (req.method === "POST" && path === "/api/config/validate") {
      const body = await this.readBody(req);
      if (!body) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Empty request body" }));
        return;
      }

      let partial: Record<string, unknown>;
      try {
        partial = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const result = this.configManager.validateUpdate(partial);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/health — proxy health/debug info
    if (req.method === "GET" && path === "/api/health") {
      const info = this.healthInfo;
      const uptime = info ? Math.floor((Date.now() - info.startTime) / 1000) : 0;
      const statusCounts = this.store?.getStatusCounts() ?? {};
      const allPRs = this.store?.getAll() ?? [];

      const rlStatus = this.rateLimitGuard?.getStatus();
      const rateLimitMetrics = rlStatus ? {
        paused: rlStatus.state !== "active",
        pauseCount: rlStatus.pauseCount,
        queueDepth: rlStatus.queueDepth,
        cooldownRemainingSeconds: rlStatus.cooldownRemainingSeconds,
      } : undefined;

      const healthData = {
        status: "ok",
        version: info?.version ?? "unknown",
        uptime,
        state: {
          totalPRs: allPRs.length,
          byStatus: statusCounts,
        },
        metrics: this.metrics && info
          ? this.metrics.snapshot(uptime, statusCounts, rateLimitMetrics)
          : null,
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(healthData, null, 2));
      return;
    }

    // GET /api/claude/version — return current Claude CLI version
    if (req.method === "GET" && path === "/api/claude/version") {
      try {
        const version = await this.getClaudeVersion();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ version }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/claude/auth — check Claude and GitHub CLI auth status
    if (req.method === "GET" && path === "/api/claude/auth") {
      try {
        const [claude, github] = await Promise.all([checkClaudeAuth(), checkGhAuth()]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ claude, github }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/usage/summary — aggregated usage with per-repo breakdown
    if (req.method === "GET" && path === "/api/usage/summary") {
      if (!this.usageStore) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Usage tracking is not enabled" }));
        return;
      }
      const days = parseInt(url.searchParams.get("days") ?? "30", 10) || 30;
      const summary = this.usageStore.getOverallSummary(days);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(summary));
      return;
    }

    // GET /api/usage/recent — recent usage records
    if (req.method === "GET" && path === "/api/usage/recent") {
      if (!this.usageStore) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Usage tracking is not enabled" }));
        return;
      }
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10) || 50;
      const records = this.usageStore.getRecentRecords(Math.min(limit, 200));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(records));
      return;
    }

    // GET /api/rate-limit — rate limit guard status
    if (req.method === "GET" && path === "/api/rate-limit") {
      if (!this.rateLimitGuard) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ state: "active", pausedSince: null, resumesAt: null, queueDepth: 0, pauseCount: 0, cooldownRemainingSeconds: 0, events: [] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.rateLimitGuard.getStatus()));
      return;
    }

    // POST /api/rate-limit/resume — manually resume from rate limit pause
    if (req.method === "POST" && path === "/api/rate-limit/resume") {
      if (!this.rateLimitGuard) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ state: "active" }));
        return;
      }
      this.rateLimitGuard.resume("manual");
      this.logger.info("Rate limit guard manually resumed via dashboard");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.rateLimitGuard.getStatus()));
      return;
    }

    // POST /api/claude/update — update Claude CLI via npm
    if (req.method === "POST" && path === "/api/claude/update") {
      if (this.updateInProgress) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Update already in progress" }));
        return;
      }

      this.updateInProgress = true;
      try {
        const before = await this.getClaudeVersion().catch(() => "unknown");
        await this.runNpmInstall();
        const after = await this.getClaudeVersion().catch(() => "unknown");
        this.logger.info("Claude CLI updated", { before, after });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ before, after }));
      } catch (err) {
        this.logger.error("Claude CLI update failed", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      } finally {
        this.updateInProgress = false;
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  /** Pure auth check — returns true if request is authorized, false otherwise. */
  private isAuthorized(req: IncomingMessage): boolean {
    const config = this.configManager.getConfig();
    const token = config.dashboard?.token;
    if (!token) return true; // No auth configured

    const authHeader = req.headers.authorization;
    const expected = `Bearer ${token}`;

    // Use timing-safe comparison to prevent token enumeration via timing attacks
    if (
      !authHeader ||
      authHeader.length !== expected.length ||
      !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
    ) {
      return false;
    }
    return true;
  }

  private getClaudeVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("claude", ["--version"], { timeout: 10_000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
    });
  }

  private runNpmInstall(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "npm",
        ["install", "-g", "@anthropic-ai/claude-code"],
        {
          timeout: 120_000,
          env: { ...process.env, NPM_CONFIG_PREFIX: "/home/node/.local" },
        },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || String(err)));
          resolve(stdout.trim());
        },
      );
    });
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let len = 0;
      let resolved = false;
      const MAX = 1024 * 1024; // 1MB
      const TIMEOUT = 10_000; // 10s max to receive full body

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
          req.destroy();
        }
      }, TIMEOUT);

      req.on("data", (chunk: Buffer) => {
        if (resolved) return;
        len += chunk.length;
        if (len > MAX) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (len === 0) {
          resolve(null);
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
      req.on("error", () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
  }
}
