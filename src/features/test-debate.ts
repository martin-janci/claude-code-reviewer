import { exec } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logger.js";
import type { AppConfig } from "../types.js";
import { TEST_FINDING_MARKER, TEST_DEBATE_MARKER } from "../reviewer/formatter.js";

export interface TestDebateThread {
  prNumber: number;
  prTitle: string;
  owner: string;
  repo: string;
  findingBody: string; // Root comment body (the original missing-test finding)
  path: string;
  line: number | null;
  diffHunk: string;
  replies: Array<{ author: string; body: string; fromBot: boolean }>;
  authorLogin: string; // Author of the latest (triggering) reply
}

export interface TestDebateResult {
  success: boolean;
  decision?: "concede" | "hold";
  reply?: string; // Markdown reply to post in the thread
  reason?: string; // One-line summary of the author's justification (for the exemption record)
  confidence?: number;
  error?: string;
}

const VALID_DECISIONS = new Set<string>(["concede", "hold"]);

/** Strip our invisible HTML markers so they don't leak into prompts or quoted text. */
function stripMarkers(body: string): string {
  return body.replaceAll(TEST_FINDING_MARKER, "").replaceAll(TEST_DEBATE_MARKER, "").trim();
}

/**
 * Lenient JSON object extraction: direct parse → ```json fence → trailing object scan.
 * Same strategy as parseStructuredReview, for the debate verdict payload.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object") return obj as Record<string, unknown>;
  } catch { /* fall through */ }

  const fenceMatch = trimmed.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1]);
      if (obj && typeof obj === "object") return obj as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  const lastBrace = trimmed.lastIndexOf("}");
  if (lastBrace !== -1) {
    let searchFrom = lastBrace;
    while (searchFrom >= 0) {
      const openIdx = trimmed.lastIndexOf("{", searchFrom);
      if (openIdx === -1) break;
      try {
        const obj = JSON.parse(trimmed.slice(openIdx, lastBrace + 1));
        if (obj && typeof obj === "object") return obj as Record<string, unknown>;
      } catch { /* try next '{' to the left */ }
      searchFrom = openIdx - 1;
    }
  }

  return null;
}

function validateDebateResult(obj: Record<string, unknown>): TestDebateResult | null {
  if (typeof obj.decision !== "string" || !VALID_DECISIONS.has(obj.decision)) return null;
  if (typeof obj.reply !== "string" || !obj.reply.trim()) return null;
  const reply = obj.reply.trim();
  return {
    success: true,
    decision: obj.decision as "concede" | "hold",
    reply,
    reason: typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : reply.slice(0, 200),
    confidence: typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 100 ? obj.confidence : undefined,
  };
}

