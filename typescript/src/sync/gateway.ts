/**
 * The Garmin boundary of the sync engine — the ONLY way the engine reaches
 * Garmin Connect. `findExistingActivity` is a READ (dedup layer 2, the
 * 409-prevention lookup). `upload`, `rename` and `describe` are WRITES, reached
 * only on the live path (dryRun === false). Nothing here decides WHETHER to
 * upload; the engine does.
 *
 * `garminGateway(client)` is the default over this package's own Garmin ops. A
 * test supplies spies instead.
 */
import type { GarminClient } from "garmin-auth";
import {
  findActivityByStartTime, renameActivity, setDescription, uploadFit,
  getActivitiesByDate, getActivityExerciseSets, pushExerciseSets,
  deleteActivity, downloadActivityFit, getDailyHeartRate,
  type UploadResult,
} from "../garmin";
import type { CandidateActivity } from "../merge-match";
import { createRateLimiter, type RateLimitOptions } from "../rate-limit";

export interface GarminGateway {
  /**
   * READ: the id of an activity already at this start time, or null.
   *
   * `excludeActivityIds` is what makes the replace strategy work: the watch
   * activity being replaced sits at the same start time, so without excluding
   * it this lookup would match the activity we are about to delete and skip the
   * upload that is supposed to take its place.
   */
  findExistingActivity(startTime: string, excludeActivityIds?: Array<number | string> | null): Promise<number | null>;
  /**
   * WRITE: upload a FIT (bytes); resolve the activity id.
   *
   * `excludeActivityIds` is forwarded to the start-time lookup that resolves
   * the new activity. On a replace the watch copy shares that start time, so
   * without it the upload resolves to the id the caller is about to delete and
   * every later call 404s on a dead activity.
   */
  upload(
    fit: Uint8Array,
    workoutStart?: string,
    excludeActivityIds?: Array<number | string> | null,
  ): Promise<UploadResult>;
  /** WRITE: rename an activity. */
  rename(activityId: number, name: string): Promise<void>;
  /** WRITE: set an activity's description. */
  describe(activityId: number, description: string): Promise<void>;
  /** READ: activities in a date range, the candidates a merge matches against. */
  activitiesByDate(startDate: string, endDate: string): Promise<CandidateActivity[]>;
  /** READ: an activity's current exercise sets, backed up before a merge. */
  exerciseSets(activityId: number): Promise<Record<string, unknown>>;
  /** WRITE: replace an activity's exercise sets. Atomic; throws with Garmin's text. */
  putExerciseSets(activityId: number, payload: unknown): Promise<void>;
  /**
   * WRITE: delete an activity. Only the replace strategy uses it, and only
   * after the named upload succeeded and the watch's HR was secured.
   */
  deleteActivity(activityId: number): Promise<void>;
  /** READ: the raw FIT of an activity, the densest HR source there is. */
  activityFit?(activityId: number | string): Promise<Uint8Array | null>;
  /**
   * READ: Garmin's daily wrist heart rate for a date, as [epoch ms, bpm].
   * The last-resort HR source, and the only one that covers a workout the
   * watch never recorded as an activity.
   */
  dailyHeartRate?(date: string): Promise<Array<[number, number | null]>>;
}

/**
 * The default gateway: thin passthroughs to the package's Garmin functions,
 * every one of them paced and backed off.
 *
 * The limiter is applied HERE rather than inside each function in `garmin.ts`
 * for two reasons. It is one place to look, so a new Garmin call cannot be
 * added without it. And it is the boundary the engine already talks through, so
 * a consumer that supplies its own gateway keeps control of its own pacing.
 *
 * One limiter per gateway, so the spacing is shared across every call in a run
 * rather than each function keeping its own clock (#599).
 */
export function garminGateway(client: GarminClient, options: RateLimitOptions = {}): GarminGateway {
  const limit = createRateLimiter(options);
  return {
    findExistingActivity: (startTime, exclude) =>
      limit(() => findActivityByStartTime(client, startTime, exclude)),
    upload: (fit, workoutStart, exclude) => limit(() => uploadFit(client, fit, workoutStart, exclude)),
    rename: (activityId, name) => limit(() => renameActivity(client, activityId, name)),
    describe: (activityId, description) => limit(() => setDescription(client, activityId, description)),
    // Garmin's activity JSON is wider than the matcher reads, so the cast goes
    // through unknown: the matcher guards every field it touches anyway.
    activitiesByDate: async (s, e) =>
      (await limit(() => getActivitiesByDate(client, s, e))) as unknown as CandidateActivity[],
    exerciseSets: (activityId) => limit(() => getActivityExerciseSets(client, activityId)),
    putExerciseSets: (activityId, payload) => limit(() => pushExerciseSets(client, activityId, payload)),
    deleteActivity: (activityId) => limit(() => deleteActivity(client, activityId)),
    activityFit: (activityId) => limit(() => downloadActivityFit(client, activityId)),
    dailyHeartRate: (date) => limit(() => getDailyHeartRate(client, date)),
  };
}

/** What the engine needs from its host. All IO goes through these. */
export interface SyncDeps {
  store: import("./store").SyncStore;
  /** Lazily built: only called once a Garmin read/write is actually needed. */
  gateway: () => Promise<GarminGateway>;
  /** The Hevy workout list, newest first (the order the engine picks in). */
  fetchWorkouts: () => Promise<import("./types").DedupWorkout[]>;
  /**
   * Where HR comes from and where a backup is kept. Optional: a consumer that
   * supplies none still syncs, it just embeds no heart rate. The activity FIT
   * source defaults to the gateway, so most consumers only need to add durable
   * backup storage, which is the part a replace depends on.
   */
  hr?: Omit<import("../hr").HrDeps, "fetchActivityFit"> & {
    fetchActivityFit?: (activityId: number | string) => Promise<Uint8Array | null>;
  };
  /**
   * Called after a watch activity has been deleted from Garmin.
   *
   * Exists for the intervals.icu cleanup (#586): that original has usually
   * already synced there, so the named FIT replacing it arrives as a second
   * copy. Kept as a host-supplied hook rather than the engine reading the
   * environment, so a consumer embedding this engine configures it or does not,
   * and the engine stays free of third-party credentials.
   *
   * Never awaited for its result and never allowed to throw: the Garmin delete
   * has already happened, and tidying elsewhere must not fail the sync.
   *
   * The third argument says which workout the replace was for, for a hook that
   * keys what it records on the workout or needs its end. Optional, so a hook
   * written for two arguments keeps working.
   */
  onWatchActivityDeleted?: (
    activityId: number | string,
    workoutStart: string,
    context?: WatchActivityDeletedContext,
  ) => Promise<void>;
}

/** The workout whose replace just deleted the watch copy. */
export interface WatchActivityDeletedContext {
  /** The Hevy workout id. */
  hevyId: string;
  /** The Hevy workout's end, or null when the workout carries none. */
  workoutEnd: string | null;
}
