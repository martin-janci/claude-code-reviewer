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
}

export interface AppConfig {
  mode: "polling" | "webhook" | "both";
  polling: PollingConfig;
  webhook: WebhookConfig;
  github: GithubConfig;
  repos: RepoConfig[];
  review: ReviewConfig;
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

export interface ReviewFinding {
  severity: ConventionalLabel;
  blocking: boolean;
  path: string;
  line: number;
  body: string;
}

export interface StructuredReview {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  overall?: string;
}

export type SkipReason = "draft" | "wip_title" | "diff_too_large";

export type ErrorPhase = "diff_fetch" | "clone_prepare" | "claude_review" | "comment_post";

export interface ReviewRecord {
  sha: string;
  reviewedAt: string;
  commentId: string | null;
  reviewId: string | null;
  verdict: ReviewVerdict;
  posted: boolean;
}

export interface ErrorRecord {
  occurredAt: string;
  sha: string;
  message: string;
  phase: ErrorPhase;
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

export interface PullRequest {
  number: number;
  title: string;
  headSha: string;
  isDraft: boolean;
  baseBranch: string;
  owner: string;
  repo: string;
  forceReview?: boolean;
}

export interface ReviewResult {
  body: string;
  success: boolean;
  structured?: StructuredReview;
}
