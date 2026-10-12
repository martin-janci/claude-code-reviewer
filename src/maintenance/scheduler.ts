import { cleanupStaleEntries } from "../state/cleanup.js";
import type { AppConfig, RepoConfig } from "../types.js";
import type { Logger } from "../logger.js";
import type { StateStore } from "../state/store.js";
import type { CloneManager } from "../clone/manager.js";

export type MaintenanceCloneManager = Pick<CloneManager, "pruneStaleWorktrees" | "pruneUntracked">;
export type MaintenanceStore = Pick<StateStore, "getAll" | "deleteMany">;

export interface MaintenanceDeps {
  /** Read the *current* config so hot-reloaded thresholds take effect. */
  getConfig: () => AppConfig;
  store: MaintenanceStore;
  cloneManager?: MaintenanceCloneManager;
  logger: Logger;
  /** How often to run; default 10 minutes. */
  intervalMs?: number;
}

export interface MaintenanceHandle {
  /** Run one maintenance pass now (also used by the timer). Never throws. */
  runOnce(): Promise<void>;
  stop(): void;
}

export const DEFAULT_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Housekeeping that must happen regardless of event source.
 *
 * `Poller.poll()` does the same work after every poll, but in `mode: webhook`
 * there is no poller, so without this nothing ever pruned stale worktrees or
 * stale state entries and the data volume filled up.
 */
export function startMaintenance(deps: MaintenanceDeps): MaintenanceHandle {
  const { store, cloneManager, logger } = deps;
  const intervalMs = deps.intervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
  let running = false;

  const runOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const config = deps.getConfig();

      try {
        const removed = cleanupStaleEntries(store as StateStore, config.review);
        if (removed > 0) logger.info("Maintenance: removed stale state entries", { removed });
      } catch (err) {
        logger.error("Maintenance: error cleaning stale state entries", { error: String(err) });
      }

      if (!cloneManager) return;

      try {
        const pruned = await cloneManager.pruneStaleWorktrees(config.review.staleWorktreeMinutes);
        if (pruned > 0) logger.info("Maintenance: pruned stale worktrees", { pruned });
      } catch (err) {
        logger.error("Maintenance: error pruning stale worktrees", { error: String(err) });
      }

      // An empty repo list would mean "prune every clone" — never do that from a timer.
      const repos: RepoConfig[] = config.repos;
      if (repos.length > 0) {
        try {
          const pruned = await cloneManager.pruneUntracked(repos);
          if (pruned > 0) logger.info("Maintenance: pruned untracked clones", { pruned });
        } catch (err) {
          logger.error("Maintenance: error pruning untracked clones", { error: String(err) });
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  timer.unref();

  return {
    runOnce,
    stop: () => clearInterval(timer),
  };
}
