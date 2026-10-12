/**
 * AuditLogger must not litter the data directory when a flush fails.
 *
 * Seen live: the data volume filled up (ENOSPC) and every 60s flush left a
 * zero-byte `audit.json.tmp.<ts>` behind — 204 of them by the time the pod
 * was looked at. Each one is an unlinked-on-success temp file that the
 * failure path forgot about.
 *
 * A failing flush is simulated for real: the audit file path is replaced by a
 * non-empty directory, so the temp file is written but the atomic rename fails.
 *
 * Run: npm test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "./logger.js";

let dir: string;
let auditPath: string;

function breakFlushes(): void {
  rmSync(auditPath, { force: true });
  mkdirSync(auditPath);
  writeFileSync(join(auditPath, "occupied"), "");
}

function tempFiles(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("audit.json.tmp."));
}

describe("AuditLogger flush failure", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-test-"));
    auditPath = join(dir, "audit.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes its temp file when the atomic rename fails", () => {
    const logger = new AuditLogger({
      enabled: true,
      maxEntries: 100,
      filePath: auditPath,
      includeMetadata: true,
      minSeverity: "info",
    });
    const origError = console.error;
    console.error = () => {};
    try {
      logger.log("review_started", "info", "first");
      breakFlushes();
      logger.stop(); // final flush -> rename onto a non-empty directory fails
    } finally {
      console.error = origError;
    }

    assert.deepEqual(tempFiles(), [], "failed flush must not leave audit.json.tmp.* behind");
  });
});
