import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewResult } from "../types.js";

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

export function reviewDiff(options: ReviewOptions): Promise<ReviewResult> {
  const { diff, prTitle, context, cwd, timeoutMs, maxTurns } = options;

  let userPrompt = `## PR Title: ${prTitle}\n\n`;

  if (context?.previousVerdict && context.previousSha) {
    userPrompt += `## Re-review Context\nThis is a re-review. Previous verdict was **${context.previousVerdict}** at commit ${context.previousSha.slice(0, 7)}. Focus on what changed since the previous review.\n\n`;
  }

  if (cwd) {
    userPrompt += `## Codebase Access\nYou have read-only access to the full repository in your working directory. Use Read, Grep, and Glob tools to explore the codebase when the diff raises questions about contracts, callers, patterns, or architectural impact. Do NOT read every file — only explore when the diff context is insufficient.\n\n`;
  }

  userPrompt += `## Diff\n\`\`\`diff\n${diff}\n\`\`\``;

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
      resolve({ body: stdout.trim(), success: true });
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
