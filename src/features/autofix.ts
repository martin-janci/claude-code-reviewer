import { exec, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Logger } from "../logger.js";
import type { AppConfig, PullRequest, ReviewFinding } from "../types.js";

export interface AutofixResult {
  success: boolean;
  commitSha?: string;
  filesChanged: number; // Actual count from git diff
  fixBranch?: string; // Branch name where fixes were pushed (if not autoApply)
  error?: string;
}

/**
 * Execute autofix using Claude CLI with edit capabilities.
 * Creates a fix commit on the PR branch.
 *
 * @param findings - Latest review findings from state (if available). Passed
 *   directly in the prompt so Claude doesn't need to fetch them via Bash.
 */
export async function executeAutofix(
  config: AppConfig,
  pr: PullRequest,
  worktreePath: string,
  logger: Logger,
  findings?: ReviewFinding[],
): Promise<AutofixResult> {
  const { owner, repo, number } = pr;
  const log = logger.child({ owner, repo, prNumber: number, phase: "autofix" });

  log.info("Starting autofix session", { findingsCount: findings?.length ?? 0 });

  // Build Claude CLI args
  const args = [
    "-p",
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--max-turns", String(config.features.autofix.maxTurns),
    // Explicitly allow the tools autofix needs:
    // - Bash: run gh CLI (fallback fetch), linters, build checks
    // - Read/Edit/Write/Glob/Grep: read and modify source files
    // - WebFetch/WebSearch: look up API docs, changelogs when needed
    "--tools", "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch",
  ];

  const prompt = buildAutofixPrompt(owner, repo, number, findings);

  // Write prompt to temp file and redirect via shell (same pattern as reviewer)
  const promptDir = "/tmp/claude-prompts";
  mkdirSync(promptDir, { recursive: true });
  const promptFile = join(promptDir, `autofix-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt);

  const shellCmd = `claude ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} < '${promptFile}'`;
  log.info("Invoking claude CLI for autofix", {
    args: args.join(" "),
    timeoutMs: config.features.autofix.timeoutMs,
    cwd: worktreePath,
    findingsProvided: (findings?.length ?? 0) > 0,
  });

  return new Promise<AutofixResult>((resolve) => {
    exec(shellCmd, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: config.features.autofix.timeoutMs,
      cwd: worktreePath,
    }, (err, stdout, stderr) => {
      // Clean up temp file
      try { unlinkSync(promptFile); } catch { /* ignore */ }

      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT" || err.killed) {
          log.error("Autofix session timed out");
          resolve({ success: false, filesChanged: 0, error: "Timeout" });
          return;
        }
        log.error("Autofix session failed", { error: String(err), stderr });
        resolve({ success: false, filesChanged: 0, error: String(err) });
        return;
      }

      // Parse JSON envelope from --output-format json
      let outputText = stdout;
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) {
          const errMsg = typeof envelope.result === "string" ? envelope.result : "Claude returned an error";
          log.error("Autofix: Claude returned is_error", { message: errMsg });
          resolve({ success: false, filesChanged: 0, error: errMsg });
          return;
        }
        outputText = typeof envelope.result === "string" ? envelope.result : stdout;
      } catch {
        // Fallback for old CLI versions without JSON output support
        log.warn("Autofix: Claude CLI did not return JSON — upgrade claude to enable structured output");
      }

      log.info("Autofix session completed", { output: outputText.slice(0, 500) });

      // Create a commit with the fixes (returns actual file count from git diff)
      createFixCommit(worktreePath, owner, repo, number, log)
        .then((result) => {
          if (!result) {
            resolve({ success: false, filesChanged: 0, error: "No changes to commit" });
            return;
          }

          // Determine target branch based on autoApply setting
          const fixBranch = config.features.autofix.autoApply ? null : `autofix/pr-${number}`;
          resolve({ success: true, commitSha: result.sha, filesChanged: result.filesChanged, fixBranch: fixBranch ?? undefined });
        })
        .catch((commitErr) => {
          log.error("Failed to create fix commit", { error: String(commitErr) });
          resolve({ success: false, filesChanged: 0, error: String(commitErr) });
        });
    });
  });
}

function buildAutofixPrompt(owner: string, repo: string, prNumber: number, findings?: ReviewFinding[]): string {
  let prompt = `You are helping fix issues identified in a code review for PR #${prNumber} in ${owner}/${repo}.\n\n`;

  const fixable = findings?.filter(f => f.severity === "issue" || f.severity === "suggestion") ?? [];

  if (fixable.length > 0) {
    prompt += `## Review Findings\n\nThe following findings were identified in the most recent code review:\n\n`;
    fixable.forEach((f, i) => {
      prompt += `### Finding ${i + 1}${f.blocking ? " ⚠️ BLOCKING" : ""}\n`;
      prompt += `- **Severity**: ${f.severity}\n`;
      prompt += `- **File**: \`${f.path}\` line ${f.line}\n`;
      prompt += `- **Issue**: ${f.body}\n\n`;
    });
  } else if (findings !== undefined) {
    // Findings were fetched from state but there's nothing fixable
    prompt += `## Review Findings\n\nNo fixable findings (issue/suggestion severity) were found in the latest review. Nothing to fix.\n\n`;
  } else {
    // No findings provided — fall back to having Claude fetch them
    prompt += `## Step 1: Fetch Review Findings\n\n`;
    prompt += `Run the following to get the latest review:\n`;
    prompt += `\`\`\`bash\ngh pr view ${prNumber} --repo ${owner}/${repo} --json reviews --jq '.reviews[-1].body'\n\`\`\`\n\n`;
    prompt += `Parse the review comment to identify all findings marked as "issue" or "suggestion" with specific file paths and line numbers.\n\n`;
  }

  prompt += `## Task\n\nFor each "issue" and "suggestion" finding with a specific file path and line number:\n`;
  prompt += `1. Read the file at the given path\n`;
  prompt += `2. Understand the context around the specified line\n`;
  prompt += `3. Apply a minimal, targeted fix using the Edit tool\n`;
  prompt += `4. Verify the fix is correct and doesn't break surrounding logic\n\n`;

  prompt += `## Constraints\n`;
  prompt += `- DO NOT fix "nitpick", "question", or "praise" findings\n`;
  prompt += `- DO NOT make changes beyond what was explicitly identified in the review\n`;
  prompt += `- Preserve existing code style and formatting\n`;
  prompt += `- Do not refactor or improve code beyond the specific issue\n`;
  prompt += `- If a fix is unclear or risky, skip it and note why\n\n`;

  prompt += `After all fixes are applied, briefly summarize what you changed and what you skipped.`;

  return prompt;
}

