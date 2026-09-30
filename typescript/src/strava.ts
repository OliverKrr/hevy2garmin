/**
 * Mute the stale watch copy on Strava after a replace, opt-in.
 *
 * When the replace strategy deletes the watch activity from Garmin, Garmin has
 * usually already pushed that recording to Strava, and Garmin deletions do not
 * propagate there. Our named replacement is pushed separately, minutes later,
 * so the athlete ends up with two Strava activities for one session. Strava
 * has no DELETE for activities. The most a cleanup can do is rename the stale
 * copy with `STRAVA_DUP_PREFIX` and set `hide_from_home`: out of followers'
 * feeds, still in the athlete's totals, still easy to find and delete by hand.
 *
 * The write is the easy part. Knowing WHICH copy is stale is the hard part,
 * and every rule that tried to answer it from one look at the window failed on
 * real data:
 *
 * - `external_id` is not the Garmin activity id, unlike intervals.icu. A
 *   Garmin-pushed activity carries `garmin_ping_<pingId>`, a push-notification
 *   id unrelated to the activity, so a matcher keyed on it never fires.
 * - `start_date` is Strava's first RECORD, not the FIT session start. HR fusion
 *   gives our upload the watch's samples, so both copies report the same start.
 * - `device_name` separates some pairs and not others: activities that are
 *   certainly watch recordings can report none, exactly like our uploads.
 * - The end measures the watch, not the copy. When the watch stops early both
 *   copies report the same end, to the second.
 *
 * So nothing here tries to recognise the stale copy. It observes.
 * `observeStravaWindow` snapshots the window at the moment the watch copy is
 * deleted from Garmin, before our replacement exists anywhere and so before
 * Garmin could have pushed it, and keeps that as the record's baseline.
 * Anything in the baseline predates our upload and cannot be ours; anything
 * that appears later is ours unless its timing rules it out.
 * `recheckStravaObservations` re-snapshots until our copy shows up, and only
 * then, and only in `mute` mode, does it write.
 *
 * That ordering is the safety property: a stale copy is only ever muted in a
 * window where our own copy is confirmed present, so the workout always keeps
 * a visible activity on Strava. Timing may rule an activity OUT of being ours
 * (see `SPAN_TOLERANCE_S`). It is never asked to rule one in.
 *
 * Like `./intervals`, the engine does not read the environment: credentials,
 * the mode and the storage arrive as arguments, so a consumer embedding the
 * engine configures its own or none. And every exported function resolves and
 * never rejects. The caller has just deleted a Garmin activity, and tidying a
 * third-party service must not fail a sync that already did what was asked.
 *
 * Ported from the Python `strava.py` that ran against one athlete's account
 * from 2026-08-25, where it observed ten replace pairs and muted the stale
 * copy of each once the account was armed. The record shape is the Python's,
 * key for key, so a database written by one reads correctly in the other.
 */

/**
 * What the cleanup may do.
 *
 *   off     nothing, not even the read-only observation
 *   report  observe and record; never writes to Strava (the default)
 *   mute    observe, and once a duplicate is confirmed, rename the stale copy
 *           with STRAVA_DUP_PREFIX and hide it from followers' feeds
 *
 * The default is not `mute` on purpose. The write lands on a public feed in a
 * third-party account, so a deployment arms it once its own recorded
 * observations look right.
 */
export type StravaCleanupMode = "off" | "report" | "mute";

export const STRAVA_DUP_PREFIX = "[dup] ";

/**
 * Where the rotated refresh token and the observation records live.
 *
 * Narrow on purpose, like the merge backup methods on `SyncStore`: two values,
 * not a key-value door onto the host's storage. The web app keeps them in
 * `app_cache` under `strava_tokens` and `strava_observations`, the keys the
 * Python used.
 */
