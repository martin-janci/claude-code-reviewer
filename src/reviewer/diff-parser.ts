/**
 * Parses a unified diff to determine which lines are commentable via the
 * GitHub Pull Request Reviews API (RIGHT side / new file lines).
 */

export type CommentableLines = Map<string, Set<number>>;

/**
 * Simple glob matching: supports * (any chars in segment) and ** (any path segments).
 */
function globMatch(pattern: string, path: string): boolean {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}

/**
 * Filter a unified diff to exclude files matching any of the given glob patterns.
 * Returns the filtered diff and a count of excluded files.
 */
export function filterDiff(
  diff: string,
  excludePatterns: string[],
): { filtered: string; excludedCount: number } {
  if (excludePatterns.length === 0) return { filtered: diff, excludedCount: 0 };

  const lines = diff.split("\n");
  const outputLines: string[] = [];
  let excludedCount = 0;
  let excluding = false;
  let currentPath: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of a new file diff
    if (line.startsWith("diff --git ")) {
      // Check the next lines for the file path
      const pathLine = lines.slice(i, i + 5).find((l) => l.startsWith("+++ b/"));
      if (pathLine) {
        currentPath = pathLine.slice(6);
        excluding = excludePatterns.some((p) => globMatch(p, currentPath!));
        if (excluding) {
          excludedCount++;
        }
      } else {
        excluding = false;
      }
    }

    if (!excluding) {
      outputLines.push(line);
    }
  }

  return { filtered: outputLines.join("\n"), excludedCount };
}

/**
 * Parse a unified diff and return a map of file path → set of commentable line numbers.
 * Commentable lines are those on the RIGHT side (new file): context lines (` `) and additions (`+`).
 */
export function parseCommentableLines(diff: string): CommentableLines {
  const result: CommentableLines = new Map();
  let currentPath: string | null = null;
  let rightLine = 0;

  for (const line of diff.split("\n")) {
    // New file header: +++ b/path/to/file
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice(6);
      if (!result.has(currentPath)) {
        result.set(currentPath, new Set());
      }
      continue;
    }

    // Skip --- header and other non-diff lines
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("diff --git")) {
      currentPath = null;
      continue;
    }

    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      rightLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!currentPath) continue;

    const lines = result.get(currentPath)!;

    if (line.startsWith("+")) {
      // Addition: commentable on the right side
      lines.add(rightLine);
      rightLine++;
    } else if (line.startsWith("-")) {
      // Deletion: not commentable (no right-side line)
    } else if (line.startsWith(" ")) {
      // Context line: commentable on the right side
      lines.add(rightLine);
      rightLine++;
    }
    // Other lines (e.g. "\ No newline at end of file") are ignored
  }

  return result;
}

/**
 * Extract all file paths from a unified diff.
 */
export function extractDiffPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      paths.push(line.slice(6));
    }
  }
  return paths;
}

/**
 * Check if any paths in the diff match security-sensitive glob patterns.
 * Returns the list of matching paths.
 */
export function findSecurityPaths(diffPaths: string[], securityPatterns: string[]): string[] {
  if (securityPatterns.length === 0) return [];
  return diffPaths.filter((path) => securityPatterns.some((p) => globMatch(p, path)));
}

/**
 * Find the nearest commentable line to the given target line for a file.
 * Returns null if no commentable line is within maxDistance.
 */
export function findNearestCommentableLine(
  commentable: CommentableLines,
  path: string,
  targetLine: number,
  maxDistance: number = 3,
): number | null {
  const lines = commentable.get(path);
  if (!lines) return null;

  // Exact match
  if (lines.has(targetLine)) return targetLine;

  // Search outward from target
  for (let d = 1; d <= maxDistance; d++) {
    if (lines.has(targetLine + d)) return targetLine + d;
    if (lines.has(targetLine - d)) return targetLine - d;
  }

  return null;
}
