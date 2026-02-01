/**
 * Parses a unified diff to determine which lines are commentable via the
 * GitHub Pull Request Reviews API (RIGHT side / new file lines).
 */

export type CommentableLines = Map<string, Set<number>>;

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
    } else if (line.startsWith(" ") || line === "") {
      // Context line: commentable on the right side
      lines.add(rightLine);
      rightLine++;
    }
    // Other lines (e.g. "\ No newline at end of file") are ignored
  }

  return result;
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