export interface StravaStore {
  /** The latest refresh token Strava handed out, or null if none was saved. */
  loadRefreshToken(): Promise<string | null>;
  saveRefreshToken(token: string): Promise<void>;
  /** The stored records, as stored. Parsed defensively here, not by the host. */
  loadObservations(): Promise<unknown>;
  saveObservations(records: StravaObservationRecord[]): Promise<void>;
}

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Bootstrap only. Strava rotates refresh tokens, and the latest one is kept
   * in the store, which wins over this value once it holds one.
   */
  refreshToken?: string;
  /** Default `report`. */
  mode?: StravaCleanupMode;
  store: StravaStore;
  /**
   * A recheck skips records checked more recently than this. The web app calls
   * the recheck after every live sync, and a dashboard batch is one call per
   * workout, so without it a batch of ten would poll Strava ten times over.
   * Default five minutes.
   */
  minRecheckIntervalMs?: number;
  /** One line per event worth reading in a log. Default: silent. */
  log?: (line: string) => void;
  /** Overrides for tests. */
  baseUrl?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** The raw Strava fields a snapshot keeps. No interpretation; see `deriveStravaEntry`. */
export interface StravaActivitySummary {
  id: number;
  start_date: string | null;
  elapsed_time: number | null;
  moving_time: number | null;
  sport_type: string | null;
  name: string | null;
  external_id: string | null;
  upload_id: number | null;
  manual: boolean | null;
  device_name: string | null;
  hide_from_home: boolean | null;
}

export type StravaVerdict = "ours" | "stale" | "hevy_direct" | "unknown" | "ours?" | "stale?";

export interface StravaDerivedEntry extends StravaActivitySummary {
  delta_start_s: number | null;
  delta_elapsed_s: number | null;
  delta_end_s: number | null;
  verdict: StravaVerdict;
}

export interface StravaSnapshot {
  at: string;
  phase: "watch_copy_deleted" | "recheck" | "after_mute";
  activities: StravaActivitySummary[];
}

/**
 * One replace, followed over time. The keys are the Python's, so records
 * move between the two implementations through a shared database unchanged.
 */
export interface StravaObservationRecord {
  hevy_id: string;
  hevy_start: string;
  hevy_end: string | null;
  hevy_duration_s: number | null;
  watch_activity_id: string | null;
  replacement_activity_id: string | null;
  opened_at: string;
  closed: boolean;
  closed_reason?: "aged_out" | "duplicate_confirmed" | "duplicate_cleaned" | "stale_copy_gone";
  snapshots: StravaSnapshot[];
  checks?: number;
  last_checked_at?: string;
  /**
   * What the window held when the watch copy was deleted. Null when that fetch
   * failed, and then it stays null: see `snapshot`.
   */
  baseline_ids?: number[] | null;
  baseline_at?: string | null;
  ours_present?: boolean;
  stale_count?: number;
  basis?: "baseline" | "time_only";
  cleanup?: Array<{ id: number; at: string; muted: boolean }>;
}

/** What the engine passes along with a deleted watch activity. */
export interface StravaObserveInput {
  hevyId: string;
  workoutStart: string;
  workoutEnd?: string | null;
  watchActivityId?: number | string | null;
  replacementActivityId?: number | string | null;
}

const DEFAULT_BASE_URL = "https://www.strava.com/api/v3";
const DEFAULT_TOKEN_URL = "https://www.strava.com/oauth/token";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RECORDS = 25;
const MAX_SNAPSHOTS = 15;
const OBSERVE_DAYS = 21;
const WINDOW_HOURS = 3;
const DEFAULT_MIN_RECHECK_MS = 5 * 60_000;

/** Strava sport types a Hevy strength workout can plausibly land as. */
const STRENGTH_TYPES = new Set(["WeightTraining", "Workout", "Crossfit", "HighIntensityIntervalTraining"]);

