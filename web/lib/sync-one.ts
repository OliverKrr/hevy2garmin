/**
 * Route-facing sync entry points. The engine itself — dedup layers, dry-run
 * default, merge, HR fusion, claim → upload → finalize — lives in the
 * `hevy2garmin` package and is shared with soma. This module only binds it to
 * this app's IO:
 *
 *   store        → Postgres, via ./pending-store (postgresSyncStore)
 *   gateway      → the app's healed Garmin client (getGarminClient), lazily
 *   fetchWorkouts→ the app's Hevy key resolution (fetchAllWorkouts)
 *   hr           → ./hr-store (the hr_cache table and the durable backup)
 *   settings     → ./sync-settings (what the user saved on the Settings page)
 *   strava       → ./strava-store (app_cache), when STRAVA_* credentials are set
 *
 * The settings are the point of this module now. The engine can merge and fuse
 * heart rate, and it only does either when told to, so without this the Settings
 * page would go on saving values that changed nothing (#565).
 *
 * Signatures keep the `(sql, options)` shape every route already calls.
 * dryRun still defaults to TRUE inside the engine; nothing here overrides it.
 */
import {
  garminGateway,
  intervalsCleanupHook,
  listCandidates as engineListCandidates,
  syncOneWorkout as engineSyncOneWorkout,
  type GarminGateway,
  type SyncDeps,
  type SyncOneOptions as EngineSyncOneOptions,
} from "hevy2garmin";
import type { GarminClient } from "garmin-auth";
import { getGarminClient } from "./garmin-upload";
import { fetchAllWorkouts, type HevyWorkout } from "./hevy-sync";
import { hrDepsFor, type HrWorkout } from "./hr-store";
import { postgresSyncStore } from "./sync-store";
import { loadSyncSettings, loadSyncStartDate } from "./sync-settings";
import { parseStartDate, withinSyncWindow } from "./sync-window";
import { parseStravaMode, recheckStravaObservations, stravaObserveHook, type StravaConfig } from "./strava";
import { postgresStravaStore } from "./strava-store";
import type { Sql } from "./pending-store";

export type {
  CandidateWorkout,
  DedupDecision,
  FitStats,
  SyncOneResult,
} from "hevy2garmin";
export { generateDescription } from "hevy2garmin";

export interface SyncOneOptions extends EngineSyncOneOptions {
  /** Test seam: replace the Hevy fetch. Default: fetchAllWorkouts(). */
  fetchWorkouts?: () => Promise<HevyWorkout[]>;
  /** Test seam: replace the Garmin client. Default: getGarminClient(). */
  garminClientFactory?: () => Promise<GarminClient>;
}

/**
 * The Strava cleanup's configuration, or null when it is not set up.
 *
 * Opt-in through STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET, plus a refresh
 * token to start from. STRAVA_CLEANUP_MODE picks off, report or mute and
 * defaults to report, which observes and never writes to Strava. There is no
 * base-URL override on purpose: the access token only ever goes to Strava.
 */
export function stravaConfig(sql: Sql): StravaConfig | null {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const mode = parseStravaMode(process.env.STRAVA_CLEANUP_MODE);
  if (mode === "off") return null;
  return {
    clientId,
    clientSecret,
    refreshToken: process.env.STRAVA_REFRESH_TOKEN,
    mode,
    store: postgresStravaStore(sql),
    log: (line) => console.log(line),
  };
}

/**
 * Run every configured cleanup after a watch delete, each on its own.
 *
 * Strava goes first. Its snapshot is the baseline that later decides which
 * copy is stale, and our upload is already on Garmin at this point, so every
 * second before it is taken is a second in which Garmin can push our copy to
 * Strava too. If that happens both copies land in the baseline, neither can be
 * called ours, and nothing is muted. The failure is safe but wasted.
 */
function watchDeletedHooks(sql: Sql): SyncDeps["onWatchActivityDeleted"] {
  const hooks = [
    stravaObserveHook(stravaConfig(sql)),
    intervalsCleanupHook({
      apiKey: process.env.INTERVALS_API_KEY,
      athleteId: process.env.INTERVALS_ATHLETE_ID,
    }),
  ].filter((h): h is NonNullable<typeof h> => h != null);
  if (!hooks.length) return undefined;
  return async (activityId, workoutStart, context) => {
    for (const hook of hooks) {
      // One service failing must not skip the other.
      await hook(activityId, workoutStart, context).catch(() => {});
    }
  };
}

