import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ConfigManager } from "../config-manager.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import type { MetricsCollector } from "../metrics.js";
import { getDashboardHtml } from "./html.js";

export class DashboardServer {
  private server: Server | null = null;

  constructor(
    private configManager: ConfigManager,
    private logger: Logger,
    private store?: StateStore,
    private metrics?: MetricsCollector,
    private healthInfo?: { version: string; startTime: number },
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
    // Auth check
    if (!this.checkAuth(req, res)) return;

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

      const healthData = {
        status: "ok",
        version: info?.version ?? "unknown",
        uptime,
        state: {
          totalPRs: allPRs.length,
          byStatus: statusCounts,
        },
        metrics: this.metrics && info
          ? this.metrics.snapshot(uptime, statusCounts)
          : null,
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(healthData, null, 2));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
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
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return false;
    }
    return true;
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
