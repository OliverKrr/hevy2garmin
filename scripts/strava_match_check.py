#!/usr/bin/env python3
"""Read-only probe: can the Strava cleanup identify the stale watch copy?

``strava.try_mute_strava_activity`` looks for a Strava activity whose
``external_id`` contains the Garmin activity id. That assumption is wrong on
this account: Garmin-pushed activities arrive as ``garmin_ping_<pingId>``,
where the ping id is Garmin's push notification id and has no relation to the
activity id. So the matcher finds nothing and every replace-merge silently
leaves the duplicate behind (it fails safe — it never touches the wrong
activity).

Fixing it means matching on something else, and the only honest way to choose
is to look at what the account actually contains. This script does that, and
only that: it lists, for each recently synced workout, every Strava activity in
the window around it, so the discriminator can be picked from real data instead
of guessed. **It performs no writes** — no PUT, no rename, no mute.

Usage (needs STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN):
    python scripts/strava_match_check.py [--limit N] [--window-hours H]

Prints nothing secret: no tokens, only activity metadata already visible in the
Strava app.
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime, timedelta, timezone

import requests


def _iso(value: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=8, help="synced workouts to check")
    ap.add_argument("--window-hours", type=float, default=4.0, help="± window around the start")
    args = ap.parse_args()

    from hevy2garmin import db
    from hevy2garmin.strava import _get_access_token, _BASE_URL

    client_id = os.environ.get("STRAVA_CLIENT_ID", "")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        print("STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are not set — nothing to check.")
        return 1

    token = _get_access_token(client_id, client_secret)
    if not token:
        print("Could not obtain a Strava access token (refresh token missing or rejected).")
        return 1
    headers = {"Authorization": f"Bearer {token}"}
    base_url = os.environ.get("STRAVA_BASE_URL", _BASE_URL).rstrip("/")

    rows = db.get_db().get_recent_synced(limit=args.limit)
    if not rows:
        print("No synced workouts recorded yet.")
        return 1

    window = timedelta(hours=args.window_hours)
    would_match = 0

    for row in rows:
        gid = row.get("garmin_activity_id")
        title = row.get("title") or "?"
        start = _iso(row.get("synced_at") or "")
        if not gid or start is None:
            continue
        print(f"\n=== hevy={row.get('hevy_id')} garmin={gid} {title!r}")
        print(f"    method={row.get('sync_method')} synced_at={row.get('synced_at')}")

        try:
            resp = requests.get(
                f"{base_url}/athlete/activities",
                headers=headers,
                params={
                    "after": int((start - window).timestamp()),
                    "before": int((start + window).timestamp()),
                    "per_page": 30,
                },
                timeout=20,
            )
            resp.raise_for_status()
            activities = resp.json()
        except Exception as e:  # noqa: BLE001 — diagnostic script
            print(f"    ! list failed: {e}")
            continue

        if not activities:
            print("    (no Strava activities in the window)")
            continue

        for act in activities:
            ext = str(act.get("external_id") or "")
            hit = "MATCH" if str(gid) in ext else "     "
            print(
                f"    {hit} id={act.get('id')} start={act.get('start_date')} "
                f"type={act.get('sport_type') or act.get('type')} "
                f"elapsed={act.get('elapsed_time')}s "
                f"name={act.get('name')!r} external_id={ext!r} "
                f"upload_id={act.get('upload_id')} manual={act.get('manual')} "
                f"device={act.get('device_name')!r} hidden={act.get('hide_from_home')}"
            )
            if str(gid) in ext:
                would_match += 1

    print(
        f"\nCurrent matcher (garmin id inside external_id) would match "
        f"{would_match} activity/activities across {len(rows)} synced workouts."
    )
    print("No activity was modified: this script only issues GETs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
