import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function resolveDescriptionSkillPath(): string | null {
  const p = resolve(process.cwd(), ".claude/skills/auto-description-prompt/skill.md");
  return existsSync(p) ? p : null;
}

/**
 * Generate a PR description from the diff and title using Claude CLI.
 * Returns the generated markdown or null on failure.
 */
export function generateDescription(
  diff: string,
  prTitle: string,
  timeoutMs: number,
): Promise<string | null> {
  const args = ["-p", "--output-format", "text"];

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
        resolve(null);
        return;
      }

      const body = stdout.trim();
      if (!body) {
        console.warn("Auto-description returned empty output");
        resolve(null);
        return;
      }

      resolve(body);
    });

    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(userPrompt);
      child.stdin.end();
    }
  });
}
