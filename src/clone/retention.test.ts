import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEvictions, type CacheEntry } from "./retention.js";

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;
const e = (path: string, sizeKb: number, ageH: number, kind: CacheEntry["kind"] = "worktree"): CacheEntry =>
  ({ path, kind, sizeKb, lastUsedMs: NOW - ageH * HOUR });

test("under the cap evicts nothing", () => {
  assert.deepEqual(selectEvictions([e("a", 100, 50)], 100, 200, NOW, HOUR), []);
});

test("cap of 0 means unlimited", () => {
  assert.deepEqual(selectEvictions([e("a", 100, 50)], 999, 0, NOW, HOUR), []);
});

test("evicts oldest first and stops once under the cap", () => {
  const picked = selectEvictions([e("new", 100, 2), e("old", 100, 30), e("mid", 100, 10)], 300, 150, NOW, HOUR);
  assert.deepEqual(picked.map((p) => p.path), ["old", "mid"]);
});

test("never evicts entries used within the minimum idle window", () => {
  const picked = selectEvictions([e("busy", 500, 0.1), e("old", 100, 30)], 600, 50, NOW, HOUR);
  assert.deepEqual(picked.map((p) => p.path), ["old"]);
});

test("counts uncandidate size (e.g. protected clones) toward the total", () => {
  const picked = selectEvictions([e("wt", 100, 5)], 1000, 950, NOW, HOUR);
  assert.deepEqual(picked.map((p) => p.path), ["wt"]);
});
