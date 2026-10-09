/**
 * Resync: push the current Hevy version of a synced workout into the Garmin
 * activity it was synced to (#701).
 *
 * The contract is the reverse of a normal sync's. The workout must already be
 * synced, the activity is the one the ledger stored, and nothing is ever
 * matched by time, uploaded or deleted. If the stored activity is gone, the
 * resync stops and says so. A sync that "helpfully" uploaded instead would
 * create the duplicate the whole engine exists to prevent.
 *
 * The activity is read by id only to learn that it exists and on which day.
 * Whether it is a watch recording, and its start and duration, come from its
 * own entry in Garmin's activity list, the shape a merge has always read.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { syncOneWorkout } from "../../src/sync";
import { generateFit } from "../../src/fit";
import type { CandidateActivity } from "../../src/merge-match";
import type { MergeSettings, SyncDeps, SyncOneOptions } from "../../src/sync";
import { MemoryStore, mockGateway, WORKOUT } from "./helpers";

const ACTIVITY_ID = 4242;

/**
 * The stored activity as `gateway.activity` returns it. Only the id and the
 * start, because existence and the day are all a resync takes from this read.
 */
function storedActivity(over: Partial<CandidateActivity> = {}): CandidateActivity {
  return { activityId: ACTIVITY_ID, startTimeGMT: "2026-08-01T10:00:00.0", ...over };
}

/** The stored activity's entry in `gateway.activitiesByDate`. */
function listed(over: Partial<CandidateActivity> = {}): CandidateActivity {
  return {
    activityId: ACTIVITY_ID,
    activityName: "Old name",
    startTimeGMT: "2026-08-01 10:00:00",
    duration: 3600,
    activityType: { typeKey: "strength_training" },
    manufacturer: "GARMIN",
    ...over,
  };
}

/** Another strength activity, starting exactly when the workout did. */
const AT_WORKOUT_START = listed({ activityId: 9999, activityName: "Someone else's", startTimeGMT: "2026-08-01 10:00:00" });

/** A FIT holding a steady 130 bpm across the workout, as Garmin's download returns it. */
function fitWithHr(): Uint8Array {
  return generateFit(
    {
      title: "watch",
      start_time: WORKOUT.start_time,
      end_time: WORKOUT.end_time,
      exercises: [{ title: "Bench Press", sets: [{ reps: 1, weight_kg: 1 }] }],
    } as never,
    [{ time: 0, hr: 130 }, { time: 1800, hr: 130 }, { time: 3500, hr: 130 }],
  ).fit;
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

const deps = (workouts: unknown[] = [EDITED], hr?: SyncDeps["hr"]): SyncDeps => ({
  store,
  gateway: gatewayFactory,
  fetchWorkouts: async () => workouts as typeof WORKOUT[],
  hr,
});

const RESYNC: SyncOneOptions = { dryRun: false, targetHevyId: WORKOUT.id, targetActivityId: ACTIVITY_ID };

const MERGE: MergeSettings = { enabled: true, watchStrategy: "merge" };
const REPLACE: MergeSettings = { enabled: true, watchStrategy: "replace" };
const DESCRIBE: MergeSettings = { enabled: true, watchStrategy: "describe" };
const PLAIN: MergeSettings = { enabled: false };

/** Run a sync, letting the read-back's wait pass without sleeping. */
async function resync(options: SyncOneOptions = {}, workouts?: unknown[], hr?: SyncDeps["hr"]) {
  const pending = syncOneWorkout(deps(workouts, hr), { ...RESYNC, ...options });
  await vi.advanceTimersByTimeAsync(10_000);
  return pending;
}

/**
 * The calls a resync must never make, whatever the strategy. Listing
 * activities is allowed, as a read: it is how the stored activity is
 * identified, by its id.
 */
function expectNoUploadPath() {
  expect(gw.findExistingActivity).not.toHaveBeenCalled();
  expect(gw.upload).not.toHaveBeenCalled();
  expect(gw.deleteActivity).not.toHaveBeenCalled();
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
  gw.activitiesByDate.mockResolvedValue([listed()]);
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
    gw.activitiesByDate.mockResolvedValue([listed({ manufacturer: "DEVELOPMENT" })]);
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
    gw.activitiesByDate.mockResolvedValue([listed({ manufacturer: "DEVELOPMENT" })]);
    const r = await resync({ merge: REPLACE });

    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("upload");
    expect(gw.putExerciseSets).toHaveBeenCalledOnce();
    expect(gw.deleteActivity).not.toHaveBeenCalled();
    expectNoUploadPath();
  });

  it("describe on a watch activity: renames and describes only, no sets", async () => {
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

  it("describe on our own upload: pushes the sets, as there are no watch sets to keep", async () => {
    gw.activitiesByDate.mockResolvedValue([listed({ manufacturer: "DEVELOPMENT" })]);
    const r = await resync({ merge: DESCRIBE });

    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("upload");
    expect(gw.putExerciseSets).toHaveBeenCalledOnce();
    // The backup, then the read-back that every push into our own upload gets.
    expect(gw.exerciseSets).toHaveBeenCalledTimes(2);
    expect(gw.rename).toHaveBeenCalledWith(ACTIVITY_ID, "Push Day (edited)");
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
    gw.activitiesByDate.mockResolvedValue([listed({ manufacturer: "DEVELOPMENT" })]);
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
    expect(r.syncMethod).toBe("merge");
    expect(r.fitStats?.totalSets).toBe(2);
    expect(gw.exerciseSets).not.toHaveBeenCalled();
    expect(gw.activityFit).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("reports an activity it cannot identify in a dry run too", async () => {
    gw.activitiesByDate.mockResolvedValue([AT_WORKOUT_START]);
    const r = await resync({ merge: MERGE, dryRun: true });
    expect(r.status).toBe("error");
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
          gw.activitiesByDate.mockResolvedValue([listed({ manufacturer }), AT_WORKOUT_START]);
          await resync({ merge, dryRun, mergeOnly: true, hrFusion: true });
        }
      }
    }
    expectNoUploadPath();
  });

  it("even when the names are dropped or the push fails", async () => {
    gw.activitiesByDate.mockResolvedValue([listed({ manufacturer: "DEVELOPMENT" })]);
    gw.exerciseSets.mockResolvedValue(UNNAMED);
    await resync({ merge: REPLACE });
    gw.putExerciseSets.mockRejectedValue(new Error("boom"));
    await resync({ merge: MERGE });
    expectNoUploadPath();
  });
});

