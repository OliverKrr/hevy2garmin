"""Sync orchestrator — pulls Hevy workouts, generates FIT files, uploads to Garmin."""

from __future__ import annotations

import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hevy2garmin import db
from hevy2garmin.config import load_config
from hevy2garmin.fit import generate_fit, _parse_timestamp
from hevy2garmin.garmin import (
    GarminUploadRejected,
    activity_matches_start_time,
    activities_for_workout,
    delete_activity,
    find_activity_by_start_time,
    generate_description,
    get_client,
    rename_activity,
    set_description,
    upload_fit,
)
from hevy2garmin.hevy import HevyClient
from hevy2garmin.mapper import lookup_exercise
from hevy2garmin.merge import attempt_merge, reset_circuit_breaker
from hevy2garmin.db_interface import Database

try:  # rate-limit HR fetches like other Garmin data calls
    from garmin_auth import RateLimiter
    _hr_limiter = RateLimiter(delay=1.0)
except Exception:  # pragma: no cover
    _hr_limiter = None

logger = logging.getLogger("hevy2garmin")


@dataclass
class SyncOneResult:
    """Outcome of syncing a single Hevy workout."""

    status: str  # "synced" | "dry_run" | "deferred" | "merge_pending" | "processing" | "needs_review" | "failed"
    activity_id: int | None = None
    sync_method: str = "upload"
    merged: bool = False
    merge_fallback: bool = False
    calories: int | None = None
    avg_hr: int | None = None
    no_hr: bool = False


def _activity_id(activity: dict) -> int | None:
    try:
        value = int(str(activity.get("activityId", "")).strip("'\""))
        return value if value > 0 else None
    except (TypeError, ValueError):
        return None


def _pending_status(pending: dict | None) -> str:
    """Normalize durable phases to the public sync result statuses."""
    phase = (pending or {}).get("phase")
    return phase if phase in {"failed", "needs_review"} else "processing"


def _terminal_payload(payload: dict, activity_id: int) -> dict:
    return {
        "garmin_activity_id": str(activity_id),
        "title": payload.get("title", ""),
        "calories": payload.get("calories"),
        "avg_hr": payload.get("avg_hr"),
        "hevy_updated_at": payload.get("hevy_updated_at"),
        "sync_method": payload.get("sync_method", "upload"),
    }


def _complete(store, hevy_id: str, payload: dict, activity_id: int) -> None:
    terminal = _terminal_payload(payload, activity_id)
    if isinstance(store, Database):
        store.complete_pending(hevy_id, terminal)
    else:  # preserves compatibility with the module facade and test doubles
        store.mark_synced(hevy_id=hevy_id, **terminal)


