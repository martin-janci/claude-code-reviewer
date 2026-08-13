/**
 * Parses a unified diff to determine which lines are commentable via the
 * GitHub Pull Request Reviews API (RIGHT side / new file lines).
 */

export type CommentableLines = Map<string, Set<number>>;

const globCache = new Map<string, RegExp>();

/**
 * Compile a glob to a regex:
 *   `*`   → any chars within one path segment
 *   `?`   → exactly one char within one path segment
 *   `**`  → any chars across segments
 *   `**​/` → zero or more leading segments, so `**​/foo` also matches root-level `foo`
 */
function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }

  const regex = new RegExp(`^${out}$`);
  globCache.set(pattern, regex);
  return regex;
}

/**
 * Simple glob matching: supports *, ?, and ** (any path segments).
 */
function globMatch(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * Decide whether a path is excluded, honouring `!`-prefixed negations with
 * gitignore's last-match-wins semantics.
 */
export function isExcluded(path: string, patterns: string[]): boolean {
  let excluded = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (excluded && globMatch(pattern.slice(1), path)) excluded = false;
    } else if (!excluded && globMatch(pattern, path)) {
      excluded = true;
    }
  }
  return excluded;
}

/**
 * Parse `.claudeignore` content (gitignore-style syntax) into glob patterns
 * compatible with filterDiff's matcher. Negations are preserved with their `!`
 * prefix — dropping them would silently over-exclude the paths they re-include.
 */
export function parseClaudeIgnore(content: string): string[] {
  const patterns: string[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const negated = line.startsWith("!");
    // A leading backslash escapes a literal `!` or `#` (gitignore semantics)
    const body = negated ? line.slice(1) : line.replace(/^\\(?=[!#])/, "");
    if (!body) continue;

    const isDir = body.endsWith("/");
    const core = isDir ? body.slice(0, -1) : body;
    const explicitAnchor = core.startsWith("/");
    const base = explicitAnchor ? core.slice(1) : core;
    if (!base) continue;
    // A pattern is anchored to the repo root if it starts with "/" or contains
    // an inner "/" (gitignore semantics); otherwise it matches at any depth.
    const anchored = explicitAnchor || base.includes("/");
    const bases = anchored ? [base] : [base, `**/${base}`];
    const prefix = negated ? "!" : "";

    for (const b of bases) {
      // Match the entry itself, and (unless explicitly dir-only) everything under it,
      // since a bare pattern may also refer to a directory.
      if (!isDir) patterns.push(`${prefix}${b}`);
      patterns.push(`${prefix}${b}/**`);
    }
  }

  return patterns;
}

/**
 * Merge parsed `.claudeignore` patterns with the configured exclude patterns.
 * Config patterns come last so that — under last-match-wins — an operator-owned
 * rule always beats a repo-owned one.
 */
export function mergeExcludePatterns(basePatterns: string[], claudeIgnoreContent: string | null): string[] {
  if (!claudeIgnoreContent) return basePatterns;
  return [...parseClaudeIgnore(claudeIgnoreContent), ...basePatterns];
}

/**
 * Extract the file path a `diff --git` block refers to.
 * Prefers the new-file header, falls back to the rename target and then to the
 * old-file header, so deletions (`+++ /dev/null`) and pure renames (no `---`/`+++`
 * headers at all) still resolve to a path.
 */
function extractBlockPath(lines: string[], start: number): string | null {
  let newPath: string | null = null;
  let oldPath: string | null = null;
  let renamePath: string | null = null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Header block ends at the first hunk or at the next file
    if (line.startsWith("@@") || line.startsWith("diff --git ")) break;
    if (line.startsWith("+++ b/")) newPath = line.slice(6);
    else if (line.startsWith("--- a/")) oldPath = line.slice(6);
    else if (line.startsWith("rename to ")) renamePath = line.slice(10);
  }

  if (newPath) return newPath;
  if (renamePath) return renamePath;
  if (oldPath) return oldPath;

  // Last resort: parse the `diff --git a/<old> b/<new>` header itself
  const header = lines[start].match(/^diff --git a\/(.+) b\/(.+)$/);
  return header ? header[2] : null;
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of a new file diff
    if (line.startsWith("diff --git ")) {
      const path = extractBlockPath(lines, i);
      excluding = path !== null && isExcluded(path, excludePatterns);
      if (excluding) {
        excludedCount++;
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
