/**
 * syncOneWorkout — the Hevy→Garmin upload engine, host-agnostic.
 *
 * DRY-RUN BY DEFAULT. Because a bad upload creates a duplicate Garmin/Strava
 * activity — a hard user constraint — the default is dryRun=true and NO Garmin
 * write and NO store mutation happen unless the caller passes { dryRun: false }.
 *
 * The three-layer never-duplicate contract:
 *
 *   Layer 1 — already resolved: a terminal `synced_workouts` row exists for
 *     the workout → SKIPPED. The pure dedup excludes these when picking the
 *     next candidate; this module re-checks the picked workout against the live
 *     ledger so a concurrent sync can't slip a just-synced id through.
 *
 *   Layer 2 — Garmin already has it: BEFORE uploading, the gateway asks Garmin
 *     whether an activity already exists at the workout's start time. If one
 *     does, we DO NOT upload (409 prevention) — we match it and rename/describe
 *     the existing activity instead.
 *
 *   Layer 3 — in-flight ledger: claimPending atomically inserts a
 *     pending_uploads row. If another process already claimed the workout, our
 *     claim loses and we defer, so two workers never double-upload.
 *
 * ALL THREE gate the upload. In dryRun mode layers 1 and 2 run (reads only) to
 * compute the decision, but NO claim, NO upload, NO finalize, NO ledger write.
 *
 * All IO goes through `SyncDeps`: the store, a lazily built Garmin gateway, and
 * the Hevy fetch. The engine itself is pure orchestration.
 */
import { generateFit, type FitResult, type HevyWorkout as FitWorkout } from "../fit";
import { GarminUploadRejected } from "../garmin";
import { dailyHrToPoints, HRBackupError, hrForSync, type HrPoint } from "../hr";
import { toUtcDate } from "../match";
import { filterUnsynced } from "./dedup";
import { generateDescription } from "./description";
import { checkGracePeriod, DEFAULT_GRACE_MINUTES } from "./grace";
import { mergeIntoWatchActivity, type MergeOptions } from "./merge";
import type { GarminGateway, SyncDeps } from "./gateway";
import type {
  CandidateWorkout,
  DedupDecision,
  DedupWorkout,
  FitStats,
  MergeSettings,
  SyncOneOptions,
  SyncOneResult,
} from "./types";

function fitStatsOf(r: FitResult): FitStats {
  return {
    exercises: r.exercises,
    totalSets: r.total_sets,
    calories: r.calories,
    avgHr: r.avg_hr,
    durationS: r.duration_s,
  };
}

/** The merge settings in the shape `mergeIntoWatchActivity` takes. */
function mergeOptionsOf(s: MergeSettings): MergeOptions {
  return {
    strategy: s.watchStrategy ?? "merge",
    overlapThreshold: s.overlapThreshold,
    maxDriftMinutes: s.maxDriftMinutes,
    activityTypes: s.activityTypes,
    customMappings: s.customMappings,
    timing: s.timing,
  };
}

/**
 * The HR sources, with the gateway filling in the activity FIT when the host
 * did not. A host still has to supply `saveBackup`/`loadBackup` for a replace
 * to be allowed: without durable storage the watch's HR cannot be protected.
 */
function hrDeps(deps: SyncDeps, gateway: GarminGateway) {
  const supplied = deps.hr ?? {};
  return {
    ...supplied,
    fetchActivityFit:
      supplied.fetchActivityFit ??
      (gateway.activityFit ? (id: number | string) => gateway.activityFit!(id) : undefined),
    dailyHr:
      supplied.dailyHr ??
      (gateway.dailyHeartRate
        ? async (start: Date, end: Date) =>
            dailyHrToPoints(await gateway.dailyHeartRate!(start.toISOString().slice(0, 10)), start, end)
        : undefined),
  };
}

function workoutView(w: DedupWorkout): SyncOneResult["workout"] {
  return {
    hevy_id: w.id,
    title: (w.title as string | null) ?? null,
    start_time: (w.start_time as string | null) ?? null,
  };
}

