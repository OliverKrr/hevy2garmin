/**
 * Merge-only mode: the engine half of the webhook's staged retry.
 *
 * The contract is narrow on purpose. `merge_pending` means "the merge found no
 * Garmin activity", and nothing else. The Python version also returned it when
 * a `replace` match came back as an unmerged fallback, so with
 * watch_strategy=replace every attempt but the last was thrown away and every
 * workout synced about 25 minutes late. The replace tests below are that bug.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { syncOneWorkout } from "../../src/sync/sync-one";
import type { GarminGateway, SyncDeps } from "../../src/sync/gateway";
import type { SyncStore } from "../../src/sync/store";
import { generateFit } from "../../src/fit";

const iso = (d: Date) => d.toISOString();
/** Garmin's own spelling: "YYYY-MM-DD HH:MM:SS", no zone marker. */
const garminTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

/** A workout that ended `endedMinutesAgo` ago and lasted an hour. */
function workoutEnded(endedMinutesAgo: number) {
  const end = new Date(Date.now() - endedMinutesAgo * 60_000);
  const start = new Date(end.getTime() - 3600_000);
  return {
    start,
    workout: {
      id: "w1",
      title: "Push day",
      start_time: iso(start),
      end_time: iso(end),
      updated_at: iso(end),
      exercises: [
        { title: "Bench Press (Barbell)", sets: [{ reps: 10, weight_kg: 60 }, { reps: 8, weight_kg: 70 }] },
      ],
    },
  };
}

// Three hours old by default, well outside the grace period, so the grace
// tests below are the only ones where it matters.
const { start: START, workout: WORKOUT } = workoutEnded(180);

function watchActivity(start: Date = START, over: Record<string, unknown> = {}) {
  return {
    activityId: 777,
    duration: 3600,
    startTimeGMT: garminTime(new Date(start.getTime() + 2 * 60_000)),
    activityType: { typeKey: "strength_training" },
    manufacturer: "GARMIN",
    ...over,
  };
}

function store(): SyncStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isSynced: async () => false,
    loadSyncedIds: async () => new Set<string>(),
    loadPendingIds: async () => new Set<string>(),
    getPending: async () => null,
    claimPending: async (id) => {
      calls.push(`claim:${id}`);
      return true;
    },
    updatePending: async () => {},
    deletePending: async () => true,
    completePending: async (id, o) => {
      calls.push(`complete:${id}:${o.syncMethod}`);
    },
    markSynced: async (id, o) => {
      calls.push(`markSynced:${id}:${o.syncMethod}`);
    },
  };
}

function gateway(over: Partial<GarminGateway> = {}, activities: unknown[] = [watchActivity()]): GarminGateway {
  return {
    findExistingActivity: vi.fn(async () => null),
    upload: vi.fn(async () => ({ uploadId: 1, activityId: 999 })),
    rename: vi.fn(async () => {}),
    describe: vi.fn(async () => {}),
    activitiesByDate: vi.fn(async () => activities as never),
    exerciseSets: vi.fn(async () => ({ exerciseSets: [] })),
    putExerciseSets: vi.fn(async () => {}),
    deleteActivity: vi.fn(async () => {}),
    activityFit: vi.fn(async () => null),
    ...over,
  } as GarminGateway;
}

function deps(g: GarminGateway, s: SyncStore, workout: unknown = WORKOUT, hr?: SyncDeps["hr"]): SyncDeps {
  return { store: s, gateway: async () => g, fetchWorkouts: async () => [workout as never], hr };
}

/** A FIT holding real HR, so a replace can secure the watch's heart rate. */
function fitWithHr(): Uint8Array {
  return generateFit(
    {
      title: "watch",
      start_time: WORKOUT.start_time,
      end_time: WORKOUT.end_time,
      exercises: [{ title: "Bench Press (Barbell)", sets: [{ reps: 1, weight_kg: 1 }] }],
    } as never,
    [{ time: 0, hr: 120 }, { time: 60, hr: 140 }],
  ).fit;
}