/**
 * A bound on the shape of our own copy. Provenance decides; this only rules out.
 *
 * Strava reports `start_date` from the first record, and HR fusion gives our
 * upload the watch's samples, so our copy starts at or after the Hevy start:
 * 64 s after it on one observed pair, with the watch copy on the same second.
 *
 * The end has been reported two ways, with nothing changing on our side. At
 * first `elapsed_time` ran to the last record, so our copy ended at
 * `min(watch_end, hevy_end)`: on the Hevy end when the watch ran past it, and
 * on the same second as the watch copy when the watch stopped early (both 14 s
 * before the Hevy end on one pair). Later Strava began reporting the full Hevy
 * duration from the shifted start, so our copy's end overhangs the Hevy end by
 * the start offset (38 s and 38 s on one pair, `elapsed_time` equal to the Hevy
 * duration to the second). A rule on the end rejected our own copy under each
 * behaviour in turn, and the duplicate went unmuted.
 *
 * What holds under both: our copy starts inside the Hevy window and is never
 * longer than the Hevy workout. The end is not bounded at all.
 */
const SPAN_TOLERANCE_S = 10;

type Fetch = typeof fetch;

function fetchOf(config: StravaConfig): Fetch {
  return config.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
}

function nowOf(config: StravaConfig): Date {
  return config.now ? config.now() : new Date();
}

/** A deadline for every call. A hung Strava request must not hang the sync that made it. */
function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

