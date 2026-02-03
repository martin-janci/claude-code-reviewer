/**
 * Audit log types for tracking important operations
 */

export type AuditEventType =
  | "review_started"
  | "review_completed"
  | "review_failed"
  | "review_skipped"
  | "comment_posted"
  | "state_changed"
  | "feature_executed"
  | "config_loaded"
  | "server_started"
  | "server_stopped"
  | "webhook_received"
  | "poll_completed"
  | "auth_check"
  | "cleanup_executed";

export type AuditSeverity = "info" | "warning" | "error";

export interface AuditMetadata {
  // PR context
  owner?: string;
  repo?: string;
  prNumber?: number;
  sha?: string;

  // Review details
  verdict?: string;
  findingsCount?: number;
  durationMs?: number;

  // State tracking
  oldStatus?: string;
  newStatus?: string;

  // Feature tracking
  feature?: string;
  featureStatus?: string;

  // Error tracking
  error?: string;
  errorPhase?: string;

  // Webhook/polling
  webhookEvent?: string;
  pollIntervalSeconds?: number;

  // Auth
  cliName?: string;
  authStatus?: boolean;

  // Generic
  [key: string]: string | number | boolean | undefined;
}

export interface AuditEntry {
  timestamp: string; // ISO 8601
  eventType: AuditEventType;
  severity: AuditSeverity;
  message: string;
  metadata?: AuditMetadata;
  actor?: string; // e.g., "poller", "webhook", "manual"
}

export interface AuditLogConfig {
  enabled: boolean;
  maxEntries: number; // Rolling window size
  filePath: string;
  includeMetadata: boolean;
  minSeverity: AuditSeverity; // Filter events by minimum severity
}
