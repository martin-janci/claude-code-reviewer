import { exec, execFile } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ReviewResult, ReviewVerdict, StructuredReview, ConventionalLabel, ReviewFinding, FindingResolution, ResolutionEntry, PRSummary, RiskLevel, ClaudeUsage } from "../types.js";
import type { Logger } from "../logger.js";

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
  logger?: Logger;
  focusPaths?: string[];
  securityPaths?: string[]; // Paths that touch security-sensitive areas
  sessionId?: string; // Resume a previous session for prompt cache reuse
}

const VALID_VERDICTS = new Set<string>(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
const VALID_LABELS = new Set<string>(["issue", "suggestion", "nitpick", "question", "praise"]);
const VALID_RISK_LEVELS = new Set<string>(["low", "medium", "high", "critical"]);

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

  // PR Summary (optional)
  let prSummary: PRSummary | undefined;
  if (o.prSummary && typeof o.prSummary === "object") {
    const ps = o.prSummary as Record<string, unknown>;
    if (
      typeof ps.tldr === "string" && ps.tldr.trim() &&
      typeof ps.filesChanged === "number" &&
      typeof ps.linesAdded === "number" &&
      typeof ps.linesRemoved === "number" &&
      Array.isArray(ps.areasAffected) &&
      typeof ps.riskLevel === "string" && VALID_RISK_LEVELS.has(ps.riskLevel)
    ) {
      prSummary = {
        tldr: ps.tldr.trim(),
        filesChanged: ps.filesChanged,
        linesAdded: ps.linesAdded,
        linesRemoved: ps.linesRemoved,
        areasAffected: ps.areasAffected.filter((a): a is string => typeof a === "string"),
        riskLevel: ps.riskLevel as RiskLevel,
        riskFactors: Array.isArray(ps.riskFactors)
          ? ps.riskFactors.filter((r): r is string => typeof r === "string")
          : undefined,
      };
    }
  }

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
    const finding: ReviewFinding = {
      severity: fi.severity as ConventionalLabel,
      blocking: fi.blocking === true,
      path: fi.path,
      line: fi.line,
      body: fi.body,
    };
    // Optional fields
    if (typeof fi.confidence === "number" && fi.confidence >= 0 && fi.confidence <= 100) {
      finding.confidence = fi.confidence;
    }
    if (typeof fi.securityRelated === "boolean") {
      finding.securityRelated = fi.securityRelated;
    }
    if (typeof fi.isNew === "boolean") {
      finding.isNew = fi.isNew;
    }
    findings.push(finding);
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

  return { verdict, summary, prSummary, findings, overall, resolutions };
}

/**
 * Attempt to parse Claude's output as a structured JSON review.
 * Three-tier fallback: direct parse → fence extraction → trailing JSON extraction → null (freeform).
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

  // Tier 3: extract JSON object from mixed text output.
  // Claude sometimes outputs reasoning/thinking text before the JSON object.
  // Strategy: find each '{' in the text (searching from the end) and try
  // JSON.parse on the substring from that '{' to the last '}'. This is
  // simple, correct, and delegates all parsing complexity to JSON.parse.
  const lastBrace = trimmed.lastIndexOf("}");
  if (lastBrace !== -1) {
    let searchFrom = lastBrace;
    while (searchFrom >= 0) {
      const openIdx = trimmed.lastIndexOf("{", searchFrom);
      if (openIdx === -1) break;
      const candidate = trimmed.slice(openIdx, lastBrace + 1);
      try {
        const obj = JSON.parse(candidate);
        const result = validateStructuredReview(obj);
        if (result) return result;
      } catch {
        // Not valid JSON starting here — try the next '{' to the left
      }
      searchFrom = openIdx - 1;
    }
  }

  return null;
}

/**
 * Extract usage metrics from the Claude CLI JSON envelope.
 * Maps snake_case API fields to camelCase ClaudeUsage.
 */
export function extractUsage(envelope: Record<string, unknown>): ClaudeUsage | undefined {
  // The JSON envelope exposes usage fields at the top level
  if (typeof envelope.session_id !== "string") return undefined;

  return {
    inputTokens: typeof envelope.input_tokens === "number" ? envelope.input_tokens : 0,
    outputTokens: typeof envelope.output_tokens === "number" ? envelope.output_tokens : 0,
    cacheCreationInputTokens: typeof envelope.cache_creation_input_tokens === "number" ? envelope.cache_creation_input_tokens : 0,
    cacheReadInputTokens: typeof envelope.cache_read_input_tokens === "number" ? envelope.cache_read_input_tokens : 0,
    totalCostUsd: typeof envelope.cost_usd === "number" ? envelope.cost_usd : 0,
    model: typeof envelope.model === "string" ? envelope.model : "unknown",
    numTurns: typeof envelope.num_turns === "number" ? envelope.num_turns : 0,
    durationMs: typeof envelope.duration_ms === "number" ? envelope.duration_ms : 0,
    durationApiMs: typeof envelope.duration_api_ms === "number" ? envelope.duration_api_ms : 0,
    sessionId: envelope.session_id,
  };
}

