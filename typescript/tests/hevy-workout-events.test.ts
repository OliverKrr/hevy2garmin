import { describe, it, expect, vi } from "vitest";
import { HevyClient, HevyAuthError } from "../src/hevy";

/**
 * Hevy's workout events, newest first: what changed since a moment (#701).
 *
 * The web app reads them to badge synced workouts that were edited in Hevy
 * afterwards. It goes through `get`, like every other read, for the retry, the
 * pacing and the named auth error. A page that fails throws rather than
 * returning what was collected so far: a fragment would look like "nothing
 * else changed", and the badges it drives would quietly go missing.
 */

/** A fetch that answers from a script of responses, recording the URLs asked. */
function scriptedFetch(pages: Array<{ status: number; body?: unknown }>) {
  const urls: string[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string) => {
    urls.push(String(url));
    const p = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return {
      ok: p.status >= 200 && p.status < 300,
      status: p.status,
      json: async () => p.body ?? {},
      text: async () => JSON.stringify(p.body ?? {}),
    };
  });
  return { impl: impl as unknown as typeof fetch, urls };
}

const updated = (id: string, updated_at = "2026-10-07T10:55:55.631Z") => ({
  type: "updated",
  workout: { id, updated_at, created_at: "2026-10-07T09:00:00.000Z", start_time: "2026-10-07T08:00:00Z" },
});
const client = (f: typeof fetch) =>
  new HevyClient("key", undefined, { fetchImpl: f, callDelayMs: 0, retryBackoffMs: 0 });
const SINCE = "2026-10-01T00:00:00.000Z";

describe("getWorkoutEvents reads one page", () => {
  it("asks /workouts/events with the page, the page size and since", async () => {
    const { impl, urls } = scriptedFetch([{ status: 200, body: { events: [updated("a")], page: 2, page_count: 5 } }]);
    const d = await client(impl).getWorkoutEvents(SINCE, 2, 10);

    const url = new URL(urls[0]);
    expect(url.pathname).toBe("/v1/workouts/events");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect(url.searchParams.get("since")).toBe(SINCE);
    expect(d.events?.[0].workout?.id).toBe("a");
    expect(d.page_count).toBe(5);
  });

  it("defaults to the first page of ten, Hevy's maximum", async () => {
    const { impl, urls } = scriptedFetch([{ status: 200, body: { events: [], page_count: 0 } }]);
    await client(impl).getWorkoutEvents(SINCE);
    const url = new URL(urls[0]);
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("pageSize")).toBe("10");
  });

  it("names a bad key, as every other read does", async () => {
    const { impl } = scriptedFetch([{ status: 401 }]);
    await expect(client(impl).getWorkoutEvents(SINCE)).rejects.toBeInstanceOf(HevyAuthError);
  });

  it("retries a 429 and then succeeds", async () => {
    const { impl } = scriptedFetch([{ status: 429 }, { status: 200, body: { events: [updated("a")], page_count: 1 } }]);
    const d = await client(impl).getWorkoutEvents(SINCE);
    expect(d.events).toHaveLength(1);
  });
});

describe("getWorkoutEventsSince walks the pages", () => {
  it("collects every page in order until page_count", async () => {
    const { impl, urls } = scriptedFetch([
      { status: 200, body: { events: [updated("a")], page: 1, page_count: 3 } },
      { status: 200, body: { events: [updated("b")], page: 2, page_count: 3 } },
      { status: 200, body: { events: [updated("c")], page: 3, page_count: 3 } },
    ]);
    const out = await client(impl).getWorkoutEventsSince(SINCE);

    expect(out.events.map((e) => e.workout?.id)).toEqual(["a", "b", "c"]);
    expect(out.truncated).toBe(false);
    expect(urls.every((u) => new URL(u).searchParams.get("since") === SINCE)).toBe(true);
  });

  it("stops on an empty page rather than looping for ever", async () => {
    const { impl } = scriptedFetch([
      { status: 200, body: { events: [updated("a")], page_count: 99 } },
      { status: 200, body: { events: [], page_count: 99 } },
    ]);
    const out = await client(impl).getWorkoutEventsSince(SINCE);
    expect(out.events).toHaveLength(1);
    expect(out.truncated).toBe(false);
  });

  it("stops at maxPages and says it did, when more pages exist", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({
      status: 200,
      body: { events: [updated(String(i))], page_count: 12 },
    }));
    const { impl, urls } = scriptedFetch(pages);
    const out = await client(impl).getWorkoutEventsSince(SINCE, { maxPages: 10 });

    expect(urls).toHaveLength(10);
    expect(out.events).toHaveLength(10);
    expect(out.truncated).toBe(true);
  });

  it("is not truncated when the last page is exactly maxPages", async () => {
    const { impl } = scriptedFetch([
      { status: 200, body: { events: [updated("a")], page_count: 2 } },
      { status: 200, body: { events: [updated("b")], page_count: 2 } },
    ]);
    const out = await client(impl).getWorkoutEventsSince(SINCE, { maxPages: 2 });
    expect(out.events).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });

  it("has no page cap unless one is asked for", async () => {
    const pages = Array.from({ length: 15 }, (_, i) => ({
      status: 200,
      body: { events: [updated(String(i))], page_count: 15 },
    }));
    const { impl } = scriptedFetch(pages);
    const out = await client(impl).getWorkoutEventsSince(SINCE);
    expect(out.events).toHaveLength(15);
    expect(out.truncated).toBe(false);
  });

  it("THROWS when a later page fails, rather than returning a fragment", async () => {
    const { impl } = scriptedFetch([
      { status: 200, body: { events: [updated("a")], page_count: 3 } },
      { status: 404 },
    ]);
    await expect(client(impl).getWorkoutEventsSince(SINCE)).rejects.toThrow(/404/);
  });

  it("passes a deleted event through untouched, for the caller to ignore", async () => {
    const deleted = { type: "deleted", id: "gone", deleted_at: "2026-10-07T11:00:00Z" };
    const { impl } = scriptedFetch([{ status: 200, body: { events: [deleted, updated("a")], page_count: 1 } }]);
    const out = await client(impl).getWorkoutEventsSince(SINCE);
    expect(out.events.map((e) => e.type)).toEqual(["deleted", "updated"]);
  });
});
