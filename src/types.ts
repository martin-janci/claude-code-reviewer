export interface RepoConfig {
  owner: string;
  repo: string;
}

export interface PollingConfig {
  intervalSeconds: number;
}

export interface WebhookConfig {
  port: number;
  secret: string;
  path: string;
}

export interface GithubConfig {
  token: string;
}

export interface ReviewConfig {
  maxDiffLines: number;
  skipDrafts: boolean;
  skipWip: boolean;
  commentTag: string;
  maxRetries: number;
  debouncePeriodSeconds: number;
  staleClosedDays: number;
  staleErrorDays: number;
  commentVerifyIntervalMinutes: number;
  maxReviewHistory: number;
  commentTrigger: string;
  codebaseAccess: boolean;
  cloneDir: string;
  cloneTimeoutMs: number;
  reviewTimeoutMs: number;
  reviewMaxTurns: number;
  staleWorktreeMinutes: number;
  excludePaths: string[];
  dryRun: boolean;
  // Parallel reviews
  maxConcurrentReviews: number;
  // Confidence filtering
  confidenceThreshold: number;
  // Security paths for elevated scrutiny
  securityPaths: string[];
}

export interface JiraConfig {
  enabled: boolean;
  baseUrl: string;
  token: string;
  email: string;
  projectKeys: string[];
}

export interface AutoDescriptionConfig {
  enabled: boolean;
  overwriteExisting: boolean;
  timeoutMs: number;
}

export interface DiffLabelRule {
  pattern: string;
  label: string;
}

export interface AutoLabelConfig {
  enabled: boolean;
  verdictLabels: Partial<Record<ReviewVerdict, string[]>>;
  severityLabels: Partial<Record<ConventionalLabel, string[]>>;
  diffLabels: DiffLabelRule[];
}

export interface SlackConfig {
  enabled: boolean;
  webhookUrl: string;
  notifyOn: ("review_complete" | "error" | "request_changes" | "approve")[];
  channel?: string;
}

export interface AuditConfig {
  enabled: boolean;
  maxEntries: number;
  filePath: string;
  includeMetadata: boolean;
  minSeverity: "info" | "warning" | "error";
}

export interface AutofixConfig {
  enabled: boolean;
  commandTrigger: string; // Regex for comment that triggers autofix (default: "^\s*/fix\s*$")
  autoApply: boolean; // If true, push fixes directly; if false, create suggestion commits
  maxTurns: number; // Max Claude turns for autofix session
  timeoutMs: number;
}

export interface UsageConfig {
  enabled: boolean;
  dbPath: string;
  retentionDays: number;
  sessionTtlSeconds: number; // default: 270 (4.5 min, under 5-min cache TTL)
}

export interface FeaturesConfig {
  jira: JiraConfig;
  autoDescription: AutoDescriptionConfig;
  autoLabel: AutoLabelConfig;
  slack: SlackConfig;
  audit: AuditConfig;
  autofix: AutofixConfig;
  usage: UsageConfig;
}

export interface DashboardConfig {
  port: number;
  token?: string;
}

export interface AppConfig {
  mode: "polling" | "webhook" | "both";
  polling: PollingConfig;
  webhook: WebhookConfig;
  github: GithubConfig;
  repos: RepoConfig[];
  review: ReviewConfig;
  features: FeaturesConfig;
  dashboard?: DashboardConfig;
}

// --- PR State Machine ---

export type PRStatus =
  | "pending_review"
  | "reviewing"
  | "reviewed"
  | "changes_pushed"
  | "error"
  | "skipped"
  | "closed"
  | "merged";

export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | "unknown";

// --- Structured Review (JSON output from Claude) ---

export type ConventionalLabel = "issue" | "suggestion" | "nitpick" | "question" | "praise";

export type FindingResolution = "resolved" | "wont_fix" | "open";

export interface ReviewFinding {
  severity: ConventionalLabel;
  blocking: boolean;
  path: string;
  line: number;
  body: string;
  confidence?: number; // 0-100, for filtering low-confidence findings
  isNew?: boolean; // For incremental reviews: true if finding is new since last review
  securityRelated?: boolean; // True if finding relates to security
}

