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