export function reviewDiff(options: ReviewOptions): Promise<ReviewResult> {
  const { diff, prTitle, context, cwd, timeoutMs, maxTurns, logger: log, focusPaths, securityPaths, sessionId } = options;

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

  if (focusPaths && focusPaths.length > 0) {
    userPrompt += `## Focus Paths\nFocus your review on changes in these paths: ${focusPaths.join(", ")}. Findings outside these paths should be deprioritized unless they represent critical issues.\n\n`;
  }

  if (securityPaths && securityPaths.length > 0) {
    userPrompt += `## Security-Sensitive Files\n⚠️ This PR touches security-sensitive paths:\n`;
    for (const p of securityPaths) {
      userPrompt += `- \`${p}\`\n`;
    }
    userPrompt += `\nApply elevated scrutiny to these files. Look carefully for:\n`;
    userPrompt += `- Authentication/authorization bypasses\n`;
    userPrompt += `- Credential exposure or hardcoded secrets\n`;
    userPrompt += `- Injection vulnerabilities (SQL, command, XSS)\n`;
    userPrompt += `- Cryptographic weaknesses\n`;
    userPrompt += `- Access control issues\n\n`;
    userPrompt += `Mark security-related findings with \`"securityRelated": true\` in the JSON output.\n\n`;
  }

  userPrompt += `## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
  userPrompt += `## Output Requirements\nOutput ONLY a JSON object matching this schema — no markdown, no fences, no extra text:\n${JSON_SCHEMA}\n\nVerdict rules:\n- REQUEST_CHANGES if any finding has "blocking": true\n- APPROVE if no issues or only non-blocking suggestions\n- COMMENT for non-blocking observations worth noting\n\nResolutions array: only include when re-reviewing (previous findings were provided). Omit the field entirely on first reviews.`;

  const args = ["-p", "--output-format", "json"];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

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

  // Write prompt to temp file and redirect stdin via shell — more reliable
  // than Node.js child.stdin.write() which can race with process startup.
  const promptDir = "/tmp/claude-prompts";
  mkdirSync(promptDir, { recursive: true });
  const promptFile = join(promptDir, `review-${Date.now()}.txt`);
  writeFileSync(promptFile, userPrompt);

  const shellCmd = `claude ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} < '${promptFile}'`;

  if (log) {
    log.info("Invoking claude CLI", { args: args.join(" "), timeoutMs: timeoutMs ?? 300_000, cwd: cwd ?? "none", promptBytes: Buffer.byteLength(userPrompt) });
  } else {
    console.log(`Invoking claude CLI: args=[${args.join(" ")}], timeout=${timeoutMs ?? 300_000}ms, cwd=${cwd ?? "none"}, prompt=${Buffer.byteLength(userPrompt)} bytes`);
  }
  const startTime = Date.now();

  return new Promise((resolve) => {
    exec(shellCmd, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs ?? 300_000,
      cwd: cwd ?? undefined,
    }, (err, stdout, stderr) => {
      // Clean up temp file
      try { unlinkSync(promptFile); } catch {}

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errLog = log ?? console;
        if (log) {
          log.error("Claude CLI failed", { elapsedS: elapsed, error: message, stderr: stderr?.trim().slice(0, 500), stdout: stdout?.trim().slice(0, 500) });
        } else {
          console.error(`Claude CLI failed after ${elapsed}s: ${message}`);
          if (stderr?.trim()) console.error("Claude stderr:", stderr.trim());
          if (stdout?.trim()) console.error("Claude stdout:", stdout.trim().slice(0, 2000));
          console.error("Prompt preview:", userPrompt.slice(0, 200));
        }
        resolve({ body: message, success: false });
        return;
      }

      // Parse JSON envelope from --output-format json
      let body: string;
      let usage: ClaudeUsage | undefined;
      try {
        const envelope = JSON.parse(stdout);
        body = (typeof envelope.result === "string" ? envelope.result : "").trim();
        if (envelope.is_error) {
          resolve({ body: body || "Claude returned an error", success: false });
          return;
        }
        usage = extractUsage(envelope);
      } catch {
        // Fallback for old CLI versions without JSON output support
        body = stdout.trim();
      }

      const structured = parseStructuredReview(body);

      // Log cache stats when available
      if (usage && log) {
        const total = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
        const hitRate = total > 0 ? usage.cacheReadInputTokens / total : 0;
        log.info("Claude usage", {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheRead: usage.cacheReadInputTokens,
          cacheWrite: usage.cacheCreationInputTokens,
          cost: usage.totalCostUsd,
          cacheHitRate: Math.round(hitRate * 100) + "%",
          sessionId: usage.sessionId,
        });
      }

      if (log) {
        log.info("Claude CLI completed", { elapsedS: elapsed, outputBytes: body.length, structured: !!structured, verdict: structured?.verdict, findings: structured?.findings.length });
      } else {
        console.log(`Claude CLI completed in ${elapsed}s (${body.length} bytes output)`);
        if (structured) {
          console.log(`Parsed structured review: verdict=${structured.verdict}, ${structured.findings.length} finding(s)`);
        } else {
          console.warn("Claude output was not valid structured JSON — using freeform fallback");
        }
      }

      resolve({ body, success: true, structured: structured ?? undefined, usage });
    });
  });
}
