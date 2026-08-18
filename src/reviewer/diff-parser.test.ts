/**
 * Tests for diff filtering and `.claudeignore` parsing.
 *
 * The exclusion path decides what Claude never gets to see, so a silent
 * over- or under-match here is invisible in production — hence these tests.
 *
 * Run: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeIgnore, mergeExcludePatterns, buildExcludePatterns, isExcluded, filterDiff, countDiffLines, GRAPHIFY_OUT_PATTERN } from "./diff-parser.js";

const excluded = (path: string, ignore: string) => isExcluded(path, parseClaudeIgnore(ignore));

// ---------------------------------------------------------------------------
// parseClaudeIgnore / isExcluded — gitignore-style semantics
// ---------------------------------------------------------------------------

describe("parseClaudeIgnore", () => {
  it("excludes a directory and everything under it", () => {
    assert.equal(excluded("graphify-out/cache/a.json", "graphify-out/cache/"), true);
    assert.equal(excluded("graphify-out/cache/deep/nested/b.json", "graphify-out/cache/"), true);
    assert.equal(excluded("graphify-out/src/a.ts", "graphify-out/cache/"), false);
  });

  it("matches an unanchored pattern at any depth", () => {
    assert.equal(excluded("dist/main.js", "dist/"), true);
    assert.equal(excluded("packages/api/dist/main.js", "dist/"), true);
  });

  it("anchors patterns that start with a slash", () => {
    assert.equal(excluded("dist/main.js", "/dist/"), true);
    assert.equal(excluded("packages/api/dist/main.js", "/dist/"), false);
  });

  it("anchors patterns containing an inner slash", () => {
    assert.equal(excluded("build/out.js", "build/out.js"), true);
    assert.equal(excluded("sub/build/out.js", "build/out.js"), false);
  });

  it("matches a bare file pattern at root and at depth", () => {
    assert.equal(excluded("package-lock.json", "package-lock.json"), true);
    assert.equal(excluded("packages/api/package-lock.json", "package-lock.json"), true);
  });

  it("supports wildcards without crossing segment boundaries", () => {
    assert.equal(excluded("yarn.lock", "*.lock"), true);
    assert.equal(excluded("vendor/yarn.lock", "*.lock"), true);
    assert.equal(excluded("a.lock/b.ts", "*.lock"), true); // the pattern may name a directory
    assert.equal(excluded("src/main.ts", "*.lock"), false);
  });

  it("treats ? as exactly one non-separator char", () => {
    assert.equal(excluded("a1.log", "a?.log"), true);
    assert.equal(excluded("a.log", "a?.log"), false);
    assert.equal(excluded("a/b.log", "a?b.log"), false);
  });

  it("matches **/ at root level too", () => {
    assert.equal(excluded("generated/x.ts", "**/generated/"), true);
    assert.equal(excluded("src/generated/x.ts", "**/generated/"), true);
  });

  it("honours negations with last-match-wins", () => {
    const ignore = "generated/\n!generated/schema.ts";
    assert.equal(excluded("generated/client.ts", ignore), true);
    assert.equal(excluded("generated/schema.ts", ignore), false);
  });

  it("skips comments and blank lines", () => {
    assert.deepEqual(parseClaudeIgnore("# comment\n\n   \n"), []);
  });

  it("treats a backslash-escaped marker as a literal name", () => {
    assert.equal(excluded("#notes.md", "\\#notes.md"), true);
  });
});

describe("mergeExcludePatterns", () => {
  it("returns the base patterns unchanged when there is no .claudeignore", () => {
    assert.deepEqual(mergeExcludePatterns(["dist/**"], null), ["dist/**"]);
  });

  it("lets operator config win over a repo-side negation", () => {
    // The repo tries to re-include a path the operator excluded
    const patterns = mergeExcludePatterns(["secrets/**"], "!secrets/prod.env");
    assert.equal(isExcluded("secrets/prod.env", patterns), true);
  });
});

// ---------------------------------------------------------------------------
// buildExcludePatterns — the effective exclusion list for one review
// ---------------------------------------------------------------------------