/** `2026-08-25T15:58:54+00:00`, the shape the Python writes. */
function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** A timestamp as a Date, treating a zone-less value as UTC. Null when unparseable. */
function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A Strava activity id we are willing to put in a URL: a positive safe integer. */
function activityIdOf(value: unknown): number | null {
  const n = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** `+64s` / `-8s` / `?`, as the Python log lines print deltas. */
function delta(value: number | null): string {
  if (value == null) return "?";
  return `${value >= 0 ? "+" : ""}${value}s`;
}

/**
 * Parse `STRAVA_CLEANUP_MODE`. Empty means the default, `report`. An unknown
 * value also means `report`: a typo must not arm the write, and it must not
 * silently switch the observation off either.
 */
export function parseStravaMode(raw: string | null | undefined): StravaCleanupMode {
  const mode = (raw ?? "").trim().toLowerCase();
  return mode === "off" || mode === "report" || mode === "mute" ? mode : "report";
}

/**
 * Label one activity. Provenance decides; timing only rules out.
 *
 * `baselineIds` is what the window held when we deleted the watch copy from
 * Garmin, before our replacement existed anywhere. Anything in it cannot be
 * ours however its timings look, and anything that shows up later is ours
 * unless it arrived by some other route. That is the only identification here
 * that is not a heuristic.
 *
 * Timing's one job is to catch the other route: a late arrival whose span
 * does not fit the Hevy workout is a different recording. It must never be
 * asked to confirm a copy IS ours, because both copies of one session have
 * reported identical timings.
 */
function classify(
  entry: Omit<StravaDerivedEntry, "verdict">,
  baselineIds: Set<number> | null,
  hevyDurationS: number | null,
): StravaVerdict {
  // Hevy's own Strava integration posts a manual activity. It is a third copy
  // with a different cause, and nothing this module does is about it.
  if (entry.manual || entry.device_name === "Hevy") return "hevy_direct";
  // Our copy reaches Strava through Garmin's push like any other, so this
  // shape is a precondition, not a discriminator. It only rules out anything
  // that arrived another way.
  if (!String(entry.external_id ?? "").startsWith("garmin_ping_")) return "unknown";

  const { delta_start_s: ds, delta_elapsed_s: de } = entry;
  const withinHevySpan =
    ds != null &&
    de != null &&
    hevyDurationS != null &&
    ds >= -SPAN_TOLERANCE_S &&
    ds < hevyDurationS &&
    de <= SPAN_TOLERANCE_S;

  if (baselineIds == null) {
    // No baseline: the delete-time fetch failed. Fall back to the weak signal
    // and say so with a question mark. Neither verdict can drive a write.
    return withinHevySpan ? "ours?" : "stale?";
  }
  if (baselineIds.has(entry.id)) return "stale";
  return withinHevySpan ? "ours" : "unknown";
}

function baselineOf(record: StravaObservationRecord): Set<number> | null {
  return Array.isArray(record.baseline_ids) ? new Set(record.baseline_ids) : null;
}

/**
 * An entry plus its deltas and verdict, computed against `record` on read.
 *
 * Nothing interpretive is stored. A verdict frozen into a snapshot outlives
 * the rule that produced it: when a rule is disproved, the stored history keeps
 * its old labels and no recheck rewrites them, because the window has not
 * changed. Deriving on read means a rule change re-reads the whole history.
 */
export function deriveStravaEntry(
  entry: StravaActivitySummary,
  record: Pick<StravaObservationRecord, "hevy_start" | "hevy_duration_s" | "baseline_ids">,
): StravaDerivedEntry {
  const hevyStart = parseIso(record.hevy_start);
  const hevyDuration = intOrNull(record.hevy_duration_s);
  const start = parseIso(entry.start_date);
  const elapsed = intOrNull(entry.elapsed_time);

  const deltaStart = start && hevyStart ? Math.trunc((start.getTime() - hevyStart.getTime()) / 1000) : null;
  const deltaElapsed = elapsed != null && hevyDuration ? elapsed - hevyDuration : null;
  const deltaEnd =
    deltaStart != null && elapsed != null && hevyDuration ? deltaStart + elapsed - hevyDuration : null;

  const out = { ...entry, delta_start_s: deltaStart, delta_elapsed_s: deltaElapsed, delta_end_s: deltaEnd };
  return {
    ...out,
    verdict: classify(out, baselineOf(record as StravaObservationRecord), hevyDuration),
  };
}

/** Keep the raw fields worth keeping, and drop anything without a usable id. */
function summarize(act: Record<string, unknown>): StravaActivitySummary | null {
  const id = activityIdOf(act.id);
  if (id == null) return null;
  return {
    id,
    start_date: strOrNull(act.start_date),
    elapsed_time: intOrNull(act.elapsed_time),
    moving_time: intOrNull(act.moving_time),
    sport_type: strOrNull(act.sport_type) ?? strOrNull(act.type),
    name: strOrNull(act.name),
    external_id: strOrNull(act.external_id),
    upload_id: intOrNull(act.upload_id),
    manual: boolOrNull(act.manual),
    device_name: strOrNull(act.device_name),
    hide_from_home: boolOrNull(act.hide_from_home),
  };
}

/**
 * Records as stored, keeping only what is shaped like a record. The store is
 * shared with other writers (an older build, the Python), so nothing read back
 * is trusted to have the shape this module wrote.
 */
function parseRecords(stored: unknown): StravaObservationRecord[] {
  const list = Array.isArray(stored)
    ? stored
    : stored && typeof stored === "object" && Array.isArray((stored as { records?: unknown }).records)
      ? (stored as { records: unknown[] }).records
      : [];
  return list
    .filter(
      (r): r is StravaObservationRecord =>
        !!r &&
        typeof r === "object" &&
        typeof (r as StravaObservationRecord).hevy_id === "string" &&
        typeof (r as StravaObservationRecord).hevy_start === "string" &&
        Array.isArray((r as StravaObservationRecord).snapshots),
    )
    .map((r) => ({
      ...r,
      snapshots: r.snapshots
        .filter((snap) => !!snap && typeof snap === "object" && Array.isArray(snap.activities))
        .map((snap) => ({
          ...snap,
          activities: snap.activities.filter((a) => !!a && typeof a === "object" && activityIdOf(a.id) != null),
        })),
    }));
}

async function loadRecords(config: StravaConfig): Promise<StravaObservationRecord[]> {
  try {
    return parseRecords(await config.store.loadObservations());
  } catch {
    return [];
  }
}

/**
 * Save `touched` over whatever is stored NOW, matched by hevy id.
 *
 * A recheck spends seconds on Strava between its load and its save, and a sync
 * in another request can open a record in that gap. Writing back the list read
 * at the start would drop that record, and with it the only baseline its
 * replace will ever get.
 */
async function saveRecords(config: StravaConfig, touched: StravaObservationRecord[]): Promise<void> {
  try {
    const current = await loadRecords(config);
    const byId = new Map(touched.map((r) => [r.hevy_id, r]));
    const merged = current.map((r) => byId.get(r.hevy_id) ?? r);
    for (const r of touched) if (!current.some((c) => c.hevy_id === r.hevy_id)) merged.push(r);
    await config.store.saveObservations(merged.slice(-MAX_RECORDS));
  } catch {
    // Losing a write loses one observation, not the sync.
  }
}

/** A bearer token, rotating and persisting the refresh token. Null on any failure. */
async function accessToken(config: StravaConfig): Promise<string | null> {
  let refresh: string | null = null;
  try {
    refresh = await config.store.loadRefreshToken();
  } catch {
    refresh = null;
  }
  refresh = refresh || config.refreshToken || null;
  if (!refresh) return null;

  let data: Record<string, unknown>;
  try {
    const res = await fetchOf(config)(config.tokenUrl ?? DEFAULT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refresh,
      }).toString(),
      signal: timeoutSignal(),
    });
    if (!res.ok) {
      config.log?.(`[strava] token refresh failed: HTTP ${res.status}`);
      return null;
    }
    const body = await res.json();
    if (!body || typeof body !== "object") return null;
    data = body as Record<string, unknown>;
  } catch (e) {
    config.log?.(`[strava] token refresh failed: ${(e as Error)?.message ?? String(e)}`);
    return null;
  }

  // Strava invalidates the old refresh token once it issues a new one, so a
  // rotation that is not saved locks the deployment out at the next refresh.
  const rotated = data.refresh_token;
  if (typeof rotated === "string" && rotated && rotated !== refresh) {
    await config.store.saveRefreshToken(rotated).catch(() => {
      config.log?.("[strava] could not persist the rotated refresh token");
    });
  }
  const token = data.access_token;
  return typeof token === "string" && token ? token : null;
}

