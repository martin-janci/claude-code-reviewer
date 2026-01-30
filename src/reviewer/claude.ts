import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewResult } from "../types.js";

// Resolve skill path: check Docker location first, then project-relative
function resolveSkillPath(): string | null {
  const candidates = [
    "/home/node/.claude/skills/code-review.md",
    resolve(process.cwd(), ".claude/skills/code-review.md"),
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

export function reviewDiff(diff: string, prTitle: string, context?: ReviewContext): Promise<ReviewResult> {
  let userPrompt = `## PR Title: ${prTitle}\n\n`;

  if (context?.previousVerdict && context.previousSha) {
    userPrompt += `## Re-review Context\nThis is a re-review. Previous verdict was **${context.previousVerdict}** at commit ${context.previousSha.slice(0, 7)}. Focus on what changed since the previous review.\n\n`;
  }

  userPrompt += `## Diff\n\`\`\`diff\n${diff}\n\`\`\``;

  const args = ["-p", "--output-format", "text"];

  const skillPath = resolveSkillPath();
  if (skillPath) {
    args.push("--append-system-prompt-file", skillPath);
  }

  return new Promise((resolve) => {
    const child = execFile("claude", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300_000, // 5 minute timeout
    }, (err, stdout) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Claude review failed:", message);
        resolve({ body: "", success: false });
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
