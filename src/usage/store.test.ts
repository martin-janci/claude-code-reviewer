/**
 * Tests for UsageStore — SQLite-backed token usage tracking.
 *
 * Uses in-memory SQLite (:memory:) so no files are created on disk.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { UsageStore } from "./store.js";
import type { ClaudeUsage } from "../types.js";

function makeUsage(overrides: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return {
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 800,
    totalCostUsd: 0.015,
    model: "claude-opus-4-5",
    numTurns: 10,
    durationMs: 30000,
    durationApiMs: 28000,
    sessionId: "test-session-001",
    ...overrides,
  };
}

describe("UsageStore", () => {
  let store: UsageStore;

  beforeEach(() => {
    store = new UsageStore(":memory:");
  });

  // ---- record() + getOverallSummary() -------------------------------------

  describe("record() and getOverallSummary()", () => {
    it("returns zero summary on empty store", () => {
      const summary = store.getOverallSummary(30);
      assert.equal(summary.totalReviews, 0);
      assert.equal(summary.totalCostUsd, 0);
      assert.equal(summary.totalInputTokens, 0);
      assert.equal(summary.cacheHitRate, 0);
      assert.deepEqual(summary.repos, []);
    });

    it("records a single entry and reflects it in summary", () => {
      const record = UsageStore.buildRecord("papayapos", "backend", 42, "review", makeUsage());
      store.record(record);

      const summary = store.getOverallSummary(30);
      assert.equal(summary.totalReviews, 1);
      assert.equal(summary.totalInputTokens, 1000);
      assert.equal(summary.totalOutputTokens, 200);
      assert.equal(summary.totalCacheCreationTokens, 100);
      assert.equal(summary.totalCacheReadTokens, 800);
      assert.equal(summary.totalCostUsd, 0.015);
    });

    it("aggregates multiple entries", () => {
      store.record(UsageStore.buildRecord("papayapos", "backend", 1, "review", makeUsage({ inputTokens: 1000, totalCostUsd: 0.01 })));
      store.record(UsageStore.buildRecord("papayapos", "backend", 2, "review", makeUsage({ inputTokens: 2000, totalCostUsd: 0.02 })));
      store.record(UsageStore.buildRecord("papayapos", "frontend", 3, "review", makeUsage({ inputTokens: 500, totalCostUsd: 0.005 })));

      const summary = store.getOverallSummary(30);
      assert.equal(summary.totalReviews, 3);
      assert.equal(summary.totalInputTokens, 3500);
      assert.ok(Math.abs(summary.totalCostUsd - 0.035) < 0.0001);
    });

    it("computes avgCostPerReview correctly", () => {
      store.record(UsageStore.buildRecord("a", "b", 1, "review", makeUsage({ totalCostUsd: 0.10 })));
      store.record(UsageStore.buildRecord("a", "b", 2, "review", makeUsage({ totalCostUsd: 0.20 })));

      const summary = store.getOverallSummary(30);
      assert.ok(Math.abs(summary.avgCostPerReview - 0.15) < 0.0001);
    });

    it("computes cacheHitRate correctly", () => {
      // input_tokens=1000, cache_creation=0, cache_read=4000 → rate = 4000/5000 = 0.8
      store.record(UsageStore.buildRecord("a", "b", 1, "review", makeUsage({
        inputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 4000,
      })));

      const summary = store.getOverallSummary(30);
      assert.ok(Math.abs(summary.cacheHitRate - 0.8) < 0.001);
    });
  });

  // ---- per-repo breakdown -------------------------------------------------

  describe("getRepoSummaries()", () => {
    it("groups records by owner/repo", () => {
      store.record(UsageStore.buildRecord("papayapos", "backend", 1, "review", makeUsage({ totalCostUsd: 0.05 })));
      store.record(UsageStore.buildRecord("papayapos", "backend", 2, "review", makeUsage({ totalCostUsd: 0.05 })));
      store.record(UsageStore.buildRecord("papayapos", "frontend", 3, "review", makeUsage({ totalCostUsd: 0.02 })));

      const repos = store.getRepoSummaries(30);
      assert.equal(repos.length, 2);

      const backend = repos.find(r => r.repo === "backend");
      assert.ok(backend);
      assert.equal(backend.reviews, 2);
      assert.ok(Math.abs(backend.totalCostUsd - 0.10) < 0.0001);

      const frontend = repos.find(r => r.repo === "frontend");
      assert.ok(frontend);
      assert.equal(frontend.reviews, 1);
    });

    it("orders repos by cost descending", () => {
      store.record(UsageStore.buildRecord("a", "cheap", 1, "review", makeUsage({ totalCostUsd: 0.01 })));
      store.record(UsageStore.buildRecord("a", "expensive", 2, "review", makeUsage({ totalCostUsd: 0.99 })));

      const repos = store.getRepoSummaries(30);
      assert.equal(repos[0].repo, "expensive");
      assert.equal(repos[1].repo, "cheap");
    });
  });

  // ---- sinceDays filter ---------------------------------------------------

  describe("sinceDays filter", () => {
    it("excludes records older than sinceDays", () => {
      // Record with old timestamp (35 days ago)
      const oldRecord = UsageStore.buildRecord("a", "b", 1, "review", makeUsage({ totalCostUsd: 0.99 }));
      oldRecord.timestamp = new Date(Date.now() - 35 * 86400_000).toISOString();
      store.record(oldRecord);

      // Recent record
      store.record(UsageStore.buildRecord("a", "b", 2, "review", makeUsage({ totalCostUsd: 0.01 })));

      const summary = store.getOverallSummary(30);
      assert.equal(summary.totalReviews, 1);
      assert.ok(Math.abs(summary.totalCostUsd - 0.01) < 0.0001);
    });

    it("includes all records with large sinceDays", () => {
      const oldRecord = UsageStore.buildRecord("a", "b", 1, "review", makeUsage({ totalCostUsd: 0.5 }));
      oldRecord.timestamp = new Date(Date.now() - 60 * 86400_000).toISOString();
      store.record(oldRecord);
      store.record(UsageStore.buildRecord("a", "b", 2, "review", makeUsage({ totalCostUsd: 0.5 })));

      const summary = store.getOverallSummary(365);
      assert.equal(summary.totalReviews, 2);
    });
  });

  // ---- session management -------------------------------------------------

  describe("getSession() and setSession()", () => {
    it("returns null when no session is stored", () => {
      assert.equal(store.getSession("a", "b", 300), null);
    });

    it("returns session ID within TTL", () => {
      store.setSession("papayapos", "backend", "sess-abc");
      const id = store.getSession("papayapos", "backend", 300);
      assert.equal(id, "sess-abc");
    });

    it("returns null when session has expired (negative ttl forces expiry)", () => {
      store.setSession("papayapos", "backend", "sess-xyz");
      // Negative TTL: elapsed > -1000ms is always true → expired
      const id = store.getSession("papayapos", "backend", -1);
      assert.equal(id, null);
    });

    it("overwrites session on second setSession call", () => {
      store.setSession("a", "b", "first");
      store.setSession("a", "b", "second");
      assert.equal(store.getSession("a", "b", 300), "second");
    });

    it("isolates sessions by repo", () => {
      store.setSession("a", "repo1", "sess-1");
      store.setSession("a", "repo2", "sess-2");
      assert.equal(store.getSession("a", "repo1", 300), "sess-1");
      assert.equal(store.getSession("a", "repo2", 300), "sess-2");
    });
  });

  // ---- UsageStore.buildRecord() ------------------------------------------

  describe("buildRecord()", () => {
    it("maps ClaudeUsage fields to UsageRecord correctly", () => {
      const usage = makeUsage();
      const record = UsageStore.buildRecord("papayapos", "backend", 99, "autofix", usage);

      assert.equal(record.owner, "papayapos");
      assert.equal(record.repo, "backend");
      assert.equal(record.prNumber, 99);
      assert.equal(record.source, "autofix");
      assert.equal(record.model, usage.model);
      assert.equal(record.inputTokens, usage.inputTokens);
      assert.equal(record.outputTokens, usage.outputTokens);
      assert.equal(record.cacheCreationTokens, usage.cacheCreationInputTokens);
      assert.equal(record.cacheReadTokens, usage.cacheReadInputTokens);
      assert.equal(record.totalCostUsd, usage.totalCostUsd);
      assert.equal(record.numTurns, usage.numTurns);
      assert.equal(record.sessionId, usage.sessionId);
      assert.ok(record.timestamp); // ISO string
    });
  });
});