export interface ResolutionEntry {
  path: string;
  line: number;
  body: string;
  resolution: FindingResolution;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface PRSummary {
  tldr: string; // One-line summary
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  areasAffected: string[]; // e.g., ["authentication", "database", "UI"]
  riskLevel: RiskLevel;
  riskFactors?: string[]; // Why it's risky
}

export interface StructuredReview {
  verdict: ReviewVerdict;
  summary: string;
  prSummary?: PRSummary; // New: structured PR summary
  findings: ReviewFinding[];
  overall?: string;
  resolutions?: ResolutionEntry[];
}

export type SkipReason = "draft" | "wip_title" | "diff_too_large";

export type ErrorPhase = "diff_fetch" | "clone_prepare" | "claude_review" | "comment_post" | "jira_validate" | "description_generate" | "label_apply";

export type ErrorKind = "transient" | "permanent";

export interface ReviewRecord {
  sha: string;
  reviewedAt: string;
  commentId: string | null;
  reviewId: string | null;
  verdict: ReviewVerdict;
  posted: boolean;
  findings: ReviewFinding[];
}

export interface ErrorRecord {
  occurredAt: string;
  sha: string;
  message: string;
  phase: ErrorPhase;
  kind: ErrorKind;
}

export type FeatureName = "jira" | "auto_description" | "auto_label" | "slack";
export type FeatureStatus = "success" | "skipped" | "error";

export interface FeatureExecution {
  feature: FeatureName;
  status: FeatureStatus;
  durationMs?: number;
  error?: string;
  timestamp: string;
}

export interface PRState {
  // Identity
  owner: string;
  repo: string;
  number: number;

  // Status
  status: PRStatus;

  // PR metadata
  title: string;
  isDraft: boolean;
  headSha: string;
  baseBranch: string;
  headBranch: string;

  // Review history
  reviews: ReviewRecord[];
  lastReviewedSha: string | null;
  lastReviewedAt: string | null;

  // Skip tracking
  skipReason: SkipReason | null;
  skipDiffLines: number | null;
  skippedAtSha: string | null;

  // Error tracking
  lastError: ErrorRecord | null;
  consecutiveErrors: number;

  // Comment tracking (legacy — issue comments)
  commentId: string | null;
  commentVerifiedAt: string | null;

  // Review tracking (new — PR Reviews API)
  reviewId: string | null;
  reviewVerifiedAt: string | null;

  // Timestamps
  firstSeenAt: string;
  updatedAt: string;
  closedAt: string | null;

  // Debounce
  lastPushAt: string | null;

  // Feature tracking
  jiraKey: string | null;
  jiraValidated: boolean;
  descriptionGenerated: boolean;
  labelsApplied: string[];
  featureExecutions: FeatureExecution[];
}

export interface ReviewDecision {
  shouldReview: boolean;
  reason: string;
}

export interface StateFileV2 {
  version: 2;
  prs: Record<string, PRState>; // "owner/repo#number" -> PRState
}

// V1 format for migration
export interface StateFileV1 {
  [key: string]: string; // "owner/repo#number" -> last reviewed SHA
}

export interface ReviewOverrides {
  maxTurns?: number;
  skipDescription?: boolean;
  skipLabels?: boolean;
  focusPaths?: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  headSha: string;
  isDraft: boolean;
  baseBranch: string;
  headBranch: string;
  owner: string;
  repo: string;
  forceReview?: boolean;
  overrides?: ReviewOverrides;
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  model: string;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  sessionId: string;
}

export type UsageSource = "review" | "auto_description" | "autofix";

export interface ReviewResult {
  body: string;
  success: boolean;
  structured?: StructuredReview;
  usage?: ClaudeUsage;
}

export type ProcessPROutcome = "reviewed" | "skipped" | "error";

export interface ProcessPRResult {
  outcome: ProcessPROutcome;
  skipReason?: string; // Human-readable reason when skipped
  verdict?: ReviewVerdict; // When reviewed successfully
  error?: string; // When error occurred
}
