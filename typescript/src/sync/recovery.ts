/**
 * Recovery for stuck in-flight uploads — the counterpart to syncOneWorkout for
 * a SPECIFIC pending workout rather than the next candidate.
 *
 *   reconcile — a Garmin READ: check whether Garmin already has an activity at
 *     the workout's start time. If it does, the earlier attempt actually
 *     landed, so complete the pending as a matched success (no re-upload).
 *     Otherwise leave the pending in place and record that nothing was found.
 *
 *   retry — reconcile first (never double-upload), and only if Garmin still has
 *     nothing, regenerate the FIT from the stored payload and re-upload, then
 *     finalize. A Garmin WRITE — the host gates it behind auth + confirmation.
 */
import { toUtcDate } from "../match";
import { generateDescription } from "./description";
// One direction only. `sync-one` does not import this module, so recovery may
// depend on sync and not the reverse. Keeping it that way is what stops the
// retry growing a second, worse implementation of syncing a workout.
import { syncOneWorkout } from "./sync-one";
import type { SyncDeps } from "./gateway";
import type { PendingRecord, RecoveryOptions, RecoveryResult } from "./types";

interface StoredPayload {
  workout?: Record<string, unknown>;
  title?: string;
  calories?: number;
  avg_hr?: number | null;
  description_enabled?: boolean;
  description?: string;
  sync_method?: string;
}

/** Park for review after this many failed deletes rather than retrying for ever. */
const MAX_DELETE_ATTEMPTS = 3;

function payloadOf(pending: PendingRecord): StoredPayload {
  const p = pending.payload;
  return p && typeof p === "object" ? (p as StoredPayload) : {};
}

function startTimeOf(workout: Record<string, unknown> | undefined): string | null {
  const s = workout?.start_time;
  return typeof s === "string" && s ? s : null;
}

type RecoveryDeps = Pick<SyncDeps, "store" | "gateway" | "onWatchActivityDeleted">;

/** Complete a pending as a matched Garmin activity (no upload). */
async function completeMatched(deps: RecoveryDeps, hevyId: string, pl: StoredPayload, activityId: number): Promise<void> {
  await deps.store.completePending(hevyId, {
    garminActivityId: String(activityId),
    title: pl.title ?? "",
    calories: pl.calories ?? null,
    avgHr: pl.avg_hr ?? null,
    syncMethod: "match",
  });
}

/**
 * Resume remote finalization from a durable checkpoint. Never uploads.
 *
 * A four-step machine over `next_step`, rename then description then delete
 * then commit, checkpointing after each so a crash resumes where it stopped
 * instead of starting again. Ported from `finalize_pending` in
 * `src/hevy2garmin/sync.py:116`.
 *
 * The delete is the step this exists for. A replace uploads a named activity
 * and then removes the watch copy, so a run that dies between those two leaves
 * the user with two activities for one workout, for ever. Nothing else cleans
 * that up: reconcile will not, and a later sync will not either because the
 * workout is already in the ledger.
 */
