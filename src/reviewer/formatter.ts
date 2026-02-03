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

const SEVERITY_EMOJI: Record<ConventionalLabel, string> = {
  issue: "🚨",
  suggestion: "💡",
  nitpick: "✨",
  question: "❓",
  praise: "👏",
};

const VERDICT_EMOJI = {
  APPROVE: "✅",
  REQUEST_CHANGES: "🔄",
  COMMENT: "💬",
  unknown: "❔",
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

  // Verdict badge at the top
  const verdictEmoji = VERDICT_EMOJI[structured.verdict] ?? VERDICT_EMOJI.unknown;
  const verdictText = structured.verdict === "APPROVE" ? "Approved" :
                      structured.verdict === "REQUEST_CHANGES" ? "Changes Requested" :
                      structured.verdict === "COMMENT" ? "Commented" : "Review Complete";
  parts.push(`## ${verdictEmoji} ${verdictText}`);
  parts.push("");

  // PR Summary (TL;DR section)
  if (structured.prSummary) {
    const ps = structured.prSummary;
    const riskEmoji = RISK_EMOJI[ps.riskLevel] ?? "⚪";
    parts.push(`### 📋 PR Overview`);
    parts.push("");
    parts.push(`> ${ps.tldr}`);
    parts.push("");
    parts.push(`| 📊 Metric | Value |`);
    parts.push(`|-----------|-------|`);
    parts.push(`| 📁 Files Changed | ${ps.filesChanged} |`);
    parts.push(`| 📝 Lines | +${ps.linesAdded} / -${ps.linesRemoved} |`);
    parts.push(`| 🎯 Areas | ${ps.areasAffected.join(", ")} |`);
    parts.push(`| ${riskEmoji} Risk Level | **${ps.riskLevel.toUpperCase()}** |`);
    if (ps.riskFactors && ps.riskFactors.length > 0) {
      parts.push("");
      parts.push(`⚠️ **Risk Factors:**`);
      for (const factor of ps.riskFactors) {
        parts.push(`- ${factor}`);
      }
    }
    parts.push("");
  }

  // Jira link (before summary)
  if (jira) {
    if (jira.valid && jira.summary) {
      parts.push(`🎫 **Jira:** [${jira.key}](${jira.url}) — ${jira.summary}`);
    } else {
      parts.push(`🎫 **Jira:** [${jira.key}](${jira.url})`);
    }
    parts.push("");
  }

  // Summary
  parts.push(`### 📝 Review Summary`);
  parts.push(structured.summary);
  parts.push("");

  // Collapsible findings overview
  const counts = countBySeverity(structured.findings);
  const countParts: string[] = [];
  const totalBlockingCount = structured.findings.filter(f => f.blocking).length;

  for (const [label, count] of Object.entries(counts)) {
    if (count > 0) {
      const emoji = SEVERITY_EMOJI[label as ConventionalLabel] ?? "";
      countParts.push(`${emoji} ${count} ${label}${count > 1 ? "s" : ""}`);
    }
  }

  if (countParts.length > 0) {
    const blockingSuffix = totalBlockingCount > 0 ? ` — ⚠️ ${totalBlockingCount} blocking` : "";
    parts.push(`<details>`);
    parts.push(`<summary>🔍 Findings (${countParts.join(", ")})${blockingSuffix}</summary>`);
    parts.push("");

    // Group by severity
    const grouped = groupBySeverity(structured.findings);
    for (const [label, findings] of grouped) {
      const emoji = SEVERITY_EMOJI[label] ?? "";
      parts.push(`### ${emoji} ${pluralizeLabel(label)}`);
      for (const f of findings) {
        const blocking = f.blocking ? " 🚫 **blocking**" : "";
        const isNew = f.isNew ? " 🆕" : "";
        const security = f.securityRelated ? " 🔐" : "";
        const confidence = f.confidence !== undefined && f.confidence < 100 ? ` (${f.confidence}% confidence)` : "";
        parts.push(`- \`${f.path}:${f.line}\` — ${truncate(f.body, 120)}${blocking}${security}${isNew}${confidence}`);
      }
      parts.push("");
    }

    parts.push(`</details>`);
    parts.push("");
  }

  // Orphan findings (couldn't be placed inline)
  if (orphanFindings.length > 0) {
    parts.push(`### 📌 Additional Findings`);
    parts.push("");
    parts.push(`> The following findings couldn't be placed as inline comments (line out of range or file removed):`);
    parts.push("");
    for (const f of orphanFindings) {
      const emoji = SEVERITY_EMOJI[f.severity] ?? "";
      const isNew = f.isNew ? " 🆕" : "";
      const security = f.securityRelated ? " 🔐" : "";
      const blocking = f.blocking ? " 🚫 **blocking**" : "";
      parts.push(`${emoji} **${f.severity}${blocking}${security}${isNew}:** \`${f.path}:${f.line}\``);
      parts.push("");
      parts.push(f.body);
      parts.push("");
    }
  }

  // Previous finding resolutions
  if (structured.resolutions?.length) {
    parts.push(`### ✅ Previous Finding Resolutions`);
    parts.push("");
    const resolvedCount = structured.resolutions.filter(r => r.resolution === "resolved").length;
    const wontFixCount = structured.resolutions.filter(r => r.resolution === "wont_fix").length;
    const openCount = structured.resolutions.filter(r => r.resolution === "open").length;

    const statusParts: string[] = [];
    if (resolvedCount > 0) statusParts.push(`✅ ${resolvedCount} resolved`);
    if (wontFixCount > 0) statusParts.push(`⏭️ ${wontFixCount} won't fix`);
    if (openCount > 0) statusParts.push(`⏸️ ${openCount} still open`);

    if (statusParts.length > 0) {
      parts.push(`> ${statusParts.join(" • ")}`);
      parts.push("");
    }

    for (const r of structured.resolutions) {
      const icon = r.resolution === "resolved" ? "✅" : r.resolution === "wont_fix" ? "⏭️" : "⏸️";
      const resolutionText = r.resolution.replace("_", " ").toUpperCase();
      parts.push(`${icon} \`${r.path}:${r.line}\` — **${resolutionText}**`);
      parts.push(`${r.body}`);
      parts.push("");
    }
  }

  // Overall notes
  if (structured.overall) {
    parts.push(`### 💭 Additional Notes`);
    parts.push("");
    parts.push(structured.overall);
    parts.push("");
  }

  parts.push("---");
  parts.push(`🤖 *Reviewed by Claude Code at commit [\`${headSha.slice(0, 7)}\`](../../commit/${headSha})*`);

  return parts.join("\n");
}

/**
 * Format an inline comment using Conventional Comments style.
 */
export function formatInlineComment(finding: ReviewFinding): string {
  const emoji = SEVERITY_EMOJI[finding.severity] ?? "";
  const blockingStr = finding.blocking ? " 🚫 **blocking**" : "";
  const isNew = finding.isNew ? " 🆕" : "";
  const security = finding.securityRelated ? " 🔐" : "";
  const confidence = finding.confidence !== undefined && finding.confidence < 100 ? ` *(${finding.confidence}% confidence)*` : "";
  return `${emoji} **${finding.severity}${blockingStr}${security}${isNew}:** ${finding.body}${confidence}`;
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
