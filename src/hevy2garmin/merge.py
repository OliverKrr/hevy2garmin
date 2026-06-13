"""Merge mode: combine a Hevy workout with a user-recorded Garmin activity.

When a user records a Strength Training on their Garmin watch at the gym, this
module detects the matching activity and applies the Hevy data using one of two
strategies (config key ``merge_strategy``):

* ``"exercise_sets"`` (default) — non-destructive: PUT Hevy's exercise/set data
  onto the existing activity via the exerciseSets API. The watch's 1-second HR,
  training effect, EPOC, and recovery stay intact.
* ``"fit_replace"`` — regenerate a fresh FIT (watch HR + Hevy exercises), upload
  it, and delete the original watch activity (gated by ``merge_delete_original``).
  Renders exercise names reliably via FIT enums (drkostas/hevy2garmin#138).

Public API:
    attempt_merge(client, hevy_workout, db) -> MergeResult
"""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from hevy2garmin.config import load_config
from hevy2garmin.fit import generate_fit
from hevy2garmin.garmin import (
    delete_activity,
    download_activity_fit,
    extract_hr_samples,
    find_matching_garmin_activity,
    generate_description,
    get_activity_exercise_sets,
    push_exercise_sets,
    rename_activity,
    set_description,
    upload_fit,
)
from hevy2garmin.mapper import lookup_exercise

logger = logging.getLogger("hevy2garmin")

# Circuit breaker: disable merge after N consecutive PUT failures
_MAX_CONSECUTIVE_FAILURES = 3
_consecutive_failures = 0


@dataclass
class MergeResult:
    """Result of a merge attempt."""
    merged: bool
    activity_id: int | None = None
    fallback_reason: str | None = None


def reset_circuit_breaker() -> None:
    """Reset the failure counter (call at start of each sync run)."""
    global _consecutive_failures
    _consecutive_failures = 0


def _circuit_breaker_tripped() -> bool:
    return _consecutive_failures >= _MAX_CONSECUTIVE_FAILURES


# ---------------------------------------------------------------------------
# Category int → string conversion
# ---------------------------------------------------------------------------

# FIT SDK exercise category IDs → Garmin API string names.
# These are the categories from the FIT SDK profile, used in the
# exerciseSets PUT payload.
_CATEGORY_NAMES: dict[int, str] = {
    0: "BENCH_PRESS", 1: "CALF_RAISE", 2: "CARDIO", 3: "CARRY",
    4: "CHOP", 5: "CORE", 6: "CRUNCH", 7: "CURL", 8: "DEADLIFT",
    9: "FLYE", 10: "HIP_RAISE", 11: "HIP_STABILITY", 12: "HIP_SWING",
    13: "HYPEREXTENSION", 14: "LATERAL_RAISE", 15: "LEG_CURL",
    16: "LEG_RAISE", 17: "LUNGE", 18: "OLYMPIC_LIFT", 19: "PLANK",
    20: "PLYO", 21: "PULL_UP", 22: "PUSH_UP", 23: "ROW",
    24: "SHOULDER_PRESS", 25: "SHOULDER_STABILITY", 26: "SHRUG",
    27: "SIT_UP", 28: "SQUAT", 29: "TOTAL_BODY",
    30: "TRICEPS_EXTENSION", 31: "WARM_UP", 32: "RUN",
    65534: "UNKNOWN",
}

# Subcategory names per category. Built from the FIT SDK profile.
# Only the most common ones are listed — unmapped subs fall back to
# the category's generic "0" name.
# Format: {(category_id, subcategory_id): "GARMIN_STRING_NAME"}
#
# We populate this lazily from fit_tool if available, otherwise
# use the category name as the exercise name (Garmin accepts this).

def _category_to_string(cat_id: int) -> str:
    return _CATEGORY_NAMES.get(cat_id, "UNKNOWN")