/** Build the "nothing to do" result. */
function emptyResult(dryRun: boolean, decision: DedupDecision, remaining: number): SyncOneResult {
  return {
    status: "none",
    dryRun,
    wouldUpload: false,
    dedupDecision: decision,
    workout: null,
    fitStats: null,
    existingGarminActivityId: null,
    garminActivityId: null,
    remaining,
    syncMethod: null,
    error: null,
  };
}

/**
 * The unsynced Hevy workouts (dedup layer 1) — everything that would be a sync
 * candidate. READ-ONLY: no Garmin call, no store write.
 */
export async function listCandidates(deps: Pick<SyncDeps, "store" | "fetchWorkouts">): Promise<CandidateWorkout[]> {
  const workouts = await deps.fetchWorkouts();
  const [syncedIds, pendingIds] = await Promise.all([deps.store.loadSyncedIds(), deps.store.loadPendingIds()]);
  const candidates = filterUnsynced(workouts, syncedIds, pendingIds);
  return candidates.map((c) => ({
    hevy_id: String(c.id),
    title: (c.title as string | null) ?? null,
    start_time: (c.start_time as string | null) ?? null,
  }));
}

/**
 * Sync the single next unsynced Hevy workout to Garmin.
 *
 * DEFAULT dryRun=true → computes the decision (next unsynced, FIT, layers 1 & 2)
 * and returns it WITHOUT any Garmin write or store mutation. Only when
 * dryRun=false does it claim → upload → finalize → mark synced.
 */
