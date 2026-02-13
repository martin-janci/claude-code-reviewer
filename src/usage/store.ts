import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ClaudeUsage, UsageSource } from "../types.js";

interface UsageRecord {
  timestamp: string;
  owner: string;
  repo: string;
  prNumber: number;
  source: UsageSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  sessionId: string;
}

interface OverallSummary {
  totalReviews: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  cacheHitRate: number;
  avgCostPerReview: number;
  repos: RepoSummary[];
}

interface RepoSummary {
  owner: string;
  repo: string;
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  cacheHitRate: number;
  avgCostPerReview: number;
}

interface RecentRecord {
  id: number;
  timestamp: string;
  owner: string;
  repo: string;
  prNumber: number;
  source: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  sessionId: string;
}

export class UsageStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private upsertSessionStmt: Database.Statement;
  private getSessionStmt: Database.Statement;

  constructor(dbPath: string) {
    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        source TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'unknown',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        num_turns INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        session_id TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_usage_repo ON usage_records(owner, repo);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_records(timestamp);

      CREATE TABLE IF NOT EXISTS repo_sessions (
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (owner, repo)
      );
    `);

    // Prepared statements for hot paths
    this.insertStmt = this.db.prepare(`
      INSERT INTO usage_records (timestamp, owner, repo, pr_number, source, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_cost_usd, num_turns, duration_ms, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.upsertSessionStmt = this.db.prepare(`
      INSERT INTO repo_sessions (owner, repo, session_id, last_used_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(owner, repo) DO UPDATE SET session_id = excluded.session_id, last_used_at = excluded.last_used_at
    `);

    this.getSessionStmt = this.db.prepare(`
      SELECT session_id, last_used_at FROM repo_sessions WHERE owner = ? AND repo = ?
    `);
  }

  /** Record a usage entry from a Claude invocation. */
  record(entry: UsageRecord): void {
    this.insertStmt.run(
      entry.timestamp,
      entry.owner,
      entry.repo,
      entry.prNumber,
      entry.source,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheCreationTokens,
      entry.cacheReadTokens,
      entry.totalCostUsd,
      entry.numTurns,
      entry.durationMs,
      entry.sessionId,
    );
  }

  /** Build a UsageRecord from ClaudeUsage + context. */
  static buildRecord(
    owner: string,
    repo: string,
    prNumber: number,
    source: UsageSource,
    usage: ClaudeUsage,
  ): UsageRecord {
    return {
      timestamp: new Date().toISOString(),
      owner,
      repo,
      prNumber,
      source,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationInputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      totalCostUsd: usage.totalCostUsd,
      numTurns: usage.numTurns,
      durationMs: usage.durationMs,
      sessionId: usage.sessionId,
    };
  }

  /** Get a valid session ID for a repo if the TTL hasn't expired. */
  getSession(owner: string, repo: string, ttlSeconds: number): string | null {
    const row = this.getSessionStmt.get(owner, repo) as { session_id: string; last_used_at: string } | undefined;
    if (!row) return null;

    const lastUsed = new Date(row.last_used_at).getTime();
    if (isNaN(lastUsed)) {
      console.warn("UsageStore: invalid last_used_at timestamp for session", { owner, repo, raw: row.last_used_at });
      return null;
    }
    const now = Date.now();
    if (now - lastUsed > ttlSeconds * 1000) return null;

    return row.session_id;
  }

  /** Save or update a session ID for a repo. */
  setSession(owner: string, repo: string, sessionId: string): void {
    this.upsertSessionStmt.run(owner, repo, sessionId, new Date().toISOString());
  }

  /** Get aggregated usage summary with per-repo breakdown. */
  getOverallSummary(sinceDays: number = 30): OverallSummary {
    const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();

    const overall = this.db.prepare(`
      SELECT
        COUNT(*) as total_reviews,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd
      FROM usage_records
      WHERE timestamp >= ?
    `).get(since) as {
      total_reviews: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_read_tokens: number;
      total_cache_creation_tokens: number;
      total_cost_usd: number;
    };

    const totalTokens = overall.total_input_tokens + overall.total_cache_read_tokens + overall.total_cache_creation_tokens;
    const cacheHitRate = totalTokens > 0 ? overall.total_cache_read_tokens / totalTokens : 0;

    const repos = this.getRepoSummaries(sinceDays);

    return {
      totalReviews: overall.total_reviews,
      totalInputTokens: overall.total_input_tokens,
      totalOutputTokens: overall.total_output_tokens,
      totalCacheReadTokens: overall.total_cache_read_tokens,
      totalCacheCreationTokens: overall.total_cache_creation_tokens,
      totalCostUsd: overall.total_cost_usd,
      cacheHitRate,
      avgCostPerReview: overall.total_reviews > 0 ? overall.total_cost_usd / overall.total_reviews : 0,
      repos,
    };
  }

  /** Get per-repo usage summaries. */
  getRepoSummaries(sinceDays: number = 30): RepoSummary[] {
    const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();

    const rows = this.db.prepare(`
      SELECT
        owner, repo,
        COUNT(*) as reviews,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd
      FROM usage_records
      WHERE timestamp >= ?
      GROUP BY owner, repo
      ORDER BY total_cost_usd DESC
    `).all(since) as Array<{
      owner: string;
      repo: string;
      reviews: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      total_cost_usd: number;
    }>;

    return rows.map((r) => {
      const totalTokens = r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens;
      return {
        owner: r.owner,
        repo: r.repo,
        reviews: r.reviews,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cacheCreationTokens: r.cache_creation_tokens,
        totalCostUsd: r.total_cost_usd,
        cacheHitRate: totalTokens > 0 ? r.cache_read_tokens / totalTokens : 0,
        avgCostPerReview: r.reviews > 0 ? r.total_cost_usd / r.reviews : 0,
      };
    });
  }

  /** Get recent usage records. */
  getRecentRecords(limit: number = 50): RecentRecord[] {
    return this.db.prepare(`
      SELECT id, timestamp, owner, repo, pr_number as prNumber, source, model,
             input_tokens as inputTokens, output_tokens as outputTokens,
             cache_creation_tokens as cacheCreationTokens, cache_read_tokens as cacheReadTokens,
             total_cost_usd as totalCostUsd, num_turns as numTurns, duration_ms as durationMs,
             session_id as sessionId
      FROM usage_records
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as RecentRecord[];
  }

  /** Delete old records and stale sessions. Sessions are cleaned with a shorter TTL (7 days) since they're only useful for prompt cache reuse. */
  cleanup(retentionDays: number): { deletedRecords: number; deletedSessions: number } {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    // Sessions older than 7 days are certainly stale (cache TTL is 5 minutes)
    const sessionCutoff = new Date(Date.now() - 7 * 86400_000).toISOString();

    const recordResult = this.db.prepare(`DELETE FROM usage_records WHERE timestamp < ?`).run(cutoff);
    const sessionResult = this.db.prepare(`DELETE FROM repo_sessions WHERE last_used_at < ?`).run(sessionCutoff);

    return {
      deletedRecords: recordResult.changes,
      deletedSessions: sessionResult.changes,
    };
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
