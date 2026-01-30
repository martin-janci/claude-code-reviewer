import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PRState, PRStatus, StateFileV1, StateFileV2 } from "../types.js";

export class StateStore {
  private state: StateFileV2 = { version: 2, prs: {} };
  private filePath: string;

  constructor(filePath: string = "data/state.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      this.state = { version: 2, prs: {} };
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`State file corrupt (${this.filePath}), starting fresh:`, err);
      this.state = { version: 2, prs: {} };
      return;
    }

    if (parsed.version === 2) {
      this.state = parsed as StateFileV2;
    } else {
      // V1 migration: old format has no version field
      this.state = this.migrateV1(parsed as StateFileV1);
      this.save();
      console.log("Migrated state file from V1 to V2");
    }

    // Reset any "reviewing" entries to "pending_review" (crash recovery)
    for (const entry of Object.values(this.state.prs)) {
      if (entry.status === "reviewing") {
        entry.status = "pending_review";
        entry.updatedAt = new Date().toISOString();
      }
    }
  }

  private migrateV1(v1: StateFileV1): StateFileV2 {
    const v2: StateFileV2 = { version: 2, prs: {} };
    const now = new Date().toISOString();

    for (const [key, sha] of Object.entries(v1)) {
      if (key === "version") continue;

      const match = key.match(/^(.+?)\/(.+?)#(\d+)$/);
      if (!match) {
        console.warn(`V1 migration: skipping malformed key "${key}"`);
        continue;
      }

      const [, owner, repo, numStr] = match;
      const number = parseInt(numStr, 10);

      v2.prs[key] = {
        owner,
        repo,
        number,
        status: "reviewed",
        title: "",
        isDraft: false,
        headSha: sha,
        baseBranch: "",
        reviews: [
          {
            sha,
            reviewedAt: now,
            commentId: null,
            verdict: "unknown",
            posted: true,
          },
        ],
        lastReviewedSha: sha,
        lastReviewedAt: now,
        skipReason: null,
        skipDiffLines: null,
        skippedAtSha: null,
        lastError: null,
        consecutiveErrors: 0,
        commentId: null,
        commentVerifiedAt: null,
        firstSeenAt: now,
        updatedAt: now,
        closedAt: null,
        lastPushAt: null,
      };
    }

    return v2;
  }

  private save(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });

    // Atomic write: write to temp file then rename
    const tmpPath = join(dir, `.state-${randomUUID()}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  static prKey(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${number}`;
  }

  get(owner: string, repo: string, number: number): PRState | undefined {
    return this.state.prs[StateStore.prKey(owner, repo, number)];
  }

  getAll(): PRState[] {
    return Object.values(this.state.prs);
  }

  getOrCreate(owner: string, repo: string, number: number, defaults: Partial<PRState> = {}): PRState {
    const key = StateStore.prKey(owner, repo, number);
    if (!this.state.prs[key]) {
      const now = new Date().toISOString();
      this.state.prs[key] = {
        owner,
        repo,
        number,
        status: "pending_review",
        title: defaults.title ?? "",
        isDraft: defaults.isDraft ?? false,
        headSha: defaults.headSha ?? "",
        baseBranch: defaults.baseBranch ?? "",
        reviews: [],
        lastReviewedSha: null,
        lastReviewedAt: null,
        skipReason: null,
        skipDiffLines: null,
        skippedAtSha: null,
        lastError: null,
        consecutiveErrors: 0,
        commentId: null,
        commentVerifiedAt: null,
        firstSeenAt: now,
        updatedAt: now,
        closedAt: null,
        lastPushAt: null,
      };
      this.save();
    }
    return this.state.prs[key];
  }

  update(owner: string, repo: string, number: number, updates: Partial<PRState>): PRState {
    const key = StateStore.prKey(owner, repo, number);
    const entry = this.state.prs[key];
    if (!entry) {
      throw new Error(`No state entry for ${key}`);
    }
    Object.assign(entry, updates, { updatedAt: new Date().toISOString() });
    this.save();
    return entry;
  }

  setStatus(owner: string, repo: string, number: number, status: PRStatus): PRState {
    return this.update(owner, repo, number, { status });
  }

  delete(owner: string, repo: string, number: number): void {
    const key = StateStore.prKey(owner, repo, number);
    delete this.state.prs[key];
    this.save();
  }

  deleteMany(entries: Array<{ owner: string; repo: string; number: number }>): number {
    let removed = 0;
    for (const { owner, repo, number } of entries) {
      const key = StateStore.prKey(owner, repo, number);
      if (this.state.prs[key]) {
        delete this.state.prs[key];
        removed++;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }
}
