import { describe, it, expect } from "vitest";
import { extractUsage } from "../src/reviewer/claude.js";

/**
 * Simulate the JSON parsing logic from executeClaudeReview in claude.ts.
 * This replicates the exact parsing pipeline without needing to invoke the CLI.
 */
function parseClaudeResponse(stdout: string): {
  body: string;
  usage: ReturnType<typeof extractUsage>;
  isError: boolean;
} | null {
  try {
    const parsed = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const envelope = items.find((i: Record<string, unknown>) => i.type === "result") ?? items[items.length - 1];
    const systemItem = items.find((i: Record<string, unknown>) => i.type === "system");

    // Merge model from system item into envelope
    if (systemItem && typeof systemItem.model === "string" && !envelope.model) {
      envelope.model = systemItem.model;
    }

    // Fallback: extract model name from modelUsage keys
    if (!envelope.model && envelope.modelUsage && typeof envelope.modelUsage === "object") {
      const modelKeys = Object.keys(envelope.modelUsage as Record<string, unknown>);
      if (modelKeys.length > 0) {
        const mu = envelope.modelUsage as Record<string, Record<string, unknown>>;
        let bestModel = modelKeys[0];
        let bestOutput = 0;
        for (const mk of modelKeys) {
          const out = typeof mu[mk]?.outputTokens === "number" ? mu[mk].outputTokens as number : 0;
          if (out > bestOutput) { bestOutput = out; bestModel = mk; }
        }
        envelope.model = bestModel;
      }
    }

    const body = (typeof envelope.result === "string" ? envelope.result : "").trim();
    const isError = !!envelope.is_error;
    const usage = extractUsage(envelope);

    return { body, usage, isError };
  } catch {
    return null;
  }
}

/**
 * Detect stale session errors — replicates the check in reviewDiff().
 */
function isStaleSessionError(body: string): boolean {
  return body.includes("No conversation found with session ID");
}

