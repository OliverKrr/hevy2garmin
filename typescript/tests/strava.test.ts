import { describe, it, expect, vi } from "vitest";
import {
  STRAVA_DUP_PREFIX,
  observeStravaWindow,
  parseStravaMode,
  readStravaObservations,
  recheckStravaObservations,
  stravaObserveHook,
  type StravaConfig,
  type StravaObservationRecord,
  type StravaStore,
} from "../src/strava";

/**
 * The Strava cleanup after a replace: observe the window when the watch copy
 * is deleted from Garmin, recheck later, and mute the stale copy only once our
 * own copy is confirmed present.
 *
 * The three session shapes below are the ones that broke an earlier rule each.
 * Their ids, dates and names are made up. Their timing offsets are not: those
 * are what Strava reported for real pairs, and the offsets are the point.
 */

// ---------------------------------------------------------------------------
// A fake Strava and a fake store
// ---------------------------------------------------------------------------

class MemoryStravaStore implements StravaStore {
  refresh: string | null = null;
  records: unknown = null;
  loadRefreshToken = vi.fn(async () => this.refresh);
  saveRefreshToken = vi.fn(async (t: string) => {
    this.refresh = t;
  });
  loadObservations = vi.fn(async () => this.records);
  saveObservations = vi.fn(async (r: StravaObservationRecord[]) => {
    // Round-trip through JSON, as a database would.
    this.records = JSON.parse(JSON.stringify({ records: r }));
  });
  get list(): StravaObservationRecord[] {
    return ((this.records as { records?: StravaObservationRecord[] } | null)?.records ?? []);
  }
}

interface Call {
  url: string;
  method: string;
  body: string | null;
}

/**
 * Answers the token refresh, then serves one window per listing call from
 * `windows` (the last one repeats), and records every PUT.
 */
function fakeStrava(windows: unknown[][], opts: { token?: unknown; putOk?: boolean; listFails?: boolean } = {}) {
  const calls: Call[] = [];
  let listed = 0;
  const impl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method, body: init?.body ?? null });
    if (String(url).includes("/oauth/token")) {
      return { ok: true, status: 200, json: async () => opts.token ?? { access_token: "at", refresh_token: "r1" } };
    }
    if (method === "PUT") return { ok: opts.putOk ?? true, status: opts.putOk === false ? 403 : 200, json: async () => ({}) };
    if (opts.listFails) throw new Error("strava down");
    const w = windows[Math.min(listed, windows.length - 1)] ?? [];
    listed += 1;
    return { ok: true, status: 200, json: async () => w };
  });
  return { impl: impl as unknown as typeof fetch, calls, puts: () => calls.filter((c) => c.method === "PUT") };
}