const LIVE = { dryRun: false, hrFusion: false, mergeOnly: true } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("mergeOnly: no Garmin activity yet", () => {
  it("returns merge_pending and writes nothing, to Garmin or the store", async () => {
    const g = gateway({}, []);
    const s = store();
    const r = await syncOneWorkout(deps(g, s), { ...LIVE, merge: { enabled: true, watchStrategy: "merge" } });

    expect(r.status).toBe("merge_pending");
    expect(r.workout?.hevy_id).toBe("w1");
    expect(r.mergeFallbackReason).toMatch(/no matching Garmin activity/);
    expect(g.upload).not.toHaveBeenCalled();
    expect(g.rename).not.toHaveBeenCalled();
    expect(g.putExerciseSets).not.toHaveBeenCalled();
    expect(g.deleteActivity).not.toHaveBeenCalled();
    // Layer 2 is a later step; merge-only stops before it.
    expect(g.findExistingActivity).not.toHaveBeenCalled();
    // No claim either, so the next attempt is not blocked by a row of ours.
    expect(s.calls).toEqual([]);
  });

  it("is the same answer for replace when nothing matched", async () => {
    const g = gateway({}, []);
    const r = await syncOneWorkout(deps(g, store()), { ...LIVE, merge: { enabled: true, watchStrategy: "replace" } });
    expect(r.status).toBe("merge_pending");
    expect(g.upload).not.toHaveBeenCalled();
  });

  it("waits when Garmin could not be asked, rather than uploading blind", async () => {
    const g = gateway({ activitiesByDate: vi.fn(async () => { throw new Error("503 from Garmin"); }) });
    const r = await syncOneWorkout(deps(g, store()), { ...LIVE, merge: { enabled: true } });
    expect(r.status).toBe("merge_pending");
    expect(r.mergeFallbackReason).toMatch(/could not list Garmin activities: 503/);
    expect(g.upload).not.toHaveBeenCalled();
  });

  it("uploads as before when merge-only is not asked for", async () => {
    const g = gateway({}, []);
    const r = await syncOneWorkout(deps(g, store()), {
      dryRun: false,
      hrFusion: false,
      merge: { enabled: true, watchStrategy: "merge" },
    });
    expect(r.status).toBe("synced");
    expect(g.upload).toHaveBeenCalledOnce();
  });
});

