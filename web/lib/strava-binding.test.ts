import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The Strava cleanup reaching THIS app.
 *
 * strava.test.ts covers what the cleanup decides. What they cannot
 * cover is whether anything here hands it to the engine, and whether the
 * recheck runs from every trigger, which is the half that went missing once
 * in the Python version: an observation opened at delete time and never
 * looked at again does nothing.
 *
 * So these assert the binding only: opt-in through the environment, both
 * cleanups run when both are configured, and the recheck follows every live
 * sync and no dry run.
 */
const h = vi.hoisted(() => ({
  engine: {
    syncOneWorkout: vi.fn(async (_deps: unknown, opts: { dryRun?: boolean }) => ({
      status: "none",
      dryRun: opts?.dryRun ?? true,
    })),
    listCandidates: vi.fn(async (_deps: unknown) => [] as unknown[]),
    garminGateway: vi.fn((client: unknown) => ({ client })),
  },
  strava: {
    recheckStravaObservations: vi.fn(async (_config: unknown) => {}),
  },
  ps: { isSynced: vi.fn(async () => false) },
}));
vi.mock("hevy2garmin", async (importOriginal) => ({ ...(await importOriginal<object>()), ...h.engine }));
vi.mock("./strava", async (importOriginal) => ({ ...(await importOriginal<object>()), ...h.strava }));
vi.mock("./pending-store", () => h.ps);
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./garmin-upload", () => ({ getGarminClient: async () => ({}) }));
vi.mock("./hevy-sync", () => ({ fetchAllWorkouts: async () => [] }));
vi.mock("./sync-settings", () => ({
  loadSyncSettings: async () => ({}),
  loadSyncStartDate: async () => null,
}));

import { buildSyncDeps, stravaConfig, syncOneWorkout } from "./sync-one";
import { postgresStravaStore } from "./strava-store";

const ENV = { ...process.env };
const KEYS = [
  "STRAVA_CLIENT_ID",
  "STRAVA_CLIENT_SECRET",
  "STRAVA_REFRESH_TOKEN",
  "STRAVA_CLEANUP_MODE",
  "INTERVALS_API_KEY",
  "INTERVALS_ATHLETE_ID",
];
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  h.strava.recheckStravaObservations.mockClear();
  h.engine.syncOneWorkout.mockClear();
});
afterEach(() => {
  process.env = { ...ENV };
});

const sql = (() => {}) as never;

function configureStrava(mode?: string) {
  process.env.STRAVA_CLIENT_ID = "cid";
  process.env.STRAVA_CLIENT_SECRET = "secret";
  process.env.STRAVA_REFRESH_TOKEN = "r1";
  if (mode !== undefined) process.env.STRAVA_CLEANUP_MODE = mode;
}

describe("it stays opt-in", () => {
  it("has no config and gives the engine no hook without credentials", () => {
    expect(stravaConfig(sql)).toBeNull();
    expect(buildSyncDeps(sql).onWatchActivityDeleted).toBeUndefined();
  });

  it("needs both the client id and the secret", () => {
    process.env.STRAVA_CLIENT_ID = "cid";
    expect(stravaConfig(sql)).toBeNull();
    delete process.env.STRAVA_CLIENT_ID;
    process.env.STRAVA_CLIENT_SECRET = "secret";
    expect(stravaConfig(sql)).toBeNull();
  });

  it("is switched off by STRAVA_CLEANUP_MODE=off", () => {
    configureStrava("off");
    expect(stravaConfig(sql)).toBeNull();
    expect(buildSyncDeps(sql).onWatchActivityDeleted).toBeUndefined();
  });

  it("defaults to report, which never writes", () => {
    configureStrava();
    expect(stravaConfig(sql)?.mode).toBe("report");
    process.env.STRAVA_CLEANUP_MODE = "mutee";
    expect(stravaConfig(sql)?.mode).toBe("report");
    process.env.STRAVA_CLEANUP_MODE = "mute";
    expect(stravaConfig(sql)?.mode).toBe("mute");
  });

  it("sends the token to Strava and nowhere else", () => {
    configureStrava();
    process.env.STRAVA_BASE_URL = "https://attacker.test";
    const c = stravaConfig(sql)!;
    expect(c.baseUrl).toBeUndefined();
    expect(c.tokenUrl).toBeUndefined();
  });
});

