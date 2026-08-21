/**
 * The per-PR mutex in Reviewer.processPR must serialize concurrent callers for
 * the same PR even when they park on the rate-limit guard / concurrency slot
 * between the lock check and the lock set. Two reviews of one PR racing on the
 * same worktree was a real outage (both failed in clone_prepare).
 *
 * Run: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Reviewer } from "./reviewer.js";
import type { Logger } from "../logger.js";

const noopLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return noopLogger; },
} as unknown as Logger;

function makeReviewer(guardGate: Promise<void>) {
  const config = { review: { maxConcurrentReviews: 3 } } as any;
  const store = {} as any;
  const guard = { acquire: () => guardGate } as any;
  const reviewer = new Reviewer(config, store, noopLogger, undefined, undefined, undefined, undefined, guard);

  // Instrument doProcessPR to detect overlap
  let active = 0;
  let maxActive = 0;
  const runs: string[] = [];
  (reviewer as any).doProcessPR = async (_pr: any, _log: any) => {
    active++;
    maxActive = Math.max(maxActive, active);
    runs.push("start");
    await new Promise((r) => setTimeout(r, 20));
    runs.push("end");
    active--;
    return { outcome: "reviewed" };
  };
  return { reviewer, get maxActive() { return maxActive; }, runs };
}

describe("Reviewer.processPR per-PR mutex", () => {
  it("serializes two callers for the same PR that both park on the rate-limit guard", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    const h = makeReviewer(gate);
    const pr = { owner: "o", repo: "r", number: 1, headSha: "abcdef0" } as any;

    // Both callers pass the lock check before either can set the lock, then park on the guard.
    const a = h.reviewer.processPR(pr);
    const b = h.reviewer.processPR(pr);
    await new Promise((r) => setTimeout(r, 5));
    openGate();
    await Promise.all([a, b]);

    assert.equal(h.maxActive, 1, "two reviews of the same PR ran concurrently");
    assert.deepEqual(h.runs, ["start", "end", "start", "end"]);
  });

  it("still lets different PRs run in parallel", async () => {
    const h = makeReviewer(Promise.resolve());
    const a = h.reviewer.processPR({ owner: "o", repo: "r", number: 1, headSha: "abcdef0" } as any);
    const b = h.reviewer.processPR({ owner: "o", repo: "r", number: 2, headSha: "abcdef0" } as any);
    await Promise.all([a, b]);
    assert.equal(h.maxActive, 2);
  });
});
