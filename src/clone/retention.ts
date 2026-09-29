export interface CacheEntry {
  path: string;
  kind: "worktree" | "clone";
  sizeKb: number;
  lastUsedMs: number;
}

/**
 * Pick cache entries to evict until the total fits under the cap.
 * Oldest first; entries used within `minIdleMs` are never evicted.
 * `totalKb` is the size of the whole cache (it may include entries not in `candidates`).
 */
export function selectEvictions(
  candidates: CacheEntry[],
  totalKb: number,
  capKb: number,
  nowMs: number,
  minIdleMs: number,
): CacheEntry[] {
  if (capKb <= 0 || totalKb <= capKb) return [];

  const evictable = candidates
    .filter((e) => nowMs - e.lastUsedMs >= minIdleMs)
    .sort((a, b) => a.lastUsedMs - b.lastUsedMs);

  const picked: CacheEntry[] = [];
  let remaining = totalKb;
  for (const entry of evictable) {
    if (remaining <= capKb) break;
    picked.push(entry);
    remaining -= entry.sizeKb;
  }
  return picked;
}