/** Bind the engine to this app's store, Garmin client, Hevy fetch and HR storage. */
export function buildSyncDeps(sql: Sql, options: SyncOneOptions = {}): SyncDeps {
  const clientFactory = options.garminClientFactory ?? (() => getGarminClient());
  let gateway: Promise<GarminGateway> | null = null;
  const fetchWorkouts = options.fetchWorkouts ?? (() => fetchAllWorkouts());

  // The engine asks for a backup by workout id, and rebasing one needs the
  // workout's start and end. The fetch is the only place both are in hand, so
  // the list is kept as it goes past.
  const seen = new Map<string, HrWorkout>();

  return {
    store: postgresSyncStore(sql),
    // Built once, lazily: the dry-run/no-candidate paths never log in to Garmin.
    gateway: () => (gateway ??= clientFactory().then(garminGateway)),
    fetchWorkouts: async () => {
      const all = await fetchWorkouts();
      // Applied HERE, before the engine sees the list, so listCandidates and
      // syncOneWorkout both honour it without being told and without the engine
      // needing a release (#647).
      const startDate = parseStartDate(await loadSyncStartDate(sql).catch(() => null));
      const workouts = withinSyncWindow(all, startDate);
      // The HR backup is looked up by id against the FULL list on purpose: a
      // workout outside the window is not a candidate, but one that was synced
      // before the window was set still has heart rate worth finding.
      for (const w of all) {
        const id = String((w as { id?: unknown }).id ?? "");
        if (id) seen.set(id, w as HrWorkout);
      }
      return workouts;
    },
    hr: hrDepsFor(sql, () => seen),
    // A replace deletes the watch's own copy from Garmin, and that copy has
    // usually already reached intervals.icu and Strava, where our named upload
    // then arrives as a second one. intervals.icu can delete the stale copy;
    // Strava gets its window recorded, and is dealt with by the recheck in
    // syncOneWorkout below. Undefined unless one of them is configured, rather
    // than a no-op function, so the engine skips the step outright for
    // everyone else.
    onWatchActivityDeleted: watchDeletedHooks(sql),
  };
}

/** READ-only: the unsynced Hevy workouts. */
export function listCandidates(sql: Sql, options: SyncOneOptions = {}) {
  return engineListCandidates(buildSyncDeps(sql, options));
}

/**
 * Sync the next unsynced workout (or `options.targetHevyId`). dryRun defaults
 * to true in the engine; pass `{ dryRun: false }` for a real upload.
 *
 * The user's merge and HR settings are read here unless the caller passes its
 * own, so every route gets them without having to remember to.
 */
export async function syncOneWorkout(sql: Sql, options: SyncOneOptions = {}) {
  const { fetchWorkouts: _f, garminClientFactory: _g, ...engineOptions } = options;
  const saved = await loadSyncSettings(sql);
  const result = await engineSyncOneWorkout(buildSyncDeps(sql, options), {
    merge: saved.merge,
    hrFusion: saved.hrFusion,
    descriptionEnabled: saved.descriptionEnabled,
    profile: saved.profile,
    ...engineOptions, // an explicit option still wins, which is what tests rely on
  });
  // Our Strava copy arrives through Garmin's push minutes after the sync that
  // uploaded it, so the record opened at delete time has to be looked at again
  // by some later request. This is the one function the cron, the webhook and
  // the dashboard all go through, so hanging it here reaches every trigger;
  // hanging it off any one route is how the Python version once lost a
  // trigger. A run that finds nothing to sync is exactly when it matters.
  // Live runs only: a dry run promises no writes, and this can write. It
  // resolves on every failure and throttles itself, so a batch of calls
  // polls Strava once.
  if (result.dryRun === false) {
    const strava = stravaConfig(sql);
    if (strava) await recheckStravaObservations(strava);
  }
  return result;
}