export async function finalizePending(deps: RecoveryDeps, hevyId: string): Promise<RecoveryResult> {
  const pending = await deps.store.getPending(hevyId);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };

  const activityId = Number(pending.garmin_activity_id);
  if (!Number.isFinite(activityId) || activityId <= 0) {
    return { status: "no_payload", garminActivityId: null, error: null };
  }

  const pl = payloadOf(pending);
  const watchId = pending.watch_activity_id;
  const gateway = await deps.gateway();
  let step = pending.next_step || "rename";

  try {
    if (step === "rename") {
      await gateway.rename(activityId, pl.title ?? "Workout");
      step = pl.description_enabled ? "description" : watchId ? "delete" : "commit";
      await deps.store.updatePending(hevyId, { phase: "finalizing", next_step: step, last_error: null });
    }

    if (step === "description") {
      const workout = pl.workout ?? {};
      await gateway.describe(
        activityId,
        pl.description ?? generateDescription(workout, pl.calories ?? 0, pl.avg_hr ?? null),
      );
      step = watchId ? "delete" : "commit";
      await deps.store.updatePending(hevyId, { next_step: step, last_error: null });
    }

    if (step === "delete") {
      if (!watchId) {
        step = "commit";
        await deps.store.updatePending(hevyId, { next_step: step, last_error: null });
      } else if (Number(watchId) === activityId) {
        // Deleting here would destroy the activity just created, leaving the
        // workout on neither side. A person decides instead.
        await deps.store.updatePending(hevyId, {
          phase: "needs_review",
          last_error: "replacement equals watch activity; deletion blocked",
        });
        return { status: "needs_review", garminActivityId: activityId, error: null };
      } else {
        try {
          await gateway.deleteActivity(Number(watchId));
          // Same cleanup as the happy path. Hanging it off only one of the two
          // delete sites is how a feature ends up silently not running for
          // whichever path the user actually took (#586).
          const workoutStart = startTimeOf(pl.workout);
          if (deps.onWatchActivityDeleted && workoutStart) {
            const workoutEnd = pl.workout?.end_time;
            await deps
              .onWatchActivityDeleted(Number(watchId), workoutStart, {
                hevyId,
                workoutEnd: typeof workoutEnd === "string" && workoutEnd ? workoutEnd : null,
              })
              .catch(() => {});
          }
        } catch (err) {
          // Count rather than retry for ever. Three failures against a Garmin
          // that keeps refusing is a person's problem, not a loop's.
          const attempts = (pending.delete_attempt_count ?? 0) + 1;
          const exhausted = attempts >= MAX_DELETE_ATTEMPTS;
          await deps.store.updatePending(hevyId, {
            phase: exhausted ? "needs_review" : "finalizing",
            next_step: "delete",
            delete_attempt_count: attempts,
            last_error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
          });
          return {
            status: exhausted ? "needs_review" : "processing",
            garminActivityId: activityId,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        // Python also removes it from intervals.icu here so the deleted copy
        // does not linger there. That whole integration is unported and is
        // #586, so it is deliberately absent rather than forgotten.
        step = "commit";
        await deps.store.updatePending(hevyId, { next_step: step, last_error: null });
      }
    }

    await deps.store.completePending(hevyId, {
      garminActivityId: String(activityId),
      title: pl.title ?? "",
      calories: pl.calories ?? null,
      avgHr: pl.avg_hr ?? null,
      syncMethod: pl.sync_method ?? "upload",
    });
    return { status: "synced", garminActivityId: activityId, error: null };
  } catch (err) {
    // Park at the step that failed, so the next run resumes there.
    const message = err instanceof Error ? err.message : String(err);
    await deps.store
      .updatePending(hevyId, { phase: "finalizing", next_step: step, last_error: message.slice(0, 1000) })
      .catch(() => {});
    return { status: "processing", garminActivityId: activityId, error: message };
  }
}

export async function reconcilePending(deps: RecoveryDeps, hevyId: string): Promise<RecoveryResult> {
  const pending = await deps.store.getPending(hevyId);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };

  // Garmin refused this import. There is nothing to find and looking wastes a
  // rate-limited call, so say so and stop.
  if (pending.phase === "failed") {
    return { status: "failed", garminActivityId: null, error: pending.last_error ?? null };
  }

  // The activity is already known, so this is a resume rather than a search.
  if (pending.garmin_activity_id) return finalizePending(deps, hevyId);

  const pl = payloadOf(pending);
  const startTime = startTimeOf(pl.workout);
  if (!startTime) return { status: "no_payload", garminActivityId: null, error: null };

  // Adopting an activity means recording it as the one we created. Get that
  // wrong and the workout is marked synced against something that is not ours,
  // which reads as success and is unrecoverable without the user noticing.
  //
  // Python guards it three ways and we carry two of them. The third resolves
  // the activity from the upload id, and it is NOT ported on purpose: it calls
  // `get_upload_status` / `get_activity_from_upload` behind a
  // `getattr(client, name, None)` check, and neither method exists on the
  // garminconnect client this project installs, so that branch never runs on
  // either side. Porting it would mean inventing an endpoint the reference
  // never calls, on the one path where a wrong answer is unrecoverable.
  const excluded = new Set<string>((pending.pre_upload_ids ?? []).map((x) => String(x)));
  if (pending.watch_activity_id) excluded.add(String(pending.watch_activity_id));

  // Without evidence that an upload was ever attempted, anything sitting at
  // this start time belongs to someone else. Refuse rather than guess.
  const hasRecoveryEvidence = Boolean(
    pending.upload_id ||
      (pending.pre_upload_ids ?? []).length ||
      (["processing", "finalizing", "needs_review"].includes(pending.phase) &&
        (pending.attempt_count ?? 0) > 0),
  );
  if (!hasRecoveryEvidence) {
    await deps.store.updatePending(hevyId, {
      phase: "needs_review",
      last_error: "no upload attempt checkpoint; refusing snapshot adoption",
    });
    return { status: "needs_review", garminActivityId: null, error: null };
  }

  const gateway = await deps.gateway();
  const target = toUtcDate(startTime);
  if (!target) return { status: "no_payload", garminActivityId: null, error: null };
  const day = (d: Date, off: number) => new Date(d.getTime() + off * 86_400_000).toISOString().slice(0, 10);

  let activities;
  try {
    activities = await gateway.activitiesByDate(day(target, -1), day(target, 1));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.store.updatePending(hevyId, { last_error: message.slice(0, 1000) }).catch(() => {});
    return { status: "processing", garminActivityId: null, error: message };
  }

  const candidates = activities.filter((a) => a.activityId != null && !excluded.has(String(a.activityId)));

  // Deliberately strict: exactly one activity that we made (DEVELOPMENT),
  // is strength-shaped, and starts when the workout did. Anything else is
  // ambiguous, and ambiguity here is a person's decision.
  const safe = candidates.filter((a) => {
    if (String(a.manufacturer ?? "").toUpperCase() !== "DEVELOPMENT") return false;
    const typeKey = a.activityType?.typeKey ?? "";
    if (!["strength_training", "other"].includes(typeKey)) return false;
    const started = toUtcDate(String(a.startTimeGMT ?? a.startTimeLocal ?? ""));
    return started != null && Math.abs(started.getTime() - target.getTime()) < 10 * 60 * 1000;
  });

  if (safe.length !== 1) {
    if (candidates.length) {
      await deps.store.updatePending(hevyId, {
        phase: "needs_review",
        last_error: `${candidates.length} unverified snapshot candidate(s)`,
      });
      return { status: "needs_review", garminActivityId: null, error: null };
    }
    await deps.store.updatePending(hevyId, { last_error: "reconcile: no matching Garmin activity" });
    return { status: "no_activity", garminActivityId: null, error: null };
  }

  const resolved = Number(safe[0].activityId);
  await deps.store.updatePending(hevyId, {
    phase: "finalizing",
    next_step: "rename",
    garmin_activity_id: String(resolved),
    resolution_source: "snapshot",
    last_error: null,
  });
  return finalizePending(deps, hevyId);
}

