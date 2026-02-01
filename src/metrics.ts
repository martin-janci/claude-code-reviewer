import type { PRStatus, ReviewVerdict, ErrorPhase, SkipReason } from "./types.js";

export interface MetricsSnapshot {
  uptime: number;
  reviews: {
    total: number;
    byVerdict: Record<ReviewVerdict, number>;
  };
  errors: {
    total: number;
    byPhase: Record<ErrorPhase, number>;
  };
  skips: {
    total: number;
    byReason: Partial<Record<SkipReason, number>>;
  };
  prs: {
    total: number;
    byStatus: Partial<Record<PRStatus, number>>;
  };
}

export class MetricsCollector {
  private reviewCount = 0;
  private verdictCounts: Record<ReviewVerdict, number> = {
    APPROVE: 0,
    REQUEST_CHANGES: 0,
    COMMENT: 0,
    unknown: 0,
  };
  private errorCount = 0;
  private errorPhaseCounts: Record<ErrorPhase, number> = {
    diff_fetch: 0,
    clone_prepare: 0,
    claude_review: 0,
    comment_post: 0,
    jira_validate: 0,
    description_generate: 0,
    label_apply: 0,
  };
  private skipCount = 0;
  private skipReasonCounts: Partial<Record<SkipReason, number>> = {};

  recordReview(verdict: ReviewVerdict): void {
    this.reviewCount++;
    this.verdictCounts[verdict]++;
  }

  recordError(phase: ErrorPhase): void {
    this.errorCount++;
    this.errorPhaseCounts[phase]++;
  }

  recordSkip(reason: SkipReason): void {
    this.skipCount++;
    this.skipReasonCounts[reason] = (this.skipReasonCounts[reason] ?? 0) + 1;
  }

  snapshot(uptimeSeconds: number, prStatusCounts: Partial<Record<PRStatus, number>>): MetricsSnapshot {
    const prTotal = Object.values(prStatusCounts).reduce((sum, n) => sum + (n ?? 0), 0);
    return {
      uptime: uptimeSeconds,
      reviews: {
        total: this.reviewCount,
        byVerdict: { ...this.verdictCounts },
      },
      errors: {
        total: this.errorCount,
        byPhase: { ...this.errorPhaseCounts },
      },
      skips: {
        total: this.skipCount,
        byReason: { ...this.skipReasonCounts },
      },
      prs: {
        total: prTotal,
        byStatus: prStatusCounts,
      },
    };
  }
}
