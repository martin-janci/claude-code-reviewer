import type { ConventionalLabel, ReviewFinding, StructuredReview, RiskLevel } from "../types.js";

export interface JiraLink {
  key: string;
  url: string;
  summary?: string;
  valid: boolean;
}

const RISK_EMOJI: Record<RiskLevel, string> = {
  low: "🟢",
  medium: "🟡",
  high: "🟠",
  critical: "🔴",
};

/**
 * Filter findings by confidence threshold.
 */
export function filterByConfidence(findings: ReviewFinding[], threshold: number): ReviewFinding[] {
  if (threshold <= 0) return findings;
  return findings.filter((f) => (f.confidence ?? 100) >= threshold);
}

/**
 * Format the top-level review body with a collapsible summary.
 * orphanFindings are findings that couldn't be placed as inline comments.
 */
export function formatReviewBody(
  structured: StructuredReview,
  headSha: string,
  tag: string,
  orphanFindings: ReviewFinding[],
  jira?: JiraLink,
): string {
  const parts: string[] = [tag, ""];

  // PR Summary (TL;DR section)
  if (structured.prSummary) {
    const ps = structured.prSummary;
    const riskEmoji = RISK_EMOJI[ps.riskLevel] ?? "⚪";
    parts.push(`## TL;DR`);
    parts.push(`> ${ps.tldr}`);
    parts.push("");
    parts.push(`| Metric | Value |`);
    parts.push(`|--------|-------|`);
    parts.push(`| Files Changed | ${ps.filesChanged} |`);
    parts.push(`| Lines | +${ps.linesAdded} / -${ps.linesRemoved} |`);
    parts.push(`| Areas | ${ps.areasAffected.join(", ")} |`);
    parts.push(`| Risk | ${riskEmoji} ${ps.riskLevel.toUpperCase()} |`);
    if (ps.riskFactors && ps.riskFactors.length > 0) {
      parts.push("");
      parts.push(`**Risk Factors:** ${ps.riskFactors.join("; ")}`);
    }
    parts.push("");
  }

  // Jira link (before summary)
  if (jira) {
    if (jira.valid && jira.summary) {
      parts.push(`**Jira:** [${jira.key} \u2014 ${jira.summary}](${jira.url})`);
    } else {
      parts.push(`**Jira:** [${jira.key}](${jira.url})`);
    }
    parts.push("");
  }

  // Summary
  parts.push(`## Review Summary`);
  parts.push(structured.summary);
  parts.push("");

  // Collapsible findings overview
  const counts = countBySeverity(structured.findings);
  const countParts: string[] = [];
  for (const [label, count] of Object.entries(counts)) {
    if (count > 0) countParts.push(`${count} ${label}${count > 1 ? "s" : ""}`);
  }

  if (countParts.length > 0) {
    parts.push(`<details>`);
    parts.push(`<summary>Findings (${countParts.join(", ")})</summary>`);
    parts.push("");

    // Group by severity
    const grouped = groupBySeverity(structured.findings);
    for (const [label, findings] of grouped) {
      parts.push(`### ${pluralizeLabel(label)}`);
      for (const f of findings) {
        const blocking = f.blocking ? " (blocking)" : "";
        const isNew = f.isNew ? " 🆕" : "";
        const security = f.securityRelated ? " 🔐" : "";
        parts.push(`- \`${f.path}:${f.line}\` — ${truncate(f.body, 120)}${blocking}${security}${isNew}`);
      }
      parts.push("");
    }

    parts.push(`</details>`);
    parts.push("");
  }

  // Orphan findings (couldn't be placed inline)
  if (orphanFindings.length > 0) {
    parts.push(`### Additional Findings`);
    parts.push("");
    for (const f of orphanFindings) {
      const isNew = f.isNew ? " 🆕" : "";
      const security = f.securityRelated ? " 🔐" : "";
      parts.push(`**${f.severity}${f.blocking ? " (blocking)" : ""}${security}${isNew}:** \`${f.path}:${f.line}\``);
      parts.push(f.body);
      parts.push("");
    }
  }

  // Previous finding resolutions
  if (structured.resolutions?.length) {
    parts.push(`### Previous Finding Resolutions`);
    parts.push("");
    for (const r of structured.resolutions) {
      const icon = r.resolution === "resolved" ? "\u2705" : r.resolution === "wont_fix" ? "\u23ED\uFE0F" : "\u274C";
      parts.push(`${icon} \`${r.path}:${r.line}\` — **${r.resolution}**: ${r.body}`);
    }
    parts.push("");
  }

  // Overall notes
  if (structured.overall) {
    parts.push(structured.overall);
    parts.push("");
  }

  parts.push("---");
  parts.push(`*Reviewed by Claude Code at commit ${headSha.slice(0, 7)}*`);

  return parts.join("\n");
}

/**
 * Format an inline comment using Conventional Comments style.
 */
export function formatInlineComment(finding: ReviewFinding): string {
  const blockingStr = finding.blocking ? " (blocking)" : " (non-blocking)";
  const isNew = finding.isNew ? " 🆕" : "";
  const security = finding.securityRelated ? " 🔐" : "";
  return `**${finding.severity}${blockingStr}${security}${isNew}:** ${finding.body}`;
}

function countBySeverity(findings: ReviewFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}

function groupBySeverity(findings: ReviewFinding[]): Array<[ConventionalLabel, ReviewFinding[]]> {
  const order: ConventionalLabel[] = ["issue", "suggestion", "nitpick", "question", "praise"];
  const grouped = new Map<ConventionalLabel, ReviewFinding[]>();

  for (const f of findings) {
    if (!grouped.has(f.severity)) grouped.set(f.severity, []);
    grouped.get(f.severity)!.push(f);
  }

  return order.filter((l) => grouped.has(l)).map((l) => [l, grouped.get(l)!]);
}

const LABEL_PLURALS: Record<ConventionalLabel, string> = {
  issue: "Issues",
  suggestion: "Suggestions",
  nitpick: "Nitpicks",
  question: "Questions",
  praise: "Praise",
};

function pluralizeLabel(label: ConventionalLabel): string {
  return LABEL_PLURALS[label];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
