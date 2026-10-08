import { describe, it, expect, vi } from "vitest";
import { getActivity } from "../src/garmin";
import type { GarminClient } from "garmin-auth";

/**
 * One activity by id, the read a resync starts from (#701).
 *
 * A 404 has to come back as null rather than an error. It is the answer to
 * "is the activity this workout was synced to still there", and a resync that
 * gets "no" must stop and say so, not report a generic failure.
 */

function client() {
  return {
    domain: "garmin.com",
    di_token: "t",
    refreshDiToken: vi.fn(async () => {}),
  } as unknown as GarminClient & { refreshDiToken: ReturnType<typeof vi.fn> };
}

function respond(...responses: Array<{ status: number; body?: unknown }>) {
  const queue = [...responses];
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = queue.shift()!;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ""),
    };
  });
}

async function withFetch<T>(mock: unknown, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const DETAIL = {
  activityId: 4242,
  activityName: "Push Day",
  activityTypeDTO: { typeKey: "strength_training" },
  metadataDTO: { manufacturer: "GARMIN" },
  summaryDTO: {
    startTimeGMT: "2026-08-01T10:02:00.0",
    startTimeLocal: "2026-08-01T13:02:00.0",
    duration: 3540.5,
  },
};

describe("getActivity", () => {
  it("reads the activity from the activity-service URL", async () => {
    const fetchMock = respond({ status: 200, body: DETAIL });
    await withFetch(fetchMock, () => getActivity(client(), 4242));
    expect(fetchMock.mock.calls[0][0]).toBe("https://connectapi.garmin.com/activity-service/activity/4242");
    expect(fetchMock.mock.calls[0][1]?.method ?? "GET").toBe("GET");
  });

  it("maps the detail into the shape a merge reads", async () => {
    const act = await withFetch(respond({ status: 200, body: DETAIL }), () => getActivity(client(), 4242));
    expect(act).toEqual({
      activityId: 4242,
      activityName: "Push Day",
      activityType: { typeKey: "strength_training" },
      manufacturer: "GARMIN",
      startTimeGMT: "2026-08-01T10:02:00.0",
      startTimeLocal: "2026-08-01T13:02:00.0",
      duration: 3540.5,
    });
  });

  it("reports our own upload as DEVELOPMENT", async () => {
    const body = { ...DETAIL, metadataDTO: { manufacturer: "DEVELOPMENT" } };
    const act = await withFetch(respond({ status: 200, body }), () => getActivity(client(), 4242));
    expect(act?.manufacturer).toBe("DEVELOPMENT");
  });

  it("returns null when Garmin answers 404", async () => {
    const act = await withFetch(respond({ status: 404 }), () => getActivity(client(), 4242));
    expect(act).toBeNull();
  });

  it("throws on any other failure, which says nothing about whether it exists", async () => {
    await expect(withFetch(respond({ status: 500 }), () => getActivity(client(), 4242))).rejects.toThrow(/500/);
  });

  it("refreshes the token once on 401 and retries", async () => {
    const c = client();
    const fetchMock = respond({ status: 401 }, { status: 200, body: DETAIL });
    const act = await withFetch(fetchMock, () => getActivity(c, 4242));
    expect(c.refreshDiToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(act?.activityId).toBe(4242);
  });
});