describe("buildExcludePatterns", () => {
  it("is just the configured excludePaths when nothing else applies", () => {
    assert.deepEqual(buildExcludePatterns({ excludePaths: ["dist/**"], graphify: false }), ["dist/**"]);
  });

  it("always adds graphify-out/** when review.graphify is on", () => {
    const patterns = buildExcludePatterns({ excludePaths: [], graphify: true });
    assert.deepEqual(patterns, [GRAPHIFY_OUT_PATTERN]);
    assert.equal(isExcluded("graphify-out/graph.json", patterns), true);
    assert.equal(isExcluded("graphify-out/.graphify_analysis.json", patterns), true);
    assert.equal(isExcluded("graphify-out/2026-08-17/cache.json", patterns), true);
    assert.equal(isExcluded("src/graphify-out.ts", patterns), false);
  });

  it("does not add graphify-out/** when review.graphify is off", () => {
    const patterns = buildExcludePatterns({ excludePaths: [], graphify: false, claudeIgnore: "logs/" });
    assert.equal(isExcluded("graphify-out/graph.json", patterns), false);
    assert.equal(isExcluded("logs/app.log", patterns), true);
  });

  it("puts repo .claudeignore first, then operator config, then the graphify rule (last-match-wins)", () => {
    const patterns = buildExcludePatterns({ excludePaths: ["dist/**"], graphify: true, claudeIgnore: "logs/" });
    assert.deepEqual(patterns, ["logs/**", "**/logs/**", "dist/**", GRAPHIFY_OUT_PATTERN]);
  });

  it("does not let a repo-side negation re-include graphify-out/", () => {
    const patterns = buildExcludePatterns({ excludePaths: [], graphify: true, claudeIgnore: "!graphify-out/graph.json" });
    assert.equal(isExcluded("graphify-out/graph.json", patterns), true);
  });

  it("does not need the repo's .claudeignore to exclude graphify-out/ (bootstrap PR case)", () => {
    // Base branch has no .claudeignore yet; the PR adds one alongside a regenerated graph.
    const patterns = buildExcludePatterns({ excludePaths: [], graphify: true, claudeIgnore: null });
    assert.equal(isExcluded("graphify-out/graph.json", patterns), true);
  });
});

// ---------------------------------------------------------------------------
// filterDiff — block-level exclusion
// ---------------------------------------------------------------------------

const modified = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
-old
+new
`;

const deleted = `diff --git a/cache/big.json b/cache/big.json
deleted file mode 100644
index 333..0000000
--- a/cache/big.json
+++ /dev/null
@@ -1,2 +0,0 @@
-{"a":1}
-{"b":2}
`;

const renamed = `diff --git a/cache/old.json b/cache/new.json
similarity index 100%
rename from cache/old.json
rename to cache/new.json
`;

describe("filterDiff", () => {
  it("returns the diff untouched when there are no patterns", () => {
    const { filtered, excludedCount } = filterDiff(modified, []);
    assert.equal(filtered, modified);
    assert.equal(excludedCount, 0);
  });

  it("drops the whole block of a matching file", () => {
    const { filtered, excludedCount } = filterDiff(modified + deleted, ["cache/**"]);
    assert.equal(excludedCount, 1);
    assert.ok(filtered.includes("src/app.ts"));
    assert.ok(!filtered.includes("cache/big.json"));
  });

  it("excludes deleted files (no +++ b/ header)", () => {
    const { excludedCount } = filterDiff(deleted, ["cache/**"]);
    assert.equal(excludedCount, 1);
  });

  it("excludes pure renames (no ---/+++ headers at all)", () => {
    const { filtered, excludedCount } = filterDiff(renamed, ["cache/**"]);
    assert.equal(excludedCount, 1);
    assert.equal(filtered.trim(), "");
  });

  it("keeps non-matching files when a neighbouring block is excluded", () => {
    const { filtered } = filterDiff(deleted + modified + renamed, ["cache/**"]);
    assert.ok(filtered.includes("+new"));
    assert.ok(!filtered.includes('{"a":1}'));
  });
});

// ---------------------------------------------------------------------------
// countDiffLines — the number that is compared against review.maxDiffLines.
// Excluded files must be filtered out BEFORE counting, so a huge ignored
// artefact can never push a PR over the limit.
// ---------------------------------------------------------------------------

function bigGeneratedFile(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+{"node":${i}}`).join("\n");
  return `diff --git a/${path} b/${path}
new file mode 100644
index 0000000..444
--- /dev/null
+++ b/${path}
@@ -0,0 +1,${lines} @@
${body}
`;
}

describe("countDiffLines", () => {
  it("counts the lines of the diff text as the size gate does", () => {
    assert.equal(countDiffLines(""), 0);
    assert.equal(countDiffLines(modified), modified.split("\n").length);
  });

  it("does not count lines of files excluded by graphify-out/** (the papayapos-common#530 shape)", () => {
    const maxDiffLines = 15_000;
    const diff = modified + bigGeneratedFile("graphify-out/graph.json", 50_000) + bigGeneratedFile("graphify-out/manifest.json", 9_000);
    assert.ok(countDiffLines(diff) > maxDiffLines, "unfiltered diff must exceed the limit for this test to mean anything");

    const patterns = buildExcludePatterns({ excludePaths: [], graphify: true, claudeIgnore: null });
    const { filtered, excludedCount } = filterDiff(diff, patterns);
    assert.equal(excludedCount, 2);
    assert.ok(countDiffLines(filtered) <= maxDiffLines);
    assert.ok(filtered.includes("src/app.ts"));
  });

  it("does not count lines of files excluded via .claudeignore or excludePaths either", () => {
    const diff = modified + bigGeneratedFile("build/out.js", 40_000) + bigGeneratedFile("vendor/lib.js", 40_000);
    const patterns = buildExcludePatterns({ excludePaths: ["vendor/**"], graphify: false, claudeIgnore: "**/build/" });
    const { filtered, excludedCount } = filterDiff(diff, patterns);
    assert.equal(excludedCount, 2);
    assert.ok(countDiffLines(filtered) <= countDiffLines(modified));
    assert.ok(filtered.includes("+new"));
  });
});
