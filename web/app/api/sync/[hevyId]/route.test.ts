import { describe, it, expect, vi, beforeEach } from "vitest";

/** Gating + targetHevyId passthrough for POST /api/sync/[hevyId]. */

const syncOneWorkout = vi.fn();
vi.mock("@/lib/sync-one", () => ({ syncOneWorkout: (...a: unknown[]) => syncOneWorkout(...a) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const authEnabled = vi.fn();
const verifySession = vi.fn();
vi.mock("@/lib/auth", () => ({
  authEnabled: (...a: unknown[]) => authEnabled(...a),
  verifySession: (...a: unknown[]) => verifySession(...a),
  SESSION_COOKIE: "h2g_session",
}));
const cookieGet = vi.fn();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (...a: unknown[]) => cookieGet(...a) }) }));

const storedGarminActivityId = vi.fn();
const unsync = vi.fn();
vi.mock("@/lib/pending-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pending-store")>()),
  storedGarminActivityId: (...a: unknown[]) => storedGarminActivityId(...a),
  unsync: (...a: unknown[]) => unsync(...a),
}));

const release = vi.fn(async () => {});
const acquireSyncLock = vi.fn();
const recordSyncRun = vi.fn();
vi.mock("hevy2garmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("hevy2garmin")>()),
  acquireSyncLock: (...a: unknown[]) => acquireSyncLock(...a),
  recordSyncRun: (...a: unknown[]) => recordSyncRun(...a),
}));
vi.mock("@/lib/sync-lock-store", () => ({ postgresLockBackend: () => ({}) }));

const getWorkout = vi.fn();
vi.mock("@/lib/hevy-sync", () => ({ getHevyClient: async () => ({ getWorkout }) }));
const OLD_WORKOUT = { id: "w9", title: "Before the sync start date", start_time: "2024-01-01T10:00:00Z" };

import { POST } from "./route";

const params = (id: string) => ({ params: Promise.resolve({ hevyId: id }) });
function req(url: string, body: unknown = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  authEnabled.mockReturnValue(true);
  verifySession.mockReturnValue(false);
  cookieGet.mockReturnValue(undefined);
  syncOneWorkout.mockResolvedValue({ status: "dry_run", dryRun: true, dedupDecision: "would_upload" });
  storedGarminActivityId.mockResolvedValue("4242");
  getWorkout.mockResolvedValue(OLD_WORKOUT);
  acquireSyncLock.mockResolvedValue({ key: "sync", token: "t", release });
});

