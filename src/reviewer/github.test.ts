import { test } from "node:test";
import assert from "node:assert/strict";
import { isDiffTooLargeError } from "./github.js";

test("isDiffTooLargeError", async (t) => {
  await t.test("matches maxBuffer overflow by error code", () => {
    const err = Object.assign(new Error("stdout maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    assert.equal(isDiffTooLargeError(err), true);
  });

  await t.test("matches maxBuffer overflow by message", () => {
    assert.equal(isDiffTooLargeError(new Error("maxBuffer length exceeded")), true);
  });

  await t.test("matches HTTP 406 diff-exceeded-file-count", () => {
    const err = new Error(
      "Command failed: gh pr diff 42 --repo owner/repo\ncould not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300)",
    );
    assert.equal(isDiffTooLargeError(err), true);
  });

  await t.test("matches HTTP 422 diff-generation timeout", () => {
    const err = new Error(
      "Command failed: gh pr diff 513 --repo papayapos/papayapos-common\ncould not find pull request diff: HTTP 422: Server Error: Sorry, this diff is taking too long to generate. (https://api.github.com/repos/papayapos/papayapos-common/pulls/513)",
    );
    assert.equal(isDiffTooLargeError(err), true);
  });

  await t.test("does not match an unrelated 422 validation error", () => {
    const err = new Error("HTTP 422: Validation Failed: title is required");
    assert.equal(isDiffTooLargeError(err), false);
  });

  await t.test("does not match an unrelated error", () => {
    assert.equal(isDiffTooLargeError(new Error("network timeout")), false);
  });
});