interface Session {
  headers: Record<string, string>;
  base: string;
}

async function session(config: StravaConfig): Promise<Session | null> {
  if (!config.clientId || !config.clientSecret) return null;
  const token = await accessToken(config);
  if (!token) return null;
  return {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    base: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
  };
}

/** Strength activities around `centre`. Null on failure, which is not the same as empty. */
async function fetchWindow(
  config: StravaConfig,
  s: Session,
  centre: Date,
): Promise<StravaActivitySummary[] | null> {
  const span = WINDOW_HOURS * 3600;
  const t = Math.floor(centre.getTime() / 1000);
  const url = `${s.base}/athlete/activities?after=${t - span}&before=${t + span}&per_page=50`;
  let body: unknown;
  try {
    const res = await fetchOf(config)(url, { headers: s.headers, signal: timeoutSignal() });
    if (!res.ok) {
      config.log?.(`[strava] window fetch failed: HTTP ${res.status}`);
      return null;
    }
    body = await res.json();
  } catch (e) {
    config.log?.(`[strava] window fetch failed: ${(e as Error)?.message ?? String(e)}`);
    return null;
  }
  if (!Array.isArray(body)) {
    config.log?.("[strava] window fetch returned something other than a list");
    return null;
  }
  return body
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .filter((a) => STRENGTH_TYPES.has(String(a.sport_type ?? a.type ?? "")))
    .map(summarize)
    .filter((a): a is StravaActivitySummary => a != null);
}

/** Compare the fields we would act on. Ids alone would miss a rename or a mute done by hand. */
function fingerprint(items: StravaActivitySummary[]): string {
  return JSON.stringify(items.map((i) => [i.id, i.name, i.hide_from_home]));
}

