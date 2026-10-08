/**
 * Resync: push the current Hevy version of a synced workout into the Garmin
 * activity it was synced to (#701).
 *
 * The contract is the reverse of a normal sync's. The workout must already be
 * synced, the activity is the one the ledger stored, and nothing is ever looked
 * up by time, uploaded or deleted. If the stored activity is gone, the resync
 * stops and says so. A sync that "helpfully" uploaded instead would create the
 * duplicate the whole engine exists to prevent.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { syncOneWorkout } from "../../src/sync";
import type { CandidateActivity } from "../../src/merge-match";
import type { MergeSettings, SyncOneOptions } from "../../src/sync";
import { MemoryStore, mockGateway, WORKOUT } from "./helpers";

const ACTIVITY_ID = 4242;

/** The stored activity as `gateway.activity` returns it. */
function storedActivity(over: Partial<CandidateActivity> = {}): CandidateActivity {
  return {
    activityId: ACTIVITY_ID,
    activityName: "Old name",
    startTimeGMT: "2026-08-01T10:00:00.0",
    duration: 3600,
    activityType: { typeKey: "strength_training" },
    manufacturer: "GARMIN",
    ...over,
  };
}

/** A read-back in which Garmin kept the exercise names. */
const NAMED = { exerciseSets: [{ setType: "ACTIVE", exercises: [{ category: "BENCH_PRESS" }] }] };
/** A read-back in which Garmin dropped them. */
const UNNAMED = { exerciseSets: [{ setType: "ACTIVE", exercises: [{ category: "UNKNOWN" }] }] };

/** The edited workout: a new title, an extra set and a later updated_at. */
const EDITED = {
  ...WORKOUT,
  title: "Push Day (edited)",
  updated_at: "2026-08-02T09:00:00Z",
  exercises: [
    {
      title: "Bench Press",
      sets: [
        { type: "normal", weight_kg: 80, reps: 5 },
        { type: "failure", weight_kg: 80, reps: 4 },
      ],
    },
  ],
};

let store: MemoryStore;
let gw: ReturnType<typeof mockGateway>;
let gatewayFactory: ReturnType<typeof vi.fn<() => Promise<typeof gw>>>;

const deps = (workouts: unknown[] = [EDITED]) => ({
  store,
  gateway: gatewayFactory,
  fetchWorkouts: async () => workouts as typeof WORKOUT[],
});

const RESYNC: SyncOneOptions = { dryRun: false, targetHevyId: WORKOUT.id, targetActivityId: ACTIVITY_ID };

const MERGE: MergeSettings = { enabled: true, watchStrategy: "merge" };
const REPLACE: MergeSettings = { enabled: true, watchStrategy: "replace" };
const DESCRIBE: MergeSettings = { enabled: true, watchStrategy: "describe" };
const PLAIN: MergeSettings = { enabled: false };

/** Run a sync, letting the read-back's wait pass without sleeping. */
async function resync(options: SyncOneOptions = {}, workouts?: unknown[]) {
  const pending = syncOneWorkout(deps(workouts), { ...RESYNC, ...options });
  await vi.advanceTimersByTimeAsync(10_000);
  return pending;
}

/** The calls a resync must never make, whatever the strategy. */
function expectNoUploadPath() {
  expect(gw.findExistingActivity).not.toHaveBeenCalled();
  expect(gw.activitiesByDate).not.toHaveBeenCalled();
  expect(gw.upload).not.toHaveBeenCalled();
  expect(gw.deleteActivity).not.toHaveBeenCalled();
  expect(gw.activityFit).not.toHaveBeenCalled();
  expect(store.claimPending).not.toHaveBeenCalled();
  expect(store.updatePending).not.toHaveBeenCalled();
  expect(store.completePending).not.toHaveBeenCalled();
}

