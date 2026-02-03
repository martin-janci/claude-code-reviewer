import type { PRStatus, ReviewVerdict, ErrorPhase, SkipReason } from "./types.js";

export interface PhaseTimings {
  diff_fetch_ms: number;
  clone_prepare_ms: number;
  claude_review_ms: number;
  comment_post_ms: number;
  total_ms: number;
}

export interface TimingStats {
  min: number;
  max: number;
  avg: number;
  p95: number;
  count: number;
}

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
  capacity: {
    activeReviews: number;
    queueDepth: number;
  };
  timings: {
    total: TimingStats | null;
    byPhase: Partial<Record<keyof PhaseTimings, TimingStats>>;
  };
}

const ROLLING_WINDOW = 100;

function computeStats(values: number[]): TimingStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    p95: sorted[p95Index],
    count: sorted.length,
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

  // Phase timing rolling window
  private timingWindow: PhaseTimings[] = [];

  // Capacity tracking
  private _activeReviews = 0;
  private _queueDepth = 0;

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

  recordReviewTiming(timings: PhaseTimings): void {
    this.timingWindow.push(timings);
    if (this.timingWindow.length > ROLLING_WINDOW) {
      this.timingWindow.shift();
    }
  }

  updateCapacity(activeReviews: number, queueDepth: number): void {
    this._activeReviews = activeReviews;
    this._queueDepth = queueDepth;
  }

  snapshot(uptimeSeconds: number, prStatusCounts: Partial<Record<PRStatus, number>>): MetricsSnapshot {
    const prTotal = Object.values(prStatusCounts).reduce((sum, n) => sum + (n ?? 0), 0);

    // Compute timing stats
    const totalTimes = this.timingWindow.map((t) => t.total_ms);
    const phaseKeys: (keyof PhaseTimings)[] = [
      "diff_fetch_ms", "clone_prepare_ms", "claude_review_ms", "comment_post_ms", "total_ms",
    ];
    const byPhase: Partial<Record<keyof PhaseTimings, TimingStats>> = {};
    for (const key of phaseKeys) {
      const values = this.timingWindow.map((t) => t[key]).filter((v) => v > 0);
      const stats = computeStats(values);
      if (stats) byPhase[key] = stats;
    }

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
      capacity: {
        activeReviews: this._activeReviews,
        queueDepth: this._queueDepth,
      },
      timings: {
        total: computeStats(totalTimes),
        byPhase,
      },
    };
  }
}
