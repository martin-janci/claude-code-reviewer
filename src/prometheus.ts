import { Registry, Counter, Gauge, collectDefaultMetrics } from "prom-client";
import type { MetricsSnapshot } from "./metrics.js";
import type { PRStatus } from "./types.js";

/**
 * Prometheus metrics exporter for Claude Code Reviewer
 * Converts internal JSON metrics to Prometheus text format
 *
 * Note: This uses gauges for cumulative counters since we're syncing from
 * an external state rather than incrementing on events. This is the correct
 * approach when the source of truth is a snapshot rather than event stream.
 */
export class PrometheusExporter {
  private registry: Registry;

  // Gauges for cumulative values (synced from snapshots)
  private reviewsTotalGauge: Gauge<string>;
  private errorsTotalGauge: Gauge<string>;
  private skipsTotalGauge: Gauge<string>;

  // Gauges for current state
  private prsGauge: Gauge<string>;
  private activeReviewsGauge: Gauge;
  private queueDepthGauge: Gauge;
  private uptimeGauge: Gauge;

  // Gauges for timing statistics
  private reviewDurationAvg: Gauge<string>;
  private reviewDurationP95: Gauge<string>;
  private reviewDurationMax: Gauge<string>;

  // Token/cache usage gauges
  private tokensTotalGauge: Gauge<string>;
  private costTotalGauge: Gauge;
  private cacheHitRateGauge: Gauge;

  // Rate limit gauges
  private rateLimitPausedGauge: Gauge;
  private rateLimitPausesTotalGauge: Gauge;
  private rateLimitQueueDepthGauge: Gauge;
  private rateLimitCooldownGauge: Gauge;

  constructor() {
    this.registry = new Registry();

    // Collect default Node.js metrics (CPU, memory, event loop, etc.)
    // Note: These will have standard prometheus names (process_*, nodejs_*)
    collectDefaultMetrics({
      register: this.registry,
    });

    // Review totals (as gauges since we're syncing from external state)
    this.reviewsTotalGauge = new Gauge({
      name: "claude_reviewer_reviews_total",
      help: "Total number of PR reviews completed",
      labelNames: ["verdict"],
      registers: [this.registry],
    });

    // Error totals
    this.errorsTotalGauge = new Gauge({
      name: "claude_reviewer_errors_total",
      help: "Total number of errors encountered",
      labelNames: ["phase"],
      registers: [this.registry],
    });

    // Skip totals
    this.skipsTotalGauge = new Gauge({
      name: "claude_reviewer_skips_total",
      help: "Total number of PRs skipped",
      labelNames: ["reason"],
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

    // Review duration gauges (statistics from rolling window)
    this.reviewDurationAvg = new Gauge({
      name: "claude_reviewer_review_duration_avg_seconds",
      help: "Average review duration by phase (rolling window)",
      labelNames: ["phase"],
      registers: [this.registry],
    });

    this.reviewDurationP95 = new Gauge({
      name: "claude_reviewer_review_duration_p95_seconds",
      help: "95th percentile review duration by phase (rolling window)",
      labelNames: ["phase"],
      registers: [this.registry],
    });

    this.reviewDurationMax = new Gauge({
      name: "claude_reviewer_review_duration_max_seconds",
      help: "Maximum review duration by phase (rolling window)",
      labelNames: ["phase"],
      registers: [this.registry],
    });

    // Token/cache usage gauges
    this.tokensTotalGauge = new Gauge({
      name: "claude_reviewer_tokens_total",
      help: "Total tokens by type (input, output, cache_read, cache_creation)",
      labelNames: ["type"],
      registers: [this.registry],
    });

    this.costTotalGauge = new Gauge({
      name: "claude_reviewer_cost_usd_total",
      help: "Total cost in USD across all Claude invocations",
      registers: [this.registry],
    });

    this.cacheHitRateGauge = new Gauge({
      name: "claude_reviewer_cache_hit_rate",
      help: "Prompt cache hit rate (0-1)",
      registers: [this.registry],
    });

    // Rate limit gauges
    this.rateLimitPausedGauge = new Gauge({
      name: "claude_reviewer_rate_limit_paused",
      help: "Whether the rate limit guard is currently paused (0 or 1)",
      registers: [this.registry],
    });

    this.rateLimitPausesTotalGauge = new Gauge({
      name: "claude_reviewer_rate_limit_pauses_total",
      help: "Total number of rate limit pauses",
      registers: [this.registry],
    });

    this.rateLimitQueueDepthGauge = new Gauge({
      name: "claude_reviewer_rate_limit_queue_depth",
      help: "Number of reviews queued behind rate limit guard",
      registers: [this.registry],
    });

    this.rateLimitCooldownGauge = new Gauge({
      name: "claude_reviewer_rate_limit_cooldown_remaining_seconds",
      help: "Seconds remaining until rate limit cooldown expires",
      registers: [this.registry],
    });
  }

  /**
   * Update Prometheus metrics from internal metrics snapshot
   * This is called on each /metrics request to sync with current state
   */
  updateMetrics(snapshot: MetricsSnapshot): void {
    // Update review totals by verdict
    for (const [verdict, count] of Object.entries(snapshot.reviews.byVerdict)) {
      this.reviewsTotalGauge.labels(verdict).set(count);
    }

    // Update error totals by phase
    for (const [phase, count] of Object.entries(snapshot.errors.byPhase)) {
      this.errorsTotalGauge.labels(phase).set(count);
    }

    // Update skip totals by reason
    for (const [reason, count] of Object.entries(snapshot.skips.byReason)) {
      this.skipsTotalGauge.labels(reason).set(count);
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

    // Update timing statistics
    if (snapshot.timings.total) {
      this.reviewDurationAvg.labels("total").set(snapshot.timings.total.avg / 1000);
      this.reviewDurationP95.labels("total").set(snapshot.timings.total.p95 / 1000);
      this.reviewDurationMax.labels("total").set(snapshot.timings.total.max / 1000);
    }

    for (const [phase, stats] of Object.entries(snapshot.timings.byPhase)) {
      if (stats) {
        this.reviewDurationAvg.labels(phase).set(stats.avg / 1000);
        this.reviewDurationP95.labels(phase).set(stats.p95 / 1000);
        this.reviewDurationMax.labels(phase).set(stats.max / 1000);
      }
    }

    // Update token/cache usage gauges
    if (snapshot.usage) {
      this.tokensTotalGauge.labels("input").set(snapshot.usage.totalInputTokens);
      this.tokensTotalGauge.labels("output").set(snapshot.usage.totalOutputTokens);
      this.tokensTotalGauge.labels("cache_read").set(snapshot.usage.totalCacheReadTokens);
      this.tokensTotalGauge.labels("cache_creation").set(snapshot.usage.totalCacheCreationTokens);
      this.costTotalGauge.set(snapshot.usage.totalCostUsd);
      this.cacheHitRateGauge.set(snapshot.usage.cacheHitRate);
    }

    // Update rate limit gauges
    if (snapshot.rateLimit) {
      this.rateLimitPausedGauge.set(snapshot.rateLimit.paused ? 1 : 0);
      this.rateLimitPausesTotalGauge.set(snapshot.rateLimit.pauseCount);
      this.rateLimitQueueDepthGauge.set(snapshot.rateLimit.queueDepth);
      this.rateLimitCooldownGauge.set(snapshot.rateLimit.cooldownRemainingSeconds);
    }
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