/** Append a snapshot to `record` if the window changed. True if one was appended. */
async function snapshot(
  config: StravaConfig,
  s: Session,
  record: StravaObservationRecord,
  phase: StravaSnapshot["phase"],
): Promise<boolean> {
  const hevyStart = parseIso(record.hevy_start);
  if (!hevyStart) return false;
  const raw = await fetchWindow(config, s, hevyStart);
  const now = isoSeconds(nowOf(config));
  record.checks = (intOrNull(record.checks) ?? 0) + 1;
  record.last_checked_at = now;

  // Everything present when the watch copy was deleted predates our upload and
  // so cannot be ours. Only that moment can establish it: a baseline taken on
  // any later pass may already contain our own replacement, which is worse
  // than no baseline at all. So when the delete-time fetch failed the record
  // stays baseline-less for good, and its verdicts can never drive a write.
  if (!("baseline_ids" in record)) {
    const taken = phase === "watch_copy_deleted" && raw != null;
    record.baseline_ids = taken ? raw.map((a) => a.id) : null;
    record.baseline_at = taken ? now : null;
  }
  if (raw == null) return false;

  const entries = [...raw].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  const snapshots = record.snapshots;
  const previous = snapshots.length ? snapshots[snapshots.length - 1].activities : null;
  const changed = previous == null || fingerprint(previous) !== fingerprint(entries);
  if (changed) {
    snapshots.push({ at: now, phase, activities: entries });
    snapshots.splice(0, Math.max(0, snapshots.length - MAX_SNAPSHOTS));
  }

  // Refresh the summary even on an unchanged window: a rule change can move a
  // verdict without the window moving at all.
  const derived = entries.map((e) => deriveStravaEntry(e, record));
  const count = (v: StravaVerdict) => derived.filter((e) => e.verdict === v).length;
  const ours = count("ours");
  const stale = count("stale");
  record.ours_present = ours > 0;
  record.stale_count = stale;
  record.basis = Array.isArray(record.baseline_ids) ? "baseline" : "time_only";
  if (!changed) return false;

  if (config.log) {
    config.log(
      `[strava] observe [${phase}, ${record.basis}] hevy=${JSON.stringify(record.hevy_id)}: ` +
        `${entries.length} strength activities in window, ours=${ours} stale=${stale} ` +
        `hevy_direct=${count("hevy_direct")} unknown=${count("unknown")}`,
    );
    for (const e of derived) {
      // Strings are JSON-quoted: an activity name is whatever the athlete (or
      // anyone they share a group with) typed, and a newline in it must not
      // forge a log line.
      config.log(
        `[strava]   ${e.verdict} id=${e.id} start=${JSON.stringify(e.start_date)} ` +
          `(start${delta(e.delta_start_s)} end${delta(e.delta_end_s)}) elapsed=${e.elapsed_time}s ` +
          `name=${JSON.stringify(e.name)} external_id=${JSON.stringify(e.external_id)} ` +
          `upload_id=${e.upload_id} manual=${e.manual} device=${JSON.stringify(e.device_name)} ` +
          `hidden=${e.hide_from_home}`,
      );
    }
    if (ours && stale) {
      config.log(
        `[strava] confirmed duplicate for hevy=${JSON.stringify(record.hevy_id)}: ` +
          `our copy and ${stale} stale cop${stale === 1 ? "y" : "ies"} coexist`,
      );
    }
  }
  return true;
}

/**
 * Rename one activity with the prefix and hide it from followers' feeds.
 * The only cleanup Strava's API permits. True when Strava accepted it.
 */
async function mute(config: StravaConfig, s: Session, entry: StravaDerivedEntry): Promise<boolean> {
  const id = activityIdOf(entry.id);
  if (id == null) return false;
  const name = strOrNull(entry.name) || "Workout";
  const newName = name.startsWith(STRAVA_DUP_PREFIX) ? name : `${STRAVA_DUP_PREFIX}${name}`;
  try {
    const res = await fetchOf(config)(`${s.base}/activities/${id}`, {
      method: "PUT",
      headers: { ...s.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ hide_from_home: true, name: newName }),
      signal: timeoutSignal(),
    });
    if (!res.ok) {
      config.log?.(`[strava] could not mute activity ${id}: HTTP ${res.status}`);
      return false;
    }
  } catch (e) {
    config.log?.(`[strava] could not mute activity ${id}: ${(e as Error)?.message ?? String(e)}`);
    return false;
  }
  config.log?.(`[strava] muted activity ${id} as ${JSON.stringify(newName)}`);
  return true;
}

