/**
 * Sync orchestration types — shared by every consumer of the engine (the web
 * dashboard, soma, any fork). Field names are snake_case where they mirror a
 * database row or a Hevy/Garmin payload, so the Postgres store and the Python
 * pipeline read the same shapes without a mapping layer.
 */

/** Minimal shape a Hevy workout needs for dedup + upload. `id` is the Hevy id (PK). */
export interface DedupWorkout {
  id: string;
  title?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

/** What the dedup gate decided for this workout. */
export type DedupDecision =
  | "would_upload" // fresh: no terminal row, no existing Garmin activity — a real upload
  | "already_synced" // layer 1: terminal synced_workouts row exists — skip
  | "existing_garmin_activity" // layer 2: Garmin already has an activity at this start time — match, do NOT upload
  | "claim_lost" // layer 3: another worker holds the pending claim — deferred
  | "within_grace" // too new: the watch may not have uploaded its own activity yet — deferred
  | "no_candidates" // nothing left to sync
  | "no_start_time"; // workout has no start_time; can't run the layer-2 lookup safely

/** Compact FIT stats surfaced to the caller (no bytes). */
export interface FitStats {
  exercises: number;
  totalSets: number;
  calories: number;
  avgHr: number | null;
  durationS: number;
}

/**
 * Result of syncing one workout, aligned with the Python status vocabulary
 * (`sync.py:73`).
 *
 * The four states below `error` each say something a caller has to act on
 * differently, and collapsing them is what #587 and #590 were about.
 *
 * - `processing` the upload may or may not have reached Garmin. NOTHING may be
 *   re-uploaded; reconciliation has to go and look. Reporting this as `error`
 *   invites a retry, which is the one thing that must not happen.
 * - `failed` Garmin refused the import outright. There is nothing to find and
 *   waiting will not help.
 * - `needs_review` a person has to look. Used where an automatic choice would
 *   risk destroying something, such as a delete whose target is the activity we
 *   just created.
 * - `merge_pending` merge-only was asked for and no watch activity has appeared
 *   yet, so the workout is deliberately left unsynced rather than uploaded.
 *   Nothing was written to Garmin or the store; the next attempt starts clean.
 *
 * `error` and `none` stay for now because the web routes count them. Narrowing
 * those is a separate change.
 */
export interface SyncOneResult {
  status:
    | "synced"
    | "skipped"
    | "deferred"
    | "dry_run"
    | "none"
    | "error"
    | "processing"
    | "failed"
    | "needs_review"
    | "merge_pending";
  dryRun: boolean;
  /** In dry-run: true when a live run WOULD upload a fresh FIT. */
  wouldUpload: boolean;
  /**
   * The user asked for HR fusion, the activity went up, and there was no heart
   * rate to embed.
   *
   * Worth its own signal because it is the one case where a setting the user
   * turned on silently did nothing, and because Garmin recomputes calories from
   * the embedded HR. Without it the user sees only the symptom, a calorie
   * figure that disagrees with the app, and reports that instead (#343).
   * Mirrors `SyncOneResult.no_hr` at `sync.py:80`.
   */
  noHr?: boolean;
  dedupDecision: DedupDecision;
  workout: { hevy_id: string; title: string | null; start_time: string | null } | null;
  fitStats: FitStats | null;
  /** The matched/created Garmin activity id, when known. */
  existingGarminActivityId: number | null;
  garminActivityId: number | null;
  /** How many candidates remained after dedup (context for the caller). */
  remaining: number;
  syncMethod: "upload" | "match" | "merge" | null;
  error: string | null;
  /** Set when a merge was tried and fell through, so the caller can log why. */
  mergeFallbackReason?: string | null;
  /** ACTIVE sets pushed into a watch activity by a merge. */
  setsPushed?: number;
}

/** A candidate workout surfaced to a candidates listing. */
export interface CandidateWorkout {
  hevy_id: string;
  title: string | null;
  start_time: string | null;
}

/** Terminal statuses stored in synced_workouts.status. */
export type TerminalStatus = "success" | "manual" | "skipped";

/** An in-flight durable checkpoint (a pending_uploads row). */
export interface PendingRecord {
  hevy_id: string;
  phase: string;
  next_step: string | null;
  upload_id: string | null;
  garmin_activity_id: string | null;
  watch_activity_id: string | null;
  pre_upload_ids: unknown[];
  payload: Record<string, unknown>;
  resolution_source: string | null;
  attempt_count: number;
  delete_attempt_count: number;
  last_error: string | null;
  locked_until: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Fields a checkpoint update may change (mirrors the Python allow-list). */
export interface PendingUpdate {
  phase?: string;
  next_step?: string | null;
  upload_id?: string | null;
  garmin_activity_id?: string | null;
  watch_activity_id?: string | null;
  pre_upload_ids?: unknown[];
  payload?: Record<string, unknown>;
  resolution_source?: string | null;
  attempt_count?: number;
  delete_attempt_count?: number;
  last_error?: string | null;
  locked_until?: string | null;
}

/** Fields written when recording a successful upload or match. */
export interface MarkSyncedOpts {
  garminActivityId?: string | null;
  title?: string | null;
  calories?: number | null;
  avgHr?: number | null;
  hevyUpdatedAt?: string | null;
  syncMethod?: string;
}

/** Options controlling syncOneWorkout. dryRun defaults to TRUE (safe). */
export interface SyncOneOptions {
  /** DEFAULT true. When true: NO Garmin write and NO store mutation happen. */
  dryRun?: boolean;
  /** Whether to attach a text description on the activity. Default true. */
  descriptionEnabled?: boolean;
  /**
   * Sync a SPECIFIC workout by its Hevy id instead of the next candidate. It
   * must still be an unsynced candidate (all three dedup layers still gate the
   * upload); if it is not among the candidates the result is `no_candidates`.
   */
  targetHevyId?: string;
  /**
   * Hold back a workout that ended less than `graceMinutes` ago, so the watch
   * has time to upload its own activity first. DEFAULT false: an unattended run
   * (cron, auto-sync) passes true, while a person pressing Sync Now has already
   * decided they want it now.
   */
  respectGrace?: boolean;
  /** The wait applied when `respectGrace` is set. Default 120; 0 disables it. */
  graceMinutes?: number;
  /**
   * The user's merge settings, as saved on the Settings page. Omitted means
   * merge is off and the engine uploads a fresh activity, which is what it did
   * before these were wired up.
   */
  merge?: MergeSettings;
  /**
   * Merge or nothing. When merge is on and the merge finds no Garmin activity
   * to act on, return `merge_pending` instead of uploading a fresh one, so a
   * later attempt can still merge once the watch activity reaches Garmin. The
   * Python `merge_only` flag behind the webhook's staged retry (`sync.py:326`).
   *
   * "Found no activity" is the only case. A `replace` match is a match: the
   * engine goes on to upload the named activity and delete the watch copy, as
   * it would without this flag. So does a matched activity the merge could
   * not push into, because waiting will not change that answer.
   *
   * It also stands in for the grace period, which exists to wait for the
   * watch activity and is what this flag does explicitly. With merge off there
   * is nothing to merge into, the flag does nothing, and `respectGrace` applies
   * as usual. Live runs only; a dry run never merges. DEFAULT false.
   */
  mergeOnly?: boolean;
  /** The user's `hr_fusion` setting. Default on, matching the Python config. */
  hrFusion?: boolean;
  /**
   * The user's profile and timing, the way `_get_profile` feeds `generate_fit`
   * in the Python. Without it a FIT is encoded for an 80 kg person born in
   * 1990, with no timezone, whoever the user is.
   */
  profile?: Partial<import("../fit").FitProfile>;
}

/**
 * The merge half of the Settings page, in engine terms.
 *
 * Names match the stored config keys so a consumer can map them without a
 * lookup table: `merge_mode`, `merge_watch_strategy`, `merge_activity_types`,
 * `merge_overlap_pct` (as a fraction here), `merge_max_drift_min`.
 */
export interface MergeSettings {
  /** `merge_mode`. Default false in the engine: merging is opt-in per call. */
  enabled?: boolean;
  /** `merge_watch_strategy`: merge, replace or describe. Default merge. */
  watchStrategy?: "merge" | "replace" | "describe";
  /** `merge_activity_types`. Default ["strength_training"]. */
  activityTypes?: string[];
  /** `merge_overlap_pct` as a fraction of 1. Default 0.7. */
  overlapThreshold?: number;
  /** `merge_max_drift_min`. Default 20. */
  maxDriftMinutes?: number;
  /** User overrides for exercises the built-in mapping table does not cover. */
  customMappings?: Record<string, [number, number]>;
  /** The user's Timing settings, applied to the sets a merge pushes. */
  timing?: Partial<import("../exercise-sets").SetTiming>;
}

/** Options for reconcile/retry. */
export interface RecoveryOptions {
  /** Attach a text description on a retried upload. Default true. */
  descriptionEnabled?: boolean;
}

/** Result of reconcile/retry on a specific pending workout. */
export interface RecoveryResult {
  /**
   * reconciled_synced — Garmin already had it, completed as matched.
   * no_activity — reconcile found nothing on Garmin, pending left in place.
   * synced — retry re-uploaded successfully, or finalization completed.
   * not_found — no pending row for this id.
   * no_payload — the pending row has no usable stored workout.
   * error — the retry upload failed (pending parked with the error).
   * processing — the outcome is still unknown; the row stays parked and a
   *   later run resumes from its checkpoint. Not a failure, and never a reason
   *   to re-upload.
   * needs_review — a person has to look. Used where an automatic choice could
   *   destroy something or adopt an activity that is not ours.
   * failed — Garmin refused the import; there is nothing to find.
   */
  status:
    | "reconciled_synced"
    | "no_activity"
    | "synced"
    | "not_found"
    | "no_payload"
    | "error"
    | "processing"
    | "needs_review"
    | "failed";
  garminActivityId: number | null;
  error: string | null;
}