describe("the engine is given the delete hook", () => {
  it("passes a function when Strava is configured", () => {
    configureStrava();
    expect(buildSyncDeps(sql).onWatchActivityDeleted).toBeTypeOf("function");
  });

  it("runs Strava and intervals.icu both, and one failing does not skip the other", async () => {
    configureStrava();
    process.env.INTERVALS_API_KEY = "k";
    process.env.INTERVALS_ATHLETE_ID = "i12345";
    const order: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      order.push(u.includes("strava") ? "strava" : "intervals");
      if (u.includes("strava")) throw new Error("strava down");
      return new Response("[]", { status: 200 });
    });
    try {
      await buildSyncDeps(sql).onWatchActivityDeleted!(901, "2026-08-01T10:00:00Z", {
        hevyId: "w1",
        workoutEnd: "2026-08-01T11:00:00Z",
      });
    } finally {
      fetchSpy.mockRestore();
    }
    // Strava first: its snapshot is the baseline, and it has to be taken
    // before Garmin pushes our copy there too.
    expect(order[0]).toBe("strava");
    expect(order).toContain("intervals");
  });
});

describe("the recheck follows every live sync", () => {
  it("runs after a live run, even one that found nothing to sync", async () => {
    configureStrava();
    await syncOneWorkout(sql, { dryRun: false });
    expect(h.strava.recheckStravaObservations).toHaveBeenCalledTimes(1);
    const cfg = h.strava.recheckStravaObservations.mock.calls[0][0] as { store: unknown; mode: string };
    expect(cfg.mode).toBe("report");
    expect(cfg.store).toBeTruthy();
  });

  it("runs after the engine, not before", async () => {
    configureStrava();
    const order: string[] = [];
    h.engine.syncOneWorkout.mockImplementationOnce(async () => {
      order.push("sync");
      return { status: "none", dryRun: false };
    });
    h.strava.recheckStravaObservations.mockImplementationOnce(async () => {
      order.push("recheck");
    });
    await syncOneWorkout(sql, { dryRun: false });
    expect(order).toEqual(["sync", "recheck"]);
  });

  it("never runs on a dry run", async () => {
    configureStrava();
    await syncOneWorkout(sql, {});
    await syncOneWorkout(sql, { dryRun: true });
    expect(h.strava.recheckStravaObservations).not.toHaveBeenCalled();
  });

  it("never runs without credentials", async () => {
    await syncOneWorkout(sql, { dryRun: false });
    expect(h.strava.recheckStravaObservations).not.toHaveBeenCalled();
  });
});

describe("the store uses the Python's app_cache keys and shapes", () => {
  function recordingSql(value: unknown) {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
      return value == null ? [] : [{ value }];
    }) as unknown as { json: (v: unknown) => unknown };
    tag.json = (v: unknown) => ({ json: v });
    return { sql: tag as never, queries };
  }

  it("reads the rotated token from strava_tokens", async () => {
    const { sql: s, queries } = recordingSql({ refresh_token: "r7" });
    expect(await postgresStravaStore(s).loadRefreshToken()).toBe("r7");
    expect(queries[0].values).toEqual(["strava_tokens"]);
  });

  it("writes the token as { refresh_token }", async () => {
    const { sql: s, queries } = recordingSql(null);
    await postgresStravaStore(s).saveRefreshToken("r8");
    expect(queries[0].text).toContain("INSERT INTO app_cache");
    expect(queries[0].values).toEqual(["strava_tokens", { json: { refresh_token: "r8" } }]);
  });

  it("writes the observations as { records }", async () => {
    const { sql: s, queries } = recordingSql(null);
    await postgresStravaStore(s).saveObservations([]);
    expect(queries[0].values).toEqual(["strava_observations", { json: { records: [] } }]);
  });

  it("reads no token from an empty or odd row", async () => {
    expect(await postgresStravaStore(recordingSql(null).sql).loadRefreshToken()).toBeNull();
    expect(await postgresStravaStore(recordingSql({ refresh_token: 7 }).sql).loadRefreshToken()).toBeNull();
  });
});
