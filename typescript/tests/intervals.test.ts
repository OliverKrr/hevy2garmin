import { describe, it, expect, vi } from "vitest";
import { deleteIcuActivity, intervalsCleanupHook } from "../src/intervals";
import type { SyncDeps } from "../src/sync";

/**
 * The intervals.icu cleanup after a replace, never ported until now (#586).
 *
 * When a replace deletes the original watch activity from Garmin, that original
 * has usually already synced to intervals.icu, and the named FIT we upload in
 * its place then arrives there as a second copy. Python removes the stale one.
 *
 * Two inherited properties matter more than the feature itself: it is opt-in,
 * so it is a no-op for everyone not using intervals.icu, and it never throws,
 * because failing to tidy a third-party service must not fail a sync that
 * already did what the user asked.
 */

const CONFIG = { apiKey: "k", athleteId: "i12345", baseUrl: "https://icu.test" };
const START = "2026-08-01T10:00:00Z";

/** A fetch that answers the listing, then records the DELETE. */
function icuFetch(activities: unknown, deleteOk = true) {
  const calls: Array<{ url: string; method: string }> = [];
  const impl = vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if ((init?.method ?? "GET") === "DELETE") return { ok: deleteOk, status: deleteOk ? 200 : 500 };
    return { ok: true, status: 200, json: async () => activities };
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const act = (id: number, externalId: string) => ({ id, external_id: externalId });

describe("finding and deleting the stale copy", () => {
  it("deletes the activity whose external_id is the Garmin id", async () => {
    const { impl, calls } = icuFetch([act(555, "24360411253")]);
    const ok = await deleteIcuActivity(24360411253, START, { ...CONFIG, fetchImpl: impl });

    expect(ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    // Single-activity operations are under /api/v1/activity/{id}; the
    // athlete-scoped path only lists, and a DELETE there is a 405.
    expect(calls.at(-1)!.url).toContain("/api/v1/activity/555");
  });

  it("matches the legacy G-prefixed external id too", async () => {
    // Older imports used that form, so a user with history has both shapes.
    const { impl } = icuFetch([act(556, "G24360411253")]);
    expect(await deleteIcuActivity(24360411253, START, { ...CONFIG, fetchImpl: impl })).toBe(true);
  });

  it("searches a window around the workout, not a single day", async () => {
    const { impl, calls } = icuFetch([]);
    await deleteIcuActivity(1, "2026-08-01T23:30:00Z", { ...CONFIG, fetchImpl: impl });
    // 23:30 plus two hours is the next day, which is exactly why the window
    // exists rather than a single date.
    expect(calls[0].url).toContain("oldest=2026-08-01");
    expect(calls[0].url).toContain("newest=2026-08-02");
  });

  it("deletes nothing when no activity matches", async () => {
    const { impl, calls } = icuFetch([act(999, "some other activity")]);
    expect(await deleteIcuActivity(24360411253, START, { ...CONFIG, fetchImpl: impl })).toBe(false);
    expect(calls.every((c) => c.method !== "DELETE")).toBe(true);
  });
});

describe("it can never break a sync", () => {
  it("returns false rather than throwing when the listing fails", async () => {
    const impl = vi.fn(async () => {
      throw new Error("intervals.icu unreachable");
    }) as unknown as typeof fetch;
    await expect(deleteIcuActivity(1, START, { ...CONFIG, fetchImpl: impl })).resolves.toBe(false);
  });

  it("returns false rather than throwing when the delete fails", async () => {
    const { impl } = icuFetch([act(555, "1")], false);
    await expect(deleteIcuActivity(1, START, { ...CONFIG, fetchImpl: impl })).resolves.toBe(false);
  });

  it("returns false for an unparseable workout start", async () => {
    const { impl, calls } = icuFetch([]);
    expect(await deleteIcuActivity(1, "not a date", { ...CONFIG, fetchImpl: impl })).toBe(false);
    expect(calls).toHaveLength(0); // did not even ask
  });

  it("returns false and calls nothing without credentials", async () => {
    const { impl, calls } = icuFetch([]);
    expect(await deleteIcuActivity(1, START, { apiKey: "", athleteId: "", fetchImpl: impl })).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("the hook the engine calls", () => {
  it("is null when intervals.icu is not configured", () => {
    // Null rather than a no-op function on purpose: the engine can skip the
    // call entirely, and a caller can tell "not configured" from "found
    // nothing".
    expect(intervalsCleanupHook(null)).toBeNull();
    expect(intervalsCleanupHook({ apiKey: "k" })).toBeNull();
    expect(intervalsCleanupHook({ athleteId: "i1" })).toBeNull();
  });

  it("is a function when it is configured", async () => {
    const { impl, calls } = icuFetch([act(555, "1")]);
    const hook = intervalsCleanupHook({ ...CONFIG, fetchImpl: impl });
    expect(hook).toBeTypeOf("function");

    await hook!(1, START);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("does nothing without a workout start", async () => {
    const { impl, calls } = icuFetch([]);
    await intervalsCleanupHook({ ...CONFIG, fetchImpl: impl })!(1, "");
    expect(calls).toHaveLength(0);
  });
});

describe("the hook is wired to BOTH delete sites", () => {
  it("is called after the happy-path watch delete", async () => {
    const { syncOneWorkout } = await import("../src/sync");
    const { MemoryStore, mockGateway, WORKOUT } = await import("./sync/helpers");

    const store = new MemoryStore();
    const gw = mockGateway();
    gw.activitiesByDate.mockResolvedValue([
      {
        activityId: 901,
        manufacturer: "GARMIN",
        activityType: { typeKey: "strength_training" },
        startTimeGMT: "2026-08-01 10:00:00",
        duration: 3600,
      },
    ]);
    const onWatchActivityDeleted = vi.fn(async () => {});

    await syncOneWorkout(
      {
        store,
        gateway: async () => gw,
        fetchWorkouts: async () => [WORKOUT],
        // A replace refuses to delete unless the watch's HR is secured first,
        // which is the #244 guard. Supplying a durable backup satisfies it, so
        // the delete actually happens and the hook after it can be observed.
        hr: {
          loadBackup: async () => [{ time: 0, hr: 120 }],
          saveBackup: async () => {},
          cachedHr: async () => null,
        },
        onWatchActivityDeleted,
      } as never,
      { dryRun: false, merge: { enabled: true, watchStrategy: "replace" } },
    );

    expect(gw.deleteActivity).toHaveBeenCalled();
    expect(onWatchActivityDeleted).toHaveBeenCalledWith(901, WORKOUT.start_time, {
      hevyId: WORKOUT.id,
      workoutEnd: WORKOUT.end_time,
    });
  });

  it("is called after the RESUMED finalization delete too", async () => {
    // The one that is easy to miss. Batch 2b added a second delete site in
    // recovery, and hanging the cleanup off only one means it silently does
    // not run for whichever path the user actually took.
    const { finalizePending } = await import("../src/sync/recovery");

    let row: Record<string, unknown> | null = {
      hevy_id: "w1",
      phase: "finalizing",
      next_step: "delete",
      garmin_activity_id: "500",
      watch_activity_id: "777",
      delete_attempt_count: 0,
      payload: { title: "Push Day", workout: { id: "w1", start_time: "2026-08-01T10:00:00Z" } },
    };
    const store = {
      getPending: vi.fn(async () => row),
      updatePending: vi.fn(async (_id: string, f: Record<string, unknown>) => {
        if (row) row = { ...row, ...f };
      }),
      completePending: vi.fn(async () => {}),
    };
    const gw = mockGatewayForDelete();
    const onWatchActivityDeleted = vi.fn(async () => {});

    await finalizePending(
      { store, gateway: async () => gw, onWatchActivityDeleted } as never,
      "w1",
    );

    expect(gw.deleteActivity).toHaveBeenCalledWith(777);
    // The stored payload has no end_time, so the context says null rather
    // than inventing one.
    expect(onWatchActivityDeleted).toHaveBeenCalledWith(777, "2026-08-01T10:00:00Z", {
      hevyId: "w1",
      workoutEnd: null,
    });
  });

  it("a hook written for two arguments still type-checks and runs", async () => {
    const { finalizePending } = await import("../src/sync/recovery");
    const seen: Array<[number | string, string]> = [];
    // The pre-context signature, typed as SyncDeps' hook so an editor or tsc
    // flags it if the old shape ever stops being assignable. The call below
    // is the check that runs.
    const twoArgs: SyncDeps["onWatchActivityDeleted"] = async (id, start) => {
      seen.push([id, start]);
    };
    let row: Record<string, unknown> | null = {
      hevy_id: "w2",
      phase: "finalizing",
      next_step: "delete",
      garmin_activity_id: "501",
      watch_activity_id: "778",
      delete_attempt_count: 0,
      payload: { title: "Pull Day", workout: { id: "w2", start_time: "2026-08-02T10:00:00Z", end_time: "2026-08-02T11:00:00Z" } },
    };
    const store = {
      getPending: vi.fn(async () => row),
      updatePending: vi.fn(async (_id: string, f: Record<string, unknown>) => {
        if (row) row = { ...row, ...f };
      }),
      completePending: vi.fn(async () => {}),
    };
    await finalizePending({ store, gateway: async () => mockGatewayForDelete(), onWatchActivityDeleted: twoArgs } as never, "w2");
    expect(seen).toEqual([[778, "2026-08-02T10:00:00Z"]]);
  });
});

function mockGatewayForDelete() {
  return {
    findExistingActivity: vi.fn(async () => null),
    upload: vi.fn(async () => ({ uploadId: 1, activityId: 1 })),
    rename: vi.fn(async () => {}),
    describe: vi.fn(async () => {}),
    activitiesByDate: vi.fn(async () => []),
    exerciseSets: vi.fn(async () => ({ exerciseSets: [] })),
    putExerciseSets: vi.fn(async () => {}),
    deleteActivity: vi.fn(async () => {}),
    activityFit: vi.fn(async () => null),
  } as never;
}
