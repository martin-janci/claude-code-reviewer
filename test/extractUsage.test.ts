import { describe, it, expect } from "vitest";
import { extractUsage } from "../src/reviewer/claude.js";

describe("extractUsage", () => {
  it("maps all fields from snake_case to camelCase", () => {
    const envelope: Record<string, unknown> = {
      session_id: "test-session-1",
      total_cost_usd: 0.05,
      num_turns: 3,
      duration_ms: 5000,
      duration_api_ms: 4000,
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 100,
        output_tokens: 500,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 5000,
      },
    };

    const result = extractUsage(envelope);
    expect(result).toBeDefined();
    expect(result!.inputTokens).toBe(100);
    expect(result!.outputTokens).toBe(500);
    expect(result!.cacheCreationInputTokens).toBe(1000);
    expect(result!.cacheReadInputTokens).toBe(5000);
    expect(result!.totalCostUsd).toBe(0.05);
    expect(result!.model).toBe("claude-sonnet-4-6");
    expect(result!.numTurns).toBe(3);
    expect(result!.durationMs).toBe(5000);
    expect(result!.durationApiMs).toBe(4000);
    expect(result!.sessionId).toBe("test-session-1");
  });

  it("defaults missing numeric fields to zero", () => {
    const envelope: Record<string, unknown> = {
      session_id: "test-session-2",
      model: "claude-sonnet-4-6",
      // no usage, no cost, no turns, no duration
    };

    const result = extractUsage(envelope);
    expect(result).toBeDefined();
    expect(result!.inputTokens).toBe(0);
    expect(result!.outputTokens).toBe(0);
    expect(result!.cacheCreationInputTokens).toBe(0);
    expect(result!.cacheReadInputTokens).toBe(0);
    expect(result!.totalCostUsd).toBe(0);
    expect(result!.numTurns).toBe(0);
    expect(result!.durationMs).toBe(0);
    expect(result!.durationApiMs).toBe(0);
  });

  it("defaults missing model to 'unknown'", () => {
    const envelope: Record<string, unknown> = {
      session_id: "test-session-3",
      // no model field
    };

    const result = extractUsage(envelope);
    expect(result).toBeDefined();
    expect(result!.model).toBe("unknown");
  });

  it("returns undefined when session_id is missing", () => {
    const envelope: Record<string, unknown> = {
      model: "claude-sonnet-4-6",
      total_cost_usd: 0.05,
    };

    const result = extractUsage(envelope);
    expect(result).toBeUndefined();
  });

  it("returns undefined when session_id is empty string", () => {
    const envelope: Record<string, unknown> = {
      session_id: "",
      model: "claude-sonnet-4-6",
    };

    const result = extractUsage(envelope);
    expect(result).toBeUndefined();
  });

  it("returns undefined when session_id is not a string", () => {
    const envelope: Record<string, unknown> = {
      session_id: 12345,
      model: "claude-sonnet-4-6",
    };

    const result = extractUsage(envelope);
    expect(result).toBeUndefined();
  });

  it("extracts sessionId correctly", () => {
    const envelope: Record<string, unknown> = {
      session_id: "unique-session-abc-456",
    };

    const result = extractUsage(envelope);
    expect(result).toBeDefined();
    expect(result!.sessionId).toBe("unique-session-abc-456");
  });

  it("handles usage as null gracefully", () => {
    const envelope: Record<string, unknown> = {
      session_id: "test-null-usage",
      usage: null,
    };

    const result = extractUsage(envelope);
    expect(result).toBeDefined();
    expect(result!.inputTokens).toBe(0);
    expect(result!.outputTokens).toBe(0);
  });

  it("handles usage with partial fields", () => {
    const envelope: Record<string, unknown> = {
      session_id: "test-partial",
      usage: {
        input_tokens: 42,
        // output_tokens missing
      },
    };

    const result = extractUsage(envelope);
    expect(result).toBeDefined();
    expect(result!.inputTokens).toBe(42);
    expect(result!.outputTokens).toBe(0);
  });
});
