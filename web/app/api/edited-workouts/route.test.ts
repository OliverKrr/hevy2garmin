import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/edited-workouts — the synced workouts Hevy says were edited after
 * they synced (#701). Read-only, and it never fails the page: when Hevy is
 * slow, down or unreachable through this engine, the answer is no badges.
 * A missing badge is acceptable; a wrong one is not.
 */

interface Row {
  hevy_id: string;
  hevy_updated_at: string | null;
  synced_at: Date | string | null;
  garmin_activity_id: string | null;
  status: string;
}
let rows: Row[] = [];
const queries: string[] = [];
const sql = vi.fn((strings: TemplateStringsArray) => {
  queries.push(strings.join("?"));
  return Promise.resolve(rows);
});
vi.mock("@/lib/db", () => ({ getDb: () => sql }));

const demo = { on: false };
vi.mock("@/lib/demo", () => ({ demoMode: () => demo.on }));

const getWorkoutEventsSince = vi.fn();
let client: Record<string, unknown> = {};
const getHevyClient = vi.fn(async () => client);
vi.mock("@/lib/hevy-sync", () => ({ getHevyClient: () => getHevyClient() }));

import { GET } from "./route";

const row = (over: Partial<Row> = {}): Row => ({
  hevy_id: "w1",
  hevy_updated_at: "2026-10-01T10:00:00.000Z",
  synced_at: new Date("2026-10-01T10:05:00.000Z"),
  garmin_activity_id: "4242",
  status: "success",
  ...over,
});
const updated = (id: string, updated_at: string) => ({ type: "updated", workout: { id, updated_at } });
const events = (list: unknown[], truncated = false) => getWorkoutEventsSince.mockResolvedValue({ events: list, truncated });

async function get() {
  const res = await GET();
  return { status: res.status, body: (await res.json()) as { editedIds: string[]; truncated?: boolean; unsupported?: boolean; error?: string; demo?: boolean } };
}

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  demo.on = false;
  rows = [row()];
  client = { getWorkoutEventsSince };
  events([]);
});

describe("GET /api/edited-workouts", () => {
  it("lists a workout whose Hevy event is later than the stored updated_at", async () => {
    events([updated("w1", "2026-10-03T08:00:00.000Z")]);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.editedIds).toEqual(["w1"]);
    expect(body.truncated).toBe(false);
  });

  it("asks Hevy for events since the oldest synced_at among the eligible rows, capped at 10 pages", async () => {
    rows = [
      row({ hevy_id: "new", synced_at: new Date("2026-10-05T00:00:00Z") }),
      row({ hevy_id: "old", synced_at: new Date("2026-09-20T12:00:00Z") }),
      // Not eligible, so its older sync must not widen the window.
      row({ hevy_id: "manual", status: "manual", synced_at: new Date("2026-01-01T00:00:00Z") }),
    ];
    await get();
    expect(getWorkoutEventsSince).toHaveBeenCalledWith("2026-09-20T12:00:00.000Z", { maxPages: 10 });
  });

  it("reads synced_at given as a string as well as a Date", async () => {
    rows = [row({ synced_at: "2026-09-20 12:00:00+00" })];
    await get();
    expect(getWorkoutEventsSince).toHaveBeenCalledWith("2026-09-20T12:00:00.000Z", { maxPages: 10 });
  });

  it("no badge when the event is the version that synced", async () => {
    events([updated("w1", "2026-10-01T10:00:00.000Z")]);
    expect((await get()).body.editedIds).toEqual([]);
  });

  it("no badge for the same moment written in another format", async () => {
    // Stored by the engine as Hevy sent it at the time, or by the Python
    // pipeline as +00:00, with or without milliseconds. All the same instant.
    rows = [
      row({ hevy_id: "z", hevy_updated_at: "2026-10-01T10:00:00.631000+00:00" }),
      row({ hevy_id: "s", hevy_updated_at: "2026-10-01T10:00:00+00:00" }),
      row({ hevy_id: "n", hevy_updated_at: "2026-10-01T10:00:00.631" }),
    ];
    events([
      updated("z", "2026-10-01T10:00:00.631Z"),
      updated("s", "2026-10-01T10:00:00.631Z"),
      updated("n", "2026-10-01T10:00:00.631Z"),
    ]);
    expect((await get()).body.editedIds).toEqual([]);
  });

  it("no badge for an event older than the stored version", async () => {
    events([updated("w1", "2026-09-30T10:00:00.000Z")]);
    expect((await get()).body.editedIds).toEqual([]);
  });

  it("judges a workout by its newest event", async () => {
    events([updated("w1", "2026-10-04T10:00:00.000Z"), updated("w1", "2026-09-30T10:00:00.000Z")]);
    expect((await get()).body.editedIds).toEqual(["w1"]);
  });

  it("no badge without a stored hevy_updated_at", async () => {
    rows = [row({ hevy_updated_at: null })];
    events([updated("w1", "2026-10-03T08:00:00.000Z")]);
    const { body } = await get();
    expect(body.editedIds).toEqual([]);
    expect(getWorkoutEventsSince).not.toHaveBeenCalled();
  });

  it("no badge on rows that are not success, or have no Garmin activity", async () => {
    rows = [
      row({ hevy_id: "m", status: "manual" }),
      row({ hevy_id: "k", status: "skipped" }),
      row({ hevy_id: "g", garmin_activity_id: null }),
    ];
    events([updated("m", "2026-10-03T08:00:00Z"), updated("k", "2026-10-03T08:00:00Z"), updated("g", "2026-10-03T08:00:00Z")]);
    const { body } = await get();
    expect(body.editedIds).toEqual([]);
    expect(getWorkoutEventsSince).not.toHaveBeenCalled();
  });

  it("ignores deleted events and events for workouts it does not show", async () => {
    events([
      { type: "deleted", id: "w1", deleted_at: "2026-10-03T08:00:00Z" },
      updated("someone-else", "2026-10-03T08:00:00Z"),
    ]);
    expect((await get()).body.editedIds).toEqual([]);
  });

  it("past the page cap, returns what it found and says so", async () => {
    events([updated("w1", "2026-10-03T08:00:00.000Z")], true);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.editedIds).toEqual(["w1"]);
    expect(body.truncated).toBe(true);
  });

  it("Hevy failing → an empty list with the reason, not a 500", async () => {
    getWorkoutEventsSince.mockRejectedValue(new Error("Hevy GET /workouts/events → 503"));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.editedIds).toEqual([]);
    expect(body.error).toMatch(/503/);
  });

  it("no Hevy key → an empty list, not a 500", async () => {
    getHevyClient.mockRejectedValueOnce(new Error("No Hevy API key available"));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.editedIds).toEqual([]);
  });

  it("an engine without the events read → an empty list with a flag", async () => {
    client = { getWorkout: vi.fn() };
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.editedIds).toEqual([]);
    expect(body.unsupported).toBe(true);
  });

  it("the demo asks Hevy nothing", async () => {
    demo.on = true;
    const { body } = await get();
    expect(body).toEqual({ editedIds: [], demo: true });
    expect(sql).not.toHaveBeenCalled();
    expect(getWorkoutEventsSince).not.toHaveBeenCalled();
  });

  it("only reads the ledger", async () => {
    events([updated("w1", "2026-10-03T08:00:00.000Z")]);
    await get();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^\s*SELECT/);
  });
});