function expectNoWrites() {
  expectNoUploadPath();
  expect(gw.putExerciseSets).not.toHaveBeenCalled();
  expect(gw.rename).not.toHaveBeenCalled();
  expect(gw.describe).not.toHaveBeenCalled();
  expect(store.markSynced).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  store = new MemoryStore();
  store.syncedIds.add(WORKOUT.id);
  gw = mockGateway();
  gw.activity.mockResolvedValue(storedActivity());
  gw.exerciseSets.mockResolvedValue(NAMED);
  gatewayFactory = vi.fn(async () => gw);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resync: each watch strategy", () => {
  it("merge: pushes the sets into the stored watch activity, renames and describes it", async () => {
    const r = await resync({ merge: MERGE });

    expect(r.status).toBe("synced");
    expect(r.dedupDecision).toBe("stored_activity");
    expect(r.garminActivityId).toBe(ACTIVITY_ID);
    expect(r.syncMethod).toBe("merge");
    expect(gw.activity).toHaveBeenCalledWith(ACTIVITY_ID);
    expect(gw.putExerciseSets).toHaveBeenCalledOnce();
    expect(gw.putExerciseSets.mock.calls[0][0]).toBe(ACTIVITY_ID);
    expect(gw.rename).toHaveBeenCalledWith(ACTIVITY_ID, "Push Day (edited)");
    expect(gw.describe).toHaveBeenCalledWith(ACTIVITY_ID, expect.stringContaining("2 sets"));
    expect(store.markSynced).toHaveBeenCalledWith(WORKOUT.id, expect.objectContaining({
      garminActivityId: String(ACTIVITY_ID),
      title: "Push Day (edited)",
      hevyUpdatedAt: "2026-08-02T09:00:00Z",
      syncMethod: "merge",
    }));
    expectNoUploadPath();
  });

  it("merge into a watch activity does not read the sets back, as a normal merge does not", async () => {
    await resync({ merge: MERGE });
    // One read only: the backup taken before the push.
    expect(gw.exerciseSets).toHaveBeenCalledOnce();
  });

  it("plain upload: pushes the sets into our own activity and checks Garmin kept the names", async () => {
    gw.activity.mockResolvedValue(storedActivity({ manufacturer: "DEVELOPMENT" }));
    const r = await resync({ merge: PLAIN });

    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("upload");
    expect(gw.putExerciseSets).toHaveBeenCalledOnce();
    // The backup, then the read-back.
    expect(gw.exerciseSets).toHaveBeenCalledTimes(2);
    expect(gw.rename).toHaveBeenCalledWith(ACTIVITY_ID, "Push Day (edited)");
    expect(store.markSynced).toHaveBeenCalledWith(WORKOUT.id, expect.objectContaining({ syncMethod: "upload" }));
    expectNoUploadPath();
  });

  it("plain upload matched to a watch activity (an upload_fallback row) pushes the sets too", async () => {
    const r = await resync({ merge: PLAIN });
    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("merge");
    expect(gw.putExerciseSets).toHaveBeenCalledOnce();
    expectNoUploadPath();
  });

  it("replace: treats the stored activity as our named upload and never deletes anything", async () => {
    gw.activity.mockResolvedValue(storedActivity({ manufacturer: "DEVELOPMENT" }));
    const r = await resync({ merge: REPLACE });

    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("upload");
    expect(gw.putExerciseSets).toHaveBeenCalledOnce();
    expect(gw.deleteActivity).not.toHaveBeenCalled();
    expectNoUploadPath();
  });

  it("describe: renames and describes only, no sets", async () => {
    const r = await resync({ merge: DESCRIBE });

    expect(r.status).toBe("synced");
    expect(r.setsPushed).toBe(0);
    expect(gw.putExerciseSets).not.toHaveBeenCalled();
    expect(gw.exerciseSets).not.toHaveBeenCalled();
    expect(gw.rename).toHaveBeenCalledWith(ACTIVITY_ID, "Push Day (edited)");
    expect(gw.describe).toHaveBeenCalledOnce();
    expect(store.markSynced).toHaveBeenCalledOnce();
    expectNoUploadPath();
  });

  it("leaves the description alone when descriptions are off", async () => {
    await resync({ merge: MERGE, descriptionEnabled: false });
    expect(gw.rename).toHaveBeenCalledOnce();
    expect(gw.describe).not.toHaveBeenCalled();
  });
});

describe("resync: the stored activity is gone", () => {
  it("stops with target_missing: no upload, nothing written", async () => {
    gw.activity.mockResolvedValue(null);
    const r = await resync({ merge: MERGE });

    expect(r.status).toBe("target_missing");
    expect(r.existingGarminActivityId).toBe(ACTIVITY_ID);
    expect(r.garminActivityId).toBeNull();
    expectNoWrites();
  });

  it("is the same under every strategy", async () => {
    for (const merge of [MERGE, REPLACE, DESCRIBE, PLAIN]) {
      gw.activity.mockResolvedValue(null);
      const r = await resync({ merge });
      expect(r.status).toBe("target_missing");
    }
    expectNoWrites();
  });
});