describe("Claude CLI Response Parsing", () => {
  describe("Single object format (CLI v2.1.84)", () => {
    const singleObjectResponse = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Review text here",
      session_id: "abc-123",
      total_cost_usd: 0.05,
      num_turns: 3,
      duration_ms: 5000,
      duration_api_ms: 4000,
      usage: {
        input_tokens: 100,
        output_tokens: 500,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 5000,
      },
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 100,
          outputTokens: 500,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 1000,
          costUSD: 0.05,
        },
      },
    });

    it("parses result body", () => {
      const result = parseClaudeResponse(singleObjectResponse);
      expect(result).not.toBeNull();
      expect(result!.body).toBe("Review text here");
      expect(result!.isError).toBe(false);
    });

    it("extracts model from modelUsage keys", () => {
      const result = parseClaudeResponse(singleObjectResponse);
      expect(result!.usage).toBeDefined();
      expect(result!.usage!.model).toBe("claude-sonnet-4-6");
    });

    it("extracts usage metrics", () => {
      const result = parseClaudeResponse(singleObjectResponse);
      const usage = result!.usage!;
      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(500);
      expect(usage.cacheCreationInputTokens).toBe(1000);
      expect(usage.cacheReadInputTokens).toBe(5000);
      expect(usage.totalCostUsd).toBe(0.05);
      expect(usage.numTurns).toBe(3);
      expect(usage.durationMs).toBe(5000);
      expect(usage.durationApiMs).toBe(4000);
      expect(usage.sessionId).toBe("abc-123");
    });
  });

  describe("Array format (newer CLI)", () => {
    const arrayResponse = JSON.stringify([
      { type: "system", model: "claude-opus-4-5-20251101" },
      { type: "assistant", message: { role: "assistant" } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Review text here",
        session_id: "def-456",
        total_cost_usd: 0.08,
        num_turns: 5,
        duration_ms: 8000,
        duration_api_ms: 7000,
        usage: {
          input_tokens: 200,
          output_tokens: 800,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 10000,
        },
        modelUsage: {
          "claude-opus-4-5-20251101": { inputTokens: 200, outputTokens: 800 },
        },
      },
    ]);

    it("parses result body from array", () => {
      const result = parseClaudeResponse(arrayResponse);
      expect(result).not.toBeNull();
      expect(result!.body).toBe("Review text here");
      expect(result!.isError).toBe(false);
    });

    it("extracts model from system item", () => {
      const result = parseClaudeResponse(arrayResponse);
      expect(result!.usage).toBeDefined();
      expect(result!.usage!.model).toBe("claude-opus-4-5-20251101");
    });

    it("extracts usage metrics from result item", () => {
      const result = parseClaudeResponse(arrayResponse);
      const usage = result!.usage!;
      expect(usage.inputTokens).toBe(200);
      expect(usage.outputTokens).toBe(800);
      expect(usage.cacheCreationInputTokens).toBe(2000);
      expect(usage.cacheReadInputTokens).toBe(10000);
      expect(usage.totalCostUsd).toBe(0.08);
      expect(usage.numTurns).toBe(5);
      expect(usage.durationMs).toBe(8000);
      expect(usage.durationApiMs).toBe(7000);
      expect(usage.sessionId).toBe("def-456");
    });
  });

  describe("Multi-model modelUsage", () => {
    it("picks the model with most output tokens", () => {
      const response = JSON.stringify({
        type: "result",
        session_id: "multi-123",
        total_cost_usd: 0.10,
        result: "text",
        usage: { input_tokens: 50, output_tokens: 300 },
        modelUsage: {
          "claude-haiku-4-5-20251001": { inputTokens: 50, outputTokens: 20, costUSD: 0.001 },
          "claude-sonnet-4-6": { inputTokens: 200, outputTokens: 800, costUSD: 0.05 },
        },
      });

      const result = parseClaudeResponse(response);
      expect(result!.usage).toBeDefined();
      expect(result!.usage!.model).toBe("claude-sonnet-4-6");
    });
  });

  describe("No modelUsage, no model field", () => {
    it("defaults model to 'unknown'", () => {
      const response = JSON.stringify({
        type: "result",
        session_id: "no-model-123",
        total_cost_usd: 0.01,
        result: "text",
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const result = parseClaudeResponse(response);
      expect(result!.usage).toBeDefined();
      expect(result!.usage!.model).toBe("unknown");
    });
  });

  describe("Missing session_id", () => {
    it("returns undefined usage when session_id is absent", () => {
      const response = JSON.stringify({
        type: "result",
        total_cost_usd: 0.05,
        result: "text",
        usage: { input_tokens: 100, output_tokens: 500 },
      });

      const result = parseClaudeResponse(response);
      expect(result).not.toBeNull();
      expect(result!.usage).toBeUndefined();
    });
  });

  describe("Cost field variants", () => {
    it("uses total_cost_usd correctly", () => {
      const response = JSON.stringify({
        type: "result",
        session_id: "cost-test",
        total_cost_usd: 0.123,
        result: "text",
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const result = parseClaudeResponse(response);
      expect(result!.usage!.totalCostUsd).toBe(0.123);
    });

    it("does NOT use old cost_usd field (returns 0)", () => {
      const response = JSON.stringify({
        type: "result",
        session_id: "old-cost-test",
        cost_usd: 0.999,
        result: "text",
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const result = parseClaudeResponse(response);
      expect(result!.usage!.totalCostUsd).toBe(0);
    });
  });

  describe("Stale session error detection", () => {
    it("detects stale session error message", () => {
      expect(isStaleSessionError("No conversation found with session ID: abc-123")).toBe(true);
    });

    it("detects stale session error in longer text", () => {
      expect(isStaleSessionError("Error: No conversation found with session ID: xyz-789. Please start a new session.")).toBe(true);
    });

    it("does NOT detect unrelated errors", () => {
      expect(isStaleSessionError("Some other error")).toBe(false);
    });

    it("does NOT detect empty string", () => {
      expect(isStaleSessionError("")).toBe(false);
    });
  });

  describe("Empty/malformed responses", () => {
    it("handles empty string stdout gracefully", () => {
      const result = parseClaudeResponse("");
      expect(result).toBeNull();
    });

    it("handles non-JSON stdout gracefully", () => {
      const result = parseClaudeResponse("This is not JSON at all");
      expect(result).toBeNull();
    });

    it("handles JSON with missing result field", () => {
      const response = JSON.stringify({
        type: "result",
        session_id: "missing-result",
      });

      const result = parseClaudeResponse(response);
      expect(result).not.toBeNull();
      expect(result!.body).toBe("");
      expect(result!.usage).toBeDefined();
      expect(result!.usage!.sessionId).toBe("missing-result");
    });

    it("handles JSON with missing usage field", () => {
      const response = JSON.stringify({
        type: "result",
        session_id: "no-usage",
        result: "some text",
      });

      const result = parseClaudeResponse(response);
      expect(result).not.toBeNull();
      expect(result!.body).toBe("some text");
      expect(result!.usage).toBeDefined();
      expect(result!.usage!.inputTokens).toBe(0);
      expect(result!.usage!.outputTokens).toBe(0);
    });

    it("handles empty array", () => {
      const result = parseClaudeResponse("[]");
      // Empty array — last item is undefined-ish, should handle gracefully
      // The code does items[items.length - 1] which is undefined for empty array
      expect(result).toBeNull();
    });

    it("handles array with only system item (no result)", () => {
      const response = JSON.stringify([
        { type: "system", model: "claude-sonnet-4-6" },
      ]);

      const result = parseClaudeResponse(response);
      expect(result).not.toBeNull();
      // Falls back to last item (system item), no session_id → no usage
      expect(result!.usage).toBeUndefined();
    });
  });
});