function buildDebatePrompt(thread: TestDebateThread, hasCodebase: boolean): string {
  const { owner, repo, prNumber, prTitle } = thread;
  let prompt = `You are the automated code reviewer for PR #${prNumber} in ${owner}/${repo} ("${prTitle}").\n`;
  prompt += `You previously flagged a missing test. The PR author replied, arguing that a test is not required here. Judge whether their justification is valid.\n\n`;

  prompt += `## Your Original Finding\n`;
  prompt += `File: \`${thread.path}\`${thread.line != null ? ` line ${thread.line}` : ""}\n\n`;
  prompt += `${stripMarkers(thread.findingBody)}\n\n`;

  if (thread.diffHunk) {
    prompt += `## Code Context (diff hunk)\n\`\`\`diff\n${thread.diffHunk}\n\`\`\`\n\n`;
  }

  if (thread.replies.length > 0) {
    prompt += `## Discussion Thread\n`;
    for (const r of thread.replies) {
      const who = r.fromBot ? "you (reviewer)" : `@${r.author}`;
      prompt += `- **${who}**: ${stripMarkers(r.body)}\n`;
    }
    prompt += `\n`;
  }

  if (hasCodebase) {
    prompt += `## Codebase Access\n`;
    prompt += `You have read-only access to the repository at the PR's head commit in your working directory. `;
    prompt += `VERIFY factual claims before accepting them — if the author says the behavior is already covered by existing tests, Grep for those tests and Read them. Do not take coverage claims on faith.\n\n`;
  }

  prompt += `## How to Decide\n`;
  prompt += `Default stance: the finding existed for a reason — hold unless the justification genuinely survives scrutiny.\n\n`;
  prompt += `Concede ONLY when the justification is valid, for example:\n`;
  prompt += `- The changed behavior is already covered by existing tests (verified, not just claimed)\n`;
  prompt += `- The change is genuinely non-behavioral, dev-only tooling, or unreachable in production\n`;
  prompt += `- The behavior is guaranteed by the framework/library rather than this code\n`;
  prompt += `- Testing this in this repo is infeasible and the cost clearly exceeds the risk\n\n`;
  prompt += `Hold when the justification is convenience ("hard to test", "no time", "will add later", "works locally"), or when a concrete failure scenario remains uncovered. When you hold:\n`;
  prompt += `- Name the specific scenario that could break without this test\n`;
  prompt += `- Restate the SMALLEST test that would cover it\n`;
  prompt += `- Be respectful and brief — you are debating a colleague, not lecturing\n\n`;
  prompt += `When you concede, acknowledge their specific point (not a generic "you're right").\n\n`;

  prompt += `## Output\n`;
  prompt += `Output ONLY a JSON object, no markdown fences, no extra text:\n`;
  prompt += `{\n`;
  prompt += `  "decision": "concede" | "hold",\n`;
  prompt += `  "reply": "Markdown reply to post in the thread (2-6 sentences, no headings)",\n`;
  prompt += `  "reason": "One-line summary of the author's justification (for record-keeping)",\n`;
  prompt += `  "confidence": 85\n`;
  prompt += `}\n`;

  return prompt;
}

/**
 * Ask Claude to judge a PR author's objection to a missing-test finding.
 * Non-fatal by design: any failure returns { success: false } and the caller stays silent.
 */
export function evaluateTestObjection(
  config: AppConfig,
  thread: TestDebateThread,
  cwd: string | undefined,
  logger: Logger,
): Promise<TestDebateResult> {
  const log = logger.child({ pr: `${thread.owner}/${thread.repo}#${thread.prNumber}`, phase: "test_debate" });

  const args = ["-p", "--output-format", "json"];
  if (cwd) {
    args.push("--tools", "Read,Grep,Glob");
    args.push("--max-turns", "8");
  }

  const prompt = buildDebatePrompt(thread, !!cwd);

  const promptDir = "/tmp/claude-prompts";
  mkdirSync(promptDir, { recursive: true });
  const promptFile = join(promptDir, `test-debate-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt);

  const shellCmd = `claude ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} < '${promptFile}'`;
  const timeoutMs = config.features.testDebate.timeoutMs;
  log.info("Invoking claude CLI for test debate", { args: args.join(" "), timeoutMs, cwd: cwd ?? "none", promptBytes: Buffer.byteLength(prompt) });

  return new Promise<TestDebateResult>((resolve) => {
    exec(shellCmd, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      cwd: cwd ?? undefined,
    }, (err, stdout, stderr) => {
      try { unlinkSync(promptFile); } catch { /* ignore */ }

      if (err) {
        log.error("Test debate session failed", { error: String(err), stderr: stderr?.trim().slice(0, 500) });
        resolve({ success: false, error: String(err) });
        return;
      }

      let body = stdout;
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) {
          const errMsg = typeof envelope.result === "string" ? envelope.result : "Claude returned an error";
          log.error("Test debate: Claude returned is_error", { message: errMsg });
          resolve({ success: false, error: errMsg });
          return;
        }
        body = typeof envelope.result === "string" ? envelope.result : stdout;
      } catch {
        log.warn("Test debate: Claude CLI did not return JSON envelope — using raw output");
      }

      const obj = extractJsonObject(body);
      const result = obj ? validateDebateResult(obj) : null;
      if (!result) {
        log.error("Test debate: could not parse decision JSON", { output: body.trim().slice(0, 500) });
        resolve({ success: false, error: "Unparseable debate decision" });
        return;
      }

      log.info("Test debate decision", { decision: result.decision, confidence: result.confidence });
      resolve(result);
    });
  });
}
