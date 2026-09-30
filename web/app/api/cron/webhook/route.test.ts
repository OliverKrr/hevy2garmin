import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const syncOneWorkout = vi.fn();
vi.mock("@/lib/sync-one", () => ({ syncOneWorkout: (...a: unknown[]) => syncOneWorkout(...a) }));
const db = { getDb: vi.fn((): unknown => ({})) };
vi.mock("@/lib/db", () => ({ getDb: () => db.getDb() }));

const lock = {
  acquire: vi.fn(async (): Promise<{ release: () => Promise<void> } | null> => ({ release: lock.release })),
  release: vi.fn(async () => {}),
};
vi.mock("hevy2garmin", async (orig) => ({
  ...(await orig<typeof import("hevy2garmin")>()),
  acquireSyncLock: () => lock.acquire(),
}));

// The runner is tested on its own; here the route only has to start it with
// the right attempt, so the start is captured instead of run.
const staged = {
  start: vi.fn((..._a: unknown[]): { accepted: true } | { accepted: false; inFlight: number } => ({ accepted: true })),
};
vi.mock("@/lib/webhook-retry", async (orig) => ({
  ...(await orig<typeof import("@/lib/webhook-retry")>()),
  startStagedSync: (...a: unknown[]) => staged.start(...a),
}));

import { POST } from "./route";

type Attempt = (o: { mergeOnly: boolean; targetHevyId?: string }) => Promise<unknown>;

function req(headers: Record<string, string> = {}, body?: string): Request {
  return new Request("http://h/api/cron/webhook", { method: "POST", headers, body });
}