describe("resync identifies the activity by its id, never by time", () => {
  it("lists the activities around the stored activity's own date", async () => {
    gw.activity.mockResolvedValue(storedActivity({ startTimeGMT: "2026-08-05T18:30:00.0" }));
    gw.activitiesByDate.mockResolvedValue([listed({ startTimeGMT: "2026-08-05 18:30:00" })]);
    await resync({ merge: MERGE });
    expect(gw.activitiesByDate).toHaveBeenCalledWith("2026-08-04", "2026-08-06");
  });

  it("uses the workout's date when the read by id carries no start", async () => {
    gw.activity.mockResolvedValue({ activityId: ACTIVITY_ID });
    const r = await resync({ merge: MERGE });
    expect(gw.activitiesByDate).toHaveBeenCalledWith("2026-07-31", "2026-08-02");
    expect(r.status).toBe("synced");
  });

  it("ignores another activity sitting exactly at the workout's start time", async () => {
    gw.activitiesByDate.mockResolvedValue([AT_WORKOUT_START, listed({ startTimeGMT: "2026-08-01 15:00:00" })]);
    const r = await resync({ merge: MERGE });

    expect(r.status).toBe("synced");
    expect(r.garminActivityId).toBe(ACTIVITY_ID);
    for (const call of [...gw.putExerciseSets.mock.calls, ...gw.rename.mock.calls, ...gw.describe.mock.calls]) {
      expect(call[0]).toBe(ACTIVITY_ID);
    }
    expect(gw.exerciseSets.mock.calls.every((c) => c[0] === ACTIVITY_ID)).toBe(true);
  });

  it("decides watch or upload from the listing, not from the read by id", async () => {
    // The read by id says DEVELOPMENT; the listing, the proven shape, says a
    // watch recorded it. The listing wins, so no read-back runs.
    gw.activity.mockResolvedValue(storedActivity({ manufacturer: "DEVELOPMENT" }));
    const r = await resync({ merge: MERGE });
    expect(r.syncMethod).toBe("merge");
    expect(gw.exerciseSets).toHaveBeenCalledOnce();
  });

  it("takes the start and duration for the push from the listing", async () => {
    gw.activity.mockResolvedValue(storedActivity({ duration: 1 }));
    gw.activitiesByDate.mockResolvedValue([listed({ startTimeGMT: "2026-08-01 10:05:00", duration: 3000 })]);
    const r = await resync({ merge: MERGE });
    expect(r.status).toBe("synced");
    const payload = gw.putExerciseSets.mock.calls[0][1] as { exerciseSets: Array<{ startTime?: string }> };
    expect(payload.exerciseSets[0].startTime).toMatch(/^2026-08-01T10:05/);
  });

  it("stops with an error when the stored id is not in the listing, even with a match by time", async () => {
    gw.activitiesByDate.mockResolvedValue([AT_WORKOUT_START]);
    const r = await resync({ merge: MERGE });

    expect(r.status).toBe("error");
    expect(r.error).toMatch(/4242/);
    expect(r.error).toMatch(/activity list/);
    expectNoWrites();
  });

  it("stops with an error when the listing itself fails", async () => {
    gw.activitiesByDate.mockRejectedValue(new Error("Garmin 503"));
    const r = await resync({ merge: MERGE });

    expect(r.status).toBe("error");
    expect(r.error).toMatch(/Garmin 503/);
    expectNoWrites();
  });
});