/**
 * Phases a retry may act on.
 *
 * Only a row Garmin definitively refused. Every other phase means the FIT may
 * have reached Garmin, and a retry there is how one workout becomes two: the
 * activity can still be processing, so the existing-activity lookup honestly
 * answers "nothing there" while the first copy is on its way. Python refuses
 * the same way at `cli.py:346-349`, before and after reconciling.
 */
const RETRYABLE_PHASES = new Set(["failed"]);

/**
 * Re-sync a workout whose upload was refused.
 *
 * Deliberately NOT a second implementation of "sync this workout". It clears
 * the pending row and then runs the ordinary sync at the workout, so heart
 * rate, the watch strategy, the user profile, the description setting and the
 * watch-copy delete all come from the one place they are implemented. Python
 * does the same thing for the same reason (`cli.py:361-368`), calling
 * `sync_one_workout` with `force_upload=True`.
 *
 * The previous version hand-rolled `generateFit(workout, null)` with no
 * profile and no merge, so a retried workout came back with no heart rate,
 * calories computed without it, and a standalone activity instead of the merge
 * the user asked for. It reported success while being quietly worse than every
 * other workout they had.
 */
export async function retryPending(
  deps: RecoveryDeps,
  hevyId: string,
  opts: RecoveryOptions = {},
): Promise<RecoveryResult> {
  const pending = await deps.store.getPending(hevyId);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };
  const pl = payloadOf(pending);
  const workout = pl.workout;
  const startTime = startTimeOf(workout);
  if (!workout || !startTime) return { status: "no_payload", garminActivityId: null, error: null };

  if (!RETRYABLE_PHASES.has(pending.phase)) {
    // Naming reconcile matters. A button that refuses without saying what to do
    // instead is a wall, and reconcile is the thing that actually resolves an
    // upload whose outcome is unknown.
    return {
      status: "needs_review",
      garminActivityId: null,
      error:
        `not retryable from phase '${pending.phase}': the upload may have reached Garmin. ` +
        `Reconcile it first, which resolves it without risking a second copy.`,
    };
  }

  const gateway = await deps.gateway();

  // Never double-upload, even from `failed`. Cheap, and the cost of being wrong
  // is a duplicate the user has to clean up by hand.
  const existing = await gateway.findExistingActivity(
    startTime,
    pending.watch_activity_id ? [pending.watch_activity_id] : null,
  );
  if (existing != null) {
    await completeMatched(deps, hevyId, pl, existing);
    return { status: "reconciled_synced", garminActivityId: existing, error: null };
  }

  // Free the claim. The row also keeps this workout out of the candidate list,
  // so the sync below could not see it otherwise.
  await deps.store.deletePending(hevyId);

  // Feed it the workout we stored rather than re-fetching from Hevy. Python
  // does the same (`cli.py:357-368`), and it matters for more than the saved
  // call: Hevy can be down, and the workout can have been edited since, so a
  // retry would silently sync something other than what failed.
  const result = await syncOneWorkout(
    { ...deps, fetchWorkouts: async () => [workout as Record<string, unknown>] } as SyncDeps,
    { ...opts, targetHevyId: hevyId, dryRun: false },
  );

  if (result.status === "synced") {
    return { status: "synced", garminActivityId: result.garminActivityId, error: null };
  }
  return {
    status: result.status === "processing" || result.status === "failed" ? result.status : "error",
    garminActivityId: result.garminActivityId,
    error: result.error,
  };
}
