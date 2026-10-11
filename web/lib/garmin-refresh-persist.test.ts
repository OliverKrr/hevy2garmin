import { describe, it, expect, vi, afterEach } from "vitest";
import { GarminClient } from "garmin-auth";
import { persistRefreshes } from "./garmin-upload";
import { garminDelete } from "./garmin-delete";

/**
 * Garmin rotates the DI refresh token on every refresh. A refresh the store does not see leaves
 * it holding a token Garmin has replaced, so every refresh must be saved, including the ones the
 * client makes on a 401 long after GarminAuth's startup check.
 */

const STORED = { di_token: "access-1", di_refresh_token: "refresh-1", di_client_id: "client" };

function clientWithStore() {
  const saved: string[] = [];
  const client = new GarminClient();
  client.loads(JSON.stringify(STORED));
  persistRefreshes(client, { save: async (t) => { saved.push(typeof t === "string" ? t : JSON.stringify(t)); } });
  return { client, saved };
}

/** connectapi answers 401 once, then 200; the refresh grant returns rotated tokens. */
function stubGarmin(refreshStatus = 200) {
  let api = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("diauth.garmin.com")) {
      return refreshStatus === 200
        ? new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2" }), { status: 200 })
        : new Response("", { status: refreshStatus });
    }
    api++;
    return new Response(api === 1 ? "" : "{}", { status: api === 1 ? 401 : 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("persistRefreshes", () => {
  it("saves the rotated tokens when a call deep in a sync refreshes on a 401", async () => {
    const { client, saved } = clientWithStore();
    stubGarmin();
    await client.connectapi("/activitylist-service/activities/search/activities");
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0])).toMatchObject({ di_token: "access-2", di_refresh_token: "refresh-2" });
  });

  it("saves them for the DELETE helper's own refresh too", async () => {
    const { client, saved } = clientWithStore();
    stubGarmin();
    await garminDelete(client, "/activity-service/activity/1");
    expect(JSON.parse(saved[0]).di_refresh_token).toBe("refresh-2");
  });

  it("saves nothing when the refresh fails, so the stored tokens stay as they were", async () => {
    const { client, saved } = clientWithStore();
    stubGarmin(503);
    await expect(client.connectapi("/x")).rejects.toThrow();
    expect(saved).toEqual([]);
  });

  it("fails the call when the save fails, rather than keep a token the store lost", async () => {
    const client = new GarminClient();
    client.loads(JSON.stringify(STORED));
    persistRefreshes(client, { save: async () => { throw new Error("db down"); } });
    stubGarmin();
    await expect(client.connectapi("/x")).rejects.toThrow("db down");
  });

  it("does nothing while no refresh happens", async () => {
    const { client, saved } = clientWithStore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await client.connectapi("/x");
    expect(saved).toEqual([]);
  });
});
