import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { AuditEntry, AuditEventType, AuditSeverity, AuditMetadata, AuditLogConfig } from "./types.js";

/**
 * Audit logger for tracking important operations.
 * Maintains a rolling log of events with automatic rotation.
 */
export class AuditLogger {
  private entries: AuditEntry[] = [];
  private readonly severityRank: Record<AuditSeverity, number> = {
    info: 0,
    warning: 1,
    error: 2,
  };

  constructor(private config: AuditLogConfig) {
    if (config.enabled) {
      this.loadExisting();
    }
  }

  /**
   * Load existing audit log entries from disk
   */
  private loadExisting(): void {
    try {
      if (existsSync(this.config.filePath)) {
        const content = readFileSync(this.config.filePath, "utf-8");
        const data = JSON.parse(content);
        if (Array.isArray(data.entries)) {
          this.entries = data.entries.slice(-this.config.maxEntries);
        }
      }
    } catch (err) {
      console.warn("Failed to load audit log", { error: String(err) });
      this.entries = [];
    }
  }

  /**
   * Persist audit log to disk
   */
  private persist(): void {
    if (!this.config.enabled) return;

    try {
      // Ensure directory exists
      const dir = dirname(this.config.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Keep only maxEntries most recent entries
      const toSave = this.entries.slice(-this.config.maxEntries);

      const data = {
        version: 1,
        generatedAt: new Date().toISOString(),
        entries: toSave,
      };

      writeFileSync(this.config.filePath, JSON.stringify(data, null, 2), "utf-8");
      this.entries = toSave;
    } catch (err) {
      console.error("Failed to persist audit log", { error: String(err) });
    }
  }

  /**
   * Log an audit event
   */
  log(
    eventType: AuditEventType,
    severity: AuditSeverity,
    message: string,
    metadata?: AuditMetadata,
    actor?: string,
  ): void {
    if (!this.config.enabled) return;

    // Filter by minimum severity
    if (this.severityRank[severity] < this.severityRank[this.config.minSeverity]) {
      return;
    }

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      eventType,
      severity,
      message,
      metadata: this.config.includeMetadata ? metadata : undefined,
      actor,
    };

    this.entries.push(entry);
    this.persist();
  }

  /**
   * Convenience methods for common events
   */

  reviewStarted(owner: string, repo: string, prNumber: number, sha: string, actor?: string): void {
    this.log(
      "review_started",
      "info",
      `Review started for PR #${prNumber}`,
      { owner, repo, prNumber, sha },
      actor,
    );
  }

  reviewCompleted(
    owner: string,
    repo: string,
    prNumber: number,
    sha: string,
    verdict: string,
    findingsCount: number,
    durationMs: number,
    actor?: string,
  ): void {
    this.log(
      "review_completed",
      "info",
      `Review completed for PR #${prNumber}: ${verdict} (${findingsCount} findings)`,
      { owner, repo, prNumber, sha, verdict, findingsCount, durationMs },
      actor,
    );
  }

  reviewFailed(
    owner: string,
    repo: string,
    prNumber: number,
    sha: string,
    error: string,
    errorPhase: string,
    actor?: string,
  ): void {
    this.log(
      "review_failed",
      "error",
      `Review failed for PR #${prNumber} at ${errorPhase}`,
      { owner, repo, prNumber, sha, error: error.slice(0, 200), errorPhase },
      actor,
    );
  }

  reviewSkipped(
    owner: string,
    repo: string,
    prNumber: number,
    reason: string,
    actor?: string,
  ): void {
    this.log(
      "review_skipped",
      "info",
      `Review skipped for PR #${prNumber}: ${reason}`,
      { owner, repo, prNumber },
      actor,
    );
  }

  commentPosted(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: string,
    reviewId: string | null,
    actor?: string,
  ): void {
    this.log(
      "comment_posted",
      "info",
      `Comment posted for PR #${prNumber}`,
      { owner, repo, prNumber, commentId, reviewId: reviewId ?? undefined },
      actor,
    );
  }

  stateChanged(
    owner: string,
    repo: string,
    prNumber: number,
    oldStatus: string,
    newStatus: string,
    actor?: string,
  ): void {
    this.log(
      "state_changed",
      "info",
      `PR #${prNumber} state: ${oldStatus} → ${newStatus}`,
      { owner, repo, prNumber, oldStatus, newStatus },
      actor,
    );
  }

