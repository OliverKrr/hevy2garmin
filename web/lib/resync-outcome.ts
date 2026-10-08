/**
 * What a workout row says after Resync (#701), from the route's response.
 *
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