def finalize_pending(store, client, pending: dict) -> SyncOneResult:
    """Resume remote finalization from a durable checkpoint; never uploads."""
    wid = pending["hevy_id"]
    payload = pending.get("payload") or {}
    activity_id = int(pending["garmin_activity_id"])
    watch_id = pending.get("watch_activity_id")
    step = pending.get("next_step") or "rename"
    try:
        if step == "rename":
            rename_activity(client, activity_id, payload.get("title", "Workout"))
            step = "description" if payload.get("description_enabled") else ("delete" if watch_id else "commit")
            store.update_pending(wid, phase="finalizing", next_step=step, last_error=None)
        if step == "description":
            set_description(client, activity_id, payload.get("description", ""))
            step = "delete" if watch_id else "commit"
            store.update_pending(wid, next_step=step, last_error=None)
        if step == "delete":
            if not watch_id:
                step = "commit"
                store.update_pending(wid, next_step=step, last_error=None)
            elif int(watch_id) == activity_id:
                store.update_pending(wid, phase="needs_review", last_error="replacement equals watch activity; deletion blocked")
                return SyncOneResult(status="needs_review", activity_id=activity_id)
            else:
                try:
                    delete_activity(client, int(watch_id))
                except Exception as exc:
                    attempts = int(pending.get("delete_attempt_count") or 0) + 1
                    phase = "needs_review" if attempts >= 3 else "finalizing"
                    store.update_pending(wid, phase=phase, next_step="delete", delete_attempt_count=attempts, last_error=str(exc)[:1000])
                    return SyncOneResult(status="needs_review" if phase == "needs_review" else "processing", activity_id=activity_id)
                # Also remove it from intervals.icu so the deleted watch copy
                # doesn't linger as a duplicate when the named activity syncs
                # across. No-op unless ICU creds are set; never raises.
                workout_start = (payload.get("workout") or {}).get("start_time", "")
                if workout_start:
                    from hevy2garmin.intervals_icu import try_delete_icu_activity

                    try_delete_icu_activity(int(watch_id), workout_start)
                step = "commit"
                store.update_pending(wid, next_step=step, last_error=None)
        _complete(store, wid, payload, activity_id)
        return SyncOneResult(status="synced", activity_id=activity_id, sync_method=payload.get("sync_method", "upload"), merge_fallback=payload.get("merge_fallback", False), calories=payload.get("calories"), avg_hr=payload.get("avg_hr"))
    except Exception as exc:
        store.update_pending(wid, phase="finalizing", next_step=step, last_error=str(exc)[:1000])
        return SyncOneResult(status="processing", activity_id=activity_id)


def reconcile_pending(store, client, hevy_id: str) -> SyncOneResult:
    """Discover an accepted activity or resume finalization without uploading."""
    pending = store.get_pending(hevy_id)
    if not pending:
        raise ValueError(f"no pending operation for {hevy_id}")
    if pending.get("phase") == "failed":
        return SyncOneResult(status="failed")
    if pending.get("garmin_activity_id"):
        return finalize_pending(store, client, pending)
    upload_id = pending.get("upload_id")
    if upload_id:
        for method_name in ("get_upload_status", "get_activity_from_upload"):
            method = getattr(client, method_name, None)
            if not callable(method):
                continue
            try:
                response = method(upload_id)
                raw_id = response.get("activityId") or response.get("activity_id") or response.get("internalId") if isinstance(response, dict) else None
                resolved = int(str(raw_id).strip("'\"")) if raw_id else None
            except Exception:
                continue
            if resolved and str(resolved) not in {str(pending.get("watch_activity_id")), *map(str, pending.get("pre_upload_ids", []))}:
                store.update_pending(hevy_id, phase="finalizing", next_step="rename", garmin_activity_id=str(resolved), resolution_source="upload_id", last_error=None)
                return finalize_pending(store, client, store.get_pending(hevy_id))
    phase = pending.get("phase")
    attempt_count = int(pending.get("attempt_count") or 0)
    has_recovery_evidence = bool(
        upload_id
        or pending.get("pre_upload_ids")
        or (phase in {"processing", "finalizing", "needs_review"} and attempt_count > 0)
    )
    if not has_recovery_evidence:
        store.update_pending(
            hevy_id,
            phase="needs_review",
            last_error="no upload attempt checkpoint; refusing snapshot adoption",
        )
        return SyncOneResult(status="needs_review")
    workout = (pending.get("payload") or {}).get("workout") or {}
    try:
        activities = activities_for_workout(client, workout)
    except Exception as exc:
        store.update_pending(hevy_id, last_error=str(exc)[:1000])
        return SyncOneResult(status="processing")
    excluded = {str(x) for x in pending.get("pre_upload_ids", [])}
    if pending.get("watch_activity_id"):
        excluded.add(str(pending["watch_activity_id"]))
    candidates = [a for a in activities if _activity_id(a) and str(_activity_id(a)) not in excluded]
    start_time = workout.get("start_time") or workout.get("startTime", "")
    # Snapshot-only recovery is deliberately strict: exactly one matching
    # DEVELOPMENT strength activity at the workout's start time.
    safe = [
        a for a in candidates
        if str(a.get("manufacturer", "")).upper() == "DEVELOPMENT"
        and (a.get("activityType") or {}).get("typeKey") in {"strength_training", "other"}
        and activity_matches_start_time(a, start_time)
    ]
    if len(safe) != 1:
        if candidates:
            store.update_pending(hevy_id, phase="needs_review", last_error=f"{len(candidates)} unverified snapshot candidate(s)")
            return SyncOneResult(status="needs_review")
        return SyncOneResult(status="processing")
    activity_id = _activity_id(safe[0])
    store.update_pending(hevy_id, phase="finalizing", next_step="rename", garmin_activity_id=str(activity_id), resolution_source="snapshot", last_error=None)
    return finalize_pending(store, client, store.get_pending(hevy_id))


