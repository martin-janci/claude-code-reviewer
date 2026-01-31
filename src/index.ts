import { createServer, type Server } from "node:http";
import { loadConfig } from "./config.js";
import { StateStore } from "./state/store.js";
import { Reviewer } from "./reviewer/reviewer.js";
import { Poller } from "./polling/poller.js";
import { WebhookServer } from "./webhook/server.js";
import { setGhToken } from "./reviewer/github.js";

function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
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
  const config = loadConfig();
  const store = new StateStore();
  const reviewer = new Reviewer(config, store);

  // Pass GitHub token to gh CLI wrapper
  if (config.github.token) {
    setGhToken(config.github.token);
  }

  let poller: Poller | null = null;
  let webhook: WebhookServer | null = null;
  let healthServer: Server | null = null;

  console.log(`Claude Code PR Reviewer starting in "${config.mode}" mode`);
  console.log(`Watching ${config.repos.length} repo(s): ${config.repos.map((r) => `${r.owner}/${r.repo}`).join(", ")}`);

  if (config.mode === "polling" || config.mode === "both") {
    poller = new Poller(config, reviewer, store);
    poller.start();
  }

  if (config.mode === "webhook" || config.mode === "both") {
    webhook = new WebhookServer(config, reviewer, store);
    webhook.start();
  } else {
    // In polling-only mode, start a minimal health server so Docker health checks pass
    healthServer = startHealthServer(config.webhook.port);
  }

  // Graceful shutdown (guarded against concurrent SIGINT+SIGTERM)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    await poller?.stop();
    await webhook?.stop();
    if (healthServer) {
      await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
      healthServer.closeAllConnections();
    }

    // Wait for in-flight reviews to complete (up to 60s)
    if (reviewer.inflight > 0) {
      console.log(`Waiting for ${reviewer.inflight} in-flight review(s) to complete...`);
      const deadline = Date.now() + 60_000;
      while (reviewer.inflight > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (reviewer.inflight > 0) {
        console.warn(`Exiting with ${reviewer.inflight} in-flight review(s) still running`);
      }
    }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
