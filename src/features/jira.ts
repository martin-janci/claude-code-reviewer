import { request } from "node:https";

const JIRA_KEY_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/**
 * Extract a Jira issue key from the PR title or branch name.
 * Searches title first (higher signal), then branch.
 * If projectKeys is non-empty, only matches with a known prefix are returned.
 */
export function extractJiraKey(
  title: string,
  branch: string,
  projectKeys: string[],
): string | null {
  const candidates: string[] = [];

  // Collect all matches from title first, then branch
  for (const source of [title, branch]) {
    const globalRegex = new RegExp(JIRA_KEY_REGEX.source, "g");
    let match: RegExpExecArray | null;
    while ((match = globalRegex.exec(source)) !== null) {
      candidates.push(match[1]);
    }
  }

  if (candidates.length === 0) return null;

  // If projectKeys is specified, filter to matching prefixes
  if (projectKeys.length > 0) {
    const upperKeys = new Set(projectKeys.map((k) => k.toUpperCase()));
    const filtered = candidates.filter((c) => {
      const prefix = c.split("-")[0];
      return upperKeys.has(prefix);
    });
    return filtered[0] ?? null;
  }

  return candidates[0];
}

interface JiraValidationResult {
  valid: boolean;
  summary?: string;
  url: string;
}

/**
 * Validate a Jira issue key against the Jira REST API.
 * Returns validation result with issue summary if valid.
 */
export function validateJiraIssue(
  baseUrl: string,
  email: string,
  token: string,
  key: string,
): Promise<JiraValidationResult> {
  const url = `${baseUrl}/browse/${key}`;

  return new Promise((resolve) => {
    const parsedUrl = new URL(`${baseUrl}/rest/api/3/issue/${key}?fields=summary,status`);
    const auth = Buffer.from(`${email}:${token}`).toString("base64");

    const req = request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "GET",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
        timeout: 15_000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const data = JSON.parse(body) as { fields: { summary: string } };
              resolve({ valid: true, summary: data.fields.summary, url });
            } catch {
              resolve({ valid: true, url });
            }
          } else {
            resolve({ valid: false, url });
          }
        });
      },
    );

    req.on("error", () => {
      resolve({ valid: false, url });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ valid: false, url });
    });
    req.end();
  });
}
