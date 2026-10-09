import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { demoMode } from "@/lib/demo";
import { getHevyClient } from "@/lib/hevy-sync";
import {
  editedWorkoutIds,
  eligibleRows,
  eventsReader,
  oldestSyncedAt,
  type LedgerRow,
} from "@/lib/edited-workouts";

// Reads Hevy and the local ledger at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Hevy pages of 10 events each: at most 100 events, and 10 paced calls. */
const MAX_EVENT_PAGES = 10;

/**
 * GET /api/edited-workouts
 *
 * The synced workouts on the Workouts page that were edited in Hevy after they
 * synced, for the "Edited in Hevy" badge (#701). READ-ONLY: one ledger read
 * and Hevy's workout events, no Garmin call, no write.
 *
 * The page loads this after it renders and shows no badges on any failure, so
 * a failure here is reported in the body with an empty list rather than as an
 * error status. Past the page cap the list is what was found, with
 * `truncated` set: the oldest events are the ones left out, so the cost is a
 * missing badge, never a wrong one. An engine without the events read gives
 * an empty list with `unsupported` set.
 */
export async function GET() {
  // The demo's Hevy credential is a placeholder; asking Hevy could only fail.
  if (demoMode()) return NextResponse.json({ editedIds: [], demo: true });

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB unavailable: ${error}`, editedIds: [] }, { status: 503 });
  }

  try {
    // The rows the Workouts page shows, newest 100.
    const rows = eligibleRows(
      (await sql`
        SELECT hevy_id, hevy_updated_at, synced_at, garmin_activity_id,
               COALESCE(status, 'success') AS status
        FROM synced_workouts
        ORDER BY synced_at DESC
        LIMIT 100
      `) as LedgerRow[],
    );
    const since = oldestSyncedAt(rows);
    if (!since) return NextResponse.json({ editedIds: [], truncated: false });

    const reader = eventsReader(await getHevyClient());
    if (!reader) return NextResponse.json({ editedIds: [], unsupported: true });

    const { events, truncated } = await reader.getWorkoutEventsSince(since, { maxPages: MAX_EVENT_PAGES });
    return NextResponse.json({ editedIds: editedWorkoutIds(rows, events), truncated });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error, editedIds: [] }, { status: 200 });
  }
}
