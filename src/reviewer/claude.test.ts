/**
 * Tests for Claude CLI output parsing.
 *
 * These tests detect breaking changes in the Claude CLI JSON envelope format
 * so we know immediately when Anthropic changes their API output structure.
 *
 * Run: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractUsage, parseStructuredReview } from "./claude.js";

// ---------------------------------------------------------------------------
// extractUsage — Claude CLI JSON envelope parsing
// ---------------------------------------------------------------------------

describe("extractUsage", () => {
  // ---- CLI >= 2.1.x format (nested usage object) -------------------------

  describe("new format (CLI >=2.1.x): nested usage{} + total_cost_usd", () => {
    it("extracts all fields from nested usage object", () => {
      const envelope = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 92260,
        duration_api_ms: 85000,
        num_turns: 15,
        result: "...",
        stop_reason: "end_turn",
        session_id: "c10854bd-7443-40aa-8c58-050da8e07dd8",
        total_cost_usd: 0.0453,
        usage: {
          input_tokens: 5000,
          output_tokens: 800,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 4000,
        },
        model: "claude-opus-4-5-20251101",
      };

      const usage = extractUsage(envelope);
      assert.ok(usage, "should return usage object");
      assert.equal(usage.inputTokens, 5000);
      assert.equal(usage.outputTokens, 800);
      assert.equal(usage.cacheCreationInputTokens, 200);
      assert.equal(usage.cacheReadInputTokens, 4000);
      assert.equal(usage.totalCostUsd, 0.0453);
      assert.equal(usage.model, "claude-opus-4-5-20251101");
      assert.equal(usage.numTurns, 15);
      assert.equal(usage.durationMs, 92260);
      assert.equal(usage.durationApiMs, 85000);
      assert.equal(usage.sessionId, "c10854bd-7443-40aa-8c58-050da8e07dd8");
    });

    it("returns zero cost when total_cost_usd is 0", () => {
      const envelope = {
        session_id: "abc-123",
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      };
      const usage = extractUsage(envelope);
      assert.ok(usage);
      assert.equal(usage.totalCostUsd, 0);
      assert.equal(usage.inputTokens, 100);
    });

    it("handles missing cache fields in nested usage (defaults to 0)", () => {
      const envelope = {
        session_id: "abc-123",
        total_cost_usd: 0.01,
        usage: { input_tokens: 500, output_tokens: 100 },
      };
      const usage = extractUsage(envelope);
      assert.ok(usage);
      assert.equal(usage.cacheCreationInputTokens, 0);
      assert.equal(usage.cacheReadInputTokens, 0);
    });
  });

  // ---- CLI < 2.1.x format (top-level fields) -----------------------------

  describe("old format (CLI <2.1.x): top-level token fields + cost_usd", () => {
    it("extracts all fields from top-level envelope", () => {
      const envelope = {
        session_id: "old-session-xyz",
        cost_usd: 0.02,
        input_tokens: 3000,
        output_tokens: 600,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 2500,
        model: "claude-opus-4-5",
        num_turns: 10,
        duration_ms: 45000,
        duration_api_ms: 40000,
      };

      const usage = extractUsage(envelope);
      assert.ok(usage);
      assert.equal(usage.inputTokens, 3000);
      assert.equal(usage.outputTokens, 600);
      assert.equal(usage.cacheCreationInputTokens, 100);
      assert.equal(usage.cacheReadInputTokens, 2500);
      assert.equal(usage.totalCostUsd, 0.02);
      assert.equal(usage.model, "claude-opus-4-5");
      assert.equal(usage.numTurns, 10);
      assert.equal(usage.sessionId, "old-session-xyz");
    });

    it("prefers total_cost_usd over cost_usd when both present", () => {
      const envelope = {
        session_id: "abc",
        cost_usd: 0.01,
        total_cost_usd: 0.02,
        input_tokens: 100,
        output_tokens: 50,
      };
      const usage = extractUsage(envelope);
      assert.ok(usage);
      assert.equal(usage.totalCostUsd, 0.02);
    });
  });

  // ---- Missing / invalid session_id → undefined --------------------------

  describe("session_id validation", () => {
    it("returns undefined when session_id is missing", () => {
      const envelope = { total_cost_usd: 0.01, usage: { input_tokens: 100 } };
      assert.equal(extractUsage(envelope), undefined);
    });

    it("returns undefined when session_id is empty string", () => {
      const envelope = { session_id: "", total_cost_usd: 0.01 };
      assert.equal(extractUsage(envelope), undefined);
    });

    it("returns undefined when session_id is not a string", () => {
      const envelope = { session_id: 42, total_cost_usd: 0.01 } as unknown as Record<string, unknown>;
      assert.equal(extractUsage(envelope), undefined);
    });
  });

  // ---- Field type coercion / missing fields --------------------------------

  describe("field defaults when fields are missing or wrong type", () => {
    it("defaults numeric fields to 0 when absent", () => {
      const envelope = { session_id: "s1", total_cost_usd: 0.005 };
      const usage = extractUsage(envelope);
      assert.ok(usage);
      assert.equal(usage.inputTokens, 0);
      assert.equal(usage.outputTokens, 0);
      assert.equal(usage.numTurns, 0);
      assert.equal(usage.durationMs, 0);
      assert.equal(usage.durationApiMs, 0);
    });

    it("defaults model to 'unknown' when absent", () => {
      const envelope = { session_id: "s1" };
      const usage = extractUsage(envelope);
      assert.ok(usage);
      assert.equal(usage.model, "unknown");
    });

    it("ignores non-numeric token values (treats as 0)", () => {
      const envelope = {
        session_id: "s1",
        usage: { input_tokens: "lots", output_tokens: null },
      } as unknown as Record<string, unknown>;
      const usage = extractUsage(envelope);
      assert.ok(usage);
      assert.equal(usage.inputTokens, 0);
      assert.equal(usage.outputTokens, 0);
    });

    it("ignores usage field that is not an object (falls back to top-level)", () => {
      const envelope = {
        session_id: "s1",
        usage: "not-an-object",
        input_tokens: 999,
        total_cost_usd: 0.1,
      } as unknown as Record<string, unknown>;
      const usage = extractUsage(envelope);
      assert.ok(usage);
      assert.equal(usage.inputTokens, 999);
    });
  });

  // ---- Real CLI output samples -------------------------------------------

  describe("real CLI output samples", () => {
    it("parses CLI 2.1.84 error response (auth expired)", () => {
      // Actual output observed from claude CLI 2.1.84 when OAuth token expired
      const raw = {
        type: "result",
        subtype: "success",
        is_error: true,
        duration_ms: 639,
        duration_api_ms: 0,
        num_turns: 1,
        result: "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth token has expired.\"}}",
        stop_reason: "stop_sequence",
        session_id: "d259a37e-6c4d-48cd-88d2-ca751788011e",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      };
      const usage = extractUsage(raw);
      assert.ok(usage);
      assert.equal(usage.totalCostUsd, 0);
      assert.equal(usage.inputTokens, 0);
      assert.equal(usage.sessionId, "d259a37e-6c4d-48cd-88d2-ca751788011e");
    });

    it("parses successful CLI 2.1.84 review response with real token counts", () => {
      const raw = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 92260,
        duration_api_ms: 88000,
        num_turns: 14,
        result: "{\"verdict\":\"COMMENT\",\"summary\":\"Found 4 issues\",\"findings\":[],\"overall\":null}",
        stop_reason: "end_turn",
        session_id: "c10854bd-7443-40aa-8c58-050da8e07dd8",
        total_cost_usd: 0.0312,
        usage: {
          input_tokens: 8422,
          output_tokens: 1205,
          cache_creation_input_tokens: 512,
          cache_read_input_tokens: 32100,
        },
        model: "claude-opus-4-5-20251101",
      };
      const usage = extractUsage(raw);
      assert.ok(usage);
      assert.equal(usage.inputTokens, 8422);
      assert.equal(usage.outputTokens, 1205);
      assert.equal(usage.cacheCreationInputTokens, 512);
      assert.equal(usage.cacheReadInputTokens, 32100);
      assert.equal(usage.totalCostUsd, 0.0312);
      assert.equal(usage.model, "claude-opus-4-5-20251101");
      assert.equal(usage.numTurns, 14);
    });
  });
});

// ---------------------------------------------------------------------------
// parseStructuredReview — three-tier JSON parsing
// ---------------------------------------------------------------------------

describe("parseStructuredReview", () => {
  const validReview = {
    verdict: "COMMENT",
    summary: "Found potential issues",
    findings: [
      { severity: "issue", blocking: true, path: "src/foo.ts", line: 10, body: "Null pointer" },
      { severity: "suggestion", blocking: false, path: "src/bar.ts", line: 5, body: "Consider refactoring" },
    ],
  };

  describe("Tier 1: direct JSON parse", () => {
    it("parses a valid review JSON string", () => {
      const result = parseStructuredReview(JSON.stringify(validReview));
      assert.ok(result);
      assert.equal(result.verdict, "COMMENT");
      assert.equal(result.summary, "Found potential issues");
      assert.equal(result.findings.length, 2);
    });

    it("parses APPROVE verdict", () => {
      const r = parseStructuredReview(JSON.stringify({ ...validReview, verdict: "APPROVE", findings: [] }));
      assert.ok(r);
      assert.equal(r.verdict, "APPROVE");
    });

    it("parses REQUEST_CHANGES verdict", () => {
      const r = parseStructuredReview(JSON.stringify({ ...validReview, verdict: "REQUEST_CHANGES" }));
      assert.ok(r);
      assert.equal(r.verdict, "REQUEST_CHANGES");
    });

    it("returns null for invalid verdict", () => {
      const r = parseStructuredReview(JSON.stringify({ ...validReview, verdict: "LGTM" }));
      assert.equal(r, null);
    });

    it("returns null for missing summary", () => {
      const { summary: _, ...noSummary } = validReview;
      const r = parseStructuredReview(JSON.stringify(noSummary));
      assert.equal(r, null);
    });

    it("returns null for missing findings array", () => {
      const { findings: _, ...noFindings } = validReview;
      const r = parseStructuredReview(JSON.stringify(noFindings));
      assert.equal(r, null);
    });

    it("skips findings with invalid severity", () => {
      const review = {
        ...validReview,
        findings: [
          { severity: "INVALID", blocking: false, path: "a.ts", line: 1, body: "x" },
          { severity: "nitpick", blocking: false, path: "b.ts", line: 2, body: "y" },
        ],
      };
      const r = parseStructuredReview(JSON.stringify(review));
      assert.ok(r);
      assert.equal(r.findings.length, 1);
      assert.equal(r.findings[0].severity, "nitpick");
    });

    it("skips findings with line < 1", () => {
      const review = {
        ...validReview,
        findings: [
          { severity: "issue", blocking: false, path: "a.ts", line: 0, body: "bad line" },
          { severity: "issue", blocking: false, path: "a.ts", line: 1, body: "good line" },
        ],
      };
      const r = parseStructuredReview(JSON.stringify(review));
      assert.ok(r);
      assert.equal(r.findings.length, 1);
    });

    it("parses all valid finding severity labels", () => {
      const severities = ["issue", "suggestion", "nitpick", "question", "praise"];
      for (const severity of severities) {
        const review = {
          ...validReview,
          findings: [{ severity, blocking: false, path: "f.ts", line: 1, body: "x" }],
        };
        const r = parseStructuredReview(JSON.stringify(review));
        assert.ok(r, `verdict should parse for severity=${severity}`);
        assert.equal(r.findings[0].severity, severity);
      }
    });

    it("parses optional 'overall' field", () => {
      const r = parseStructuredReview(JSON.stringify({ ...validReview, overall: "Looks mostly fine." }));
      assert.ok(r);
      assert.equal(r.overall, "Looks mostly fine.");
    });

    it("omits overall when it is an empty string", () => {
      const r = parseStructuredReview(JSON.stringify({ ...validReview, overall: "" }));
      assert.ok(r);
      assert.equal(r.overall, undefined);
    });

    it("parses resolutions on re-reviews", () => {
      const review = {
        ...validReview,
        resolutions: [
          { path: "src/foo.ts", line: 10, body: "Fixed the null check", resolution: "resolved" },
          { path: "src/bar.ts", line: 5, body: "Won't fix — intentional", resolution: "wont_fix" },
        ],
      };
      const r = parseStructuredReview(JSON.stringify(review));
      assert.ok(r);
      assert.ok(r.resolutions);
      assert.equal(r.resolutions.length, 2);
      assert.equal(r.resolutions[0].resolution, "resolved");
      assert.equal(r.resolutions[1].resolution, "wont_fix");
    });
  });

  describe("Tier 2: fenced JSON (```json ... ```)", () => {
    it("extracts review from markdown code fence", () => {
      const output = `Here is my review:\n\`\`\`json\n${JSON.stringify(validReview)}\n\`\`\`\nThat's all.`;
      const r = parseStructuredReview(output);
      assert.ok(r);
      assert.equal(r.verdict, "COMMENT");
    });

    it("returns null when fenced content is invalid JSON", () => {
      const output = "Some text\n```json\n{ not valid json }\n```";
      // Tier 3 would also fail since the object is invalid
      const r = parseStructuredReview(output);
      assert.equal(r, null);
    });
  });

  describe("Tier 3: JSON embedded in freeform text", () => {
    it("extracts JSON from text with reasoning before it", () => {
      const output = `Let me analyze this PR carefully.\n\nAfter reviewing:\n${JSON.stringify(validReview)}`;
      const r = parseStructuredReview(output);
      assert.ok(r);
      assert.equal(r.verdict, "COMMENT");
    });

    it("returns null for completely non-JSON output", () => {
      const r = parseStructuredReview("This is just plain text with no JSON at all.");
      assert.equal(r, null);
    });

    it("returns null for empty string", () => {
      assert.equal(parseStructuredReview(""), null);
    });
  });
});
