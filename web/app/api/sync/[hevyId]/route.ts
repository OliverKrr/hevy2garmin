import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { syncOneWorkout } from "@/lib/sync-one";
import { getDb } from "@/lib/db";
import { acquireSyncLock, recordSyncRun } from "hevy2garmin";
import { storedGarminActivityId } from "@/lib/pending-store";
import { postgresSyncStore } from "@/lib/sync-store";
import { postgresLockBackend } from "@/lib/sync-lock-store";
import { tallyForLog } from "@/lib/sync-tally";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Reads live Hevy + Postgres (and, on the live path, Garmin) at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/sync/[hevyId]  —  sync ONE specific workout. DRY-RUN BY DEFAULT.
 *
 * Same engine and the same three-layer never-duplicate contract as
 * /api/sync-one, but targets the given Hevy workout instead of the next
 * candidate. A live upload fires only when the request both asks for it
 * (?live=1 / body {live}) AND is authorized (h2g session cookie OR Bearer
 * CRON_SECRET). Anything short of both runs a dry-run.
 *
 * With ?resync=1 / body {resync} it resyncs instead (#701): the current Hevy
 * version is pushed into the Garmin activity this workout's ledger row stored,
 * under the same gate. Nothing is searched for, uploaded or unsynced.
 */

async function isAuthorized(request: Request): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1] === cronSecret) return true;
  }
  if (!authEnabled()) return true;
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value ?? null;
  return verifySession(cookie);
}

/** Whether the request asks for `flag`, as ?flag=1 or a truthy body field. */
function asksFor(request: Request, body: Record<string, unknown>, flag: "live" | "resync"): boolean {
  const q = new URL(request.url).searchParams.get(flag);
  if (q === "1" || q === "true") return true;
  const b = body[flag];
  return b === 1 || b === true || b === "1" || b === "true";
}

/**
 * Resync one synced workout into its stored Garmin activity.
 *
 * It must never unsync. Until the web pin reaches the engine release that has
 * `targetActivityId`, the installed engine ignores the option, finds this
 * synced workout is no candidate and answers `no_candidates` having done
 * nothing. That is turned into an error here rather than passed on as a
 * result, so it can never read as a resync that worked.
 *
 * A live resync takes the sync lock, like the other routes that write to
 * Garmin, so it cannot run alongside a batch working on the same activities.
 */
async function resync(sql: ReturnType<typeof getDb>, hevyId: string, dryRun: boolean) {
  const stored = await storedGarminActivityId(hevyId, sql);
  const activityId = Number(stored);
  if (!stored || !Number.isSafeInteger(activityId) || activityId <= 0) {
    return NextResponse.json(
      { error: "This workout has no stored Garmin activity to resync into." },
      { status: 404 },
    );
  }

  const lock = dryRun ? null : await acquireSyncLock({ backend: postgresLockBackend(sql), key: "sync" });
  if (!dryRun && !lock) {
    return NextResponse.json(
      { error: "A sync is already running. Wait for it to finish, or try again in a few minutes." },
      { status: 409 },
    );
  }

  try {
    const result = await syncOneWorkout(sql, { dryRun, targetHevyId: hevyId, targetActivityId: activityId });
    if (result.status === "none" || result.dedupDecision === "no_candidates") {
      return NextResponse.json(
        { error: "This engine version does not support resync yet. Nothing was changed." },
        { status: 501 },
      );
    }
    if (!dryRun) {
      try {
        const tally = tallyForLog((result as { status?: unknown }).status);
        if (tally) await recordSyncRun(postgresSyncStore(sql), tally, "manual (resync)");
      } catch (logErr) {
        console.error("sync_log write failed:", logErr);
      }
    }
    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 500 });
  } finally {
    await lock?.release();
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ hevyId: string }> },
) {
  const { hevyId } = await params;
  if (!hevyId) {
    return NextResponse.json({ error: "hevyId is required." }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const requestedLive = asksFor(request, body, "live");
  const authorized = requestedLive ? await isAuthorized(request) : false;
  const dryRun = !(requestedLive && authorized);

  if (requestedLive && !authorized) {
    return NextResponse.json(
      { error: "Unauthorized: a live upload requires a session or CRON_SECRET." },
      { status: 401 },
    );
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB unavailable: ${error}` }, { status: 503 });
  }

  if (asksFor(request, body, "resync")) return resync(sql, hevyId, dryRun);

  try {
    const result = await syncOneWorkout(sql, { dryRun, targetHevyId: hevyId });
    if (!dryRun) {
      // Same reason as /api/sync-one: the Workouts page's per-workout button is
      // a manual sync and has to leave a trace. Recorded here rather than in
      // candidates-list.tsx, because a component can forget and a route cannot.
      try {
        const tally = tallyForLog((result as { status?: unknown }).status);
        if (tally) await recordSyncRun(postgresSyncStore(sql), tally, "manual (one)");
      } catch (logErr) {
        console.error("sync_log write failed:", logErr);
      }
    }
    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 500 });
  }
}