function config(store: MemoryStravaStore, fetchImpl: typeof fetch, over: Partial<StravaConfig> = {}): StravaConfig {
  return {
    clientId: "cid",
    clientSecret: "secret",
    refreshToken: "r1",
    store,
    fetchImpl,
    baseUrl: "https://strava.test/api/v3",
    tokenUrl: "https://strava.test/oauth/token",
    // Every recheck in these tests is meant to poll; the throttle has its own test.
    minRecheckIntervalMs: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Session A: the watch ran past the Hevy end
// ---------------------------------------------------------------------------
//
// Hevy 3976 s. Both copies start 64 s in, because Strava takes the first
// record and HR fusion gives ours the watch's samples. Ours ends on the Hevy
// end (clipped to it), the watch copy 16 s after.

const A = { hevyId: "hevy-a", start: "2026-03-02T17:00:00Z", end: "2026-03-02T18:06:16Z" };

function actA(over: Record<string, unknown> = {}) {
  return {
    id: 1000000001,
    start_date: "2026-03-02T17:01:04Z",
    elapsed_time: 3928,
    moving_time: 3928,
    sport_type: "WeightTraining",
    name: "Evening Weight Training",
    external_id: "garmin_ping_500000000001",
    upload_id: 2000000001,
    manual: false,
    device_name: "Garmin Forerunner 265",
    hide_from_home: false,
    ...over,
  };
}

const OURS_A = actA({
  id: 1000000002,
  elapsed_time: 3912,
  moving_time: 3912,
  external_id: "garmin_ping_500000000002",
  upload_id: 2000000002,
  device_name: null,
});

async function observeA(cfg: StravaConfig) {
  await observeStravaWindow(cfg, {
    hevyId: A.hevyId,
    workoutStart: A.start,
    workoutEnd: A.end,
    watchActivityId: 9000000001,
    replacementActivityId: 9000000002,
  });
}

async function verdicts(store: MemoryStravaStore, index = -1) {
  const [record] = await readStravaObservations({ store });
  const snap = record.snapshots.at(index)!;
  return Object.fromEntries(snap.activities.map((a) => [a.id, a]));
}

describe("the delete-time observation", () => {
  it("records the window and writes nothing to Strava", async () => {
    const store = new MemoryStravaStore();
    const s = fakeStrava([[actA()]]);
    await observeA(config(store, s.impl));

    expect(s.puts()).toHaveLength(0);
    expect(store.list).toHaveLength(1);
    expect(store.list[0].hevy_duration_s).toBe(3976);
    expect(store.list[0].snapshots).toHaveLength(1);
    expect(store.list[0].baseline_ids).toEqual([1000000001]);
  });

  it("calls anything in the baseline stale, whatever its timings", async () => {
    // OURS_A ends exactly on the Hevy end, the shape of our own copy. If it
    // was already there when the watch copy was deleted, it cannot be ours.
    const store = new MemoryStravaStore();
    await observeA(config(store, fakeStrava([[OURS_A]]).impl));
    const e = (await verdicts(store))[OURS_A.id];
    expect(e.delta_end_s).toBe(0);
    expect(e.verdict).toBe("stale");
  });

  it("measures the watch copy against the Hevy workout", async () => {
    const store = new MemoryStravaStore();
    await observeA(config(store, fakeStrava([[actA()]]).impl));
    const e = (await verdicts(store))[1000000001];
    expect([e.delta_start_s, e.delta_end_s]).toEqual([64, 16]);
    expect(e.verdict).toBe("stale");
  });

  it("keeps only strength activities", async () => {
    const store = new MemoryStravaStore();
    const ride = actA({ id: 1000000009, sport_type: "Ride", name: "Cool down" });
    await observeA(config(store, fakeStrava([[ride, actA()]]).impl));
    expect(store.list[0].snapshots[0].activities.map((a) => a.id)).toEqual([1000000001]);
  });

  it("labels Hevy's own Strava post separately", async () => {
    const store = new MemoryStravaStore();
    const hevyPost = actA({ id: 1000000003, manual: true, device_name: "Hevy", external_id: null });
    await observeA(config(store, fakeStrava([[hevyPost]]).impl));
    expect((await verdicts(store))[1000000003].verdict).toBe("hevy_direct");
  });
});

describe("the recheck", () => {
  it("calls a late arrival that fits the Hevy span ours", async () => {
    const store = new MemoryStravaStore();
    const s = fakeStrava([[actA()], [actA(), OURS_A]]);
    const cfg = config(store, s.impl);
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    const v = await verdicts(store);
    expect(v[1000000001].verdict).toBe("stale");
    expect(v[OURS_A.id].verdict).toBe("ours");
    expect(store.list[0].basis).toBe("baseline");
  });

  it("does not claim a late arrival with unrelated timings", async () => {
    const store = new MemoryStravaStore();
    const other = actA({ id: 1000000007, start_date: "2026-03-02T19:00:00Z", elapsed_time: 1200, device_name: null });
    const cfg = config(store, fakeStrava([[actA()], [actA(), other]]).impl);
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    expect((await verdicts(store))[1000000007].verdict).toBe("unknown");
    expect(store.list[0].ours_present).toBe(false);
    expect(store.list[0].closed).toBe(false);
  });

  it("does not claim a recording that started before the Hevy workout", async () => {
    const store = new MemoryStravaStore();
    const earlier = actA({ id: 1000000008, start_date: "2026-03-02T16:30:00Z", elapsed_time: 2000, device_name: null });
    const cfg = config(store, fakeStrava([[actA()], [actA(), earlier]]).impl);
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    expect((await verdicts(store))[1000000008].verdict).toBe("unknown");
    expect(store.list[0].ours_present).toBe(false);
  });

  it("appends a snapshot only when the window changed", async () => {
    const store = new MemoryStravaStore();
    const cfg = config(store, fakeStrava([[actA()], [actA()], [actA(), OURS_A]]).impl);
    await observeA(cfg);
    await recheckStravaObservations(cfg);
    expect(store.list[0].snapshots).toHaveLength(1);
    expect(store.list[0].checks).toBe(2);

    await recheckStravaObservations(cfg);
    const r = store.list[0];
    expect(r.snapshots).toHaveLength(2);
    expect([r.ours_present, r.stale_count]).toEqual([true, 1]);
    expect(r.closed).toBe(true);
    expect(r.closed_reason).toBe("duplicate_confirmed");
  });

  it("never backfills a baseline the delete-time fetch missed", async () => {
    // A baseline taken after our upload could contain our own copy, which is
    // worse than having none.
    const store = new MemoryStravaStore();
    await observeA(config(store, fakeStrava([], { listFails: true }).impl));
    expect(store.list[0].baseline_ids).toBeNull();

    const cfg = config(store, fakeStrava([[actA(), OURS_A]]).impl);
    await recheckStravaObservations(cfg);
    const r = store.list[0];
    expect(r.baseline_ids).toBeNull();
    expect(r.basis).toBe("time_only");
    // Both copies fit the span, so timing alone cannot tell them apart. That is
    // why a record without a baseline never writes.
    const v = await verdicts(store);
    expect(Object.values(v).map((e) => e.verdict).sort()).toEqual(["ours?", "ours?"]);
  });

  it("does not poll a record checked within the interval", async () => {
    const store = new MemoryStravaStore();
    const s = fakeStrava([[actA()], [actA(), OURS_A]]);
    const cfg = config(store, s.impl, { minRecheckIntervalMs: 5 * 60_000 });
    await observeA(cfg);
    const before = s.calls.length;
    await recheckStravaObservations(cfg);
    // Not even a token refresh: a dashboard batch calls this once per workout.
    expect(s.calls.length).toBe(before);
    expect(store.list[0].checks).toBe(1);
  });

  it("keeps a record another request opened while it was polling", async () => {
    const store = new MemoryStravaStore();
    const cfg = config(store, fakeStrava([[actA()]]).impl);
    await observeA(cfg);

    // A second replace lands between this recheck's load and its save.
    const inner = fakeStrava([[actA(), OURS_A]]);
    const racing = config(store, inner.impl);
    const load = store.loadObservations.getMockImplementation()!;
    let first = true;
    store.loadObservations.mockImplementation(async () => {
      const value = await load();
      if (first) {
        first = false;
        await observeStravaWindow(config(store, fakeStrava([[]]).impl), {
          hevyId: "hevy-other",
          workoutStart: "2026-03-03T08:00:00Z",
          workoutEnd: "2026-03-03T09:00:00Z",
        });
      }
      return value;
    });
    await recheckStravaObservations(racing);

    expect(store.list.map((r) => r.hevy_id).sort()).toEqual(["hevy-a", "hevy-other"]);
    expect(store.list.find((r) => r.hevy_id === "hevy-a")!.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session B: the watch stopped early, and both copies are identical in timing
// ---------------------------------------------------------------------------
//
// Hevy 3042 s. The watch stopped 32 s before the Hevy workout closed, so there
// was no overhang to clip and both copies report 18 s in and 14 s before the
// Hevy end. A test on the end delta rejected our own copy here, which left
// ours_present false and the duplicate unmuted.

const B = { hevyId: "hevy-b", start: "2026-03-09T18:00:00Z", end: "2026-03-09T18:50:42Z" };

function actB(over: Record<string, unknown> = {}) {
  return {
    id: 1000000101,
    start_date: "2026-03-09T18:00:18Z",
    elapsed_time: 3010,
    moving_time: 3010,
    sport_type: "WeightTraining",
    name: "Evening Weight Training",
    external_id: "garmin_ping_500000000101",
    upload_id: 2000000101,
    manual: false,
    device_name: "Garmin Forerunner 265",
    hide_from_home: false,
    ...over,
  };
}

const OURS_B = actB({ id: 1000000102, external_id: "garmin_ping_500000000102", upload_id: 2000000102, device_name: null });

async function observeB(cfg: StravaConfig) {
  await observeStravaWindow(cfg, { hevyId: B.hevyId, workoutStart: B.start, workoutEnd: B.end });
}

describe("identical timings", () => {
  it("still tells our copy from the stale one, by provenance", async () => {
    const store = new MemoryStravaStore();
    const cfg = config(store, fakeStrava([[actB()], [actB(), OURS_B]]).impl);
    await observeB(cfg);
    await recheckStravaObservations(cfg);

    const v = await verdicts(store);
    expect(new Set(Object.values(v).map((e) => `${e.delta_start_s}/${e.delta_end_s}`))).toEqual(new Set(["18/-14"]));
    expect(v[1000000101].verdict).toBe("stale");
    expect(v[1000000102].verdict).toBe("ours");
    expect(store.list[0].closed_reason).toBe("duplicate_confirmed");
  });

  it("mutes the stale copy of the pair", async () => {
    const store = new MemoryStravaStore();
    const muted = actB({ name: `${STRAVA_DUP_PREFIX}Evening Weight Training`, hide_from_home: true });
    const s = fakeStrava([[actB()], [actB(), OURS_B], [muted, OURS_B]]);
    const cfg = config(store, s.impl, { mode: "mute" });
    await observeB(cfg);
    await recheckStravaObservations(cfg);

    expect(s.puts()).toHaveLength(1);
    expect(s.puts()[0].url).toBe("https://strava.test/api/v3/activities/1000000101");
    expect(JSON.parse(s.puts()[0].body!)).toEqual({
      hide_from_home: true,
      name: `${STRAVA_DUP_PREFIX}Evening Weight Training`,
    });
    expect(store.list[0].closed_reason).toBe("duplicate_cleaned");
  });
});

// ---------------------------------------------------------------------------
// Session C: Strava reports our copy for the full Hevy duration
// ---------------------------------------------------------------------------
//
// Hevy 2577 s. Our copy starts 38 s in and its elapsed_time is the Hevy
// duration to the second, so its end overhangs the Hevy end by those 38 s. An
// end bound called our own copy unknown and the mute never fired.

const C = { hevyId: "hevy-c", start: "2026-03-16T18:00:00Z", end: "2026-03-16T18:42:57Z" };

function actC(over: Record<string, unknown> = {}) {
  return {
    id: 1000000201,
    start_date: "2026-03-16T18:00:38Z",
    elapsed_time: 2546,
    moving_time: 2546,
    sport_type: "WeightTraining",
    name: "Evening Weight Training",
    external_id: "garmin_ping_500000000201",
    upload_id: 2000000201,
    manual: false,
    device_name: "Garmin Forerunner 265",
    hide_from_home: false,
    ...over,
  };
}

const OURS_C = actC({
  id: 1000000202,
  elapsed_time: 2577,
  moving_time: 2577,
  external_id: "garmin_ping_500000000202",
  upload_id: 2000000202,
  device_name: null,
});

async function observeC(cfg: StravaConfig) {
  await observeStravaWindow(cfg, { hevyId: C.hevyId, workoutStart: C.start, workoutEnd: C.end });
}

describe("our copy overhanging the Hevy end", () => {
  it("is still ours", async () => {
    const store = new MemoryStravaStore();
    const cfg = config(store, fakeStrava([[actC()], [actC(), OURS_C]]).impl);
    await observeC(cfg);
    await recheckStravaObservations(cfg);

    const v = await verdicts(store);
    const ours = v[1000000202];
    expect([ours.delta_start_s, ours.delta_end_s, ours.delta_elapsed_s]).toEqual([38, 38, 0]);
    expect(ours.verdict).toBe("ours");
    expect(v[1000000201].verdict).toBe("stale");
    expect(store.list[0].closed_reason).toBe("duplicate_confirmed");
  });

  it("gets its stale partner muted", async () => {
    const store = new MemoryStravaStore();
    const muted = actC({ name: `${STRAVA_DUP_PREFIX}Evening Weight Training`, hide_from_home: true });
    const s = fakeStrava([[actC()], [actC(), OURS_C], [muted, OURS_C]]);
    const cfg = config(store, s.impl, { mode: "mute" });
    await observeC(cfg);
    await recheckStravaObservations(cfg);

    expect(s.puts().map((p) => p.url)).toEqual(["https://strava.test/api/v3/activities/1000000201"]);
    expect(store.list[0].closed_reason).toBe("duplicate_cleaned");
  });

  it("does not claim a late arrival longer than the Hevy workout", async () => {
    // Starting inside the window is not enough: our copy is never longer.
    const store = new MemoryStravaStore();
    const longer = actC({ id: 1000000209, elapsed_time: 2577 + 600, external_id: "garmin_ping_1", device_name: null });
    const cfg = config(store, fakeStrava([[actC()], [actC(), longer]]).impl);
    await observeC(cfg);
    await recheckStravaObservations(cfg);

    expect((await verdicts(store))[1000000209].verdict).toBe("unknown");
    expect(store.list[0].ours_present).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Closing a record
// ---------------------------------------------------------------------------

describe("closing a record", () => {
  it("ages an abandoned record out without polling Strava", async () => {
    // The age test used to gate which records were visited, so the branch that
    // closes an aged record could never run.
    const store = new MemoryStravaStore();
    await observeA(config(store, fakeStrava([[actA()]]).impl, { now: () => new Date("2026-03-02T19:00:00Z") }));
    const s = fakeStrava([[actA()]]);
    // 21 days is the limit; this is 44.
    await recheckStravaObservations(config(store, s.impl, { now: () => new Date("2026-04-15T00:00:00Z") }));

    expect(s.calls).toHaveLength(0);
    expect(store.list[0].closed).toBe(true);
    expect(store.list[0].closed_reason).toBe("aged_out");
  });

  it("closes once the stale copy was deleted by hand", async () => {
    const store = new MemoryStravaStore();
    const cfg = config(store, fakeStrava([[actA()], [OURS_A]]).impl);
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    const r = store.list[0];
    expect([r.ours_present, r.stale_count]).toEqual([true, 0]);
    expect(r.closed_reason).toBe("stale_copy_gone");
  });

  it("stays open on an empty baseline", async () => {
    // Garmin had not pushed the watch copy yet, so a stale one can still land.
    const store = new MemoryStravaStore();
    const cfg = config(store, fakeStrava([[], [OURS_A]]).impl);
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    const r = store.list[0];
    expect(r.baseline_ids).toEqual([]);
    expect(r.ours_present).toBe(true);
    expect(r.closed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The mode, and the one rule every write keeps
// ---------------------------------------------------------------------------

describe("the mode", () => {
  it("defaults to report, which never writes", async () => {
    const store = new MemoryStravaStore();
    const s = fakeStrava([[actA()], [actA(), OURS_A]]);
    const cfg = config(store, s.impl);
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    expect(s.puts()).toHaveLength(0);
    expect(store.list[0].closed_reason).toBe("duplicate_confirmed");
    expect(store.list[0].cleanup).toBeUndefined();
  });

  it("parses off, report and mute, and reads anything else as report", () => {
    expect(parseStravaMode("off")).toBe("off");
    expect(parseStravaMode(" MUTE ")).toBe("mute");
    expect(parseStravaMode("report")).toBe("report");
    expect(parseStravaMode(undefined)).toBe("report");
    // A typo must not arm the write, nor switch observation off.
    expect(parseStravaMode("mutee")).toBe("report");
  });

  it("off touches nothing at all", async () => {
    const store = new MemoryStravaStore();
    const s = fakeStrava([[actA()]]);
    const cfg = config(store, s.impl, { mode: "off" });
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    expect(s.calls).toHaveLength(0);
    expect(store.saveObservations).not.toHaveBeenCalled();
    expect(stravaObserveHook(cfg)).toBeNull();
  });

  it("mute writes to the stale copy and nothing else", async () => {
    const store = new MemoryStravaStore();
    const muted = actA({ name: `${STRAVA_DUP_PREFIX}Evening Weight Training`, hide_from_home: true });
    const s = fakeStrava([[actA()], [actA(), OURS_A], [muted, OURS_A]]);
    const cfg = config(store, s.impl, { mode: "mute" });
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    expect(s.puts().map((p) => p.url)).toEqual(["https://strava.test/api/v3/activities/1000000001"]);
    const r = store.list[0];
    expect(r.cleanup).toEqual([{ id: 1000000001, at: expect.any(String), muted: true }]);
    expect(r.closed_reason).toBe("duplicate_cleaned");
    // Re-read after the write, so the timeline shows it as Strava has it.
    expect(r.snapshots.at(-1)!.phase).toBe("after_mute");
  });

  it("mute never writes while our copy is absent", async () => {
    // The safety rule: muting the only copy would hide the workout.
    const store = new MemoryStravaStore();
    const s = fakeStrava([[actA()], [actA()]]);
    const cfg = config(store, s.impl, { mode: "mute" });
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    expect(s.puts()).toHaveLength(0);
    expect(store.list[0].closed).toBe(false);
  });

  it("mute never writes on a record without a baseline", async () => {
    const store = new MemoryStravaStore();
    await observeA(config(store, fakeStrava([], { listFails: true }).impl));
    const s = fakeStrava([[actA(), OURS_A]]);
    await recheckStravaObservations(config(store, s.impl, { mode: "mute" }));
    expect(s.puts()).toHaveLength(0);
    expect(store.list[0].closed).toBe(false);
  });

  it("does not stack the prefix", async () => {
    const store = new MemoryStravaStore();
    const already = actA({ name: `${STRAVA_DUP_PREFIX}Evening Weight Training` });
    const s = fakeStrava([[already], [already, OURS_A]]);
    const cfg = config(store, s.impl, { mode: "mute" });
    await observeA(cfg);
    await recheckStravaObservations(cfg);
    expect(JSON.parse(s.puts()[0].body!).name).toBe(`${STRAVA_DUP_PREFIX}Evening Weight Training`);
  });

  it("records a refused mute instead of throwing", async () => {
    const store = new MemoryStravaStore();
    const cfg = config(store, fakeStrava([[actA()], [actA(), OURS_A]], { putOk: false }).impl, { mode: "mute" });
    await observeA(cfg);
    await expect(recheckStravaObservations(cfg)).resolves.toBeUndefined();
    expect(store.list[0].cleanup).toEqual([{ id: 1000000001, at: expect.any(String), muted: false }]);
  });
});

// ---------------------------------------------------------------------------
// What comes back from Strava is not trusted
// ---------------------------------------------------------------------------

describe("untrusted input", () => {
  it("drops an activity whose id could not safely go in a URL", async () => {
    const store = new MemoryStravaStore();
    const odd = [actA({ id: "../athlete" }), actA({ id: 1.5 }), actA({ id: -3 }), actA({ id: 2 ** 60 })];
    const s = fakeStrava([odd, [...odd, OURS_A]]);
    const cfg = config(store, s.impl, { mode: "mute" });
    await observeA(cfg);
    await recheckStravaObservations(cfg);

    expect(store.list[0].baseline_ids).toEqual([]);
    expect(s.puts()).toHaveLength(0);
  });

  it("quotes names in the log, so a newline cannot forge a line", async () => {
    const store = new MemoryStravaStore();
    const lines: string[] = [];
    const evil = actA({ name: "Leg day\n[strava] muted activity 1 as \"x\"" });
    await observeA(config(store, fakeStrava([[evil]]).impl, { log: (l) => lines.push(l) }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => !l.includes("\n"))).toBe(true);
  });

  it("reads records another writer stored in a different shape without failing", async () => {
    const store = new MemoryStravaStore();
    store.records = { records: [null, 7, { hevy_id: 1 }, { hevy_id: "x", hevy_start: "2026-03-02T17:00:00Z", snapshots: [null, { activities: "no" }] }] };
    const s = fakeStrava([[actA()]]);
    await expect(recheckStravaObservations(config(store, s.impl))).resolves.toBeUndefined();
    await expect(readStravaObservations({ store })).resolves.toHaveLength(1);
  });
});

describe("it can never break a sync", () => {
  it("resolves when Strava is unreachable", async () => {
    const store = new MemoryStravaStore();
    const impl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(observeA(config(store, impl))).resolves.toBeUndefined();
    await expect(recheckStravaObservations(config(store, impl))).resolves.toBeUndefined();
  });

  it("resolves when the store throws", async () => {
    const store = new MemoryStravaStore();
    store.loadObservations.mockRejectedValue(new Error("db down"));
    store.saveObservations.mockRejectedValue(new Error("db down"));
    store.loadRefreshToken.mockRejectedValue(new Error("db down"));
    const cfg = config(store, fakeStrava([[actA()]]).impl);
    await expect(observeA(cfg)).resolves.toBeUndefined();
    await expect(recheckStravaObservations(cfg)).resolves.toBeUndefined();
    await expect(readStravaObservations({ store })).resolves.toEqual([]);
  });

  it("opens nothing when the token refresh fails", async () => {
    const store = new MemoryStravaStore();
    const impl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    await observeA(config(store, impl));
    expect(store.saveObservations).not.toHaveBeenCalled();
  });
});

describe("the refresh token", () => {
  it("persists a rotated token", async () => {
    const store = new MemoryStravaStore();
    await observeA(config(store, fakeStrava([[actA()]], { token: { access_token: "at", refresh_token: "r2" } }).impl));
    expect(store.saveRefreshToken).toHaveBeenCalledWith("r2");
  });

  it("does not rewrite an unrotated token", async () => {
    const store = new MemoryStravaStore();
    await observeA(config(store, fakeStrava([[actA()]], { token: { access_token: "at", refresh_token: "r1" } }).impl));
    expect(store.saveRefreshToken).not.toHaveBeenCalled();
  });

  it("prefers the stored token over the bootstrap one", async () => {
    // After the first rotation the bootstrap value is dead; using it would
    // lock the deployment out.
    const store = new MemoryStravaStore();
    store.refresh = "r9";
    const s = fakeStrava([[actA()]]);
    await observeA(config(store, s.impl));
    expect(s.calls[0].body).toContain("refresh_token=r9");
  });
});

// ---------------------------------------------------------------------------
// Records the Python wrote
// ---------------------------------------------------------------------------

describe("records written by the Python", () => {
  it("derive the same verdicts here", async () => {
    // Key for key the Python's shape, including its `+00:00` timestamps and a
    // snapshot history already carrying our copy. A database shared across the
    // move from the Python to this engine is read as-is.
    const store = new MemoryStravaStore();
    store.records = {
      records: [
        {
          hevy_id: "hevy-py",
          hevy_start: "2026-03-16T18:00:00+00:00",
          hevy_end: "2026-03-16T18:42:57+00:00",
          hevy_duration_s: 2577,
          watch_activity_id: "9000000201",
          replacement_activity_id: "9000000202",
          opened_at: "2026-03-16T19:00:00+00:00",
          closed: false,
          snapshots: [
            { at: "2026-03-16T19:00:00+00:00", phase: "watch_copy_deleted", activities: [actC()] },
            { at: "2026-03-16T19:30:00+00:00", phase: "recheck", activities: [actC(), OURS_C] },
          ],
          checks: 2,
          last_checked_at: "2026-03-16T19:30:00+00:00",
          baseline_ids: [1000000201],
          baseline_at: "2026-03-16T19:00:00+00:00",
          ours_present: false,
          stale_count: 1,
          basis: "baseline",
        },
      ],
    };
    const v = Object.fromEntries(
      (await readStravaObservations({ store }))[0].snapshots[1].activities.map((a) => [a.id, a.verdict]),
    );
    expect(v).toEqual({ 1000000201: "stale", 1000000202: "ours" });
  });
});

// ---------------------------------------------------------------------------
// The hook the engine calls
// ---------------------------------------------------------------------------

describe("the hook", () => {
  it("is null without credentials", () => {
    const store = new MemoryStravaStore();
    expect(stravaObserveHook(null)).toBeNull();
    expect(stravaObserveHook({ clientId: "", clientSecret: "s", store })).toBeNull();
    expect(stravaObserveHook({ clientId: "c", clientSecret: "", store })).toBeNull();
  });

  it("opens a record from the context the engine passes", async () => {
    const store = new MemoryStravaStore();
    const hook = stravaObserveHook(config(store, fakeStrava([[actA()]]).impl))!;
    await hook(9000000001, A.start, { hevyId: A.hevyId, workoutEnd: A.end, replacementActivityId: 9000000002 });

    const r = store.list[0];
    expect([r.hevy_id, r.watch_activity_id, r.replacement_activity_id, r.hevy_duration_s]).toEqual([
      "hevy-a",
      "9000000001",
      "9000000002",
      3976,
    ]);
  });

  it("does nothing when called without context, as an older engine would", async () => {
    const store = new MemoryStravaStore();
    const s = fakeStrava([[actA()]]);
    await stravaObserveHook(config(store, s.impl))!(9000000001, A.start);
    expect(s.calls).toHaveLength(0);
  });
});

describe("the configuration this exists for", () => {
  it("a replace sync opens the record, and a later recheck mutes only the watch copy", async () => {
    // Merge on, replace strategy, Strava configured with mute: the real engine,
    // the real hook, and a fake Strava whose window gains our copy between the
    // delete and the recheck. WORKOUT runs 10:00 to 11:00; both Strava copies
    // start 20 s in, the watch copy runs 5 s past the end, ours is clipped.
    const { syncOneWorkout } = await import("../src/sync");
    const { MemoryStore, mockGateway, WORKOUT } = await import("./sync/helpers");

    const watchCopy = actA({ id: 1000000301, start_date: "2026-08-01T10:00:20Z", elapsed_time: 3585 });
    const ours = actA({
      id: 1000000302,
      start_date: "2026-08-01T10:00:20Z",
      elapsed_time: 3580,
      external_id: "garmin_ping_500000000302",
      device_name: null,
    });
    const muted = { ...watchCopy, name: `${STRAVA_DUP_PREFIX}${watchCopy.name}`, hide_from_home: true };
    const strava = fakeStrava([[watchCopy], [watchCopy, ours], [muted, ours]]);
    const store = new MemoryStravaStore();
    const cfg = config(store, strava.impl, { mode: "mute" });

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
    const result = await syncOneWorkout(
      {
        store: new MemoryStore(),
        gateway: async () => gw,
        fetchWorkouts: async () => [WORKOUT],
        hr: { loadBackup: async () => [{ time: 0, hr: 120 }], saveBackup: async () => {}, cachedHr: async () => null },
        onWatchActivityDeleted: stravaObserveHook(cfg)!,
      } as never,
      { dryRun: false, merge: { enabled: true, watchStrategy: "replace" } },
    );
    expect(result.status).toBe("synced");
    expect(gw.deleteActivity).toHaveBeenCalledWith(901);

    // At delete time: one record, keyed on the workout, baseline = watch copy.
    expect(strava.puts()).toHaveLength(0);
    const opened = store.list[0];
    expect([opened.hevy_id, opened.hevy_duration_s, opened.watch_activity_id, opened.replacement_activity_id]).toEqual([
      WORKOUT.id,
      3600,
      "901",
      // The engine's hook context carries the Hevy id and end, not our
      // replacement's id, so the record leaves it unset.
      null,
    ]);
    expect(opened.baseline_ids).toEqual([1000000301]);

    await recheckStravaObservations(cfg);
    expect(strava.puts().map((p) => p.url)).toEqual(["https://strava.test/api/v3/activities/1000000301"]);
    expect(store.list[0].closed_reason).toBe("duplicate_cleaned");
  });
});
