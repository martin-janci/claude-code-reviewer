import { execFile } from "node:child_process";
import { type Logger } from "../logger.js";
import type { AppConfig, PullRequest } from "../types.js";

export interface AutofixResult {
  success: boolean;
  commitSha?: string;
  filesChanged: number;
  fixBranch?: string; // Branch name where fixes were pushed (if not autoApply)
  error?: string;
}

/**
 * Execute autofix using Claude CLI with edit capabilities.
 * Creates a fix commit on the PR branch.
 */
export async function executeAutofix(
  config: AppConfig,
  pr: PullRequest,
  worktreePath: string,
  logger: Logger,
): Promise<AutofixResult> {
  const { owner, repo, number, headBranch } = pr;
  const log = logger.child({ owner, repo, prNumber: number, phase: "autofix" });

  log.info("Starting autofix session");

  // Build Claude CLI command with edit permissions and limited turns
  const args = [
    "--dangerously-allow-tool-risky-edits",
    "--max-turns",
    String(config.features.autofix.maxTurns),
    "--session-type",
    "one-time",
  ];

  // Prepare prompt: analyze the PR's review findings and apply fixes
  const prompt = buildAutofixPrompt(owner, repo, number);

  return new Promise<AutofixResult>((resolve) => {
    const child = execFile(
      "claude",
      [...args, prompt],
      {
        timeout: config.features.autofix.timeoutMs,
        cwd: worktreePath,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
            log.error("Autofix session timed out");
            resolve({ success: false, filesChanged: 0, error: "Timeout" });
            return;
          }
          log.error("Autofix session failed", { error: String(err), stderr });
          resolve({ success: false, filesChanged: 0, error: String(err) });
          return;
        }

        log.info("Autofix session completed", { stdout: stdout.slice(0, 500) });

        // Parse output to count files changed
        const filesChanged = countFilesChanged(stdout);

        // Create a commit with the fixes
        createFixCommit(worktreePath, owner, repo, number, log)
          .then((commitSha) => {
            if (!commitSha) {
              resolve({ success: false, filesChanged: 0, error: "No changes to commit" });
              return;
            }

            // Determine target branch based on autoApply setting
            const fixBranch = config.features.autofix.autoApply ? null : `autofix/pr-${number}`;
            resolve({ success: true, commitSha, filesChanged, fixBranch: fixBranch ?? undefined });
          })
          .catch((commitErr) => {
            log.error("Failed to create fix commit", { error: String(commitErr) });
            resolve({ success: false, filesChanged, error: String(commitErr) });
          });
      },
    );

    // Log Claude's progress in real-time
    child.stdout?.on("data", (chunk) => {
      log.debug("Claude output", { output: String(chunk).slice(0, 200) });
    });
  });
}

function buildAutofixPrompt(owner: string, repo: string, prNumber: number): string {
  return `You are helping fix issues identified in a code review for PR #${prNumber} in ${owner}/${repo}.

TASK:
1. Read the most recent review comment on this PR (use gh pr view ${prNumber} --json reviews)
2. Identify all "issue" and "suggestion" findings with specific file paths and line numbers
3. For each finding that can be automatically fixed:
   - Read the file
   - Apply the fix using Edit tool
   - Ensure the fix is minimal and targeted
4. DO NOT fix "nitpick", "question", or "praise" findings
5. DO NOT make changes beyond what was explicitly identified in the review
6. After all fixes are applied, summarize what you changed

CONSTRAINTS:
- Only fix issues that have clear, unambiguous solutions
- Preserve existing code style and formatting
- Do not refactor or improve code beyond the specific issue
- If a fix is unclear or risky, skip it and note why

Begin by reading the review findings.`;
}

function countFilesChanged(output: string): number {
  // Parse Claude output to estimate files changed
  // This is best-effort; actual count will come from git diff
  const editPattern = /Edit.*?file.*?:/gi;
  const matches = output.match(editPattern);
  return matches ? matches.length : 0;
}

async function createFixCommit(
  worktreePath: string,
  owner: string,
  repo: string,
  prNumber: number,
  logger: Logger,
): Promise<string | null> {
  return new Promise((resolve) => {
    // Check for changes
    execFile("git", ["diff", "--name-only"], { cwd: worktreePath }, (err, stdout) => {
      if (err || !stdout.trim()) {
        logger.info("No changes to commit after autofix");
        resolve(null);
        return;
      }

      const changedFiles = stdout.trim().split("\n");
      logger.info("Files modified by autofix", { files: changedFiles });

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
              logger.info("Created autofix commit", { sha });
              resolve(sha);
            });
          },
        );
      });
    });
  });
}
