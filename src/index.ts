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

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    poller?.stop();
    await webhook?.stop();
    if (healthServer) {
      await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
