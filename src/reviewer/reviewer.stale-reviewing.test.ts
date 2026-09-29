/**
 * A persisted "reviewing" status must not block a PR forever.
 *
 * initializeState() only runs while processPR() holds the per-PR mutex, so any
 * "reviewing" status it sees cannot belong to a live review in this process —
 * it was left behind by a review that died between setting the status and
 * clearing it (seen live after an ENOSPC). Before this fix the PR stayed stuck
 * with "Review already in progress" until a pod restart.
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
import type { Logger } from "../logger.js";

const noopLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return noopLogger; },
} as unknown as Logger;

const config = {
  review: { maxConcurrentReviews: 3, skipDrafts: true, skipWip: true, debouncePeriodSeconds: 60, maxRetries: 3 },
  features: { jira: { enabled: false } },
} as any;

const pr = {
  owner: "o", repo: "r", number: 448,
  title: "PD-3064 sendLog polishing",
  headSha: "55728c9", isDraft: false, baseBranch: "dev", headBranch: "feat/x",
  forceReview: true,
} as any;

let dir: string;

describe("Reviewer stale 'reviewing' recovery", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reviewer-test-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reviews a PR whose persisted status is a leftover 'reviewing'", () => {
    const store = new StateStore(join(dir, "state.json"));
    store.getOrCreate("o", "r", 448, { title: pr.title, headSha: pr.headSha, baseBranch: "dev", headBranch: "feat/x" });
    store.setStatus("o", "r", 448, "reviewing");
    const reviewer = new Reviewer(config, store, noopLogger);

    const result = (reviewer as any).initializeState(pr, noopLogger);

    assert.notEqual(result.state, null, `review was skipped: ${result.skipReason}`);
    assert.equal(store.get("o", "r", 448)?.status, "pending_review");
  });
});
