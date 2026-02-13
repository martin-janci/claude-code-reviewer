import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ClaudeUsage } from "../types.js";
import { extractUsage } from "../reviewer/claude.js";

function resolveDescriptionSkillPath(): string | null {
  const candidates = [
    "/home/node/.claude/skills/auto-description-prompt/skill.md",
    resolve(process.cwd(), ".claude/skills/auto-description-prompt/skill.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

interface DescriptionResult {
  description: string | null;
  usage?: ClaudeUsage;
}

/**
 * Generate a PR description from the diff and title using Claude CLI.
 * Returns the generated markdown (and optional usage data) or null on failure.
 */
export function generateDescription(
  diff: string,
  prTitle: string,
  timeoutMs: number,
): Promise<DescriptionResult> {
  const args = ["-p", "--output-format", "json"];

  const skillPath = resolveDescriptionSkillPath();
  if (skillPath) {
    args.push("--append-system-prompt-file", skillPath);
  }

  const userPrompt = `## PR Title: ${prTitle}\n\n## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\nGenerate a PR description following the format in your instructions.`;

  return new Promise((resolve) => {
    const child = execFile("claude", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    }, (err, stdout) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Auto-description generation failed:", message);
        resolve({ description: null });
        return;
      }

      // Parse JSON envelope from --output-format json
      let body: string;
      let usage: ClaudeUsage | undefined;
      try {
        const envelope = JSON.parse(stdout);
        body = (typeof envelope.result === "string" ? envelope.result : "").trim();
        if (envelope.is_error) {
          console.error("Auto-description: Claude returned an error:", body);
          resolve({ description: null });
          return;
        }
        usage = extractUsage(envelope);
      } catch {
        // Fallback for old CLI versions without JSON output support
        console.warn("Auto-description: Claude CLI did not return JSON — upgrade claude to enable usage tracking");
        body = stdout.trim();
      }

      if (!body) {
        console.warn("Auto-description returned empty output");
        resolve({ description: null, usage });
        return;
      }

      resolve({ description: body, usage });
    });

    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(userPrompt);
      child.stdin.end();
    }
  });
}