/**
 * Mute every stale copy in the latest snapshot.
 *
 * Only called once our copy is confirmed present, so the workout keeps a
 * visible activity. The targets are baseline members, never a timing match.
 */
async function cleanUp(
  config: StravaConfig,
  s: Session,
  record: StravaObservationRecord,
): Promise<NonNullable<StravaObservationRecord["cleanup"]>> {
  const last = record.snapshots[record.snapshots.length - 1];
  const results: NonNullable<StravaObservationRecord["cleanup"]> = [];
  for (const raw of last?.activities ?? []) {
    const entry = deriveStravaEntry(raw, record);
    if (entry.verdict !== "stale") continue;
    results.push({ id: entry.id, at: isoSeconds(nowOf(config)), muted: await mute(config, s, entry) });
  }
  return results;
}

/**
 * True once every activity the baseline held has left the window.
 *
 * Someone deleting the stale copy by hand is the other way a duplicate
 * resolves, and it leaves nothing to watch. Without this the record keeps
 * polling Strava for the full three weeks.
 *
 * An empty baseline does not count. If Garmin had not pushed the watch copy
 * yet when we looked, a stale copy can still arrive after ours.
 */
function baselineCleared(record: StravaObservationRecord): boolean {
  const baseline = record.baseline_ids;
  const last = record.snapshots[record.snapshots.length - 1];
  if (!Array.isArray(baseline) || !baseline.length || !last) return false;
  const present = new Set(last.activities.map((a) => a.id));
  return !baseline.some((id) => present.has(id));
}

/**
 * Open an observation record for one replace. Resolves, never rejects, and
 * never writes to Strava.
 *
 * Called right after the watch copy is deleted from Garmin, so the first
 * snapshot sees Strava before our replacement could have been pushed there.
 * That is what makes every later comparison mean something.
 */
export async function observeStravaWindow(config: StravaConfig, input: StravaObserveInput): Promise<void> {
  try {
    if (!config || (config.mode ?? "report") === "off") return;
    if (!input?.hevyId) return;
    const start = parseIso(input.workoutStart);
    if (!start) return;
    const end = parseIso(input.workoutEnd);
    const duration = end ? Math.trunc((end.getTime() - start.getTime()) / 1000) : null;

    const s = await session(config);
    if (!s) return;

    const record: StravaObservationRecord = {
      hevy_id: String(input.hevyId),
      hevy_start: isoSeconds(start),
      hevy_end: end ? isoSeconds(end) : null,
      // A non-positive duration is bad data, and without a duration nothing
      // can be called ours, so nothing is ever muted for this record.
      hevy_duration_s: duration != null && duration > 0 ? duration : null,
      watch_activity_id: input.watchActivityId != null ? String(input.watchActivityId) : null,
      replacement_activity_id: input.replacementActivityId != null ? String(input.replacementActivityId) : null,
      opened_at: isoSeconds(nowOf(config)),
      closed: false,
      snapshots: [],
    };
    await snapshot(config, s, record, "watch_copy_deleted");
    await saveRecords(config, [record]);
  } catch {
    // Never allowed to fail the sync that called it.
  }
}

/**
 * Re-snapshot the open records so late arrivals land on the timeline, and in
 * `mute` mode act once our copy and a stale one coexist. Resolves, never
 * rejects.
 *
 * Our replacement reaches Strava through Garmin's push, which lags the sync by
 * minutes, so the delete-time snapshot alone cannot answer anything. This has
 * to run from every path that syncs, and after the sync, not before.
 */