export async function syncOneWorkout(deps: SyncDeps, options: SyncOneOptions = {}): Promise<SyncOneResult> {
  const dryRun = options.dryRun ?? true; // SAFE DEFAULT
  const descriptionEnabled = options.descriptionEnabled ?? true;
  const targetHevyId = options.targetHevyId;
  const respectGrace = options.respectGrace ?? false;
  const graceMinutes = options.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const merge = options.merge ?? {};
  const mergeOptions = mergeOptionsOf(merge);
  const hrFusion = options.hrFusion ?? true;
  const profile = options.profile;
  // Only meaningful where a merge actually runs: live, with merge on.
  const mergeOnly = Boolean(options.mergeOnly) && !dryRun && Boolean(merge.enabled);
  const { store } = deps;

  // 1) Fetch the Hevy list + the dedup id-sets, then pick the next unsynced
  //    candidate (dedup layer 1, pure). Reads only.
  const workouts = await deps.fetchWorkouts();
  const [syncedIds, pendingIds] = await Promise.all([store.loadSyncedIds(), store.loadPendingIds()]);
  const candidates = filterUnsynced(workouts, syncedIds, pendingIds);
  const remaining = candidates.length;
  const workout = targetHevyId
    ? candidates.find((c) => String(c.id) === targetHevyId) ?? null
    : candidates[0] ?? null;

  if (!workout) {
    return emptyResult(dryRun, "no_candidates", 0);
  }

  // Named so the helpers below can use it without re-proving it is not null.
  const picked: DedupWorkout = workout;
  const wid = workout.id;
  const title = (workout.title as string | null) ?? "Workout";
  const startTime = (workout.start_time as string | null) ?? null;

  // Re-confirm layer 1 against the live ledger for the picked id (guards a
  // concurrent sync that resolved this id after the id-set snapshot).
  if (await store.isSynced(wid)) {
    return {
      ...emptyResult(dryRun, "already_synced", remaining),
      status: "skipped",
      workout: workoutView(workout),
    };
  }

  // The grace period. Checked before any Garmin call: a workout this new is one
  // whose watch activity may still be on the user's wrist, and uploading now is
  // what creates the duplicate the merge path exists to avoid.
  //
  // Merge-only replaces it. That mode never uploads without a watch activity
  // to merge into, so the reason for the wait is gone, and holding the
  // workout back here would stop the merge from running at all.
  if (respectGrace && !mergeOnly && checkGracePeriod(workout, graceMinutes).withinGrace) {
    return {
      ...emptyResult(dryRun, "within_grace", remaining),
      status: "deferred",
      workout: workoutView(workout),
    };
  }

  // Without a start_time we cannot run the layer-2 lookup, so we refuse to
  // upload rather than risk a duplicate. Checked BEFORE generating the FIT:
  // the encoder needs the same timestamps, and there is nothing to preview.
  if (!startTime) {
    return {
      ...emptyResult(dryRun, "no_start_time", remaining),
      status: dryRun ? "dry_run" : "deferred",
      wouldUpload: false,
      workout: workoutView(workout),
    };
  }

  // The gateway, built lazily. It comes before the FIT now: merge runs first
  // and can finish the sync without a FIT ever being encoded.
  const gateway = await deps.gateway();

  /**
   * Finish a sync that landed in the user's own watch activity: name it, write
   * the description, and record it as synced by `merge` rather than `upload`,
   * because no FIT of ours exists on Garmin.
   */
  async function finishMerge(
    activityId: number,
    setsPushed: number,
    fallbackReason: string | null = null,
  ): Promise<SyncOneResult> {
    const stats = fitStatsOf(generateFit(picked as unknown as FitWorkout, null, { profile }));
    await gateway.rename(activityId, title);
    if (descriptionEnabled) {
      await gateway.describe(activityId, generateDescription(picked, stats.calories, stats.avgHr));
    }
    await store.markSynced(wid, {
      garminActivityId: String(activityId),
      title,
      calories: stats.calories,
      avgHr: stats.avgHr,
      hevyUpdatedAt: (picked.updated_at as string | null) ?? null,
      syncMethod: "merge",
    });
    return {
      status: "synced",
      dryRun: false,
      wouldUpload: false,
      dedupDecision: "existing_garmin_activity",
      workout: workoutView(picked),
      fitStats: stats,
      existingGarminActivityId: activityId,
      garminActivityId: activityId,
      remaining,
      syncMethod: "merge",
      error: null,
      mergeFallbackReason: fallbackReason,
      setsPushed,
    };
  }

  // 2) MERGE. Live path only — merging writes to an activity the user already
  //    has, and a dry run must not touch it. This is the `merge_mode` setting.
  let watchActivityId: number | null = null;
  let mergeFallbackReason: string | null = null;
  let forceFreshUpload = false;

  if (!dryRun && merge.enabled) {
    const outcome = await mergeIntoWatchActivity(gateway, workout, mergeOptions, { store });
    if (outcome.merged && outcome.activityId != null) {
      return finishMerge(outcome.activityId, outcome.setsPushed ?? 0);
    }
    mergeFallbackReason = outcome.reason ?? null;
    // Merge-only, and the merge found no activity at all: the watch recording
    // has not reached Garmin yet, or Garmin could not be asked. Leave the
    // workout for the next attempt. Nothing was claimed or written, so there
    // is nothing to undo.
    //
    // Keyed on the activity id, not on `merged`. A `replace` match comes back
    // unmerged by design, with the id set, and treating it as "not yet" is the
    // bug the Python version had: every replace user synced only on the last
    // attempt, about 25 minutes late.
    if (mergeOnly && outcome.activityId == null) {
      return {
        ...emptyResult(false, "would_upload", remaining),
        status: "merge_pending",
        workout: workoutView(workout),
        mergeFallbackReason,
      };
    }
    // The merge was undone because Garmin dropped the exercise names. The
    // start-time lookup would match the very activity we just restored and skip
    // the upload, so it is bypassed and the workout gets a real named one.
    if (outcome.forceFreshUpload) {
      forceFreshUpload = true;
    }
    // `replace`: the watch activity is ours to delete, but only after the named
    // upload lands AND its heart rate is secured.
    if (outcome.replaceWatchActivity && outcome.activityId != null) {
      watchActivityId = outcome.activityId;
    }
  }

  // 3) HEART RATE. Also live-only: the FIT a dry run builds is thrown away, and
  //    fetching a watch FIT to fill it would be a Garmin call for nothing.
  //    This is the `hr_fusion` setting, and it runs even when the toggle is off
  //    if a replace is pending, because that path must not delete the only copy
  //    of the watch's HR.
  let hrSamples: HrPoint[] | null = null;
  if (!dryRun && (hrFusion || watchActivityId != null)) {
    try {
      // `enabled: true` even when the user's toggle is off. The call does two
      // jobs: it finds HR to embed, and on a replace it secures the watch's own
      // HR before the activity can be deleted. Switching the toggle off must
      // not become permission to destroy the only recording, so the protection
      // always runs and only the embedding is gated, as in `sync.py`.
      const hrOptions = { enabled: true, sourceActivityId: watchActivityId };
      let found = await hrForSync(workout, hrDeps(deps, gateway), hrOptions);

      // Ask a second time when the first found nothing. Garmin's daily
      // monitoring feed lags, so a workout that finished recently often has no
      // readings for its window on the first ask and does on the second. The
      // grace period makes this MORE likely rather than less, because an
      // unattended run reaches the workout not long after its window opens.
      // Python does the same at `sync.py:545-557`.
      if (!found || !found.length) {
        found = await hrForSync(workout, hrDeps(deps, gateway), hrOptions);
      }

      hrSamples = hrFusion ? found : null;
    } catch (err) {
      if (!(err instanceof HRBackupError)) throw err;
      // The watch's HR could not be secured, so the watch activity must live.
      // Merge the sets into it in place instead: the HR stays where it is, the
      // sets still land, and only the exercise names are lost. Matches the
      // Python fallback, which exists because aborting the sync here was a
      // regression users felt (#244).
      const inPlace = await mergeIntoWatchActivity(
        gateway,
        workout,
        { ...mergeOptions, strategy: "merge" },
        { store },
      );
      if (inPlace.merged && inPlace.activityId != null) {
        return finishMerge(inPlace.activityId, inPlace.setsPushed ?? 0, err.message);
      }
      // Even that failed. Keep the watch activity and upload alongside it, so
      // the workout still syncs and nothing the user had is lost.
      mergeFallbackReason = inPlace.reason ?? err.message;
      watchActivityId = null;
      forceFreshUpload = true;
    }
  }

  // 4) Generate the FIT (pure/in-memory). Runs in dry-run too, so a preview
  //    shows real stats. No IO, no upload.
  const fitResult = generateFit(workout as unknown as FitWorkout, hrSamples, { profile });
  const fitStats = fitStatsOf(fitResult);

  // 5) Layer 2 — ask Garmin whether an activity already exists at this start
  //    time (409 prevention). A READ; runs in dry-run too so the preview
  //    reflects the real decision. The activity being replaced is excluded:
  //    it sits at the same start time, and matching it would skip the upload
  //    meant to take its place.
  const existingId = forceFreshUpload
    ? null
    : await gateway.findExistingActivity(startTime, watchActivityId != null ? [watchActivityId] : null);

  if (existingId) {
    // Garmin already has this workout. NEVER upload — match it.
    if (dryRun) {
      return {
        status: "dry_run",
        dryRun: true,
        wouldUpload: false,
        dedupDecision: "existing_garmin_activity",
        workout: workoutView(workout),
        fitStats,
        existingGarminActivityId: existingId,
        garminActivityId: existingId,
        remaining,
        syncMethod: "match",
        error: null,
      };
    }
    await gateway.rename(existingId, title);
    if (descriptionEnabled) {
      await gateway.describe(existingId, generateDescription(workout, fitStats.calories, fitStats.avgHr));
    }
    await store.markSynced(wid, {
      garminActivityId: String(existingId),
      title,
      calories: fitStats.calories,
      avgHr: fitStats.avgHr,
      hevyUpdatedAt: (workout.updated_at as string | null) ?? null,
      syncMethod: "upload_fallback",
    });
    return {
      status: "synced",
      dryRun: false,
      wouldUpload: false,
      dedupDecision: "existing_garmin_activity",
      workout: workoutView(workout),
      fitStats,
      existingGarminActivityId: existingId,
      garminActivityId: existingId,
      remaining,
      syncMethod: "match",
      error: null,
    };
  }

  // 6) Fresh workout — a real upload WOULD happen. In dry-run STOP HERE.
  if (dryRun) {
    return {
      status: "dry_run",
      dryRun: true,
      wouldUpload: true,
      dedupDecision: "would_upload",
      workout: workoutView(workout),
      fitStats,
      existingGarminActivityId: null,
      garminActivityId: null,
      remaining,
      syncMethod: "upload",
      error: null,
    };
  }

  // ---- LIVE PATH (dryRun === false only) ----

  // Layer 3 — atomically claim the workout. If we lose the race, another
  // worker owns it; defer.
  const payload = {
    workout,
    title,
    calories: fitStats.calories,
    avg_hr: fitStats.avgHr,
    hevy_updated_at: (workout.updated_at as string | null) ?? null,
    sync_method: "upload",
    // Carried so a recovery run knows a watch activity is waiting to be
    // removed, rather than leaving the user with both copies.
    watch_activity_id: watchActivityId != null ? String(watchActivityId) : null,
  };
  const claimed = await store.claimPending(wid, payload);
  if (!claimed) {
    return {
      ...emptyResult(false, "claim_lost", remaining),
      status: "deferred",
      workout: workoutView(workout),
      fitStats,
    };
  }

  // Snapshot the activities around this workout BEFORE uploading. It is what
  // lets a later reconcile tell our upload apart from something that was
  // already there, and without it reconcile can adopt the user's own watch
  // recording and record it as ours. Python does the same at `sync.py:616-624`
  // and, like Python, a snapshot that throws drops the claim and re-raises
  // rather than uploading blind.
  let snapshotIds: string[] = [];
  try {
    const start = String(workout.start_time ?? workout.startTime ?? "");
    const end = String(workout.end_time ?? workout.endTime ?? "") || start;
    const from = toUtcDate(start);
    const to = toUtcDate(end) ?? from;
    if (from && to) {
      const day = (d: Date, off: number) =>
        new Date(d.getTime() + off * 86_400_000).toISOString().slice(0, 10);
      const snapshot = await gateway.activitiesByDate(day(from, -1), day(to, 1));
      snapshotIds = snapshot
        .map((a) => (a as { activityId?: number | string }).activityId)
        .filter((id): id is number | string => id != null)
        .map(String);
    }
  } catch (err) {
    await store.deletePending(wid).catch(() => {});
    throw err;
  }

  try {
    await store.updatePending(wid, {
      phase: "processing",
      attempt_count: 1,
      pre_upload_ids: snapshotIds,
      watch_activity_id: watchActivityId != null ? String(watchActivityId) : null,
    });

    // Exclude the watch copy while resolving the new activity. It shares this
    // workout's start time, so the lookup would otherwise hand back the id we
    // are about to delete and the rename, describe and delete would all land on
    // a dead activity (#596).
    const uploadResult = await gateway.upload(
      fitResult.fit,
      startTime,
      watchActivityId != null ? [watchActivityId] : null,
    );

    // Record which import this was, so a reconcile can ask Garmin about this
    // exact upload instead of guessing from start times.
    if (uploadResult.uploadId != null) {
      await store
        .updatePending(wid, { upload_id: String(uploadResult.uploadId), last_error: null })
        .catch(() => {});
    }

    // Do not trust an id that was already there. Garmin can answer with a
    // pre-existing activity, and adopting one would mark the workout synced
    // against something we did not create. Checked against the snapshot and the
    // watch copy, as `sync.py:648-651` does.
    const returned = uploadResult.activityId;
    const activityId =
      returned != null &&
      !snapshotIds.includes(String(returned)) &&
      String(returned) !== String(watchActivityId ?? "")
        ? returned
        : null;

    // No activity we are willing to call ours. Either Garmin returned nothing
    // we could resolve, or it returned something that was already there. Either
    // way we do not know what happened, so the row stays parked for reconcile
    // rather than being written as a success against a null id. Python keeps it
    // pending for the same reason (`sync.py:648-651`).
    if (activityId == null) {
      await store
        .updatePending(wid, {
          phase: "processing",
          last_error:
            returned != null
              ? `upload resolved to ${returned}, which existed before this upload`
              : "upload produced no activity id",
        })
        .catch(() => {});
      return {
        status: "processing",
        dryRun: false,
        wouldUpload: true,
        dedupDecision: "would_upload",
        workout: workoutView(workout),
        fitStats,
        existingGarminActivityId: null,
        garminActivityId: null,
        remaining,
        syncMethod: "upload",
        error: null,
        mergeFallbackReason,
      };
    }

    // Finalize: rename + describe, then write the terminal row and clear the claim.
    {
      await gateway.rename(activityId, title);
      if (descriptionEnabled) {
        await gateway.describe(activityId, generateDescription(workout, fitStats.calories, fitStats.avgHr));
      }
      // The replace strategy: our named activity is on Garmin and carries the
      // watch's HR, so the watch copy can go. Only after a successful upload,
      // and never when the upload produced no activity id.
      if (watchActivityId != null) {
        try {
          await gateway.deleteActivity(watchActivityId);
          // That copy has usually already reached intervals.icu, where the
          // named activity replacing it would otherwise show up as a duplicate.
          // Never allowed to fail the sync: the Garmin delete already happened
          // and tidying elsewhere is not worth losing it over (#586).
          if (deps.onWatchActivityDeleted && startTime) {
            await deps
              .onWatchActivityDeleted(watchActivityId, startTime, {
                hevyId: wid,
                workoutEnd: typeof workout.end_time === "string" && workout.end_time ? workout.end_time : null,
              })
              .catch(() => {});
          }
        } catch (e) {
          // Two activities is a worse outcome than one, but it is recoverable
          // and losing the sync is not. Report it and keep the success.
          mergeFallbackReason = `watch activity ${watchActivityId} could not be deleted: ${(e as Error).message}`;
        }
      }
    }
    await store.completePending(wid, {
      garminActivityId: activityId != null ? String(activityId) : null,
      title,
      calories: fitStats.calories,
      avgHr: fitStats.avgHr,
      hevyUpdatedAt: (workout.updated_at as string | null) ?? null,
      syncMethod: "upload",
    });

    return {
      status: "synced",
      dryRun: false,
      wouldUpload: true,
      dedupDecision: "would_upload",
      workout: workoutView(workout),
      fitStats,
      existingGarminActivityId: null,
      garminActivityId: activityId,
      remaining,
      syncMethod: "upload",
      error: null,
      mergeFallbackReason,
      // Fusion was on, the activity is up, and there was no HR to put in it.
      // The user turned this setting on, so the one case where it did nothing
      // should not be silent (#601).
      noHr: hrFusion && !(hrSamples && hrSamples.length),
    };
  } catch (err) {
    // Two outcomes that mean opposite things.
    //
    // A rejection is definitive: Garmin refused the import, nothing was
    // created, and no amount of looking or waiting will find it. It parks as
    // 'failed' so it stops pretending it might still resolve.
    //
    // Anything else may or may not have reached Garmin, so it parks as
    // 'processing' and reconciliation goes looking. Reporting that as an error
    // invited a retry, and a retry is exactly what must not happen here.
    const message = err instanceof Error ? err.message : String(err);
    const rejected = err instanceof GarminUploadRejected;
    try {
      await store.updatePending(wid, {
        phase: rejected ? "failed" : "processing",
        last_error: message.slice(0, 1000),
      });
    } catch {
      // If even the checkpoint write fails, drop the claim so the workout can
      // be re-evaluated rather than being wedged in a bad state.
      await store.deletePending(wid).catch(() => {});
    }
    return {
      status: rejected ? "failed" : "processing",
      dryRun: false,
      wouldUpload: true,
      dedupDecision: "would_upload",
      workout: workoutView(workout),
      fitStats,
      existingGarminActivityId: null,
      garminActivityId: null,
      remaining,
      syncMethod: "upload",
      error: message,
      mergeFallbackReason,
    };
  }
}