def _exercise_to_string(cat_id: int, sub_id: int) -> str | None:
    """Resolve FIT (category, subcategory) IDs to Garmin's subcategory enum name.

    Returns the valid subcategory string (e.g. ``"BARBELL_BENCH_PRESS"``) or
    ``None`` when it can't be resolved. We must NOT fall back to the parent
    category name: Garmin's ``exerciseSets`` API renders an unrecognised exercise
    *name* as **"Unknown"** (#138), whereas a ``null`` name under a valid parent
    category is accepted and shown as the category's generic label.
    """
    try:
        import fit_tool.profile.profile_type as pt
        from fit_tool.profile.profile_type import ExerciseCategory
        # e.g. BENCH_PRESS (0) → BenchPressExerciseName enum
        cat_name = ExerciseCategory(cat_id).name  # "BENCH_PRESS"
        sub_enum_cls = getattr(pt, cat_name.title().replace("_", "") + "ExerciseName", None)
        if sub_enum_cls is not None:
            return sub_enum_cls(sub_id).name
    except (ValueError, AttributeError, ImportError):
        pass
    return None


# ---------------------------------------------------------------------------
# Payload builder
# ---------------------------------------------------------------------------

def build_exercise_sets_payload(
    hevy_workout: dict,
    activity_id: int,
    activity_start_time: str,
    activity_duration_s: float,
) -> dict:
    """Convert a Hevy workout into a Garmin exerciseSets PUT payload.

    Uses the matched Garmin activity's actual start time and duration
    to distribute set timestamps across the real activity timeline.

    Args:
        hevy_workout: Hevy workout dict with exercises and sets.
        activity_id: Garmin activity ID.
        activity_start_time: Garmin activity's startTimeGMT (ISO or space-separated).
        activity_duration_s: Garmin activity's duration in seconds.
    """
    # Parse activity start
    start_str = activity_start_time.replace(" ", "T")
    if "+" not in start_str and not start_str.endswith("Z"):
        start_str += "+00:00"
    act_start = datetime.fromisoformat(start_str.replace("Z", "+00:00"))

    exercises = hevy_workout.get("exercises", [])
    if not exercises:
        return {"activityId": activity_id, "exerciseSets": []}

    # Profile timing defaults (same as fit.py uses)
    working_set_s = 40
    warmup_set_s = 25
    rest_sets_s = 75
    rest_exercises_s = 120

    # Count total sets and compute ideal duration for scaling
    all_sets: list[dict] = []
    for ex_idx, ex in enumerate(exercises):
        sets = ex.get("sets", [])
        for s_idx, s in enumerate(sets):
            is_warmup = s.get("type", "normal") == "warmup"
            explicit_dur = s.get("duration_seconds")
            if explicit_dur and explicit_dur > 0:
                set_dur = float(explicit_dur)
            else:
                set_dur = warmup_set_s if is_warmup else working_set_s

            is_last_set = s_idx == len(sets) - 1
            is_last_exercise = ex_idx == len(exercises) - 1
            if is_last_set and is_last_exercise:
                rest_dur = 0.0
            elif is_last_set:
                rest_dur = rest_exercises_s
            else:
                rest_dur = rest_sets_s

            all_sets.append({
                "ex_idx": ex_idx,
                "set_data": s,
                "set_dur": set_dur,
                "rest_dur": rest_dur,
            })

    # Scale to fit actual activity duration
    ideal_total = sum(si["set_dur"] + si["rest_dur"] for si in all_sets)
    scale = activity_duration_s / ideal_total if ideal_total > 0 else 1.0
    scale = max(0.3, min(2.0, scale))

    # Build exercise sets
    exercise_sets: list[dict] = []
    msg_idx = 0
    cursor_s = 0.0

    for si in all_sets:
        s = si["set_data"]
        ex_idx = si["ex_idx"]
        ex = exercises[ex_idx]

        cat_id, sub_id, _ = lookup_exercise(ex.get("title") or ex.get("name", "Unknown"))
        cat_str = _category_to_string(cat_id)
        sub_name = _exercise_to_string(cat_id, sub_id)
        # Garmin rejects an UNKNOWN category, so fall back to the generic
        # TOTAL_BODY *parent*. But never send the parent name (or "TOTAL_BODY")
        # as the exercise *name*: Garmin renders an unrecognised name as
        # "Unknown" (#138). A null name under a valid parent is accepted and
        # shown as the category's generic label.
        if cat_str == "UNKNOWN":
            cat_str = "TOTAL_BODY"
            sub_name = None

        set_start = act_start + timedelta(seconds=cursor_s)
        scaled_dur = si["set_dur"] * scale

        # Active set
        reps = s.get("reps")
        weight_kg = s.get("weight_kg")

        active_set: dict = {
            "exercises": [{"category": cat_str, "name": sub_name, "probability": None}],
            "duration": round(scaled_dur, 3),
            "repetitionCount": int(reps) if reps is not None else 0,
            "weight": float(round(weight_kg * 1000)) if weight_kg else 0.0,
            "setType": "ACTIVE",
            "startTime": set_start.strftime("%Y-%m-%dT%H:%M:%S.0"),
            "wktStepIndex": ex_idx,
            "messageIndex": msg_idx,
        }
        exercise_sets.append(active_set)
        msg_idx += 1
        cursor_s += scaled_dur

        # Rest set (if applicable)
        if si["rest_dur"] > 0:
            rest_start = act_start + timedelta(seconds=cursor_s)
            scaled_rest = si["rest_dur"] * scale
            rest_set: dict = {
                "exercises": [],
                "duration": round(scaled_rest, 3),
                "setType": "REST",
                "startTime": rest_start.strftime("%Y-%m-%dT%H:%M:%S.0"),
                "wktStepIndex": ex_idx,
                "messageIndex": msg_idx,
            }
            exercise_sets.append(rest_set)
            msg_idx += 1
            cursor_s += scaled_rest

    return {"activityId": activity_id, "exerciseSets": exercise_sets}


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def attempt_merge(client, hevy_workout: dict, database, overlap_threshold: float = 0.70, max_drift_minutes: int = 20) -> MergeResult:
    """Try to merge a Hevy workout into a matching watch-recorded Garmin activity.

    Finds the overlapping watch activity, then applies the Hevy data using the
    strategy named by the ``merge_strategy`` config key:

    * ``"exercise_sets"`` (default) — :func:`_exercise_sets_merge`, non-destructive.
    * ``"fit_replace"`` — :func:`_fit_replace_merge`, regenerate + replace.

    Returns MergeResult(merged=True) on success, else merged=False with a
    fallback_reason (no match, circuit breaker, upload/PUT failure).
    """
    if _circuit_breaker_tripped():
        return MergeResult(merged=False, fallback_reason="Circuit breaker: too many failures")

    match = find_matching_garmin_activity(
        client, hevy_workout,
        overlap_threshold=overlap_threshold,
        max_drift_minutes=max_drift_minutes,
    )
    if not match:
        return MergeResult(merged=False, fallback_reason="No matching Garmin activity found")

    strategy = load_config().get("merge_strategy", "exercise_sets")
    if strategy == "fit_replace":
        return _fit_replace_merge(client, hevy_workout, database, match)
    return _exercise_sets_merge(client, hevy_workout, database, match)


