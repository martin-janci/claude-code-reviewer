import { execFile } from "node:child_process";
import type { PullRequest } from "../types.js";

let ghToken: string | undefined;

export function setGhToken(token: string): void {
  ghToken = token;
}

function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (ghToken) {
      env.GH_TOKEN = ghToken;
    }

    const child = execFile("gh", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      env,
      timeout: 60_000,
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });

    if (input && child.stdin) {
      child.stdin.on("error", () => {
        // Ignore stdin errors — the child may have exited before consuming all input.
        // The execFile callback will report the actual failure.
      });
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

export async function listOpenPRs(owner: string, repo: string): Promise<PullRequest[]> {
  const json = await gh([
    "pr", "list",
    "--repo", `${owner}/${repo}`,
    "--state", "open",
    "--json", "number,title,headRefOid,isDraft,baseRefName",
    "--limit", "1000",
  ]);

  if (!json) return [];

  const raw = JSON.parse(json) as Array<{
    number: number;
    title: string;
    headRefOid: string;
    isDraft: boolean;
    baseRefName: string;
  }>;

  return raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
    headSha: pr.headRefOid,
    isDraft: pr.isDraft,
    baseBranch: pr.baseRefName,
    owner,
    repo,
  }));
}

export async function getPRDetails(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequest> {
  const json = await gh([
    "pr", "view", String(prNumber),
    "--repo", `${owner}/${repo}`,
    "--json", "number,title,headRefOid,isDraft,baseRefName",
  ]);

  if (!json) {
    throw new Error(`Empty response from gh pr view for ${owner}/${repo}#${prNumber}`);
  }

  const raw = JSON.parse(json) as {
    number: number;
    title: string;
    headRefOid: string;
    isDraft: boolean;
    baseRefName: string;
  };

  return {
    number: raw.number,
    title: raw.title,
    headSha: raw.headRefOid,
    isDraft: raw.isDraft,
    baseBranch: raw.baseRefName,
    owner,
    repo,
  };
}

export async function getPRState(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ state: string; mergedAt: string | null }> {
  const json = await gh([
    "pr", "view", String(prNumber),
    "--repo", `${owner}/${repo}`,
    "--json", "state,mergedAt",
  ]);

  if (!json) {
    throw new Error(`Empty response from gh pr view for ${owner}/${repo}#${prNumber}`);
  }

  return JSON.parse(json) as { state: string; mergedAt: string | null };
}

export async function getPRDiff(owner: string, repo: string, prNumber: number): Promise<string> {
  return gh([
    "pr", "diff", String(prNumber),
    "--repo", `${owner}/${repo}`,
  ]);
}

export async function findExistingComment(
  owner: string,
  repo: string,
  prNumber: number,
  tag: string,
): Promise<string | null> {
  // --paginate emits one JSON array per page (concatenated, not valid JSON).
  // Use --jq to flatten all pages into newline-delimited JSON objects.
  const ndjson = await gh([
    "api",
    "--paginate",
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
    "--jq", ".[] | {id, body}",
  ]);

  if (!ndjson) return null;

  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let comment: { id: number; body: string };
    try {
      comment = JSON.parse(line);
    } catch {
      continue;
    }
    if (comment.body.includes(tag)) {
      return String(comment.id);
    }
  }
  return null;
}

/**
 * Check if a comment still exists.
 * Returns true if it exists, false if it was deleted (404).
 * Throws on transient errors (500, 403, network) so callers can retry.
 */
export async function commentExists(
  owner: string,
  repo: string,
  commentId: string,
): Promise<boolean> {
  try {
    await gh([
      "api",
      `repos/${owner}/${repo}/issues/comments/${commentId}`,
    ]);
    return true;
  } catch (err) {
    // gh api exits with status 1 and includes "404" in the message for not found
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.includes("Not Found")) {
      return false;
    }
    // Re-throw transient errors so callers don't mistake them for deletion
    throw err;
  }
}

export async function postComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<string> {
  // Use stdin for the body to avoid ARG_MAX limits with large review comments
  const json = await gh([
    "api",
    "--method", "POST",
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
    "--input", "-",
  ], JSON.stringify({ body }));

  let result: { id: number };
  try {
    result = JSON.parse(json);
  } catch {
    throw new Error(`Failed to parse postComment response: ${json.slice(0, 200)}`);
  }
  return String(result.id);
}

export async function updateComment(
  owner: string,
  repo: string,
  commentId: string,
  body: string,
): Promise<void> {
  // Use stdin for the body to avoid ARG_MAX limits with large review comments
  await gh([
    "api",
    "--method", "PATCH",
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
    "--input", "-",
  ], JSON.stringify({ body }));
}

// --- PR Reviews API ---

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Post a PR review using the Pull Request Reviews API.
 * Always uses event: "COMMENT" — the bot should never approve or block.
 * Returns the review ID.
 */
export async function postReview(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  commitId: string,
  comments: ReviewComment[],
): Promise<string> {
  const payload = {
    body,
    event: "COMMENT",
    commit_id: commitId,
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      body: c.body,
    })),
  };

  const json = await gh([
    "api",
    "--method", "POST",
    `repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    "--input", "-",
  ], JSON.stringify(payload));

  let result: { id: number };
  try {
    result = JSON.parse(json);
  } catch {
    throw new Error(`Failed to parse postReview response: ${json.slice(0, 200)}`);
  }
  return String(result.id);
}

/**
 * Check if a PR review still exists and is not dismissed.
 * Returns { exists: true/false, dismissed: true/false }.
 */
export async function reviewExists(
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: string,
): Promise<{ exists: boolean; dismissed: boolean }> {
  try {
    const json = await gh([
      "api",
      `repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}`,
    ]);
    const review = JSON.parse(json) as { state: string };
    return {
      exists: true,
      dismissed: review.state === "DISMISSED",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.includes("Not Found")) {
      return { exists: false, dismissed: false };
    }
    throw err;
  }
}
