/**
 * StateStore must keep memory and disk in agreement when a save fails.
 *
 * Seen live: the data volume filled up (ENOSPC), `update()` had already applied
 * `status: "reviewing"` in memory before `save()` threw, and nothing rolled it
 * back. The next successful save persisted the phantom "reviewing" status and
 * every later /review was rejected as "Review already in progress" until a pod
 * restart ran crash recovery.
 *
 * A failing save is simulated for real: the state file path is replaced by a
 * non-empty directory, so the temp file is written but the atomic rename fails.
 *
 * Run: npm test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "./store.js";

let dir: string;
let statePath: string;

/** Make every later save() fail at the rename step. */
function breakSaves(): void {
  rmSync(statePath, { force: true });
  mkdirSync(statePath);
  writeFileSync(join(statePath, "occupied"), "");
}

function tempFiles(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(".state-") && f.endsWith(".tmp"));
}

describe("StateStore save failures", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "store-test-"));
    statePath = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("update() rolls back the in-memory entry when the save fails", () => {
    const store = new StateStore(statePath);
    store.getOrCreate("o", "r", 1, { headSha: "abc1234" });
    breakSaves();

    assert.throws(() => store.setStatus("o", "r", 1, "reviewing"));

    assert.equal(store.get("o", "r", 1)?.status, "pending_review");
  });

  it("getOrCreate() does not keep an entry it failed to persist", () => {
    const store = new StateStore(statePath);
    breakSaves();

    assert.throws(() => store.getOrCreate("o", "r", 2, { headSha: "abc1234" }));

    assert.equal(store.get("o", "r", 2), undefined);
  });

  it("save() removes its temp file when the write does not complete", () => {
    const store = new StateStore(statePath);
    store.getOrCreate("o", "r", 1, { headSha: "abc1234" });
    breakSaves();

    assert.throws(() => store.setStatus("o", "r", 1, "reviewing"));

    assert.deepEqual(tempFiles(), []);
  });
});