describe("resync: heart rate", () => {
  it("reads it from the stored activity's own FIT, so calories and avg HR are a normal sync's", async () => {
    gw.activityFit.mockResolvedValue(fitWithHr());
    const r = await resync({ merge: MERGE });

    expect(gw.activityFit).toHaveBeenCalledWith(ACTIVITY_ID);
    expect(r.fitStats?.avgHr).toBe(130);
    expect(store.markSynced).toHaveBeenCalledWith(WORKOUT.id, expect.objectContaining({
      avgHr: 130,
      calories: r.fitStats?.calories,
    }));
    expect(gw.describe).toHaveBeenCalledWith(ACTIVITY_ID, expect.stringContaining("avg 130 bpm"));
  });

  it("gives calories that differ from the no-HR estimate, as a normal sync's would", async () => {
    const without = await resync({ merge: MERGE, hrFusion: false });
    gw.activityFit.mockResolvedValue(fitWithHr());
    const withHr = await resync({ merge: MERGE });
    expect(withHr.fitStats?.calories).not.toBe(without.fitStats?.calories);
  });

  it("falls back to the usual sources when the activity's FIT has none", async () => {
    const dailyHr = vi.fn(async () => [
      { time: 0, hr: 125 },
      { time: 1800, hr: 125 },
    ]);
    const r = await resync({ merge: MERGE }, undefined, { dailyHr });
    expect(gw.activityFit).toHaveBeenCalledWith(ACTIVITY_ID);
    expect(dailyHr).toHaveBeenCalled();
    expect(r.fitStats?.avgHr).toBe(125);
  });

  it("writes nothing while finding it: no HR backup and no cache", async () => {
    gw.activityFit.mockResolvedValue(fitWithHr());
    const saveBackup = vi.fn(async () => {});
    const saveCache = vi.fn(async () => {});
    const r = await resync({ merge: MERGE }, undefined, { saveBackup, saveCache, loadBackup: async () => null });
    expect(r.fitStats?.avgHr).toBe(130);
    expect(saveBackup).not.toHaveBeenCalled();
    expect(saveCache).not.toHaveBeenCalled();
  });

  it("carries on without HR when every source fails", async () => {
    gw.activityFit.mockRejectedValue(new Error("download failed"));
    const dailyHr = vi.fn(async () => {
      throw new Error("feed down");
    });
    const r = await resync({ merge: MERGE }, undefined, { dailyHr });
    expect(r.status).toBe("synced");
    expect(r.fitStats?.avgHr).toBeNull();
    expect(store.markSynced).toHaveBeenCalledWith(WORKOUT.id, expect.objectContaining({ avgHr: null }));
  });

  it("asks for none when hr_fusion is off", async () => {
    gw.activityFit.mockResolvedValue(fitWithHr());
    const dailyHr = vi.fn(async () => [{ time: 0, hr: 125 }]);
    const r = await resync({ merge: MERGE, hrFusion: false }, undefined, { dailyHr });
    expect(gw.activityFit).not.toHaveBeenCalled();
    expect(dailyHr).not.toHaveBeenCalled();
    expect(r.fitStats?.avgHr).toBeNull();
  });

  it("asks for none when the push failed, as nothing is written after it", async () => {
    gw.activityFit.mockResolvedValue(fitWithHr());
    gw.putExerciseSets.mockRejectedValue(new Error("400"));
    await resync({ merge: MERGE });
    expect(gw.activityFit).not.toHaveBeenCalled();
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