/** The attempt function the route handed to the runner. */
function capturedAttempt(): Attempt {
  const deps = staged.start.mock.calls[0][1] as { attempt: Attempt };
  return deps.attempt;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  delete process.env.GITHUB_PAT;
  delete process.env.GITHUB_REPO;
  delete process.env.VERCEL;
  delete process.env.WEBHOOK_DELAY_SECONDS;
  db.getDb.mockImplementation(() => ({}));
  lock.acquire.mockImplementation(async () => ({ release: lock.release }));
  staged.start.mockImplementation(() => ({ accepted: true }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/cron/webhook: auth", () => {
  it("CRON_SECRET unset → 503 (can't authenticate a webhook)", async () => {
    const res = await POST(req({ authorization: "Bearer x" }));
    expect(res.status).toBe(503);
    expect(syncOneWorkout).not.toHaveBeenCalled();
    expect(staged.start).not.toHaveBeenCalled();
  });

  it("CRON_SECRET empty → 503, not a match for an empty token", async () => {
    process.env.CRON_SECRET = "";
    const res = await POST(req({ authorization: "Bearer " }));
    expect(res.status).toBe(503);
  });

  it.each([
    ["wrong token", "Bearer nope"],
    ["a prefix of the secret", "Bearer s3cre"],
    ["the secret plus more", "Bearer s3cretX"],
    ["no scheme", "s3cret"],
    ["no header", ""],
  ])("%s → 401, and nothing starts", async (_name, header) => {
    process.env.CRON_SECRET = "s3cret";
    const res = await POST(req(header ? { authorization: header } : {}));
    expect(res.status).toBe(401);
    expect(syncOneWorkout).not.toHaveBeenCalled();
    expect(staged.start).not.toHaveBeenCalled();
  });
});

describe("POST /api/cron/webhook: dispatch and Vercel, unchanged", () => {
  it("correct Bearer + GITHUB_PAT/REPO → dispatches", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.GITHUB_PAT = "pat";
    process.env.GITHUB_REPO = "drkostas/hevy2garmin";
    vi.stubGlobal("fetch", vi.fn(async (..._a: unknown[]) => new Response(null, { status: 204 })));
    const res = await POST(req({ authorization: "Bearer s3cret" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe("dispatch");
    expect(syncOneWorkout).not.toHaveBeenCalled();
    expect(staged.start).not.toHaveBeenCalled();
  });

  it("on Vercel, no PAT → one inline sync that waits out the grace period", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.VERCEL = "1";
    syncOneWorkout.mockResolvedValue({ status: "synced" });
    const res = await POST(req({ authorization: "Bearer s3cret" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe("inline");
    // Unattended, so it waits out the grace period rather than beating the
    // watch's own activity to Garmin.
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), { dryRun: false, respectGrace: true });
    expect(staged.start).not.toHaveBeenCalled();
  });

  it("DB unavailable → 503 before anything is staged", async () => {
    process.env.CRON_SECRET = "s3cret";
    db.getDb.mockImplementation(() => {
      throw new Error("no url");
    });
    const res = await POST(req({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(503);
    expect(staged.start).not.toHaveBeenCalled();
  });
});

describe("POST /api/cron/webhook: self-hosted staged sync", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret";
  });

  it("answers at once and syncs nothing inside the request", async () => {
    const request = req({ authorization: "Bearer s3cret" }, JSON.stringify({ workoutId: "x" }));
    const res = await POST(request);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, mode: "staged", status: "accepted", delaySeconds: 300, maxAttempts: 3 });
    expect(staged.start).toHaveBeenCalledOnce();
    expect(syncOneWorkout).not.toHaveBeenCalled();
    // The body is not an input: nothing in it can steer the sync.
    expect(request.bodyUsed).toBe(false);
  });

  it("passes the parsed config to the runner", async () => {
    process.env.WEBHOOK_DELAY_SECONDS = "30";
    await POST(req({ authorization: "Bearer s3cret" }));
    expect(staged.start.mock.calls[0][0]).toMatchObject({ delaySeconds: 30, maxAttempts: 3 });
  });

  it("an early attempt is merge-only, and keeps the grace flag for an engine without merge-only", async () => {
    await POST(req({ authorization: "Bearer s3cret" }));
    syncOneWorkout.mockResolvedValue({ status: "merge_pending" });
    const out = await capturedAttempt()({ mergeOnly: true });
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), {
      dryRun: false,
      respectGrace: true,
      mergeOnly: true,
    });
    expect(out).toEqual({ busy: false, result: { status: "merge_pending" } });
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("the last attempt may upload and targets the workout the earlier ones waited on", async () => {
    await POST(req({ authorization: "Bearer s3cret" }));
    syncOneWorkout.mockResolvedValue({ status: "synced" });
    await capturedAttempt()({ mergeOnly: false, targetHevyId: "w7" });
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), {
      dryRun: false,
      respectGrace: false,
      mergeOnly: false,
      targetHevyId: "w7",
    });
  });

  it("reports busy without syncing when the scheduled sync holds the lock", async () => {
    await POST(req({ authorization: "Bearer s3cret" }));
    lock.acquire.mockResolvedValue(null);
    expect(await capturedAttempt()({ mergeOnly: true })).toEqual({ busy: true });
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("releases the lock when the sync throws, and lets the error reach the runner", async () => {
    await POST(req({ authorization: "Bearer s3cret" }));
    syncOneWorkout.mockRejectedValue(new Error("Garmin 500"));
    await expect(capturedAttempt()({ mergeOnly: true })).rejects.toThrow("Garmin 500");
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("a failed lock release does not turn a finished sync into a retry", async () => {
    await POST(req({ authorization: "Bearer s3cret" }));
    syncOneWorkout.mockResolvedValue({ status: "synced" });
    lock.release.mockRejectedValueOnce(new Error("db gone"));
    expect(await capturedAttempt()({ mergeOnly: true })).toEqual({ busy: false, result: { status: "synced" } });
  });

  it("past the in-flight cap it still answers 200, so Hevy does not retry", async () => {
    staged.start.mockImplementation(() => ({ accepted: false, inFlight: 4 }));
    const res = await POST(req({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "staged", status: "throttled", inFlight: 4 });
  });
});
