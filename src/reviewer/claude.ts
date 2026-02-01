import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewResult, ReviewVerdict, StructuredReview, ConventionalLabel, ReviewFinding } from "../types.js";

// Resolve skill path: check Docker location first, then project-relative
function resolveSkillPath(): string | null {
  const candidates = [
    "/home/node/.claude/skills/code-review/skill.md",
    resolve(process.cwd(), ".claude/skills/code-review/skill.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export interface ReviewContext {
  previousVerdict?: string;
  previousSha?: string;
}

export interface ReviewOptions {
  diff: string;
  prTitle: string;
  context?: ReviewContext;
  cwd?: string;
  timeoutMs?: number;
  maxTurns?: number;
}

const VALID_VERDICTS = new Set<string>(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
const VALID_LABELS = new Set<string>(["issue", "suggestion", "nitpick", "question", "praise"]);

const JSON_SCHEMA = `{
  "verdict": "APPROVE | REQUEST_CHANGES | COMMENT",
  "summary": "Brief one-line summary of the review.",
  "findings": [
    {
      "severity": "issue | suggestion | nitpick | question | praise",
      "blocking": true,
      "path": "src/foo.ts",
      "line": 42,
      "body": "Explanation of the finding."
    }
  ],
  "overall": "Optional overall notes (omit if not needed)."
}`;

/**
 * Validate and normalize a parsed object into a StructuredReview.
 * Returns null if the object doesn't match the expected schema.
 */
function validateStructuredReview(obj: unknown): StructuredReview | null {
  if (!obj || typeof obj !== "object") return null;

  const o = obj as Record<string, unknown>;

  // Verdict
  if (typeof o.verdict !== "string" || !VALID_VERDICTS.has(o.verdict)) return null;
  const verdict = o.verdict as ReviewVerdict;

  // Summary
  if (typeof o.summary !== "string" || !o.summary.trim()) return null;
  const summary = o.summary.trim();

  // Findings
  if (!Array.isArray(o.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const f of o.findings) {
    if (!f || typeof f !== "object") continue;
    const fi = f as Record<string, unknown>;
    if (typeof fi.severity !== "string" || !VALID_LABELS.has(fi.severity)) continue;
    if (typeof fi.path !== "string" || !fi.path) continue;
    if (typeof fi.line !== "number" || fi.line < 1) continue;
    if (typeof fi.body !== "string" || !fi.body) continue;
    findings.push({
      severity: fi.severity as ConventionalLabel,
      blocking: fi.blocking === true,
      path: fi.path,
      line: fi.line,
      body: fi.body,
    });
  }

  // Overall (optional)
  const overall = typeof o.overall === "string" && o.overall.trim() ? o.overall.trim() : undefined;

  return { verdict, summary, findings, overall };
}

/**
 * Attempt to parse Claude's output as a structured JSON review.
 * Two-tier fallback: direct parse → fence extraction → null (freeform).
 */
export function parseStructuredReview(stdout: string): StructuredReview | null {
  const trimmed = stdout.trim();

  // Tier 1: direct JSON parse
  try {
    const obj = JSON.parse(trimmed);
    const result = validateStructuredReview(obj);
    if (result) return result;
  } catch {
    // Not direct JSON — try fence extraction
  }

  // Tier 2: extract from ```json ... ``` fence
  const fenceMatch = trimmed.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1]);
      const result = validateStructuredReview(obj);
      if (result) return result;
    } catch {
      // Invalid JSON in fence
    }
  }

  return null;
}

export function reviewDiff(options: ReviewOptions): Promise<ReviewResult> {
  const { diff, prTitle, context, cwd, timeoutMs, maxTurns } = options;

  let userPrompt = `## PR Title: ${prTitle}\n\n`;

  if (context?.previousVerdict && context.previousSha) {
    userPrompt += `## Re-review Context\nThis is a re-review. Previous verdict was **${context.previousVerdict}** at commit ${context.previousSha.slice(0, 7)}. Focus on what changed since the previous review.\n\n`;
  }

  if (cwd) {
    userPrompt += `## Codebase Access\nYou have read-only access to the full repository in your working directory. Use Read, Grep, and Glob tools to explore the codebase when the diff raises questions about contracts, callers, patterns, or architectural impact. Do NOT read every file — only explore when the diff context is insufficient.\n\n`;
  }

  userPrompt += `## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
  userPrompt += `## Output Requirements\nOutput ONLY a JSON object matching this schema — no markdown, no fences, no extra text:\n${JSON_SCHEMA}\n\nVerdict rules:\n- REQUEST_CHANGES if any finding has "blocking": true\n- APPROVE if no issues or only non-blocking suggestions\n- COMMENT for non-blocking observations worth noting`;

  const args = ["-p", "--output-format", "text"];

  const skillPath = resolveSkillPath();
  if (skillPath) {
    args.push("--append-system-prompt-file", skillPath);
  }

  if (cwd) {
    args.push("--tools", "Read,Grep,Glob");
  }

  if (maxTurns != null) {
    args.push("--max-turns", String(maxTurns));
  }

  return new Promise((resolve) => {
    const child = execFile("claude", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs ?? 300_000,
      cwd: cwd ?? undefined,
    }, (err, stdout) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Claude review failed:", message);
        resolve({ body: message, success: false });
        return;
      }

      const body = stdout.trim();
      const structured = parseStructuredReview(body);

      if (structured) {
        console.log(`Parsed structured review: verdict=${structured.verdict}, ${structured.findings.length} finding(s)`);
      } else {
        console.warn("Claude output was not valid structured JSON — using freeform fallback");
      }

      resolve({ body, success: true, structured: structured ?? undefined });
    });

    if (child.stdin) {
      child.stdin.on("error", () => {
        // Ignore stdin errors — the child may have exited before consuming all input.
        // The execFile callback will report the actual failure.
      });
      child.stdin.write(userPrompt);
      child.stdin.end();
    }
  });
}