def _workout_within_grace(workout: dict, grace_minutes: int) -> bool:
    """True when the workout ended less than ``grace_minutes`` ago."""
    if grace_minutes <= 0:
        return False
    end_raw = workout.get("end_time") or workout.get("endTime", "")
    end_dt = _parse_timestamp(end_raw)
    if end_dt is None or end_dt.tzinfo is None:
        return False
    age_min = (datetime.now(timezone.utc) - end_dt).total_seconds() / 60.0
    return age_min < grace_minutes


def fetch_workouts(
    hevy: HevyClient,
    limit: int | None = None,
    since: str | None = None,
    fetch_all: bool = False,
) -> list[dict]:
    """Fetch workouts from Hevy with optional limit, date filter, or full history.

    Args:
        hevy: HevyClient instance.
        limit: Max workouts to fetch (None = use default or all).
        since: ISO date string — stop fetching at this date.
        fetch_all: If True, paginate through entire history.
    """
    if not fetch_all and limit and limit <= 10:
        data = hevy.get_workouts(page=1, page_size=limit)
        return data.get("workouts", [])[:limit]

    all_workouts: list[dict] = []
    page = 1
    while True:
        page_size = min(10, limit - len(all_workouts)) if limit else 10
        if page_size <= 0:
            break
        data = hevy.get_workouts(page=page, page_size=page_size)
        workouts = data.get("workouts", [])
        if not workouts:
            break
        for w in workouts:
            start = w.get("start_time") or w.get("startTime", "")
            if since and start < since:
                logger.info("Reached date boundary (%s), stopping", since)
                return all_workouts
            all_workouts.append(w)
            if limit and len(all_workouts) >= limit:
                return all_workouts
        logger.info("  Fetched %d workouts so far...", len(all_workouts))
        if page >= data.get("page_count", page):
            break
        page += 1
    return all_workouts


def _estimate_fit_stats(workout: dict, hr_samples: list[int] | None = None) -> dict:
    """Generate a FIT file in a temp dir to obtain calorie/HR estimates."""
    with tempfile.TemporaryDirectory() as tmp:
        fit_path = str(Path(tmp) / f"{workout.get('id', 'workout')}.fit")
        return generate_fit(workout, hr_samples=hr_samples, output_path=fit_path)


