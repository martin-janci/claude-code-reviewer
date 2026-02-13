import type { Logger } from "./logger.js";

export type GuardState = "active" | "paused_rate_limit" | "paused_spending_limit";

export interface RateLimitEvent {
  timestamp: string;
  kind: "rate_limit" | "spending_limit" | "overloaded";
  retryAfterSeconds: number;
  autoResumeAt: string | null;
  resumed: boolean;
  resumedAt?: string;
  resumedBy?: "timer" | "manual";
}

export class RateLimitGuard {
  private state: GuardState = "active";
  private pausedSince: string | null = null;
  private resumesAt: string | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private waiters: Array<() => void> = [];
  private events: RateLimitEvent[] = [];
  private pauseCount = 0;

  constructor(
    private maxEventHistory: number,
    private logger: Logger,
  ) {}

  get isPaused(): boolean {
    return this.state !== "active";
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  get currentState(): GuardState {
    return this.state;
  }

  /** Wait until guard is active. Returns immediately if not paused. */
  async acquire(): Promise<void> {
    if (this.state === "active") return;
    this.logger.info("Rate limit guard: queuing request", {
      state: this.state,
      queueDepth: this.waiters.length + 1,
    });
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Report a rate limit error. Pauses the guard and starts cooldown timer. */
  reportRateLimit(
    kind: "rate_limit" | "spending_limit" | "overloaded",
    cooldownSeconds: number,
  ): void {
    // If already paused with a spending_limit (higher priority), don't downgrade
    if (this.state === "paused_spending_limit" && kind !== "spending_limit") return;

    const newState: GuardState = kind === "spending_limit"
      ? "paused_spending_limit"
      : "paused_rate_limit";

    this.state = newState;
    this.pausedSince = new Date().toISOString();
    this.resumesAt = new Date(Date.now() + cooldownSeconds * 1000).toISOString();
    this.pauseCount++;

    // Clear existing timer (e.g. upgrading from rate_limit → spending_limit)
    if (this.resumeTimer) {
      this.logger.info("Rate limit guard: replacing existing cooldown timer", { newKind: kind, newCooldownSeconds: cooldownSeconds });
      clearTimeout(this.resumeTimer);
    }
    this.resumeTimer = setTimeout(() => this.resume("timer"), cooldownSeconds * 1000);

    // Record event
    this.recordEvent({
      timestamp: new Date().toISOString(),
      kind,
      retryAfterSeconds: cooldownSeconds,
      autoResumeAt: this.resumesAt,
      resumed: false,
    });

    this.logger.warn("Rate limit guard: PAUSED", {
      state: this.state,
      cooldownSeconds,
      queueDepth: this.waiters.length,
    });
  }

  /** Resume: release all waiters. */
  resume(by: "timer" | "manual" = "manual"): void {
    if (this.state === "active") return;

    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }

    // Mark last event as resumed
    const lastEvent = this.events[this.events.length - 1];
    if (lastEvent && !lastEvent.resumed) {
      lastEvent.resumed = true;
      lastEvent.resumedAt = new Date().toISOString();
      lastEvent.resumedBy = by;
    }

    this.state = "active";
    this.pausedSince = null;
    this.resumesAt = null;

    const released = this.waiters.length;
    const waiting = this.waiters.splice(0);
    for (const resolve of waiting) resolve();

    this.logger.info("Rate limit guard: RESUMED", { by, released });
  }

  /** Get status for API/dashboard. */
  getStatus(): {
    state: GuardState;
    pausedSince: string | null;
    resumesAt: string | null;
    queueDepth: number;
    pauseCount: number;
    cooldownRemainingSeconds: number;
    events: RateLimitEvent[];
  } {
    let cooldownRemainingSeconds = 0;
    if (this.resumesAt) {
      cooldownRemainingSeconds = Math.max(
        0,
        Math.round((new Date(this.resumesAt).getTime() - Date.now()) / 1000),
      );
    }

    return {
      state: this.state,
      pausedSince: this.pausedSince,
      resumesAt: this.resumesAt,
      queueDepth: this.waiters.length,
      pauseCount: this.pauseCount,
      cooldownRemainingSeconds,
      events: [...this.events],
    };
  }

  /** Cleanup on shutdown — release all waiters so they don't hang. */
  shutdown(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    const waiting = this.waiters.splice(0);
    for (const resolve of waiting) resolve();
    this.state = "active";
    this.pausedSince = null;
    this.resumesAt = null;
  }

  private recordEvent(event: RateLimitEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEventHistory) {
      this.events.shift();
    }
  }
}
