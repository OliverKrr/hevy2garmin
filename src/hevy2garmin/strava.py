"""Optional Strava cleanup: mute the stale watch copy after a replace-merge.

Called from the replace path when an original watch activity is deleted from
Garmin. Garmin has already pushed that watch recording to Strava (deletions do
not propagate), and the named replacement upload will be pushed too — leaving
a duplicate pair. Strava's public API has no DELETE endpoint, so the best we
can do is rename the stale copy (easy to spot for manual deletion) and mute it
(``hide_from_home`` — removed from followers' feeds; still counts in stats).

This runs only for confirmed Hevy-matched duplicates by construction — it is
invoked from the same step that deletes the Garmin watch copy, never for
standalone watch workouts.

Only runs when STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET and STRAVA_REFRESH_TOKEN
are set. Strava rotates refresh tokens: the latest one is persisted to the app
config store (DB) when possible, with the env var as bootstrap. All errors are
swallowed — never breaks the merge flow.

KNOWN NOT TO MATCH, verified 2026-08-03 against a live account. The matcher
below assumes a Garmin-pushed Strava activity carries the Garmin activity id in
``external_id``. It does not: the real value is ``garmin_ping_<pingId>``, where
the ping id is Garmin's push-notification id and bears no relation to the
activity id (observed: hevy2garmin recorded 23767105780, the corresponding
Strava activity had ``garmin_ping_605244121726``). So every lookup misses and
the duplicate stays on Strava.

It fails safe, which is why it is still here unchanged: a time-only match is
deliberately never trusted, so it warns and does nothing rather than muting
whatever happens to be nearby. Fixing it needs a different discriminator, and
picking one blind is not safe — the *replacement* activity is pushed to Strava
from Garmin too, in the same window, with the same activity type and the same
``garmin_ping_`` shape, so a sloppy rule would mute the good activity instead
of the stale one. Run ``scripts/strava_match_check.py`` (read-only) to see what
the account actually returns before changing the rule.

What the account has shown so far (probed read-only 2026-08-24, 14 months,
133 strength activities):

- The duplicate is **real but conditional**. 2026-05-02 holds three copies of
  one session: the watch recording, our replacement (pushed by Garmin three
  weeks later, when that workout was finally synced), and a third posted by
  Hevy's own Strava integration.
- On every same-evening sync since (2026-07-17 through 2026-08-20) the window
  holds **one** activity, and it is the watch copy — our replacement never
  arrives. Why the late sync got pushed and the prompt ones did not is unknown;
  Strava rejecting a near-simultaneous overlapping upload is the leading guess.
- ``device_name`` does not discriminate: merge-era activities, which are
  definitely watch recordings, report ``None`` just like our uploads do.
- Start time and duration **do**. We build the FIT from the Hevy workout, so
  our copy matches it to the second (the 2026-05-02 one was exact); watch
  recordings of the same session were never closer than 39 s on either.

Hence the report-only observation below, and the safety rule any future write
must keep: **only ever mute a stale copy in a window where our own copy is
confirmed present.** On the recent syncs it is not, so a naive time-window fix
would hide the only representation of that workout on Strava.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

import requests

logger = logging.getLogger("hevy2garmin")

_BASE_URL = "https://www.strava.com/api/v3"
_TOKEN_KEY = "strava_tokens"
DUP_PREFIX = "[dup] "


def _load_refresh_token() -> str:
    """Latest persisted refresh token, falling back to the env bootstrap."""
    try:
        from hevy2garmin import db

        stored = db.get_db().get_app_config(_TOKEN_KEY)
        if isinstance(stored, dict) and stored.get("refresh_token"):
            return stored["refresh_token"]
    except Exception:
        pass
    return os.environ.get("STRAVA_REFRESH_TOKEN", "")


def _store_refresh_token(token: str) -> None:
    try:
        from hevy2garmin import db

        db.get_db().set_app_config(_TOKEN_KEY, {"refresh_token": token})
    except Exception:
        logger.debug("Strava: could not persist rotated refresh token", exc_info=True)


def _get_access_token(client_id: str, client_secret: str) -> str | None:
    refresh_token = _load_refresh_token()
    if not refresh_token:
        return None
    try:
        resp = requests.post(
            "https://www.strava.com/oauth/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.warning("Strava: token refresh failed: %s", e)
        return None
    new_refresh = data.get("refresh_token")
    if new_refresh and new_refresh != refresh_token:
        _store_refresh_token(new_refresh)
    return data.get("access_token")


def try_mute_strava_activity(garmin_activity_id: int, workout_start: str) -> bool:
    """Rename + mute the Strava copy of a deleted Garmin watch activity.

    Locates the activity in a ±2-hour window around ``workout_start`` whose
    ``external_id`` carries the Garmin activity id (Garmin-synced Strava
    activities embed it). No match → warn and do nothing; a time-only match is
    deliberately never trusted, so the wrong activity can't be touched.

    Returns True if muted, False otherwise. Never raises.
    """
    client_id = os.environ.get("STRAVA_CLIENT_ID", "")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        return False

    base_url = os.environ.get("STRAVA_BASE_URL", _BASE_URL).rstrip("/")

    try:
        start = datetime.fromisoformat(workout_start.replace("Z", "+00:00"))
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        logger.warning("Strava cleanup: invalid workout_start %r", workout_start)
        return False

    access_token = _get_access_token(client_id, client_secret)
    if not access_token:
        return False
    headers = {"Authorization": f"Bearer {access_token}"}

    try:
        resp = requests.get(
            f"{base_url}/athlete/activities",
            headers=headers,
            params={
                "after": int((start - timedelta(hours=2)).timestamp()),
                "before": int((start + timedelta(hours=2)).timestamp()),
                "per_page": 30,
            },
            timeout=15,
        )
        resp.raise_for_status()
        activities = resp.json()
    except Exception as e:
        logger.warning("Strava cleanup: failed to list activities: %s", e)
        return False

    target = None
    for act in activities:
        if str(garmin_activity_id) in str(act.get("external_id") or ""):
            target = act
            break

    if target is None:
        logger.warning(
            "Strava cleanup: no activity with external_id containing %s in ±2h window — "
            "a stale duplicate may remain on Strava",
            garmin_activity_id,
        )
        return False

    name = target.get("name") or "Workout"
    new_name = name if name.startswith(DUP_PREFIX) else f"{DUP_PREFIX}{name}"
    try:
        resp = requests.put(
            f"{base_url}/activities/{target['id']}",
            headers=headers,
            json={"hide_from_home": True, "name": new_name},
            timeout=15,
        )
        resp.raise_for_status()
        logger.info(
            "  Strava cleanup: muted activity %s (garmin_id=%s) as %r",
            target["id"], garmin_activity_id, new_name,
        )
        return True
    except Exception as e:
        logger.warning("Strava cleanup: failed to mute activity %s: %s", target.get("id"), e)
        return False


# ---------------------------------------------------------------------------
# Report-only observation (no writes to Strava)
# ---------------------------------------------------------------------------
#
# The matcher above cannot be fixed from historical data, because the account
# does not reliably contain the pair it is meant to disambiguate. What it needs
# is a timeline: for one replace-merge, what is on Strava the moment the watch
# copy is deleted from Garmin, and what appears afterwards, when.
#
# ``observe_window`` records exactly that and writes nothing to Strava. Each
# snapshot keeps the fields that could discriminate the two copies, plus the
# signed deltas against the Hevy workout, so a rule can be chosen from measured
# values rather than guessed. ``recheck_observations`` re-snapshots the open
# records from the auto-sync loop, appending only when the window actually
# changed — so the stored history is a list of events, not a list of polls.
#
# Read it back with ``hevy2garmin strava-observations``.

_OBSERVE_KEY = "strava_observations"
_OBSERVE_MAX_RECORDS = 25
_OBSERVE_MAX_SNAPSHOTS = 15
_OBSERVE_DAYS = 21
_OBSERVE_WINDOW_HOURS = 3.0

# Strava sport types that a Hevy strength workout can plausibly land as.
_STRENGTH_TYPES = {"WeightTraining", "Workout", "Crossfit", "HighIntensityIntervalTraining"}

# How close a Strava activity must sit to the Hevy workout to be read as our own
# upload. hevy2garmin builds the FIT from the Hevy start and duration, so its
# copy matches to the second — the one confirmed instance (2026-05-02) was 0/0.
# Watch recordings of the same session came no closer than +39s/-39s, so the
# window has to stay tight: a loose one relabels the watch copy as ours and
# would later justify muting the only copy on Strava. Deltas are stored raw, so
# this can be re-tuned once the observations are in.
_OURS_TOLERANCE_S = 5


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_iso(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def _classify(entry: dict) -> str:
    """Provisional label for one Strava activity, from measured fields only."""
    if entry.get("manual") or (entry.get("device_name") or "") == "Hevy":
        return "hevy_direct"
    # Our copy reaches Strava through Garmin's push like any other, so the
    # external_id shape is a precondition, not a discriminator — it only rules
    # out anything that arrived by some other route.
    if not str(entry.get("external_id") or "").startswith("garmin_ping_"):
        return "stale"
    ds, de = entry.get("delta_start_s"), entry.get("delta_elapsed_s")
    if ds is not None and de is not None and abs(ds) <= _OURS_TOLERANCE_S and abs(de) <= _OURS_TOLERANCE_S:
        return "ours"
    return "stale"


def _summarize(act: dict, hevy_start: datetime | None, hevy_duration_s: int | None) -> dict:
    start = _parse_iso(act.get("start_date"))
    elapsed = act.get("elapsed_time")
    entry = {
        "id": act.get("id"),
        "start_date": act.get("start_date"),
        "elapsed_time": elapsed,
        "moving_time": act.get("moving_time"),
        "sport_type": act.get("sport_type") or act.get("type"),
        "name": act.get("name"),
        "external_id": act.get("external_id"),
        "upload_id": act.get("upload_id"),
        "manual": act.get("manual"),
        "device_name": act.get("device_name"),
        "hide_from_home": act.get("hide_from_home"),
        "delta_start_s": int((start - hevy_start).total_seconds()) if start and hevy_start else None,
        "delta_elapsed_s": (int(elapsed) - hevy_duration_s) if isinstance(elapsed, int) and hevy_duration_s else None,
    }
    entry["verdict"] = _classify(entry)
    return entry


def _load_records() -> list[dict]:
    try:
        from hevy2garmin import db

        stored = db.get_db().get_app_config(_OBSERVE_KEY)
    except Exception:
        return []
    records = stored.get("records") if isinstance(stored, dict) else None
    return records if isinstance(records, list) else []


def _save_records(records: list[dict]) -> None:
    try:
        from hevy2garmin import db

        db.get_db().set_app_config(_OBSERVE_KEY, {"records": records[-_OBSERVE_MAX_RECORDS:]})
    except Exception:
        logger.debug("Strava observe: could not persist observations", exc_info=True)


def _fetch_window(headers: dict, base_url: str, centre: datetime) -> list[dict] | None:
    """Strength activities around ``centre``. None on failure (distinct from empty)."""
    try:
        resp = requests.get(
            f"{base_url}/athlete/activities",
            headers=headers,
            params={
                "after": int((centre - timedelta(hours=_OBSERVE_WINDOW_HOURS)).timestamp()),
                "before": int((centre + timedelta(hours=_OBSERVE_WINDOW_HOURS)).timestamp()),
                "per_page": 50,
            },
            timeout=15,
        )
        resp.raise_for_status()
        activities = resp.json()
    except Exception as e:
        logger.warning("Strava observe: window fetch failed: %s", e)
        return None
    if not isinstance(activities, list):
        logger.warning("Strava observe: unexpected window payload %r", type(activities).__name__)
        return None
    return [a for a in activities if isinstance(a, dict) and (a.get("sport_type") or a.get("type")) in _STRENGTH_TYPES]


def _snapshot(record: dict, headers: dict, base_url: str, phase: str) -> bool:
    """Append a snapshot to ``record`` if the window changed. True if appended."""
    hevy_start = _parse_iso(record.get("hevy_start"))
    if hevy_start is None:
        return False
    raw = _fetch_window(headers, base_url, hevy_start)
    record["checks"] = int(record.get("checks") or 0) + 1
    record["last_checked_at"] = _utcnow_iso()
    if raw is None:
        return False

    entries = sorted(
        (_summarize(a, hevy_start, record.get("hevy_duration_s")) for a in raw),
        key=lambda e: str(e.get("start_date")),
    )
    snapshots = record.setdefault("snapshots", [])
    previous = snapshots[-1]["activities"] if snapshots else None
    # Ids alone would miss a rename or a mute done elsewhere, so compare the
    # fields we would act on.
    def fingerprint(items):
        return [(i.get("id"), i.get("name"), i.get("hide_from_home")) for i in items]

    if previous is not None and fingerprint(previous) == fingerprint(entries):
        return False

    snapshots.append({"at": _utcnow_iso(), "phase": phase, "activities": entries})
    del snapshots[:-_OBSERVE_MAX_SNAPSHOTS]

    verdicts = [e["verdict"] for e in entries]
    ours, stale = verdicts.count("ours"), verdicts.count("stale")
    record["ours_present"] = ours > 0
    record["stale_count"] = stale
    logger.info(
        "  Strava observe [%s] hevy=%s: %d strength activit(y/ies) in window — ours=%d stale=%d hevy_direct=%d",
        phase, record.get("hevy_id"), len(entries), ours, stale, verdicts.count("hevy_direct"),
    )
    for e in entries:
        logger.info(
            "    %-11s id=%s start=%s (%+ds) elapsed=%ss (%+ds) name=%r external_id=%r "
            "upload_id=%s manual=%s device=%r hidden=%s",
            e["verdict"], e["id"], e["start_date"], e["delta_start_s"] or 0, e["elapsed_time"],
            e["delta_elapsed_s"] or 0, e["name"], e["external_id"], e["upload_id"],
            e["manual"], e["device_name"], e["hide_from_home"],
        )
    if ours and stale:
        logger.warning(
            "  Strava observe: CONFIRMED DUPLICATE for hevy=%s — our copy and %d stale cop(y/ies) "
            "coexist. This is the evidence the cleanup rule needs.",
            record.get("hevy_id"), stale,
        )
    return True


def _session() -> tuple[dict, str] | None:
    client_id = os.environ.get("STRAVA_CLIENT_ID", "")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        return None
    access_token = _get_access_token(client_id, client_secret)
    if not access_token:
        return None
    return {"Authorization": f"Bearer {access_token}"}, os.environ.get("STRAVA_BASE_URL", _BASE_URL).rstrip("/")


def observe_window(
    *,
    hevy_id: str,
    workout_start: str,
    workout_end: str = "",
    watch_activity_id: object = None,
    replacement_activity_id: object = None,
) -> None:
    """Open an observation record for one replace-merge. Never raises, never writes.

    Called from the same step that deletes the Garmin watch copy, so the first
    snapshot captures Strava *before* our replacement could have been pushed —
    which is what makes the later comparison meaningful.
    """
    try:
        session = _session()
        if session is None:
            return
        headers, base_url = session
        start = _parse_iso(workout_start)
        end = _parse_iso(workout_end)
        if start is None:
            logger.warning("Strava observe: invalid workout_start %r", workout_start)
            return
        record = {
            "hevy_id": hevy_id,
            "hevy_start": start.isoformat(timespec="seconds"),
            "hevy_end": end.isoformat(timespec="seconds") if end else None,
            "hevy_duration_s": int((end - start).total_seconds()) if end else None,
            "watch_activity_id": str(watch_activity_id) if watch_activity_id else None,
            "replacement_activity_id": str(replacement_activity_id) if replacement_activity_id else None,
            "opened_at": _utcnow_iso(),
            "closed": False,
            "snapshots": [],
        }
        _snapshot(record, headers, base_url, phase="watch_copy_deleted")
        records = [r for r in _load_records() if r.get("hevy_id") != hevy_id]
        records.append(record)
        _save_records(records)
    except Exception:
        logger.debug("Strava observe: failed to open observation", exc_info=True)


def recheck_observations() -> None:
    """Re-snapshot open records so late arrivals land on the timeline.

    Our replacement reaches Strava via Garmin's push, which can lag the sync by
    minutes or never happen at all, so a single snapshot at delete time cannot
    answer the question. Never raises, never writes to Strava.
    """
    try:
        records = _load_records()
        cutoff = datetime.now(timezone.utc) - timedelta(days=_OBSERVE_DAYS)
        open_records = [
            r for r in records
            if not r.get("closed") and (_parse_iso(r.get("opened_at")) or cutoff) > cutoff
        ]
        if not open_records:
            return
        session = _session()
        if session is None:
            return
        headers, base_url = session
        for record in open_records:
            _snapshot(record, headers, base_url, phase="recheck")
            # Both copies seen together is the whole point of watching; stop
            # there. Anything still ambiguous keeps its slot until it ages out.
            if record.get("ours_present") and record.get("stale_count"):
                record["closed"] = True
                record["closed_reason"] = "duplicate_confirmed"
            elif (_parse_iso(record.get("opened_at")) or cutoff) <= cutoff:
                record["closed"] = True
                record["closed_reason"] = "aged_out"
        _save_records(records)
    except Exception:
        logger.debug("Strava observe: recheck failed", exc_info=True)


def format_observations() -> str:
    """Human-readable timeline of every observation record."""
    records = _load_records()
    if not records:
        return "No Strava observations recorded yet."
    lines = []
    for r in records:
        lines.append(
            f"=== hevy={r.get('hevy_id')} start={r.get('hevy_start')} "
            f"duration={r.get('hevy_duration_s')}s watch={r.get('watch_activity_id')} "
            f"replacement={r.get('replacement_activity_id')}"
        )
        lines.append(
            f"    opened={r.get('opened_at')} checks={r.get('checks')} "
            f"last={r.get('last_checked_at')} closed={r.get('closed')} "
            f"{r.get('closed_reason') or ''}"
        )
        for snap in r.get("snapshots") or []:
            lines.append(f"    --- {snap.get('at')} [{snap.get('phase')}]")
            for e in snap.get("activities") or []:
                lines.append(
                    f"        {e.get('verdict'):<11} id={e.get('id')} start={e.get('start_date')} "
                    f"({e.get('delta_start_s')}s) elapsed={e.get('elapsed_time')}s "
                    f"({e.get('delta_elapsed_s')}s) name={e.get('name')!r} "
                    f"external_id={e.get('external_id')!r} upload_id={e.get('upload_id')} "
                    f"manual={e.get('manual')} device={e.get('device_name')!r} "
                    f"hidden={e.get('hide_from_home')}"
                )
    return "\n".join(lines)
