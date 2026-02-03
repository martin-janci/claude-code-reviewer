import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditEntry, AuditEventType, AuditSeverity, AuditMetadata, AuditLogConfig } from "./types.js";

/**
 * Simple file-based lock using mkdir (atomic on all platforms).
 * Reused from StateStore pattern.
 */
class FileLock {
  private lockPath: string;
  private acquired = false;
  private readonly staleMs = 60_000;

  constructor(filePath: string) {
    this.lockPath = `${filePath}.lock`;
  }

  acquire(timeoutMs: number = 5000): boolean {
    const deadline = Date.now() + timeoutMs;
    const spinMs = 50;

    while (Date.now() < deadline) {
      if (existsSync(this.lockPath)) {
        try {
          const stat = statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > this.staleMs) {
            try { rmdirSync(this.lockPath); } catch {}
          }
        } catch {}
      }

      try {
        mkdirSync(this.lockPath);
        this.acquired = true;
        return true;
      } catch {
        const waitUntil = Date.now() + spinMs;
        while (Date.now() < waitUntil) {}
      }
    }
    return false;
  }

  release(): void {
    if (this.acquired) {
      try { rmdirSync(this.lockPath); } catch {}
      this.acquired = false;
    }
  }
}

/**
 * Audit logger for tracking important operations.
 * Maintains a rolling log of events with automatic rotation.
 * Uses file locking and atomic writes for data integrity.
 */
export class AuditLogger {
  private entries: AuditEntry[] = [];
  private pendingWrites: AuditEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private consecutiveFlushFailures = 0;
  private readonly FLUSH_INTERVAL_MS = 5000; // Batch writes every 5 seconds
  private readonly FLUSH_BATCH_SIZE = 100; // Or when 100 entries pending
  private readonly MAX_FLUSH_FAILURES = 3; // Warn after this many failures
  private readonly severityRank: Record<AuditSeverity, number> = {
    info: 0,
    warning: 1,
    error: 2,
  };

  constructor(private config: AuditLogConfig) {
    if (config.enabled) {
      this.loadExisting();
      this.startFlushTimer();
    }
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushPending();
    }, this.FLUSH_INTERVAL_MS);
  }

  /**
   * Stop flush timer (for graceful shutdown)
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    this.flushPending();
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
   * Flush pending entries to disk with atomic writes and file locking
   */
  private flushPending(): void {
    if (!this.config.enabled || this.pendingWrites.length === 0) return;

    const lock = new FileLock(this.config.filePath);
    if (!lock.acquire()) {
      this.consecutiveFlushFailures++;
      if (this.consecutiveFlushFailures >= this.MAX_FLUSH_FAILURES) {
        console.warn(
          `Failed to acquire audit log lock ${this.consecutiveFlushFailures} times — ` +
          `${this.pendingWrites.length} entries pending. Lock may be held by another process or stale.`
        );
      }
      return;
    }

    try {
      // Merge pending writes into main entries
      this.entries.push(...this.pendingWrites);
      this.pendingWrites = [];

      // Keep only maxEntries most recent entries
      const toSave = this.entries.slice(-this.config.maxEntries);

      // Atomic reassignment - copy before mutation to avoid race with getEntries()
      this.entries = toSave;

      const dir = dirname(this.config.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data = {
        version: 1,
        generatedAt: new Date().toISOString(),
        entries: toSave,
      };

      // Atomic write: temp file + rename (like StateStore)
      const tmpPath = `${this.config.filePath}.tmp.${Date.now()}`;
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpPath, this.config.filePath);

      // Reset failure counter on success
      this.consecutiveFlushFailures = 0;
    } catch (err) {
      console.error("Failed to flush audit log", { error: String(err) });
      this.consecutiveFlushFailures++;
    } finally {
      lock.release();
    }
  }

  /**
   * Log an audit event (non-blocking, batched writes)
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

    this.pendingWrites.push(entry);

    // Immediate flush if batch size reached
    if (this.pendingWrites.length >= this.FLUSH_BATCH_SIZE) {
      this.flushPending();
    }
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
      { owner, repo, prNumber, commentId, ...(reviewId && { reviewId }) },
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
   * Returns a snapshot to avoid race conditions with flushPending()
   */
  getEntries(): AuditEntry[] {
    // Snapshot prevents race if flush mutates this.entries during iteration
    const snapshot = this.entries;
    return [...snapshot];
  }

  /**
   * Get entries filtered by criteria
   * Returns a snapshot to avoid race conditions with flushPending()
   */
  getFiltered(filter: {
    eventType?: AuditEventType;
    severity?: AuditSeverity;
    actor?: string;
    since?: string;
    limit?: number;
  }): AuditEntry[] {
    // Snapshot prevents race if flush mutates this.entries during iteration
    const snapshot = this.entries;
    let filtered = [...snapshot];

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
   * Uses a snapshot to avoid race conditions with flushPending()
   */
  getStats(): {
    totalEntries: number;
    bySeverity: Record<AuditSeverity, number>;
    byEventType: Record<string, number>;
    byActor: Record<string, number>;
    oldestEntry: string | null;
    newestEntry: string | null;
  } {
    // Snapshot prevents race if flush mutates this.entries during iteration
    const snapshot = this.entries;
    const bySeverity: Record<AuditSeverity, number> = { info: 0, warning: 0, error: 0 };
    const byEventType: Record<string, number> = {};
    const byActor: Record<string, number> = {};

    for (const entry of snapshot) {
      bySeverity[entry.severity]++;
      byEventType[entry.eventType] = (byEventType[entry.eventType] || 0) + 1;
      if (entry.actor) {
        byActor[entry.actor] = (byActor[entry.actor] || 0) + 1;
      }
    }

    return {
      totalEntries: snapshot.length,
      bySeverity,
      byEventType,
      byActor,
      oldestEntry: snapshot[0]?.timestamp ?? null,
      newestEntry: snapshot[snapshot.length - 1]?.timestamp ?? null,
    };
  }
}
