import type { SyncOneResult } from "@/lib/sync-one";

/**
 * Whether a run in a sync loop handed back a workout this loop already handled.
 *
 * The engine picks the first pending candidate every time. A workout it defers (inside the grace
 * period, no start time, a claim lost to another sync) stays pending, so the next call picks the
 * same one again and the loop makes no progress until its cap: a cron tick during the grace period
 * ran 50 identical passes, each fetching the Hevy list. A repeat means nothing more will move in
 * this run, so the caller stops; the next tick picks the workout up again. Records the id as seen.
 */
export function repeatsEarlierRun(seen: Set<string>, r: SyncOneResult): boolean {
  const id = (r as { workout?: { hevy_id?: unknown } | null }).workout?.hevy_id;
  if (id == null) return false;
  const key = String(id);
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}
