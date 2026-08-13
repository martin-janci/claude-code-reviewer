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
import { parseClaudeIgnore, mergeExcludePatterns, isExcluded, filterDiff } from "./diff-parser.js";

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
