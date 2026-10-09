import { vi } from "vitest";
import type { GarminGateway, MarkSyncedOpts, PendingRecord, PendingUpdate, SyncStore } from "../../src/sync";
import type { CandidateActivity } from "../../src/merge-match";

/**
 * An in-memory SyncStore whose every method is a vi.fn, so tests assert on
 * calls exactly as the web tests asserted on the mocked Postgres helpers.
 * Reads are controllable (`syncedIds`, `pendingIds`, `pending`); writes record.
 */
export class MemoryStore implements SyncStore {
  syncedIds = new Set<string>();
  pendingIds = new Set<string>();
  pending = new Map<string, PendingRecord>();
  /** Force the live layer-1 re-check independently of the id-set snapshot. */
  isSyncedOverride: boolean | null = null;
  /** Force the claim outcome (dedup layer 3). Default: win. */
  claimResult = true;

  isSynced = vi.fn(async (hevyId: string) =>
    this.isSyncedOverride ?? this.syncedIds.has(hevyId),
  );
  loadSyncedIds = vi.fn(async () => new Set(this.syncedIds));
  loadPendingIds = vi.fn(async () => new Set(this.pendingIds));
  getPending = vi.fn(async (hevyId: string) => this.pending.get(hevyId) ?? null);
  claimPending = vi.fn(async (_hevyId: string, _payload: Record<string, unknown>) => this.claimResult);
  // Actually merges, rather than recording the call and discarding it. A
  // no-op here hides every read-after-write bug: code that updates a row and
  // then re-reads it sees the stale version and the test still passes.
  updatePending = vi.fn(async (hevyId: string, fields: PendingUpdate) => {
    const row = this.pending.get(hevyId);
    if (row) this.pending.set(hevyId, { ...row, ...fields } as typeof row);
  });
  deletePending = vi.fn(async (_hevyId: string) => true);
  completePending = vi.fn(async (_hevyId: string, _opts: MarkSyncedOpts) => {});
  markSynced = vi.fn(async (_hevyId: string, _opts: MarkSyncedOpts) => {});
}

/** A GarminGateway of spies. Defaults: nothing at the timestamp; upload → 555. */
export function mockGateway() {
  return {
    findExistingActivity: vi.fn(async (_startTime: string) => null as number | null),
    upload: vi.fn(async (_fit: Uint8Array, _start?: string) => ({ uploadId: 99, activityId: 555 as number | null })),
    rename: vi.fn(async (_id: number, _name: string) => {}),
    describe: vi.fn(async (_id: number, _text: string) => {}),
    // Read before every upload for the pre-upload snapshot, not only for merge.
    // Empty here because these fixtures are a fresh workout with nothing on
    // Garmin yet, so the uploaded activity is correctly treated as new.
    activitiesByDate: vi.fn(async (_from: string, _to: string) => [] as unknown[]),
    // The rest of the gateway. A partial fake was fine while the paths under
    // test never reached these, but retry now runs the real sync, which can.
    exerciseSets: vi.fn(async (_id: number) => ({ exerciseSets: [] })),
    putExerciseSets: vi.fn(async (_id: number, _payload: unknown) => {}),
    deleteActivity: vi.fn(async (_id: number) => {}),
    activityFit: vi.fn(async (_id: number) => null),
    // Read only by a resync, which looks the stored activity up by id.
    activity: vi.fn(async (_id: number) => null as CandidateActivity | null),
  } satisfies GarminGateway;
}

export const WORKOUT = {
  id: "hevy-1",
  title: "Push Day",
  start_time: "2026-08-01T10:00:00Z",
  end_time: "2026-08-01T11:00:00Z",
  updated_at: "2026-08-01T11:05:00Z",
  exercises: [{ title: "Bench Press", sets: [{ type: "normal", weight_kg: 80, reps: 5 }] }],
};
