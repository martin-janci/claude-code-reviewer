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
    "--limit", "100",
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
  const json = await gh([
    "api",
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
  ]);

  if (!json) return null;

  const comments = JSON.parse(json) as Array<{ id: number; body: string }>;
  const match = comments.find((c) => c.body.includes(tag));
  return match ? String(match.id) : null;
}

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
  } catch {
    return false;
  }
}

export async function postComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<string> {
  const json = await gh([
    "api",
    "--method", "POST",
    `repos/${owner}/${repo}/issues/${prNumber}/comments`,
    "-f", `body=${body}`,
  ]);

  const result = JSON.parse(json) as { id: number };
  return String(result.id);
}

export async function updateComment(
  owner: string,
  repo: string,
  commentId: string,
  body: string,
): Promise<void> {
  await gh([
    "api",
    "--method", "PATCH",
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
    "-f", `body=${body}`,
  ]);
}
