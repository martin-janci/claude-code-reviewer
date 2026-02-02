import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewResult, ReviewVerdict, StructuredReview, ConventionalLabel, ReviewFinding, FindingResolution, ResolutionEntry } from "../types.js";

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
  previousFindings?: ReviewFinding[];
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
  "resolutions": [
    {
      "path": "src/foo.ts",
      "line": 42,
      "body": "Brief explanation of the resolution status.",
      "resolution": "resolved | wont_fix | open"
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

  // Resolutions (optional — only present on re-reviews)
  const VALID_RESOLUTIONS = new Set<string>(["resolved", "wont_fix", "open"]);
  let resolutions: ResolutionEntry[] | undefined;
  if (Array.isArray(o.resolutions)) {
    const parsed: ResolutionEntry[] = [];
    for (const r of o.resolutions) {
      if (!r || typeof r !== "object") continue;
      const ri = r as Record<string, unknown>;
      if (typeof ri.path !== "string" || !ri.path) continue;
      if (typeof ri.line !== "number" || ri.line < 1) continue;
      if (typeof ri.body !== "string" || !ri.body) continue;
      if (typeof ri.resolution !== "string" || !VALID_RESOLUTIONS.has(ri.resolution)) continue;
      parsed.push({
        path: ri.path,
        line: ri.line,
        body: ri.body,
        resolution: ri.resolution as FindingResolution,
      });
    }
    if (parsed.length > 0) resolutions = parsed;
  }

  // Overall (optional)
  const overall = typeof o.overall === "string" && o.overall.trim() ? o.overall.trim() : undefined;

  return { verdict, summary, findings, overall, resolutions };
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

    if (context.previousFindings && context.previousFindings.length > 0) {
      userPrompt += `## Previous Review Findings\nThe previous review had these findings:\n`;
      for (const f of context.previousFindings) {
        userPrompt += `- **${f.severity}${f.blocking ? " (blocking)" : ""}** \`${f.path}:${f.line}\`: ${f.body}\n`;
      }
      userPrompt += `\nFor each previous finding, include a \`resolutions\` entry in your JSON output stating whether it is:\n`;
      userPrompt += `- "resolved" — the issue was fixed in the new code\n`;
      userPrompt += `- "wont_fix" — the issue is intentionally not addressed (explain why)\n`;
      userPrompt += `- "open" — the issue is still present and unresolved\n\n`;
      userPrompt += `Use the same \`path\` and \`line\` from the previous finding to identify it. If any previous blocking finding has resolution "open", your verdict MUST be REQUEST_CHANGES.\n\n`;
    }
  }

  if (cwd) {
    userPrompt += `## Codebase Access\nYou have read-only access to the full repository in your working directory. Use Read, Grep, and Glob tools to explore the codebase when the diff raises questions about contracts, callers, patterns, or architectural impact. Do NOT read every file — only explore when the diff context is insufficient.\n\n`;
  }

  userPrompt += `## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
  userPrompt += `## Output Requirements\nOutput ONLY a JSON object matching this schema — no markdown, no fences, no extra text:\n${JSON_SCHEMA}\n\nVerdict rules:\n- REQUEST_CHANGES if any finding has "blocking": true\n- APPROVE if no issues or only non-blocking suggestions\n- COMMENT for non-blocking observations worth noting\n\nResolutions array: only include when re-reviewing (previous findings were provided). Omit the field entirely on first reviews.`;

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

  console.log(`Invoking claude CLI: args=[${args.join(" ")}], timeout=${timeoutMs ?? 300_000}ms, cwd=${cwd ?? "none"}`);
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = execFile("claude", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs ?? 300_000,
      cwd: cwd ?? undefined,
    }, (err, stdout, stderr) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Claude CLI failed after ${elapsed}s: ${message}`);
        if (stderr?.trim()) {
          console.error("Claude stderr:", stderr.trim());
        }
        if (stdout?.trim()) {
          console.error("Claude stdout:", stdout.trim().slice(0, 2000));
        }
        resolve({ body: message, success: false });
        return;
      }

      const body = stdout.trim();
      console.log(`Claude CLI completed in ${elapsed}s (${body.length} bytes output)`);
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
      console.log(`Sent prompt to claude stdin (${Buffer.byteLength(userPrompt)} bytes)`);
    }
  });
}