export async function recheckStravaObservations(config: StravaConfig): Promise<void> {
  try {
    const mode = config?.mode ?? "report";
    if (!config || mode === "off") return;
    const records = await loadRecords(config);
    const open = records.filter((r) => !r.closed);
    if (!open.length) return;

    const now = nowOf(config);
    const cutoff = now.getTime() - OBSERVE_DAYS * 86_400_000;
    const minGap = config.minRecheckIntervalMs ?? DEFAULT_MIN_RECHECK_MS;

    // Age out BEFORE deciding what to poll. If the age test only filtered the
    // records to visit, the branch that closes an aged record would never be
    // reached: it would stop being checked while still reporting itself open.
    const touched: StravaObservationRecord[] = [];
    const due: StravaObservationRecord[] = [];
    for (const r of open) {
      const opened = parseIso(r.opened_at)?.getTime() ?? cutoff;
      if (opened <= cutoff) {
        r.closed = true;
        r.closed_reason = "aged_out";
        touched.push(r);
        continue;
      }
      const last = parseIso(r.last_checked_at)?.getTime();
      if (last == null || now.getTime() - last >= minGap) due.push(r);
    }

    const s = due.length ? await session(config) : null;
    if (s) {
      for (const r of due) {
        await snapshot(config, s, r, "recheck");
        touched.push(r);
        // Our copy and a stale one together is the only state in which a write
        // is safe, because the workout provably keeps a visible copy after it.
        if (r.ours_present && r.stale_count) {
          if (mode === "mute") {
            r.cleanup = await cleanUp(config, s, r);
            // Re-read so the timeline shows the write as Strava has it, not as
            // we assume it landed.
            await snapshot(config, s, r, "after_mute");
          }
          r.closed = true;
          r.closed_reason = mode === "mute" ? "duplicate_cleaned" : "duplicate_confirmed";
        } else if (r.ours_present && baselineCleared(r)) {
          r.closed = true;
          r.closed_reason = "stale_copy_gone";
        }
      }
    }
    if (touched.length) await saveRecords(config, touched);
  } catch {
    // Never allowed to fail the sync that called it.
  }
}

/**
 * Every stored record with its snapshots derived under the current rules.
 * For a status page or a script; resolves to an empty list on any failure.
 */
export async function readStravaObservations(
  config: Pick<StravaConfig, "store">,
): Promise<Array<Omit<StravaObservationRecord, "snapshots"> & { snapshots: Array<Omit<StravaSnapshot, "activities"> & { activities: StravaDerivedEntry[] }> }>> {
  try {
    const records = await loadRecords(config as StravaConfig);
    return records.map((r) => ({
      ...r,
      snapshots: r.snapshots.map((snap) => ({
        ...snap,
        activities: snap.activities.map((a) => deriveStravaEntry(a, r)),
      })),
    }));
  } catch {
    return [];
  }
}

/**
 * Build the hook the engine calls after it deletes a watch activity, or null
 * when the cleanup is not configured or is switched off.
 *
 * The engine passes the Hevy id and end alongside the start. A host whose
 * engine predates that context gets a hook that does nothing, rather than a
 * record keyed on nothing.
 */
export function stravaObserveHook(
  config: StravaConfig | null | undefined,
): ((activityId: number | string, workoutStart: string, context?: WatchActivityContextLike) => Promise<void>) | null {
  if (!config?.clientId || !config?.clientSecret || !config?.store) return null;
  if ((config.mode ?? "report") === "off") return null;
  return async (activityId, workoutStart, context) => {
    if (!workoutStart || !context?.hevyId) return;
    await observeStravaWindow(config, {
      hevyId: context.hevyId,
      workoutStart,
      workoutEnd: context.workoutEnd ?? null,
      watchActivityId: activityId,
      replacementActivityId: context.replacementActivityId ?? null,
    });
  };
}

/** Structurally the engine's `WatchActivityDeletedContext`, without importing the sync module. */
interface WatchActivityContextLike {
  hevyId?: string | null;
  workoutEnd?: string | null;
  replacementActivityId?: number | string | null;
}
