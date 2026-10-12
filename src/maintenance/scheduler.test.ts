/**
 * Periodic maintenance must run even when there is no poller.
 *
 * Seen live: the deployment runs `mode: webhook`, so `Poller.poll()` — the only
 * caller of `pruneStaleWorktrees()` and `cleanupStaleEntries()` — never ran.
 * Worktrees of failed reviews accumulated (13 × ~400 MB for one Android repo)
 * until the 10 GB data volume filled and SQLite crashed the pod.
 *
 * Run: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startMaintenance, type MaintenanceCloneManager, type MaintenanceStore } from "./scheduler.js";
import { DEFAULTS } from "../config.js";
import type { AppConfig } from "../types.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function fakeConfig(): AppConfig {
  return {
    ...DEFAULTS,
    repos: [{ owner: "acme", repo: "widgets" }],
    review: { ...DEFAULTS.review, staleWorktreeMinutes: 42, staleClosedDays: 7, staleErrorDays: 30 },
  } as unknown as AppConfig;
}

describe("startMaintenance", () => {
  it("prunes stale worktrees, untracked clones and stale state entries on each tick", async () => {
    const calls: string[] = [];
    const cloneManager: MaintenanceCloneManager = {
      async pruneStaleWorktrees(maxAgeMinutes) { calls.push(`worktrees:${maxAgeMinutes}`); return 2; },
      async pruneUntracked(repos) { calls.push(`untracked:${repos.map((r) => `${r.owner}/${r.repo}`).join(",")}`); return 0; },
    };
    const store: MaintenanceStore = {
      getAll: () => [],
      deleteMany: () => { calls.push("deleteMany"); return 0; },
    };

    const m = startMaintenance({ getConfig: fakeConfig, store, cloneManager, logger: silentLogger as never, intervalMs: 60_000 });
    try {
      await m.runOnce();
    } finally {
      m.stop();
    }

    assert.deepEqual(calls, ["worktrees:42", "untracked:acme/widgets"]);
  });

  it("does not prune clones when the repo list is empty", async () => {
    const calls: string[] = [];
    const cloneManager: MaintenanceCloneManager = {
      async pruneStaleWorktrees() { calls.push("worktrees"); return 0; },
      async pruneUntracked() { calls.push("untracked"); return 0; },
    };
    const store: MaintenanceStore = { getAll: () => [], deleteMany: () => 0 };
    const getConfig = () => ({ ...fakeConfig(), repos: [] });

    const m = startMaintenance({ getConfig, store, cloneManager, logger: silentLogger as never, intervalMs: 60_000 });
    try {
      await m.runOnce();
    } finally {
      m.stop();
    }

    assert.deepEqual(calls, ["worktrees"]);
  });

  it("keeps going when one step throws", async () => {
    const calls: string[] = [];
    const cloneManager: MaintenanceCloneManager = {
      async pruneStaleWorktrees() { throw new Error("boom"); },
      async pruneUntracked() { calls.push("untracked"); return 0; },
    };
    const store: MaintenanceStore = { getAll: () => [], deleteMany: () => 0 };

    const m = startMaintenance({ getConfig: fakeConfig, store, cloneManager, logger: silentLogger as never, intervalMs: 60_000 });
    try {
      await m.runOnce();
    } finally {
      m.stop();
    }

    assert.deepEqual(calls, ["untracked"]);
  });
});
