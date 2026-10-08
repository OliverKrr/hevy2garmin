/**
 * Garmin upload — TS port of hevy2garmin garmin.py (upload_fit, rename, set_description, delete).
 * Uses garmin-auth's GarminClient for DI auth. Upload endpoint proven in Phase-0 ST2.
 */
import { GarminClient, NATIVE_API_USER_AGENT, NATIVE_X_GARMIN_USER_AGENT } from "garmin-auth";
import { toUtcDate } from "./match";

function nativeHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "User-Agent": NATIVE_API_USER_AGENT,
    "X-Garmin-User-Agent": NATIVE_X_GARMIN_USER_AGENT,
    "X-Garmin-Paired-App-Version": "10861",
    "X-Garmin-Client-Platform": "Android",
    "X-App-Ver": "10861",
    "Authorization": `Bearer ${token}`,
    ...extra,
  };
}

function sanitizeActivityId(v: unknown): number | null {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/['"]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

export interface UploadResult { uploadId: number | null; activityId: number | null; }

/**
 * Garmin definitively refused an import without accepting an activity.
 *
 * Kept distinct from every other upload error because the two demand opposite
 * handling. Any other failure means the FIT may have reached Garmin, so the
 * workout is parked and reconciliation goes looking. This one means there is
 * nothing on the other side to find, so waiting never helps and the workout
 * needs a person. Mirrors `GarminUploadRejected` in `garmin.py:23`.
 */
export class GarminUploadRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GarminUploadRejected";
  }
}