describe("resync: Garmin drops the exercise names", () => {
  it("restores the previous sets and reports an error, never uploading in their place", async () => {
    gw.activity.mockResolvedValue(storedActivity({ manufacturer: "DEVELOPMENT" }));
    const before = { exerciseSets: [{ setType: "ACTIVE", exercises: [{ category: "BENCH_PRESS" }] }] };
    gw.exerciseSets.mockResolvedValueOnce(before).mockResolvedValueOnce(UNNAMED);
    const r = await resync({ merge: MERGE });

    expect(r.status).toBe("error");
    expect(r.error).toMatch(/dropped the exercise names/);
    // The push, then the restore of what was there before.
    expect(gw.putExerciseSets).toHaveBeenCalledTimes(2);
    expect(gw.putExerciseSets.mock.calls[1]).toEqual([ACTIVITY_ID, before]);
    expect(gw.rename).not.toHaveBeenCalled();
    expect(gw.describe).not.toHaveBeenCalled();
    expect(store.markSynced).not.toHaveBeenCalled();
    expectNoUploadPath();
  });
});

describe("resync: the set push fails", () => {
  it("reports an error and writes nothing to the ledger", async () => {
    gw.putExerciseSets.mockRejectedValue(new Error("PUT exerciseSets 4242 → 400: bad"));
    const r = await resync({ merge: MERGE });

    expect(r.status).toBe("error");
    expect(r.error).toMatch(/exerciseSets push failed/);
    expect(gw.rename).not.toHaveBeenCalled();
    expect(store.markSynced).not.toHaveBeenCalled();
    expectNoUploadPath();
  });
});

describe("resync: refusals", () => {
  it("refuses a workout that is not synced, before any Garmin call", async () => {
    store.syncedIds.clear();
    const r = await resync({ merge: MERGE });

    expect(r.status).toBe("skipped");
    expect(r.dedupDecision).toBe("not_synced");
    expect(gatewayFactory).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("reports a workout Hevy no longer lists as an error, never as no_candidates", async () => {
    const r = await resync({ merge: MERGE }, []);

    expect(r.status).toBe("error");
    expect(r.dedupDecision).not.toBe("no_candidates");
    expect(r.error).toMatch(/hevy-1/);
    expect(gatewayFactory).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("reports a gateway that cannot read an activity by id as an error", async () => {
    const { activity: _omitted, ...withoutRead } = gw;
    gatewayFactory = vi.fn(async () => withoutRead as typeof gw);
    const r = await resync({ merge: MERGE });

    expect(r.status).toBe("error");
    expectNoWrites();
  });

  it("ignores the grace period: a synced workout has nothing left to wait for", async () => {
    const justEnded = { ...EDITED, end_time: new Date().toISOString() };
    const r = await resync({ merge: MERGE, respectGrace: true }, [justEnded]);
    expect(r.status).toBe("synced");
  });
});

describe("resync: dry run", () => {
  it("reads the stored activity and reports what it would do, with no writes", async () => {
    const r = await resync({ merge: MERGE, dryRun: true });

    expect(r.status).toBe("dry_run");
    expect(r.dryRun).toBe(true);
    expect(r.wouldUpload).toBe(false);
    expect(r.garminActivityId).toBe(ACTIVITY_ID);
    expect(r.fitStats?.totalSets).toBe(2);
    expect(gw.exerciseSets).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("is the default, as for every other sync", async () => {
    const pending = syncOneWorkout(deps(), { targetHevyId: WORKOUT.id, targetActivityId: ACTIVITY_ID });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await pending;
    expect(r.status).toBe("dry_run");
    expectNoWrites();
  });

  it("reports a missing activity in a dry run too", async () => {
    gw.activity.mockResolvedValue(null);
    const r = await resync({ merge: MERGE, dryRun: true });
    expect(r.status).toBe("target_missing");
    expectNoWrites();
  });
});

describe("resync never searches by time, uploads or deletes", () => {
  it("under any strategy, whatever the stored activity is", async () => {
    for (const merge of [MERGE, REPLACE, DESCRIBE, PLAIN]) {
      for (const manufacturer of ["GARMIN", "DEVELOPMENT"]) {
        for (const dryRun of [true, false]) {
          gw.activity.mockResolvedValue(storedActivity({ manufacturer }));
          await resync({ merge, dryRun, mergeOnly: true, hrFusion: true });
        }
      }
    }
    expectNoUploadPath();
  });

  it("even when the names are dropped or the push fails", async () => {
    gw.activity.mockResolvedValue(storedActivity({ manufacturer: "DEVELOPMENT" }));
    gw.exerciseSets.mockResolvedValue(UNNAMED);
    await resync({ merge: REPLACE });
    gw.putExerciseSets.mockRejectedValue(new Error("boom"));
    await resync({ merge: MERGE });
    expectNoUploadPath();
  });
});

describe("without targetActivityId nothing changes", () => {
  it("a synced target is still no_candidates on the normal path", async () => {
    const r = await resync({ targetActivityId: undefined, merge: MERGE });
    expect(r.status).toBe("none");
    expect(r.dedupDecision).toBe("no_candidates");
    expect(gw.activity).not.toHaveBeenCalled();
  });
});
