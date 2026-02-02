import type { ReviewVerdict, ReviewFinding, ConventionalLabel, AutoLabelConfig } from "../types.js";
import { addLabels as ghAddLabels, removeLabels as ghRemoveLabels } from "../reviewer/github.js";

/**
 * Simple glob matching: supports * (any chars) and ** (any path segment).
 * Converts a glob pattern to a regex for matching file paths.
 */
function globMatch(pattern: string, path: string): boolean {
  // Escape regex special chars except * and **
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}

/**
 * Extract file paths from a unified diff (lines starting with "+++ b/").
 */
function extractDiffPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      paths.push(line.slice(6));
    }
  }
  return paths;
}

/**
 * Collect all "managed" labels — labels that appear anywhere in the config.
 * Only managed labels will be removed; unmanaged labels are never touched.
 */
function collectManagedLabels(config: AutoLabelConfig): Set<string> {
  const managed = new Set<string>();

  for (const labels of Object.values(config.verdictLabels)) {
    if (labels) for (const l of labels) managed.add(l);
  }
  for (const labels of Object.values(config.severityLabels)) {
    if (labels) for (const l of labels) managed.add(l);
  }
  for (const rule of config.diffLabels) {
    managed.add(rule.label);
  }

  return managed;
}

/**
 * Compute which labels to add and remove based on review results and config.
 */
export function computeLabels(
  verdict: ReviewVerdict,
  findings: ReviewFinding[],
  diff: string,
  config: AutoLabelConfig,
  currentLabels: string[],
): { add: string[]; remove: string[] } {
  const toAdd = new Set<string>();

  // 1. Verdict labels
  const verdictLabels = config.verdictLabels[verdict];
  if (verdictLabels) {
    for (const l of verdictLabels) toAdd.add(l);
  }

  // 2. Severity labels — for each severity present in findings
  const severities = new Set<ConventionalLabel>(findings.map((f) => f.severity));
  for (const severity of severities) {
    const labels = config.severityLabels[severity];
    if (labels) {
      for (const l of labels) toAdd.add(l);
    }
  }

  // 3. Diff labels — match file paths against patterns
  const paths = extractDiffPaths(diff);
  for (const rule of config.diffLabels) {
    if (paths.some((p) => globMatch(rule.pattern, p))) {
      toAdd.add(rule.label);
    }
  }

  // 4. Reconcile: only remove managed labels that are NOT in the add set
  const managed = collectManagedLabels(config);
  const currentSet = new Set(currentLabels);

  const add = [...toAdd].filter((l) => !currentSet.has(l));
  const remove = currentLabels.filter((l) => managed.has(l) && !toAdd.has(l));

  return { add, remove };
}

/**
 * Apply label changes to a PR via the GitHub API.
 * Errors are logged and swallowed — labeling is non-fatal.
 */
export async function applyLabels(
  owner: string,
  repo: string,
  prNumber: number,
  decision: { add: string[]; remove: string[] },
): Promise<void> {
  if (decision.add.length > 0) {
    await ghAddLabels(owner, repo, prNumber, decision.add);
  }
  if (decision.remove.length > 0) {
    await ghRemoveLabels(owner, repo, prNumber, decision.remove);
  }
}
