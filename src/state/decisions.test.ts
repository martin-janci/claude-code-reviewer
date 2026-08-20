/**
 * Tests for shouldReview() gating — specifically the forceReview overrides,
 * where a wrong "no" makes an explicit /review trigger a silent no-op.
 *
 * Run: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldReview } from "./decisions.js";
import type { PRState, ReviewConfig } from "../types.js";

const config = {
  skipDrafts: true,
  skipWip: true,
  debouncePeriodSeconds: 60,
  maxRetries: 3,
} as ReviewConfig;

function state(overrides: Partial<PRState>): PRState {
  return {
    owner: "o", repo: "r", number: 1,
    title: "feat: something",
    status: "pending_review",
    headSha: "39f931a",
    isDraft: false,
    reviews: [],
    ...overrides,
  } as PRState;
}

describe("shouldReview — forceReview overrides", () => {
  it("does not review a skipped PR without force", () => {
    const d = shouldReview(state({ status: "skipped", skipReason: "diff_too_large" }), config);
    assert.equal(d.shouldReview, false);
  });

  it("reviews a skipped PR when forced (/review on diff_too_large)", () => {
    const d = shouldReview(state({ status: "skipped", skipReason: "diff_too_large" }), config, true);
    assert.equal(d.shouldReview, true);
  });

  it("still never reviews merged/closed PRs, even forced", () => {
    assert.equal(shouldReview(state({ status: "merged" }), config, true).shouldReview, false);
    assert.equal(shouldReview(state({ status: "closed" }), config, true).shouldReview, false);
  });

  it("still respects the in-progress lock, even forced", () => {
    assert.equal(shouldReview(state({ status: "reviewing" }), config, true).shouldReview, false);
  });

  it("forced re-review of an already-reviewed SHA is allowed", () => {
    const d = shouldReview(state({ status: "reviewed", lastReviewedSha: "39f931a" }), config, true);
    assert.equal(d.shouldReview, true);
  });
});
