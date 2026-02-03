import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { StateStore } from "./state/store.js";
import { Reviewer } from "./reviewer/reviewer.js";
import { Poller } from "./polling/poller.js";
import { WebhookServer } from "./webhook/server.js";
import { CloneManager } from "./clone/manager.js";
import { MetricsCollector } from "./metrics.js";
import { createRootLogger } from "./logger.js";
import { setGhToken, getPRDetails } from "./reviewer/github.js";
import { recoverPendingReviews } from "./startup-recovery.js";
import { AuditLogger } from "./audit/logger.js";

let VERSION = "unknown";
try {
  VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;
} catch {
  // package.json missing or malformed — version will show as "unknown"
}
const START_TIME = Date.now();

// --- One-shot CLI mode ---

interface OneShotTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

function parseOneShotArg(): OneShotTarget | null {
  const idx = process.argv.indexOf("--pr");
  if (idx === -1) return null;

  const value = process.argv[idx + 1];
  if (!value) {
    console.error("Error: --pr requires a value in the format owner/repo#number");
    console.error("Usage: node dist/index.js --pr owner/repo#123");
    process.exit(1);
  }

  const match = value.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    console.error(`Error: Invalid --pr format "${value}". Expected owner/repo#number`);
    console.error("Usage: node dist/index.js --pr owner/repo#123");
    process.exit(1);
  }

  return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
}

async function runOneShot(target: OneShotTarget): Promise<void> {
  const logger = createRootLogger();
  const config = loadConfig("config.yaml", true);
  const auditLogger = new AuditLogger(config.features.audit);

  // Inject the target repo if not already configured
  const hasRepo = config.repos.some(
    (r) => r.owner === target.owner && r.repo === target.repo,
  );
  if (!hasRepo) {
    config.repos.push({ owner: target.owner, repo: target.repo });
  }

  if (config.github.token) {
    setGhToken(config.github.token);
  }

  const store = new StateStore();

  let cloneManager: CloneManager | undefined;
  if (config.review.codebaseAccess) {
    cloneManager = new CloneManager(
      config.review.cloneDir,
      config.github.token || undefined,
      config.review.cloneTimeoutMs,
    );
  }

  const metrics = new MetricsCollector();
  const reviewer = new Reviewer(config, store, logger, cloneManager, metrics, auditLogger);

  const key = `${target.owner}/${target.repo}#${target.prNumber}`;
  console.log(`One-shot review: ${key}`);

  // Fetch PR details
  let pr;
  try {
    pr = await getPRDetails(target.owner, target.repo, target.prNumber);
  } catch (err) {
    console.error(`Failed to fetch PR ${key}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Force review to bypass "already reviewed" gating
  pr.forceReview = true;

  await reviewer.processPR(pr);

  // Read final state to determine exit code
  const state = store.get(target.owner, target.repo, target.prNumber);
  if (!state) {
    console.error(`No state recorded for ${key} after review`);
    process.exit(1);
  }

  switch (state.status) {
    case "reviewed": {
      const lastReview = state.reviews[state.reviews.length - 1];
      console.log(`Review complete — verdict: ${lastReview?.verdict ?? "unknown"}`);
      process.exit(0);
      break;
    }
    case "error":
      console.error(`Review failed: ${state.lastError?.message ?? "unknown error"} (phase: ${state.lastError?.phase ?? "unknown"})`);
      process.exit(1);
      break;
    case "skipped":
      console.error(`Review skipped: ${state.skipReason ?? "unknown reason"}`);
      process.exit(1);
      break;
    default:
      console.log(`Review ended in unexpected status: ${state.status}`);
      process.exit(1);
  }
}

// --- Service mode ---

function startHealthServer(port: number, metrics: MetricsCollector, store: StateStore): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        version: VERSION,
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const uptime = Math.floor((Date.now() - START_TIME) / 1000);
      res.end(JSON.stringify(metrics.snapshot(uptime, store.getStatusCounts())));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  server.listen(port, () => {
    console.log(`Health endpoint listening on port ${port}`);
  });
  return server;
}

function main(): void {
  const oneShotTarget = parseOneShotArg();
  if (oneShotTarget) {
    runOneShot(oneShotTarget).catch((err) => {
      console.error("One-shot review failed:", err);
      process.exit(1);
    });
    return;
  }

  const logger = createRootLogger();
  const config = loadConfig();
  const store = new StateStore();
  const auditLogger = new AuditLogger(config.features.audit);

  // Log config loaded
  auditLogger.configLoaded(config.mode, config.repos.length);

  let cloneManager: CloneManager | undefined;
  if (config.review.codebaseAccess) {
    cloneManager = new CloneManager(
      config.review.cloneDir,
      config.github.token || undefined,
      config.review.cloneTimeoutMs,
    );
    logger.info("Codebase access enabled", { cloneDir: config.review.cloneDir });

    // Pre-warm clones so the first review doesn't block on a full clone
    for (const { owner, repo } of config.repos) {
      cloneManager.ensureClone(owner, repo).then(() => {
        logger.info("Pre-warmed clone", { repo: `${owner}/${repo}` });
      }).catch((err) => {
        logger.warn("Pre-warm clone failed", { repo: `${owner}/${repo}`, error: String(err) });
      });
    }
  }

  const metrics = new MetricsCollector();
  const reviewer = new Reviewer(config, store, logger, cloneManager, metrics, auditLogger);

  // Pass GitHub token to gh CLI wrapper
  if (config.github.token) {
    setGhToken(config.github.token);
  }

  let poller: Poller | null = null;
  let webhook: WebhookServer | null = null;
  let healthServer: Server | null = null;

  logger.info("Claude Code PR Reviewer starting", { mode: config.mode, repos: config.repos.map((r) => `${r.owner}/${r.repo}`), dryRun: config.review.dryRun });
  if (config.review.dryRun) {
    logger.warn("DRY RUN MODE — reviews will run but results will NOT be posted to GitHub");
  }

  if (config.mode === "polling" || config.mode === "both") {
    poller = new Poller(config, reviewer, store, logger, cloneManager, auditLogger);
    poller.start();
    auditLogger.serverStarted("Poller");
  }

  if (config.mode === "webhook" || config.mode === "both") {
    webhook = new WebhookServer(config, reviewer, store, logger, metrics, auditLogger, { version: VERSION, startTime: START_TIME });
    webhook.start();
    auditLogger.serverStarted("WebhookServer", config.webhook.port);
  } else {
    // In polling-only mode, start a minimal health server so Docker health checks pass
    healthServer = startHealthServer(config.webhook.port, metrics, store);
    auditLogger.serverStarted("HealthServer", config.webhook.port);
  }

  // Startup recovery: check for PRs that need attention after restart
  // This is especially important in webhook-only mode where we don't poll
  recoverPendingReviews(config, store, reviewer, logger).catch((err) => {
    logger.error("Startup recovery failed", { error: String(err) });
  });

  // Graceful shutdown (guarded against concurrent SIGINT+SIGTERM)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    await poller?.stop();
    await webhook?.stop();
    if (healthServer) {
      const closePromise = new Promise<void>((resolve) => healthServer!.close(() => resolve()));
      healthServer.closeAllConnections();
      await closePromise;
    }

    // Wait for in-flight reviews to complete (up to 60s)
    if (reviewer.inflight > 0) {
      logger.info("Waiting for in-flight reviews to complete", { inflight: reviewer.inflight });
      const deadline = Date.now() + 60_000;
      while (reviewer.inflight > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (reviewer.inflight > 0) {
        logger.warn("Exiting with in-flight reviews still running", { inflight: reviewer.inflight });
      }
    }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
