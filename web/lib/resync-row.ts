/**
 * Resync on a workout row (#701): which rows offer it, what the row says
 * afterwards, and the "Edited in Hevy" badge that points at it.
 */

/**
 * Only a workout this app synced, with the Garmin activity it synced to. A row
 * marked as synced by hand points at whatever activity the user named, and a
 * skipped one at nothing of ours, so neither is ours to rewrite.
 */
export function canResync(row: { kind: string; state: string; garmin_activity_id: string | null }): boolean {
  return row.kind === "terminal" && row.state === "success" && Boolean(row.garmin_activity_id);
}

/**
 * Only `synced` counts as success. The engine is a separately versioned
 * package and can answer with a status this app has not heard of, so anything
 * else is an error that names it rather than a success by omission.
 */
export interface ResyncOutcome {
  kind: "success" | "missing" | "error";
  text: string;
}

export function resyncOutcome(httpOk: boolean, body: { status?: unknown; error?: unknown }): ResyncOutcome {
  const error = typeof body.error === "string" && body.error ? body.error : null;
  if (!httpOk) return { kind: "error", text: error ?? "Resync failed." };
  if (body.status === "synced") return { kind: "success", text: "Resynced from Hevy." };
  if (body.status === "target_missing") {
    return { kind: "missing", text: "This activity is no longer on Garmin, so nothing was changed." };
  }
  return { kind: "error", text: error ?? `Resync did not complete (${String(body.status ?? "no status")}).` };
}

/**
 * The "Edited in Hevy" badge: on a row the edited list names, and only where
 * Resync is offered, since Resync is what the badge asks for.
 */
export function showsEditedBadge(
  row: { kind: string; state: string; garmin_activity_id: string | null; hevy_id: string },
  editedIds: ReadonlySet<string>,
): boolean {
  return editedIds.has(row.hevy_id) && canResync(row);
}

/**
 * The edited list after a resync of `hevyId`: without it when the resync
 * succeeded, since Garmin now has the Hevy version; unchanged otherwise.
 */
export function editedAfterResync(
  editedIds: ReadonlySet<string>,
  hevyId: string,
  outcome: ResyncOutcome,
): ReadonlySet<string> {
  if (outcome.kind !== "success" || !editedIds.has(hevyId)) return editedIds;
  const next = new Set(editedIds);
  next.delete(hevyId);
  return next;
}