describe("mergeOnly: a Garmin activity matched", () => {
  it("replace: the match is a success, so it uploads and deletes the watch copy on the first attempt", async () => {
    const g = gateway({ activityFit: vi.fn(async () => fitWithHr()) });
    const s = store();
    const saveBackup = vi.fn(async () => {});
    const r = await syncOneWorkout(deps(g, s, WORKOUT, { saveBackup }), {
      ...LIVE,
      merge: { enabled: true, watchStrategy: "replace" },
    });

    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("upload");
    expect(g.upload).toHaveBeenCalledOnce();
    expect(saveBackup).toHaveBeenCalledOnce();
    expect(g.deleteActivity).toHaveBeenCalledWith(777);
    expect(s.calls).toEqual(["claim:w1", "complete:w1:upload"]);
  });

  it("replace: still goes ahead when the watch HR cannot be secured and the sets merge in place", async () => {
    // No watch FIT and no durable backup, so the HR cannot be protected and
    // the watch copy must live. The engine merges in place instead. That is
    // still a match.
    const g = gateway({ activityFit: vi.fn(async () => null) });
    const s = store();
    const r = await syncOneWorkout(deps(g, s, WORKOUT, { loadBackup: async () => null }), {
      ...LIVE,
      merge: { enabled: true, watchStrategy: "replace" },
    });
    expect(r.status).toBe("synced");
    expect(g.deleteActivity).not.toHaveBeenCalled();
    expect(s.calls).toEqual(["markSynced:w1:merge"]);
  });

  it("merge: merges into the watch activity, as without the flag", async () => {
    const g = gateway();
    const s = store();
    const r = await syncOneWorkout(deps(g, s), { ...LIVE, merge: { enabled: true, watchStrategy: "merge" } });
    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("merge");
    expect(g.upload).not.toHaveBeenCalled();
    expect(s.calls).toEqual(["markSynced:w1:merge"]);
  });

  it("describe: describes the watch activity, as without the flag", async () => {
    const g = gateway();
    const r = await syncOneWorkout(deps(g, store()), { ...LIVE, merge: { enabled: true, watchStrategy: "describe" } });
    expect(r.status).toBe("synced");
    expect(g.describe).toHaveBeenCalledOnce();
  });

  it("a match the sets could not be pushed into falls through to the match path, not merge_pending", async () => {
    // Waiting ten minutes will not make Garmin accept the PUT, so holding the
    // workout back would only delay it.
    const g = gateway({
      putExerciseSets: vi.fn(async () => { throw new Error("400"); }),
      findExistingActivity: vi.fn(async () => 777),
    });
    const s = store();
    const r = await syncOneWorkout(deps(g, s), { ...LIVE, merge: { enabled: true, watchStrategy: "merge" } });
    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("match");
    expect(g.upload).not.toHaveBeenCalled();
    expect(s.calls).toEqual(["markSynced:w1:upload_fallback"]);
  });

  it("Garmin dropping the names on our own upload forces a fresh upload, not merge_pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    // Our own earlier upload, so the read-back runs and finds no names.
    const g = gateway({}, [watchActivity(START, { manufacturer: "DEVELOPMENT" })]);
    const pending = syncOneWorkout(deps(g, store()), { ...LIVE, merge: { enabled: true, watchStrategy: "merge" } });
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await pending;
    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("upload");
    expect(g.upload).toHaveBeenCalledOnce();
  });
});

describe("mergeOnly: where it does not apply", () => {
  it("does nothing with merge off: the workout uploads as usual", async () => {
    const g = gateway({}, []);
    const r = await syncOneWorkout(deps(g, store()), { ...LIVE, merge: { enabled: false } });
    expect(r.status).toBe("synced");
    expect(g.upload).toHaveBeenCalledOnce();
  });

  it("does nothing in a dry run, which never merges", async () => {
    const g = gateway({}, []);
    const r = await syncOneWorkout(deps(g, store()), { ...LIVE, dryRun: true, merge: { enabled: true } });
    expect(r.status).toBe("dry_run");
    expect(g.activitiesByDate).not.toHaveBeenCalled();
  });
});

describe("mergeOnly and the grace period", () => {
  const recent = workoutEnded(5);

  it("replaces the grace wait when merge is on, so the merge can run", async () => {
    const g = gateway({}, [watchActivity(recent.start)]);
    const r = await syncOneWorkout(deps(g, store(), recent.workout), {
      ...LIVE,
      respectGrace: true,
      merge: { enabled: true, watchStrategy: "merge" },
    });
    expect(r.status).toBe("synced");
    expect(r.syncMethod).toBe("merge");
  });

  it("still returns merge_pending, not an upload, for a recent workout with no watch activity", async () => {
    const g = gateway({}, []);
    const r = await syncOneWorkout(deps(g, store(), recent.workout), {
      ...LIVE,
      respectGrace: true,
      merge: { enabled: true },
    });
    expect(r.status).toBe("merge_pending");
    expect(g.upload).not.toHaveBeenCalled();
  });

  it("keeps the grace wait when merge is off, because nothing else is waiting for the watch", async () => {
    const g = gateway({}, []);
    const r = await syncOneWorkout(deps(g, store(), recent.workout), {
      ...LIVE,
      respectGrace: true,
      merge: { enabled: false },
    });
    expect(r.status).toBe("deferred");
    expect(r.dedupDecision).toBe("within_grace");
    expect(g.upload).not.toHaveBeenCalled();
  });
});