# ---------------------------------------------------------------------------
# Strategy: exercise_sets (PUT Hevy data onto the existing watch activity)
# ---------------------------------------------------------------------------

def _exercise_sets_merge(client, hevy_workout: dict, database, match: dict) -> MergeResult:
    """Push Hevy exercise/set data onto the matched activity via the exerciseSets API.

    Non-destructive: the watch's HR, training effect, EPOC and recovery stay
    intact; only exercise/set data is added. Exercise names render via valid FIT
    sub-category enums, or ``null`` under a valid parent category (#138).
    """
    global _consecutive_failures

    activity_id = match.get("activityId")
    act_start = match.get("startTimeGMT") or match.get("startTimeLocal", "")
    act_duration = match.get("duration", 0)

    if not activity_id or not act_start or not act_duration:
        return MergeResult(merged=False, fallback_reason="Matched activity missing required fields")

    # Backup existing exercise sets
    try:
        existing_sets = get_activity_exercise_sets(client, activity_id)
        database.set_app_config(
            f"merge_backup_{activity_id}",
            {"activity_id": activity_id, "original_sets": existing_sets},
        )
    except Exception as e:
        logger.warning("Could not backup exercise sets for %s: %s", activity_id, e)
        # Continue anyway — backup is best-effort

    # Build payload
    title = hevy_workout.get("title", "Workout")
    payload = build_exercise_sets_payload(hevy_workout, activity_id, act_start, act_duration)

    # PUT exercise sets
    try:
        push_exercise_sets(client, activity_id, payload)
        _consecutive_failures = 0
    except Exception as e:
        _consecutive_failures += 1
        logger.error("PUT exerciseSets failed for activity %s: %s", activity_id, e)
        return MergeResult(merged=False, fallback_reason=f"PUT failed: {e}")

    # Rename + set description
    try:
        rename_activity(client, activity_id, title)
        desc = generate_description(hevy_workout)
        if not desc.endswith("— synced by hevy2garmin"):
            desc += "\n— synced by hevy2garmin"
        # Prepend merge note
        desc = "⚡ Exercises synced from Hevy by hevy2garmin\n\n" + desc
        set_description(client, activity_id, desc)
    except Exception as e:
        logger.warning("Rename/description failed after merge for %s: %s", activity_id, e)
        # Non-fatal — sets were already pushed

    return MergeResult(merged=True, activity_id=activity_id)