async function createFixCommit(
  worktreePath: string,
  owner: string,
  repo: string,
  prNumber: number,
  logger: Logger,
): Promise<{ sha: string; filesChanged: number } | null> {
  return new Promise((resolve) => {
    // Check for changes
    execFile("git", ["diff", "--name-only"], { cwd: worktreePath }, (err, stdout) => {
      if (err || !stdout.trim()) {
        logger.info("No changes to commit after autofix");
        resolve(null);
        return;
      }

      const changedFiles = stdout.trim().split("\n");
      const filesChanged = changedFiles.length;
      logger.info("Files modified by autofix", { files: changedFiles, count: filesChanged });

      // Stage all changes
      execFile("git", ["add", "-A"], { cwd: worktreePath }, (addErr) => {
        if (addErr) {
          logger.error("Failed to stage changes", { error: String(addErr) });
          resolve(null);
          return;
        }

        // Create commit
        const commitMessage = `fix: autofix issues from code review

Automatically applied fixes for issues identified in PR #${prNumber}.

Co-authored-by: Claude Code Reviewer <bot@claude.ai>`;

        execFile(
          "git",
          ["commit", "-m", commitMessage],
          { cwd: worktreePath },
          (commitErr, commitStdout) => {
            if (commitErr) {
              logger.error("Failed to create commit", { error: String(commitErr) });
              resolve(null);
              return;
            }

            // Get commit SHA
            execFile("git", ["rev-parse", "HEAD"], { cwd: worktreePath }, (shaErr, shaStdout) => {
              if (shaErr) {
                logger.error("Failed to get commit SHA", { error: String(shaErr) });
                resolve(null);
                return;
              }

              const sha = shaStdout.trim();
              logger.info("Created autofix commit", { sha, filesChanged });
              resolve({ sha, filesChanged });
            });
          },
        );
      });
    });
  });
}