/** Upload a FIT (bytes) to Garmin; resolve the activity id (by start time if needed). */
export async function uploadFit(
  client: GarminClient,
  fit: Uint8Array,
  workoutStart?: string,
  excludeActivityIds?: Array<number | string> | null,
): Promise<UploadResult> {
  const url = `https://connectapi.${client.domain}/upload-service/upload/.fit`;
  const fd = new FormData();
  fd.append("file", new Blob([fit as unknown as BlobPart], { type: "application/octet-stream" }), "workout.fit");

  const doPost = () => fetch(url, { method: "POST", headers: nativeHeaders(client.di_token!, { NK: "NT" }), body: fd });
  let res = await doPost();
  if (res.status === 401) { await client.refreshDiToken(); res = await doPost(); }
  // 200/201/202 are all accepted (202 = async, per ST2)
  if (![200, 201, 202].includes(res.status)) {
    throw new Error(`Garmin upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  let uploadId: number | null = null;
  let activityId: number | null = null;
  let rejection: string | null = null;
  try {
    const j = (await res.json()) as {
      detailedImportResult?: {
        uploadId?: number;
        successes?: Array<{ internalId?: unknown }>;
        failures?: unknown[];
      };
    };
    const d = j.detailedImportResult ?? {};
    uploadId = d.uploadId ?? null;
    if (d.successes?.length) activityId = sanitizeActivityId(d.successes[0].internalId);
    // A refusal arrives as HTTP 200 with failures in the body, so this cannot be
    // read off the status code. Failures alongside an accepted activity are a
    // partial complaint, not a rejection, which is why all three conditions have
    // to hold. Mirrors `garmin.py:145-148`.
    if (d.failures?.length && !activityId && !d.successes?.length) {
      rejection = JSON.stringify(d.failures).slice(0, 300);
    }
  } catch { /* async 202 may have no JSON body */ }
  if (rejection) throw new GarminUploadRejected(`Garmin rejected upload: ${rejection}`);

  // Resolve activity id by start time (never grab "most recent" — wrong-activity
  // risk). The exclusions matter here: on a replace the watch copy sits at the
  // same start time, so without them this resolves to the activity the caller is
  // about to delete and every later call 404s on a dead id (#596).
  if (!activityId && workoutStart) {
    for (const wait of [3, 5, 10]) {
      await sleep(wait);
      activityId = await findActivityByStartTime(client, workoutStart, excludeActivityIds);
      if (activityId) break;
    }
  }
  return { uploadId, activityId };
}

/** Python's `window_minutes` default in `find_activity_by_start_time`. */
const MATCH_WINDOW_MS = 10 * 60 * 1000;

/**
 * Activity types this lookup will accept.
 *
 * The rule is "reject what is positively something else", not "accept only
 * strength", and the difference matters. An activity Garmin has not finished
 * classifying comes back with no `typeKey`, and a strict allow-list would
 * refuse to match our own fresh upload, so we would upload it again. Matches
 * `garmin.py:266-268`.
 *
 * `merge-match.ts` uses a strict allow-list instead, and that is right there
 * for the opposite reason: it is choosing a watch activity to merge INTO, and
 * an unclassified activity is not a safe target to edit.
 */
const MATCHABLE_TYPES = new Set(["strength_training", "other"]);

/** YYYY-MM-DD, `days` from `d`, in UTC. */
function dateOffset(d: Date, days: number): string {
  return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Find an activity by its start time (matches the uploaded FIT).
 *
 * This is layer two of the never-duplicate contract, the question "does Garmin
 * already have this workout" asked before anything is uploaded. Ported from
 * `find_activity_by_start_time` in `src/hevy2garmin/garmin.py:232`.
 *
 * It searches the workout's own date rather than the most recent activities, so
 * re-syncing something old still finds it however busy the account is, and it
 * widens by a day on each side because a late-evening workout can fall on the
 * next date in GMT.
 *
 * `excludeActivityIds` exists for the replace strategy: the watch activity
 * being replaced sits at the same start time as the workout, so without the
 * exclusion this would report the very activity we are about to delete and the
 * upload would be skipped.
 */
export async function findActivityByStartTime(
  client: GarminClient,
  targetStart: string,
  excludeActivityIds?: Array<number | string> | null,
): Promise<number | null> {
  // Through the shared helper, which reads a naive string as UTC. Parsing it
  // with `new Date` would read it as the machine's LOCAL time while the Garmin
  // side of the same comparison is UTC, so the two halves would disagree by the
  // host's offset (#610).
  const target = toUtcDate(targetStart);
  if (!target) return null;

  const acts = await getActivitiesByDate(client, dateOffset(target, -1), dateOffset(target, 1));

  const excluded = new Set((excludeActivityIds ?? []).map((id) => String(id)));
  for (const a of acts) {
    const activityId = a.activityId as number | undefined;
    if (activityId == null || excluded.has(String(activityId))) continue;

    const typeKey = (a.activityType as { typeKey?: string } | undefined)?.typeKey ?? "";
    if (typeKey && !MATCHABLE_TYPES.has(typeKey)) continue;

    const raw = (a.startTimeGMT ?? a.startTimeLocal) as string | undefined;
    const started = raw ? toUtcDate(raw) : null;
    if (started && Math.abs(started.getTime() - target.getTime()) < MATCH_WINDOW_MS) {
      return activityId;
    }
  }
  return null;
}

/** Rename an activity. */
export async function renameActivity(client: GarminClient, activityId: number, name: string): Promise<void> {
  await postJson(client, `/activity-service/activity/${activityId}`, { activityId, activityName: name });
}

/** Set an activity's description. */
export async function setDescription(client: GarminClient, activityId: number, description: string): Promise<void> {
  await postJson(client, `/activity-service/activity/${activityId}`, { activityId, description });
}

/** Delete an activity. */
export async function deleteActivity(client: GarminClient, activityId: number): Promise<void> {
  const url = `https://connectapi.${client.domain}/activity-service/activity/${activityId}`;
  const req = () => fetch(url, { method: "DELETE", headers: nativeHeaders(client.di_token!, { NK: "NT" }) });
  let res = await req();
  if (res.status === 401) { await client.refreshDiToken(); res = await req(); }
  if (![200, 204].includes(res.status)) throw new Error(`delete activity ${activityId} → ${res.status}`);
}

/**
 * The original file Garmin holds for an activity, which for a watch recording
 * is the device FIT and the only place its per-second heart rate exists.
 *
 * The response is normally a zip holding one .fit; `extractHrFromFit` handles
 * both that and a bare FIT. Returns null rather than throwing, because a failed
 * download must not break a sync: the caller falls back to another HR source,
 * and the one case where the HR is not optional is enforced by `hrForSync`.
 */
export async function downloadActivityFit(
  client: GarminClient,
  activityId: number | string,
): Promise<Uint8Array | null> {
  const url = `https://connectapi.${client.domain}/download-service/files/activity/${activityId}`;
  const req = () => fetch(url, { headers: nativeHeaders(client.di_token!, { NK: "NT" }) });
  try {
    let res = await req();
    if (res.status === 401) { await client.refreshDiToken(); res = await req(); }
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * The Garmin display name, which the wellness endpoints are keyed by.
 *
 * Read from `socialProfile`. `/userprofile-service/userprofile/profile` used to
 * carry it too, but Garmin now answers that path with 404, which left every
 * daily HR lookup empty without a word.
 *
 * Cached per client: it does not change, and a sync would otherwise fetch the
 * same profile on every workout.
 */
const displayNames = new WeakMap<GarminClient, string | null>();

export async function getDisplayName(client: GarminClient): Promise<string | null> {
  if (displayNames.has(client)) return displayNames.get(client) ?? null;
  let name: string | null = null;
  try {
    const profile = await client.connectapi<{ displayName?: string }>(
      "/userprofile-service/socialProfile",
    );
    name = profile?.displayName ?? null;
  } catch {
    name = null; // best effort: the caller falls back to another HR source
  }
  displayNames.set(client, name);
  return name;
}

/** One reading from Garmin's daily monitoring feed: [epoch ms, bpm]. */
export type DailyHeartRateValue = [number, number | null];

/**
 * Garmin's daily wrist heart rate for a date, as `[epoch_ms, bpm]` pairs.
 *
 * This is the coarsest HR source, roughly a reading every couple of minutes,
 * and the last resort. It is also the only one that covers a workout the watch
 * never recorded as an activity: the user wore the watch, so the heart rate
 * exists, it is just not attached to anything.
 *
 * Returns an empty list on any failure. HR is an enrichment and must never
 * break a sync.
 */
export async function getDailyHeartRate(
  client: GarminClient,
  date: string,
): Promise<DailyHeartRateValue[]> {
  const day = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  // Keyed by the display name when there is one. Without it, the unkeyed path
  // serves the same readings for the signed-in user, so a profile lookup that
  // fails costs nothing instead of the whole series.
  const who = await getDisplayName(client);
  const path = who
    ? `/wellness-service/wellness/dailyHeartRate/${encodeURIComponent(who)}?date=${day}`
    : `/wellness-service/wellness/dailyHeartRate?date=${day}`;
  try {
    const data = await client.connectapi<{ heartRateValues?: unknown }>(path);
    const values = data?.heartRateValues;
    if (!Array.isArray(values)) return [];
    return values.filter(
      (v): v is DailyHeartRateValue => Array.isArray(v) && v.length >= 2 && typeof v[0] === "number",
    );
  } catch {
    return [];
  }
}

async function postJson(client: GarminClient, path: string, body: unknown): Promise<void> {
  const url = `https://connectapi.${client.domain}${path}`;
  const req = () => fetch(url, {
    method: "POST",
    headers: nativeHeaders(client.di_token!, { "Content-Type": "application/json", "X-HTTP-Method-Override": "PUT", NK: "NT" }),
    body: JSON.stringify(body),
  });
  let res = await req();
  if (res.status === 401) { await client.refreshDiToken(); res = await req(); }
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
}

/**
 * Activities Garmin holds in a date range, used to find the watch recording a
 * Hevy workout belongs to. Dates are YYYY-MM-DD.
 */
export async function getActivitiesByDate(
  client: GarminClient,
  startDate: string,
  endDate: string,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  const q = `startDate=${startDate}&endDate=${endDate}&limit=${limit}&start=0`;
  return client.connectapi<Array<Record<string, unknown>>>(
    `/activitylist-service/activities/search/activities?${q}`,
  );
}

/** An activity's current exercise sets, taken as a backup before a merge. */
export async function getActivityExerciseSets(
  client: GarminClient,
  activityId: number,
): Promise<Record<string, unknown>> {
  // The one-second pacing that used to be here now comes from the gateway's
  // rate limiter, which spaces EVERY Garmin call rather than the two that
  // happened to have a hand-written sleep (#599). Keeping it as well would
  // double the wait on this call alone.
  return client.connectapi<Record<string, unknown>>(
    `/activity-service/activity/${activityId}/exerciseSets`,
  );
}

/**
 * PUT exercise sets onto an existing activity, replacing ALL of them.
 *
 * Atomic: Garmin accepts or rejects the whole payload and names no offending
 * exercise, which is why callers go through pushWithNameFallback rather than
 * calling this directly.
 *
 * The failure text is carried into the thrown Error on purpose. The retry
 * decides what to do by reading it, so swallowing it would turn a recoverable
 * rejection into a total loss of the user's sets.
 */
export async function pushExerciseSets(
  client: GarminClient,
  activityId: number,
  payload: unknown,
): Promise<void> {
  const path = `/activity-service/activity/${activityId}/exerciseSets`;
  const url = `https://connectapi.${client.domain}${path}`;
  // Pacing comes from the gateway's rate limiter now, not a hand-written sleep.
  const req = () => fetch(url, {
    method: "POST",
    headers: nativeHeaders(client.di_token!, {
      "Content-Type": "application/json",
      "X-HTTP-Method-Override": "PUT",
      NK: "NT",
    }),
    body: JSON.stringify(payload),
  });
  let res = await req();
  if (res.status === 401) { await client.refreshDiToken(); res = await req(); }
  // 204 No Content is the success shape here.
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`PUT exerciseSets ${activityId} → ${res.status}: ${text.slice(0, 200)}`);
  }
}
