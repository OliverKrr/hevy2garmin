import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  writes: [] as string[],
  inserts: [] as string[],
  updateCount: 1,
  getAllWorkouts: vi.fn(async () => [] as unknown[]),
}));

vi.mock("hevy2garmin", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    HevyClient: class {
      getAllWorkouts = h.getAllWorkouts;
    },
  };
});
vi.mock("./db", () => ({
  getDb: () => {
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("UPDATE platform_credentials")) {
        h.writes.push(String(values[0]));
        // getDb() returns a plain array of rows, never the driver's `count`.
        return Promise.resolve(Array.from({ length: h.updateCount }, () => ({ platform: "hevy" })));
      }
      if (text.includes("INSERT INTO platform_credentials")) h.inserts.push(String(values[0]));
      if (text.includes("SELECT credentials")) {
        return Promise.resolve([{ credentials: { api_key: "k" } }]);
      }
      return Promise.resolve([]);
    }) as never;
    (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return tag;
  },
}));

import { fetchAllWorkouts } from "./hevy-sync";
import { HevyAuthError } from "hevy2garmin";

/**
 * A revoked Hevy key used to be invisible (#605).
 *
 * The scheduled sync keeps firing, every run fails the same way, and nothing on
 * the dashboard says the key is the reason. The user sees syncing stop with no
 * way to learn why.
 *
 * The credential row is marked disconnected instead, which puts it in the place
 * the dashboard already shows whether Hevy is connected. It deliberately does
 * NOT turn auto-sync off: that is a decision taken on the user's behalf from
 * one signal, and it would not undo itself when the key is fixed.
 */

beforeEach(() => {
  h.writes.length = 0;
  h.inserts.length = 0;
  h.updateCount = 1;
  delete process.env.HEVY_API_KEY;
  h.getAllWorkouts.mockReset();
});

describe("a rejected key stops being invisible", () => {
  it("marks the credential disconnected when Hevy rejects it", async () => {
    h.getAllWorkouts.mockRejectedValue(new HevyAuthError("key invalid"));

    await expect(fetchAllWorkouts("k")).rejects.toBeInstanceOf(HevyAuthError);
    expect(h.writes).toContain("disconnected");
  });

  it("still throws, so the caller's own error handling is unchanged", async () => {
    // Recording the reason must not swallow the failure: the sync still needs
    // to fail, and its result still needs to say so.
    h.getAllWorkouts.mockRejectedValue(new HevyAuthError("key invalid"));
    await expect(fetchAllWorkouts("k")).rejects.toThrow();
  });
});

describe("it clears itself", () => {
  it("marks the credential active again after a successful fetch", async () => {
    // The reason not to disable auto-sync. A key fixed later recovers on its
    // own, with nothing for the user to notice and re-enable.
    h.getAllWorkouts.mockResolvedValue([{ id: "w1" }]);

    await fetchAllWorkouts("k");
    expect(h.writes).toContain("active");
  });
});

describe("it does not make things worse", () => {
  it("leaves an ordinary failure alone", async () => {
    // A network blip or a 500 says nothing about the key. Marking the
    // credential bad there would send the user to regenerate a key that works.
    h.getAllWorkouts.mockRejectedValue(new Error("socket hang up"));

    await expect(fetchAllWorkouts("k")).rejects.toThrow("socket hang up");
    expect(h.writes).toEqual([]);
  });

  it("returns the workouts unchanged on success", async () => {
    h.getAllWorkouts.mockResolvedValue([{ id: "w1" }, { id: "w2" }]);
    const out = await fetchAllWorkouts("k");
    expect(out.map((w) => (w as { id: string }).id)).toEqual(["w1", "w2"]);
  });
});

describe("a key from HEVY_API_KEY has no row to mark", () => {
  it("writes a status-only row when Hevy rejects it", async () => {
    process.env.HEVY_API_KEY = "k";
    h.updateCount = 0;
    h.getAllWorkouts.mockRejectedValue(new HevyAuthError("revoked"));
    await expect(fetchAllWorkouts()).rejects.toBeInstanceOf(HevyAuthError);
    expect(h.inserts).toEqual(["disconnected"]);
  });

  it("writes nothing extra when a row exists", async () => {
    process.env.HEVY_API_KEY = "k";
    h.getAllWorkouts.mockRejectedValue(new HevyAuthError("revoked"));
    await expect(fetchAllWorkouts()).rejects.toBeInstanceOf(HevyAuthError);
    expect(h.inserts).toEqual([]);
  });

  it("writes nothing without an env key", async () => {
    h.updateCount = 0;
    h.getAllWorkouts.mockRejectedValue(new HevyAuthError("revoked"));
    await expect(fetchAllWorkouts()).rejects.toBeInstanceOf(HevyAuthError);
    expect(h.inserts).toEqual([]);
  });
});
