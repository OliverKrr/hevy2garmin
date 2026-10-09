/**
 * Which synced workouts were edited in Hevy after they synced (#701), from
 * the ledger rows and Hevy's workout events.
 *
 * Built to fail towards no badge. A wrong badge sends the user to Resync a
 * workout that has not changed, while a missing one only leaves things as they
 * were before the badge existed.
 */
import { toUtcDate } from "hevy2garmin";
import { canResync } from "./resync-row";

/** A `synced_workouts` row, as the Workouts page reads it. */
export interface LedgerRow {
  hevy_id: string;
  hevy_updated_at: string | null;
  synced_at: Date | string | null;
  garmin_activity_id: string | null;
  status: string;
}

/** One Hevy workout event, as much of it as is read here. */
export interface WorkoutEvent {
  type: string;
  workout?: { id?: string; updated_at?: string };
}

/**
 * The events read, declared here as well because the pinned engine predates
 * it. Such an engine has no `getWorkoutEventsSince`, so the route asks
 * `eventsReader` first and shows no badges without it. Drop this declaration
 * once the pin reaches the release that has the method.
 */
export interface WorkoutEventsReader {
  getWorkoutEventsSince(
    since: string,
    options?: { maxPages?: number },
  ): Promise<{ events: WorkoutEvent[]; truncated: boolean }>;
}

/** The client as an events reader, or null when its engine has no such read. */
export function eventsReader(client: object): WorkoutEventsReader | null {
  return typeof (client as Partial<WorkoutEventsReader>).getWorkoutEventsSince === "function"
    ? (client as WorkoutEventsReader)
    : null;
}

/**
 * A timestamp as whole seconds since the epoch, or null.
 *
 * Read through the engine's `toUtcDate`, which takes a string with no zone as
 * UTC rather than as the server's local time. Postgres's own text form,
 * `2026-09-20 12:00:00+00`, is beyond it, and carries its zone, so a string
 * with an explicit zone falls back to `Date`. Whole seconds, because the same
 * instant is stored with and without its milliseconds depending on what wrote
 * it, and comparing milliseconds would badge an unchanged workout whenever the
 * stored copy had lost them. Only an edit within the same second as the synced
 * version goes unseen.
 */
function epochSeconds(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const d =
    value instanceof Date
      ? value
      : toUtcDate(value) ?? (/(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(value) ? new Date(value) : null);
  const ms = d?.getTime();
  return ms == null || Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * The rows that can carry the badge: the ones that offer Resync, with the
 * Hevy version they synced recorded. A row without it, older or marked as
 * synced by hand, has nothing to compare against.
 */
export function eligibleRows(rows: LedgerRow[]): LedgerRow[] {
  return rows.filter(
    (r) =>
      canResync({ kind: "terminal", state: r.status, garmin_activity_id: r.garmin_activity_id }) &&
      epochSeconds(r.hevy_updated_at) != null,
  );
}

/** The earliest `synced_at` among the rows, as an ISO string, or null. */
export function oldestSyncedAt(rows: LedgerRow[]): string | null {
  const times = rows.map((r) => epochSeconds(r.synced_at)).filter((t): t is number => t != null);
  return times.length ? new Date(Math.min(...times) * 1000).toISOString() : null;
}

/**
 * The ids of the rows whose newest `updated` event is later than the version
 * they synced. Other event types, `deleted` among them, are ignored.
 */
export function editedWorkoutIds(rows: LedgerRow[], events: WorkoutEvent[]): string[] {
  const newest = new Map<string, number>();
  for (const e of events) {
    const id = e.workout?.id;
    const at = epochSeconds(e.workout?.updated_at);
    if (e.type !== "updated" || !id || at == null) continue;
    newest.set(id, Math.max(at, newest.get(id) ?? at));
  }
  return rows
    .filter((r) => {
      const edited = newest.get(r.hevy_id);
      const synced = epochSeconds(r.hevy_updated_at);
      return edited != null && synced != null && edited > synced;
    })
    .map((r) => r.hevy_id);
}