# ---------------------------------------------------------------------------
# Strategy: fit_replace (regenerate a FIT with watch HR, upload, delete original)
# ---------------------------------------------------------------------------

def _fit_replace_merge(client, hevy_workout: dict, database, match: dict) -> MergeResult:
    """Replace the matched watch activity with a Hevy-sourced FIT carrying watch HR."""
    global _consecutive_failures

    original_id = match.get("activityId")
    if not original_id:
        return MergeResult(merged=False, fallback_reason="Matched activity missing activityId")

    # 1. Pull watch HR from its original FIT (best effort).
    watch_hr: list[int] | None
    try:
        fit_bytes = download_activity_fit(client, original_id)
        samples = extract_hr_samples(fit_bytes)
        watch_hr = samples if samples else None
        if watch_hr:
            logger.info("  Extracted %d HR samples from watch activity %s", len(watch_hr), original_id)
        else:
            logger.info("  Watch FIT for %s contained no HR records", original_id)
    except Exception as e:
        logger.warning("  Could not extract watch HR from %s: %s — uploading without watch HR", original_id, e)
        watch_hr = None

    # 2. Generate + upload the new FIT.
    wid = hevy_workout.get("id", "unknown")
    title = hevy_workout.get("title", "Workout")
    start_time = hevy_workout.get("start_time") or hevy_workout.get("startTime", "")

    try:
        with tempfile.TemporaryDirectory() as tmp:
            fit_path = str(Path(tmp) / f"{wid}.fit")
            result = generate_fit(hevy_workout, hr_samples=watch_hr, output_path=fit_path)
            logger.info(
                "  FIT: %d exercises, %d sets, %d cal",
                result["exercises"], result["total_sets"], result["calories"],
            )
            upload_result = upload_fit(client, fit_path, workout_start=start_time)
        _consecutive_failures = 0
    except Exception as e:
        _consecutive_failures += 1
        logger.error("  FIT upload failed for workout %s: %s", wid, e)
        return MergeResult(merged=False, fallback_reason=f"FIT upload failed: {e}")

    new_id = upload_result.get("activity_id")
    if not new_id:
        # Upload returned 200 but we couldn't resolve the new activity ID.
        # Don't delete the original — that would lose data.
        logger.warning("  Upload succeeded but new activity ID not found; leaving original %s in place", original_id)
        return MergeResult(merged=False, fallback_reason="Uploaded but new activity ID not resolved")

    # 3. Rename + describe the new activity.
    try:
        rename_activity(client, new_id, title)
        desc = generate_description(
            hevy_workout,
            calories=result.get("calories"),
            avg_hr=result.get("avg_hr"),
        )
        if not desc.endswith("— synced by hevy2garmin"):
            desc += "\n— synced by hevy2garmin"
        desc = "⚡ Replaced by hevy2garmin (watch HR preserved)\n\n" + desc
        set_description(client, new_id, desc)
    except Exception as e:
        logger.warning("  Rename/description failed for new activity %s: %s", new_id, e)
        # Non-fatal — the upload itself succeeded.

    # 4. Delete the original watch activity (configurable).
    cfg = load_config()
    if cfg.get("merge_delete_original", True):
        try:
            delete_activity(client, original_id)
        except Exception as e:
            logger.error(
                "  Uploaded new activity %s but failed to delete original %s: %s. "
                "You will have two strength activities at this timestamp.",
                new_id, original_id, e,
            )
    else:
        logger.info("  Kept original watch activity %s (merge_delete_original=False)", original_id)

    return MergeResult(merged=True, activity_id=new_id)