  featureExecuted(
    feature: string,
    status: string,
    durationMs: number,
    owner?: string,
    repo?: string,
    prNumber?: number,
    error?: string,
    actor?: string,
  ): void {
    const severity: AuditSeverity = status === "error" ? "error" : "info";
    this.log(
      "feature_executed",
      severity,
      `Feature ${feature} ${status}${prNumber ? ` for PR #${prNumber}` : ""}`,
      { feature, featureStatus: status, durationMs, owner, repo, prNumber, error: error?.slice(0, 100) },
      actor,
    );
  }

  configLoaded(mode: string, repoCount: number): void {
    this.log(
      "config_loaded",
      "info",
      `Config loaded: mode=${mode}, repos=${repoCount}`,
      { mode, repoCount },
      "system",
    );
  }

  serverStarted(component: string, port?: number): void {
    this.log(
      "server_started",
      "info",
      `${component} started${port ? ` on port ${port}` : ""}`,
      { component, port },
      "system",
    );
  }

  serverStopped(component: string): void {
    this.log(
      "server_stopped",
      "info",
      `${component} stopped`,
      { component },
      "system",
    );
  }

  webhookReceived(event: string, owner?: string, repo?: string, prNumber?: number): void {
    this.log(
      "webhook_received",
      "info",
      `Webhook received: ${event}${prNumber ? ` for PR #${prNumber}` : ""}`,
      { webhookEvent: event, owner, repo, prNumber },
      "webhook",
    );
  }

  pollCompleted(reposChecked: number, prsFound: number, durationMs: number): void {
    this.log(
      "poll_completed",
      "info",
      `Poll completed: ${reposChecked} repos, ${prsFound} PRs (${durationMs}ms)`,
      { reposChecked, prsFound, durationMs },
      "poller",
    );
  }

  authCheck(cliName: string, available: boolean, authenticated: boolean, error?: string): void {
    const severity: AuditSeverity = !available || !authenticated ? "warning" : "info";
    this.log(
      "auth_check",
      severity,
      `${cliName} auth: available=${available}, authenticated=${authenticated}`,
      { cliName, authStatus: authenticated, error: error?.slice(0, 100) },
      "system",
    );
  }

  cleanupExecuted(entriesRemoved: number, criteria: string): void {
    this.log(
      "cleanup_executed",
      "info",
      `Cleanup: removed ${entriesRemoved} entries (${criteria})`,
      { entriesRemoved, criteria },
      "system",
    );
  }

  /**
   * Get all entries (for /debug endpoint)
   */
  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  /**
   * Get entries filtered by criteria
   */
  getFiltered(filter: {
    eventType?: AuditEventType;
    severity?: AuditSeverity;
    actor?: string;
    since?: string;
    limit?: number;
  }): AuditEntry[] {
    let filtered = [...this.entries];

    if (filter.eventType) {
      filtered = filtered.filter(e => e.eventType === filter.eventType);
    }

    if (filter.severity) {
      const minRank = this.severityRank[filter.severity];
      filtered = filtered.filter(e => this.severityRank[e.severity] >= minRank);
    }

    if (filter.actor) {
      filtered = filtered.filter(e => e.actor === filter.actor);
    }

    if (filter.since) {
      const since = filter.since;
      filtered = filtered.filter(e => e.timestamp >= since);
    }

    if (filter.limit && filter.limit > 0) {
      filtered = filtered.slice(-filter.limit);
    }

    return filtered;
  }

  /**
   * Get statistics about audit log
   */
  getStats(): {
    totalEntries: number;
    bySeverity: Record<AuditSeverity, number>;
    byEventType: Record<string, number>;
    byActor: Record<string, number>;
    oldestEntry: string | null;
    newestEntry: string | null;
  } {
    const bySeverity: Record<AuditSeverity, number> = { info: 0, warning: 0, error: 0 };
    const byEventType: Record<string, number> = {};
    const byActor: Record<string, number> = {};

    for (const entry of this.entries) {
      bySeverity[entry.severity]++;
      byEventType[entry.eventType] = (byEventType[entry.eventType] || 0) + 1;
      if (entry.actor) {
        byActor[entry.actor] = (byActor[entry.actor] || 0) + 1;
      }
    }

    return {
      totalEntries: this.entries.length,
      bySeverity,
      byEventType,
      byActor,
      oldestEntry: this.entries[0]?.timestamp ?? null,
      newestEntry: this.entries[this.entries.length - 1]?.timestamp ?? null,
    };
  }
}