describe("POST /api/sync/[hevyId]", () => {
  it("no live → dry-run for the TARGET workout", async () => {
    const res = await POST(req("http://h/api/sync/w9", {}), params("w9"));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), {
      dryRun: true,
      targetHevyId: "w9",
    });
  });

  it("live but unauthorized → 401, engine not called", async () => {
    const res = await POST(req("http://h/api/sync/w9", { live: 1 }), params("w9"));
    expect(res.status).toBe(401);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("live + session → live sync of the target", async () => {
    cookieGet.mockReturnValue({ value: "c" });
    verifySession.mockReturnValue(true);
    syncOneWorkout.mockResolvedValue({ status: "synced", dryRun: false, garminActivityId: 5 });
    const res = await POST(req("http://h/api/sync/w9?live=1", {}), params("w9"));
    expect(res.status).toBe(200);
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), {
      dryRun: false,
      targetHevyId: "w9",
    });
  });

  it("invalid JSON → 400", async () => {
    const bad = new Request("http://h/api/sync/w9", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{no",
    });
    const res = await POST(bad, params("w9"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/sync/[hevyId] with resync", () => {
  const live = () => {
    cookieGet.mockReturnValue({ value: "c" });
    verifySession.mockReturnValue(true);
  };
  const resync = (url = "http://h/api/sync/w9?live=1") => POST(req(url, { resync: true }), params("w9"));
  /** The options the engine was last called with. */
  const engineOptions = () => syncOneWorkout.mock.calls.at(-1)![1] as Record<string, unknown> & {
    fetchWorkouts: () => Promise<unknown[]>;
  };

  it("no live → a dry-run resync into the stored activity, without the lock", async () => {
    syncOneWorkout.mockResolvedValue({ status: "dry_run", dryRun: true, dedupDecision: "stored_activity" });
    const res = await POST(req("http://h/api/sync/w9", { resync: true }), params("w9"));
    expect(res.status).toBe(200);
    expect(storedGarminActivityId).toHaveBeenCalledWith("w9", expect.anything());
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), {
      dryRun: true,
      targetHevyId: "w9",
      targetActivityId: 4242,
      fetchWorkouts: expect.any(Function),
    });
    expect(acquireSyncLock).not.toHaveBeenCalled();
    expect(recordSyncRun).not.toHaveBeenCalled();
  });

  it("?resync=1 asks for it too", async () => {
    syncOneWorkout.mockResolvedValue({ status: "dry_run", dryRun: true, dedupDecision: "stored_activity" });
    await POST(req("http://h/api/sync/w9?resync=1", {}), params("w9"));
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ targetActivityId: 4242 }));
  });

  it("live + session → resyncs under the sync lock and logs the run", async () => {
    live();
    syncOneWorkout.mockResolvedValue({ status: "synced", dryRun: false, dedupDecision: "stored_activity", garminActivityId: 4242 });
    const res = await resync();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("synced");
    expect(syncOneWorkout).toHaveBeenCalledWith(expect.anything(), {
      dryRun: false,
      targetHevyId: "w9",
      targetActivityId: 4242,
      fetchWorkouts: expect.any(Function),
    });
    expect(acquireSyncLock).toHaveBeenCalledWith(expect.objectContaining({ key: "sync" }));
    expect(release).toHaveBeenCalledOnce();
    expect(recordSyncRun).toHaveBeenCalledWith(expect.anything(), { synced: 1, skipped: 0, failed: 0 }, "manual (resync)");
  });

  it("live but unauthorized → 401 before anything is read", async () => {
    const res = await resync();
    expect(res.status).toBe(401);
    expect(storedGarminActivityId).not.toHaveBeenCalled();
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("an engine that ignores the option answers no_candidates → an error, never a success", async () => {
    // The pinned engine predates resync: it drops targetActivityId, finds the
    // synced workout is no candidate and does nothing. That must not read as
    // a resync that worked.
    live();
    syncOneWorkout.mockResolvedValue({ status: "none", dryRun: false, dedupDecision: "no_candidates" });
    const res = await resync();
    expect(res.status).toBe(501);
    expect((await res.json()).error).toMatch(/does not support resync yet/);
    expect(recordSyncRun).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(unsync).not.toHaveBeenCalled();
  });

  it("the stored activity is gone → 200 with target_missing, for the row to show", async () => {
    live();
    syncOneWorkout.mockResolvedValue({ status: "target_missing", dryRun: false, dedupDecision: "stored_activity" });
    const res = await resync();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("target_missing");
  });

  it("never unsyncs, whatever the engine answers", async () => {
    live();
    for (const status of ["synced", "target_missing", "error", "skipped", "none"]) {
      syncOneWorkout.mockResolvedValue({ status, dryRun: false, dedupDecision: status === "none" ? "no_candidates" : "stored_activity" });
      await resync();
    }
    syncOneWorkout.mockRejectedValue(new Error("boom"));
    await resync();
    expect(unsync).not.toHaveBeenCalled();
  });

  it("hands the engine the one workout fetched from Hevy, whatever its date", async () => {
    // Fetched by id rather than from the list, which the sync start date cuts
    // short: a workout synced before that date was set must still resync.
    live();
    syncOneWorkout.mockResolvedValue({ status: "synced", dryRun: false, dedupDecision: "stored_activity" });
    await resync();
    expect(getWorkout).toHaveBeenCalledWith("w9");
    expect(await engineOptions().fetchWorkouts()).toEqual([OLD_WORKOUT]);
  });

  it("a workout Hevy does not have → 404 saying so, engine not called", async () => {
    live();
    getWorkout.mockResolvedValue(null);
    const res = await resync();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Workout not found on Hevy.");
    expect(syncOneWorkout).not.toHaveBeenCalled();
    expect(acquireSyncLock).not.toHaveBeenCalled();
  });

  it("no Hevy key → 500 with the reason, engine not called", async () => {
    live();
    getWorkout.mockRejectedValue(new Error("No Hevy API key available"));
    const res = await resync();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/No Hevy API key/);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("no stored Garmin activity → 404, engine not called", async () => {
    live();
    storedGarminActivityId.mockResolvedValue(null);
    const res = await resync();
    expect(res.status).toBe(404);
    expect(syncOneWorkout).not.toHaveBeenCalled();
    expect(acquireSyncLock).not.toHaveBeenCalled();
  });

  it("a stored id that is not a number → 404, engine not called", async () => {
    live();
    storedGarminActivityId.mockResolvedValue("abc");
    const res = await resync();
    expect(res.status).toBe(404);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("another sync holds the lock → 409, engine not called", async () => {
    live();
    acquireSyncLock.mockResolvedValue(null);
    const res = await resync();
    expect(res.status).toBe(409);
    expect(syncOneWorkout).not.toHaveBeenCalled();
  });

  it("the engine throws → 500 and the lock is released", async () => {
    live();
    syncOneWorkout.mockRejectedValue(new Error("Garmin down"));
    const res = await resync();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Garmin down");
    expect(release).toHaveBeenCalledOnce();
  });
});
