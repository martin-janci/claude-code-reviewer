import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import type { MetricsCollector, MetricsSnapshot } from "./metrics.js";
import type { PRStatus, ReviewVerdict, ErrorPhase, SkipReason } from "./types.js";

/**
 * Prometheus metrics exporter for Claude Code Reviewer
 * Converts internal JSON metrics to Prometheus text format
 */
export class PrometheusExporter {
  private registry: Registry;

  // Counters
  private reviewsTotal: Counter<string>;
  private errorsTotal: Counter<string>;
  private skipsTotal: Counter<string>;
  private stateTransitionsTotal: Counter<string>;

  // Gauges
  private prsGauge: Gauge<string>;
  private activeReviewsGauge: Gauge;
  private queueDepthGauge: Gauge;
  private uptimeGauge: Gauge;

  // Histograms
  private reviewDuration: Histogram<string>;

  constructor() {
    this.registry = new Registry();

    // Collect default Node.js metrics (CPU, memory, event loop, etc.)
    collectDefaultMetrics({
      register: this.registry,
      prefix: "claude_reviewer_",
    });

    // Review counters
    this.reviewsTotal = new Counter({
      name: "claude_reviewer_reviews_total",
      help: "Total number of PR reviews completed",
      labelNames: ["verdict"],
      registers: [this.registry],
    });

    // Error counters
    this.errorsTotal = new Counter({
      name: "claude_reviewer_errors_total",
      help: "Total number of errors encountered",
      labelNames: ["phase"],
      registers: [this.registry],
    });

    // Skip counters
    this.skipsTotal = new Counter({
      name: "claude_reviewer_skips_total",
      help: "Total number of PRs skipped",
      labelNames: ["reason"],
      registers: [this.registry],
    });

    // State transition counter
    this.stateTransitionsTotal = new Counter({
      name: "claude_reviewer_state_transitions_total",
      help: "Total number of PR state transitions",
      labelNames: ["from_status", "to_status"],
      registers: [this.registry],
    });

    // PR status gauges
    this.prsGauge = new Gauge({
      name: "claude_reviewer_prs",
      help: "Current number of PRs by status",
      labelNames: ["status"],
      registers: [this.registry],
    });

    // Capacity gauges
    this.activeReviewsGauge = new Gauge({
      name: "claude_reviewer_active_reviews",
      help: "Number of reviews currently in progress",
      registers: [this.registry],
    });

    this.queueDepthGauge = new Gauge({
      name: "claude_reviewer_queue_depth",
      help: "Number of PRs waiting for review",
      registers: [this.registry],
    });

    // Uptime gauge
    this.uptimeGauge = new Gauge({
      name: "claude_reviewer_uptime_seconds",
      help: "Service uptime in seconds",
      registers: [this.registry],
    });

    // Review duration histogram
    this.reviewDuration = new Histogram({
      name: "claude_reviewer_review_duration_seconds",
      help: "Review duration in seconds",
      labelNames: ["phase"],
      buckets: [1, 5, 10, 30, 60, 120, 300, 600], // 1s to 10min
      registers: [this.registry],
    });
  }

  /**
   * Update Prometheus metrics from internal metrics snapshot
   */
  updateMetrics(snapshot: MetricsSnapshot): void {
    // Update review counters by verdict
    for (const [verdict, count] of Object.entries(snapshot.reviews.byVerdict)) {
      this.reviewsTotal.labels(verdict).inc(count - (this.reviewsTotal.labels(verdict) as any)._value || 0);
    }

    // Update error counters by phase
    for (const [phase, count] of Object.entries(snapshot.errors.byPhase)) {
      this.errorsTotal.labels(phase).inc(count - (this.errorsTotal.labels(phase) as any)._value || 0);
    }

    // Update skip counters by reason
    for (const [reason, count] of Object.entries(snapshot.skips.byReason)) {
      this.skipsTotal.labels(reason).inc(count - (this.skipsTotal.labels(reason) as any)._value || 0);
    }

    // Update PR status gauges
    for (const [status, count] of Object.entries(snapshot.prs.byStatus)) {
      this.prsGauge.labels(status).set(count);
    }

    // Update capacity gauges
    this.activeReviewsGauge.set(snapshot.capacity.activeReviews);
    this.queueDepthGauge.set(snapshot.capacity.queueDepth);

    // Update uptime
    this.uptimeGauge.set(snapshot.uptime);

    // Update timing histograms
    if (snapshot.timings.total) {
      this.reviewDuration.labels("total").observe(snapshot.timings.total.avg / 1000);
    }

    for (const [phase, stats] of Object.entries(snapshot.timings.byPhase)) {
      if (stats) {
        this.reviewDuration.labels(phase).observe(stats.avg / 1000);
      }
    }
  }

  /**
   * Record a state transition
   */
  recordStateTransition(from: PRStatus, to: PRStatus): void {
    this.stateTransitionsTotal.labels(from, to).inc();
  }

  /**
   * Get Prometheus metrics in text format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get registry for custom metrics
   */
  getRegistry(): Registry {
    return this.registry;
  }
}
