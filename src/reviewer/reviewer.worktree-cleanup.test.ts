/**
 * A review must release its worktree however it ends.
 *
 * Seen live: the pod's Claude OAuth session died, every review failed in
 * Phase 4 (`runReview` returned null), and the worktree cleanup — which only
 * ran on the success path — never happened. 13 leftover ~400 MB worktrees of
 * one Android repo filled the 10 GB data volume and SQLite crashed the pod.
 *
 * `doProcessPR` is driven with `fetchDiff` and `runReview` stubbed, dry-run on
 * (no GitHub calls), and a fake CloneManager that records cleanups.
 *
 * Run: npm test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reviewer } from "./reviewer.js";
import { StateStore } from "../state/store.js";
import { DEFAULTS } from "../config.js";
import type { AppConfig } from "../types.js";
import type { Logger } from "../logger.js";
import type { CloneManager } from "../clone/manager.js";

const noopLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return noopLogger; },
} as unknown as Logger;

const config: AppConfig = {
  ...DEFAULTS,
  repos: [{ owner: "o", repo: "r" }],
  review: { ...DEFAULTS.review, dryRun: true, codebaseAccess: true },
  features: {
    ...DEFAULTS.features,
    jira: { ...DEFAULTS.features.jira, enabled: false },
    autoDescription: { ...DEFAULTS.features.autoDescription, enabled: false },
    autoLabel: { ...DEFAULTS.features.autoLabel, enabled: false },
    testDebate: { ...DEFAULTS.features.testDebate, enabled: false },
    usage: { ...DEFAULTS.features.usage, enabled: false },
  },
} as AppConfig;

const pr = {
  owner: "o", repo: "r", number: 481,
  title: "fix: something", headSha: "abc1234def",
  isDraft: false, baseBranch: "dev", headBranch: "feat/x", forceReview: true,
} as any;

const diffResult = {
  diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
  diffFetchMs: 1,
  exclusions: { patterns: [], excludedCount: 0, claudeignoreApplied: false },
};

let dir: string;

/** Let fire-and-forget promises scheduled in `finally` settle. */
const settle = () => new Promise((r) => setImmediate(r));

function makeReviewer(runReview: () => Promise<unknown>) {
  const cleaned: number[] = [];
  const cloneManager = {
    prepareForPR: async () => join(dir, "wt"),
    cleanupPR: async (_o: string, _r: string, n: number) => { cleaned.push(n); },
  } as unknown as CloneManager;
  const store = new StateStore(join(dir, "state.json"));
  const reviewer = new Reviewer(config, store, noopLogger, cloneManager);
  (reviewer as any).fetchDiff = async () => diffResult;
  (reviewer as any).runReview = runReview;
  return { reviewer, cleaned };
}

describe("Reviewer worktree cleanup", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reviewer-wt-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("releases the worktree when the Claude review fails", async () => {
    const { reviewer, cleaned } = makeReviewer(async () => null);
    try {
      const result = await (reviewer as any).doProcessPR(pr, noopLogger);
      await settle();
      assert.equal(result.outcome, "error");
      assert.deepEqual(cleaned, [481], "worktree must be cleaned up on a failed review");
    } finally {
      reviewer.stop();
    }
  });

  it("releases the worktree when the review throws", async () => {
    const { reviewer, cleaned } = makeReviewer(async () => { throw new Error("claude exploded"); });
    try {
      await assert.rejects((reviewer as any).doProcessPR(pr, noopLogger), /claude exploded/);
      await settle();
      assert.deepEqual(cleaned, [481]);
    } finally {
      reviewer.stop();
    }
  });
});