def sync_one_workout(
    workout: dict,
    *,
    cfg: dict[str, Any],
    garmin_client=None,
    dry_run: bool = False,
    force_upload: bool = False,
    respect_grace: bool = False,
    merge_only: bool = False,
    database: Any | None = None,
) -> SyncOneResult:
    """Sync one Hevy workout to Garmin (merge, FIT upload, or dry-run).

    When ``respect_grace`` is True (autosync/cron), too-new workouts return
    ``status="deferred"`` so a watch activity can land before we upload.

    When ``merge_only`` is True (webhook staged retry), a merge attempt that
    does not land returns ``status="merge_pending"`` instead of falling back
    to a plain FIT upload, so a later retry can merge once the watch activity
    has reached Garmin Connect.

    Raises on FIT generation / upload failures so callers can map errors.
    """
    merge_store = database if database is not None else db
    wid = workout.get("id", "unknown")
    title = workout.get("title", "Workout")
    start_time = workout.get("start_time") or workout.get("startTime", "")

    if not dry_run:
        pending = merge_store.get_pending(wid)
        if isinstance(pending, dict) and pending:
            status = _pending_status(pending)
            logger.debug("Skipping %s (%s) — pending upload is %s", wid, title, pending.get("phase"))
            return SyncOneResult(status=status)

    grace_minutes = cfg.get("sync", {}).get("grace_period_minutes", 120)
    if respect_grace and _workout_within_grace(workout, grace_minutes):
        end_raw = workout.get("end_time") or workout.get("endTime", "")
        end_dt = _parse_timestamp(end_raw)
        age_min = (
            (datetime.now(timezone.utc) - end_dt).total_seconds() / 60.0
            if end_dt is not None
            else 0.0
        )
        logger.info(
            "  Deferring %s — ended %.0f min ago (< %d min grace); waiting for watch data",
            wid,
            age_min,
            grace_minutes,
        )
        return SyncOneResult(status="deferred")

    logger.info("Syncing: %s (%s)", title, wid)

    merge_mode = cfg.get("merge_mode", True)
    merge_overlap_pct = cfg.get("merge_overlap_pct", 70) / 100.0
    merge_max_drift_min = cfg.get("merge_max_drift_min", 20)
    merge_activity_types = set(cfg.get("merge_activity_types", ["strength_training"]))
    merge_watch_strategy = cfg.get("merge_watch_strategy", "replace")
    description_enabled = cfg.get("description_enabled", True)
    hr_fusion_on = cfg.get("hr_fusion", {}).get("enabled", True)

    merge_forced_fresh = False
    merge_delete_id = None
    protected_source_hr = None

    if merge_mode and garmin_client and not dry_run:
        merge_result = attempt_merge(
            garmin_client,
            workout,
            merge_store,
            overlap_threshold=merge_overlap_pct,
            max_drift_minutes=merge_max_drift_min,
            activity_types=merge_activity_types,
            watch_strategy=merge_watch_strategy,
        )
        if merge_result.merged:
            fit_stats = _estimate_fit_stats(workout)
            merge_store.mark_synced(
                hevy_id=wid,
                garmin_activity_id=str(merge_result.activity_id),
                title=title,
                calories=fit_stats.get("calories"),
                avg_hr=fit_stats.get("avg_hr"),
                hevy_updated_at=workout.get("updated_at"),
                sync_method="merge",
            )
            logger.info("  ⚡ Enhanced → Garmin activity %s", merge_result.activity_id)
            return SyncOneResult(
                status="synced",
                activity_id=merge_result.activity_id,
                sync_method="merge",
                merged=True,
                calories=fit_stats.get("calories"),
                avg_hr=fit_stats.get("avg_hr"),
            )

        logger.info("  Merge fallback: %s", merge_result.fallback_reason)
        merge_forced_fresh = merge_result.force_fresh_upload
        merge_delete_id = merge_result.delete_after_upload
        merge_fallback = True

        # merge_only: caller (webhook retry loop) wants merge or nothing.
        # Don't fall back to a plain FIT upload — leave the workout unsynced
        # so the next retry attempt can try the merge again once the Garmin
        # watch activity has had more time to sync.
        if merge_only and not dry_run:
            logger.info(
                "  merge_only: no mergeable Garmin watch activity yet for '%s', will retry",
                title,
            )
            return SyncOneResult(status="merge_pending", merge_fallback=True)
    else:
        merge_fallback = False

    if merge_delete_id is not None and not dry_run:
        # Deletion is allowed only after the best-known source HR is durable.
        # This runs even when HR embedding is disabled: disabling fusion should
        # not discard the only recoverable high-resolution recording.
        from hevy2garmin.hr import require_activity_hr_backup

        protected_source_hr = require_activity_hr_backup(
            merge_store,
            garmin_client,
            workout,
            merge_delete_id,
            _hr_limiter,
        )

    hr_samples = None
    if not dry_run and hr_fusion_on:
        from hevy2garmin.hr import extract_hevy_hr, hr_for_sync, merge_hr_sources

        if protected_source_hr:
            hr_samples = merge_hr_sources(
                extract_hevy_hr(workout), protected_source_hr
            ) or None
        else:
            hr_samples = hr_for_sync(
                merge_store, garmin_client, workout, cfg, _hr_limiter
            )
        if not hr_samples:
            # One retry — the watch's daily HR for this window may not
            # have settled on the first try.
            hr_samples = hr_for_sync(
                merge_store, garmin_client, workout, cfg, _hr_limiter
            )

    with tempfile.TemporaryDirectory() as tmp:
        fit_path = str(Path(tmp) / f"{wid}.fit")
        result = generate_fit(workout, hr_samples=hr_samples, output_path=fit_path)
        logger.info(
            "  FIT: %d exercises, %d sets, %d cal",
            result["exercises"],
            result["total_sets"],
            result["calories"],
        )

        if dry_run:
            logger.info("  [DRY RUN] Would upload %s", fit_path)
            return SyncOneResult(
                status="dry_run",
                merge_fallback=merge_fallback,
                calories=result.get("calories"),
                avg_hr=result.get("avg_hr"),
            )

        existing_id = None
        uploaded = False
        exclude_ids = [merge_delete_id] if merge_delete_id else None
        if start_time and not force_upload and not merge_forced_fresh:
            existing_id = find_activity_by_start_time(
                garmin_client,
                start_time,
                exclude_activity_ids=exclude_ids,
            )

        if existing_id:
            logger.info("  Activity already on Garmin (%s), skipping upload", existing_id)
            activity_id = existing_id
        else:
            sync_method = "upload_fallback" if merge_mode else "upload"
            desc = generate_description(workout, calories=result.get("calories"), avg_hr=result.get("avg_hr")) if description_enabled else ""
            pending_payload = {
                "workout": workout,
                "title": title,
                "description": desc,
                "description_enabled": description_enabled,
                "calories": result.get("calories"),
                "avg_hr": result.get("avg_hr"),
                "hevy_updated_at": workout.get("updated_at"),
                "sync_method": sync_method,
                "merge_fallback": merge_fallback,
            }
            claimed = merge_store.claim_pending(wid, pending_payload)
            if claimed is False:
                pending = merge_store.get_pending(wid)
                return SyncOneResult(status=_pending_status(pending))
            try:
                snapshot = activities_for_workout(garmin_client, workout)
                snapshot_ids = [str(x) for a in snapshot if (x := _activity_id(a))]
            except Exception:
                merge_store.delete_pending(wid)
                raise
            merge_store.update_pending(wid, pre_upload_ids=snapshot_ids, watch_activity_id=str(merge_delete_id) if merge_delete_id else None, phase="processing", attempt_count=1)
            try:
                upload_result = upload_fit(
                    garmin_client,
                    fit_path,
                    workout_start=start_time,
                    exclude_activity_ids=exclude_ids,
                )
            except GarminUploadRejected as exc:
                merge_store.update_pending(wid, phase="failed", last_error=str(exc)[:1000])
                return SyncOneResult(status="failed", merge_fallback=merge_fallback)
            except Exception as exc:
                # The request may have reached Garmin. Park it; never resubmit automatically.
                merge_store.update_pending(wid, phase="processing", last_error=str(exc)[:1000])
                return SyncOneResult(status="processing", merge_fallback=merge_fallback)
            raw_id = upload_result.get("activity_id")
            activity_id = int(raw_id) if raw_id and str(raw_id).isdigit() else None
            upload_id = upload_result.get("upload_id")
            merge_store.update_pending(wid, upload_id=str(upload_id) if upload_id else None, last_error=None)
            if activity_id and str(activity_id) not in set(snapshot_ids) and (not merge_delete_id or activity_id != int(merge_delete_id)):
                merge_store.update_pending(wid, phase="finalizing", next_step="rename", garmin_activity_id=str(activity_id), resolution_source="response")
                if isinstance(merge_store, Database):
                    pending_after = merge_store.get_pending(wid)
                else:
                    pending_after = {
                        "hevy_id": wid, "phase": "finalizing", "next_step": "rename",
                        "garmin_activity_id": str(activity_id),
                        "watch_activity_id": str(merge_delete_id) if merge_delete_id else None,
                        "payload": pending_payload, "delete_attempt_count": 0,
                    }
                finalized = finalize_pending(merge_store, garmin_client, pending_after)
                finalized.no_hr = bool(hr_fusion_on and not hr_samples)
                return finalized
            return SyncOneResult(status="processing", merge_fallback=merge_fallback)

        if activity_id:
            rename_activity(garmin_client, activity_id, title)
            if description_enabled:
                desc = generate_description(
                    workout,
                    calories=result.get("calories"),
                    avg_hr=result.get("avg_hr"),
                )
                set_description(garmin_client, activity_id, desc)

        sync_method = "upload_fallback" if merge_mode else "upload"
        merge_store.mark_synced(
            hevy_id=wid,
            garmin_activity_id=str(activity_id) if activity_id else None,
            title=title,
            calories=result.get("calories"),
            avg_hr=result.get("avg_hr"),
            hevy_updated_at=workout.get("updated_at"),
            sync_method=sync_method,
        )
        no_hr = bool(hr_fusion_on and uploaded and not hr_samples)
        if no_hr:
            logger.warning(
                "  ⚠ No heart-rate data available for %s — activity uploaded without HR",
                wid,
            )
        logger.info("  ✓ Synced → Garmin activity %s", activity_id)
        return SyncOneResult(
            status="synced",
            activity_id=activity_id,
            sync_method=sync_method,
            merge_fallback=merge_fallback,
            calories=result.get("calories"),
            avg_hr=result.get("avg_hr"),
            no_hr=no_hr,
        )


