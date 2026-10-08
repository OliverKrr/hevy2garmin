/**
 * Tests for the daily monitoring HR source (#579).
 *
 * This is the last of the four sources `hr.py` names, and the only one that
 * covers a workout the watch never recorded as an activity: the user wore the
 * watch, so the heart rate exists, it is just not attached to anything.
 */
import { describe, it, expect, vi } from "vitest";
import { dailyHrToPoints } from "../src/hr";
import { getDailyHeartRate, getDisplayName } from "../src/garmin";
import type { GarminClient } from "garmin-auth";

const START = new Date("2026-09-15T10:00:00Z");
const END = new Date("2026-09-15T11:00:00Z");
const at = (minutes: number) => START.getTime() + minutes * 60000;

describe("dailyHrToPoints", () => {
  it("rebases readings to seconds from the workout start", () => {
    expect(
      dailyHrToPoints([[at(0), 100], [at(10), 120], [at(30), 140]], START, END),
    ).toEqual([
      { time: 0, hr: 100 },
      { time: 600, hr: 120 },
      { time: 1800, hr: 140 },
    ]);
  });

  it("drops readings outside the workout, which is most of a day's feed", () => {
    const out = dailyHrToPoints([[at(-120), 60], [at(20), 130], [at(180), 65]], START, END);
    expect(out).toEqual([{ time: 1200, hr: 130 }]);
  });

  it("keeps a reading one minute either side, because the feed is sparse", () => {
    // Every couple of minutes, so a strict window often loses the readings
    // closest to the start and the end. Python uses the same buffer.
    const out = dailyHrToPoints([[at(-0.5), 95], [at(60.5), 105]], START, END);
    expect(out.map((p) => p.hr)).toEqual([95, 105]);
    expect(out[0].time).toBe(0); // clamped, never negative
  });

  it("ignores the null readings Garmin sends for gaps in wear", () => {
    expect(dailyHrToPoints([[at(5), null], [at(6), 110]], START, END)).toEqual([
      { time: 360, hr: 110 },
    ]);
  });

  it("returns nothing for rubbish rather than breaking a sync", () => {
    expect(dailyHrToPoints(null, START, END)).toEqual([]);
    expect(dailyHrToPoints(undefined, START, END)).toEqual([]);
    expect(dailyHrToPoints([[1] as never, "x" as never], START, END)).toEqual([]);
  });

  it("always returns readings in time order", () => {
    const out = dailyHrToPoints([[at(30), 3], [at(1), 1], [at(15), 2]], START, END);
    expect(out.map((p) => p.hr)).toEqual([1, 2, 3]);
  });
});

/** A client whose connectapi answers a map of path prefix to payload. */
function client(routes: Record<string, unknown>, spy = vi.fn()): GarminClient {
  return {
    connectapi: async (path: string) => {
      spy(path);
      for (const [prefix, value] of Object.entries(routes)) {
        if (path.startsWith(prefix)) {
          if (value instanceof Error) throw value;
          return value;
        }
      }
      throw new Error(`404 ${path}`);
    },
  } as unknown as GarminClient;
}

describe("getDailyHeartRate", () => {
  const PROFILE = "/userprofile-service/socialProfile";
  const WELLNESS = "/wellness-service/wellness/dailyHeartRate";

  it("reads the display name the wellness endpoint is keyed by, then the readings", async () => {
    const seen = vi.fn();
    const c = client(
      { [PROFILE]: { displayName: "abc-123" }, [WELLNESS]: { heartRateValues: [[1, 60]] } },
      seen,
    );
    expect(await getDailyHeartRate(c, "2026-09-15")).toEqual([[1, 60]]);
    expect(seen.mock.calls[1][0]).toContain("/dailyHeartRate/abc-123?date=2026-09-15");
  });

  it("fetches the display name once per client, not once per workout", async () => {
    const seen = vi.fn();
    const c = client(
      { [PROFILE]: { displayName: "abc-123" }, [WELLNESS]: { heartRateValues: [] } },
      seen,
    );
    await getDailyHeartRate(c, "2026-09-15");
    await getDailyHeartRate(c, "2026-09-16");
    expect(seen.mock.calls.filter((c2) => String(c2[0]).startsWith(PROFILE))).toHaveLength(1);
  });

  it("accepts a full timestamp and uses its date", async () => {
    const seen = vi.fn();
    const c = client(
      { [PROFILE]: { displayName: "me" }, [WELLNESS]: { heartRateValues: [] } },
      seen,
    );
    await getDailyHeartRate(c, "2026-09-15T10:00:00Z");
    expect(seen.mock.calls[1][0]).toContain("date=2026-09-15");
  });

  it("returns nothing, and asks Garmin nothing, for a date it cannot parse", async () => {
    const seen = vi.fn();
    expect(await getDailyHeartRate(client({}, seen), "last tuesday")).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
  });

  it("asks the unkeyed path when the profile call fails, instead of giving up", async () => {
    const seen = vi.fn();
    const c = client(
      { [PROFILE]: new Error("404"), [WELLNESS]: { heartRateValues: [[1, 60]] } },
      seen,
    );
    expect(await getDailyHeartRate(c, "2026-09-15")).toEqual([[1, 60]]);
    expect(await getDisplayName(c)).toBeNull();
    expect(seen.mock.calls[1][0]).toBe(`${WELLNESS}?date=2026-09-15`);
  });

  it("no longer reads the retired userprofile/profile path", async () => {
    const seen = vi.fn();
    const c = client(
      { [PROFILE]: { displayName: "abc-123" }, [WELLNESS]: { heartRateValues: [] } },
      seen,
    );
    await getDailyHeartRate(c, "2026-09-15");
    expect(seen.mock.calls.map((x) => String(x[0]))).not.toContain(
      "/userprofile-service/userprofile/profile",
    );
  });

  it("returns nothing when the wellness call fails, rather than breaking the sync", async () => {
    const c = client({ [PROFILE]: { displayName: "me" }, [WELLNESS]: new Error("500") });
    expect(await getDailyHeartRate(c, "2026-09-15")).toEqual([]);
  });

  it("returns nothing when Garmin sends a body without readings", async () => {
    const c = client({ [PROFILE]: { displayName: "me" }, [WELLNESS]: { heartRateValues: null } });
    expect(await getDailyHeartRate(c, "2026-09-15")).toEqual([]);
  });
});