def sync(
    config: dict[str, Any] | None = None,
    limit: int | None = None,
    since: str | None = None,
    fetch_all: bool = False,
    dry_run: bool = False,
    respect_grace: bool = True,
    record_log: bool = True,
    log_trigger: str | None = None,
    **overrides: Any,
) -> dict:
    """Sync Hevy workouts to Garmin Connect.

    Args:
        config: Config dict (loaded from file if None).
        limit: Max workouts to sync.
        since: ISO date — sync workouts after this date.
        fetch_all: Sync entire Hevy history.
        dry_run: Generate FIT files but don't upload.
        respect_grace: Defer too-new workouts when True (autosync/cron).
        record_log: Persist a sync_log row when True.
        log_trigger: Override sync_log trigger (default: cli or github-actions).
        **overrides: Override config values (hevy_api_key, garmin_email, garmin_password).

    Returns:
        Dict with sync stats: synced, skipped, failed, total, unmapped.
    """
    cfg = config or load_config()
    candidate_store = db.get_db() if callable(getattr(db, "get_db", None)) else None
    store = candidate_store if isinstance(candidate_store, Database) else db
    hevy_api_key = overrides.get("hevy_api_key") or cfg.get("hevy_api_key")
    garmin_email = overrides.get("garmin_email") or cfg.get("garmin_email")
    garmin_password = overrides.get("garmin_password") or cfg.get("garmin_password", "")
    garmin_token_dir = cfg.get("garmin_token_dir", "~/.garminconnect")
    skip_existing = cfg.get("sync", {}).get("skip_existing", True)

    if not limit and not fetch_all and not since:
        limit = cfg.get("sync", {}).get("default_limit", 10)

    hevy = HevyClient(api_key=hevy_api_key)
    total_count = hevy.get_workout_count()
    logger.info("Hevy reports %d total workouts", total_count)

    workouts = fetch_workouts(hevy, limit=limit, since=since, fetch_all=fetch_all)
    logger.info("Fetched %d workouts to process", len(workouts))

    garmin_client = None
    if not dry_run:
        logger.info("Authenticating with Garmin Connect...")
        garmin_client = get_client(garmin_email, garmin_password, garmin_token_dir)
        logger.info("Authenticated successfully")

    merge_mode = cfg.get("merge_mode", True)
    stats = {
        "synced": 0,
        "skipped": 0,
        "failed": 0,
        "total": len(workouts),
        "unmapped": [],
        "merged": 0,
        "merge_fallback": 0,
        "deferred": 0,
        "no_hr": 0,
        "duplicates": 0,
        "processing": 0,
        "needs_review": 0,
    }

    if merge_mode:
        reset_circuit_breaker()
        logger.info("Merge mode enabled — will try to enhance watch activities")

    pending_by_id = {}
    if not dry_run:
        pending_by_id = {row["hevy_id"]: row for row in store.list_pending()}

    for workout in workouts:
        wid = workout.get("id", "unknown")
        title = workout.get("title", "Workout")

        if skip_existing and store.is_synced(wid):
            logger.debug("Skipping %s (%s) — already synced", wid, title)
            stats["skipped"] += 1
            continue

        pending = pending_by_id.get(wid)
        if pending:
            phase = pending.get("phase")
            bucket = _pending_status(pending)
            logger.debug("Skipping %s (%s) — pending upload is %s", wid, title, phase)
            stats[bucket] += 1
            continue

        for ex in workout.get("exercises", []):
            ex_name = ex.get("title") or ex.get("name", "")
            cat, _, _ = lookup_exercise(ex_name, ex.get("exercise_template_id"))
            if cat == 65534 and ex_name not in stats["unmapped"]:
                stats["unmapped"].append(ex_name)

        try:
            one = sync_one_workout(
                workout,
                cfg=cfg,
                garmin_client=garmin_client,
                dry_run=dry_run,
                respect_grace=respect_grace,
                database=store,
            )
            if one.status == "deferred":
                stats["deferred"] += 1
                continue
            if one.status == "processing":
                stats["processing"] += 1
                continue
            if one.status == "needs_review":
                stats["needs_review"] += 1
                continue
            if one.status == "failed":
                stats["failed"] += 1
                continue

            if one.status == "dry_run":
                stats["synced"] += 1
            elif one.merged:
                stats["synced"] += 1
                stats["merged"] += 1
            else:
                stats["synced"] += 1
                if one.merge_fallback:
                    stats["merge_fallback"] += 1
            if one.no_hr:
                stats["no_hr"] += 1
        except Exception as e:
            logger.error("  ✗ Failed to sync %s: %s", wid, e)
            stats["failed"] += 1

    if stats["unmapped"]:
        logger.warning("\nUnmapped exercises: %s", ", ".join(stats["unmapped"]))
        logger.warning(
            'Add custom mappings: hevy2garmin map "Exercise Name" --category N --subcategory N'
        )

    # Log-only duplicate scan (best-effort; never breaks a sync).
    if not dry_run and garmin_client:
        try:
            from hevy2garmin.reconcile import detect_duplicates
            dups = detect_duplicates(garmin_client, workouts, _hr_limiter)
            stats["duplicates"] = len(dups)
            if dups:
                logger.warning(
                    "Found %d possible duplicate activity pair(s) from past races",
                    len(dups),
                )
        except Exception:
            logger.debug("duplicate scan skipped", exc_info=True)

    if record_log:
        trigger = log_trigger
        if trigger is None:
            trigger = "cli"
            if os.environ.get("GITHUB_ACTIONS"):
                trigger = "github-actions"
        store.record_sync_log(
            synced=stats["synced"],
            skipped=stats["skipped"],
            failed=stats["failed"],
            trigger=trigger,
        )

    return stats
