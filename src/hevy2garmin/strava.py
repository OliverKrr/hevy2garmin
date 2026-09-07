"""Optional Strava cleanup: mute the stale watch copy after a replace-merge.

When the replace path deletes a watch activity from Garmin, Garmin has usually
already pushed that recording to Strava, and deletions do not propagate. Our
named replacement is pushed separately, later, leaving a duplicate pair. Strava
has no DELETE endpoint for activities, so the most a cleanup can do is rename
the stale copy with ``DUP_PREFIX`` and set ``hide_from_home`` — out of
followers' feeds, still in the athlete's totals, still easy to find and delete
by hand.

The hard part is not the write, it is knowing *which* copy is stale, and every
attempt to answer that from a single look at the window has been wrong:

- ``external_id`` does not carry the Garmin activity id the way intervals.icu's
  does. It is ``garmin_ping_<pingId>``, Garmin's push-notification id, unrelated
  to the activity (23767105780 arrived as ``garmin_ping_605244121726``). The
  original matcher keyed on this and never once fired.
- ``start_date`` is Strava's first *record* timestamp, not the FIT session
  start, and HR fusion gives our upload the watch's samples — so both copies of
  a session report the same start.
- ``device_name`` looks decisive on any single pair and is not: merge-era watch
  recordings report ``None`` exactly like our uploads do.

So this module does not try to recognise the stale copy at all. It observes.
``observe_window`` snapshots the window at the moment the watch copy is deleted
from Garmin — before our replacement exists anywhere, so before Garmin could
have pushed it — and keeps that as the record's baseline. Anything in it
predates our upload and therefore cannot be ours; anything appearing later is.
``recheck_observations`` re-snapshots from the sync paths until our copy shows
up, and only then, and only in ``mute`` mode, does it write.

That ordering is the safety property: **a stale copy is only ever muted in a
window where our own copy is confirmed present**, so the workout always keeps a
visible representation on Strava. The timings are recorded too, but they only
ever rule an activity *out* of being ours — see ``_SPAN_TOLERANCE_S`` for why
they cannot rule one in.

Runs only when STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET and STRAVA_REFRESH_TOKEN
are set, and writes only when STRAVA_CLEANUP_MODE=mute. Strava rotates refresh
tokens: the latest is persisted to the app config store (DB), with the env var
as bootstrap. All errors are swallowed — this must never break a sync.

Inspect what has been recorded with ``hevy2garmin strava-observations``;
``scripts/strava_match_check.py`` is an ad-hoc read-only probe of the raw API.

What the account has shown (read-only sweep 2026-08-24 over 14 months, plus the
first observed pair on 2026-08-25):

- The duplicate is **real**. On 2026-08-25 the window held one activity when we
  deleted the watch copy from Garmin and two an hour later, the second pushed by
  Garmin from our own replacement. 2026-05-02 holds three copies of one session,
  the extra one posted by Hevy's own Strava integration.
- It happens **every time**, and it does not heal itself. Every replace-merge
  observed since (2026-08-31, 09-02, 09-07) found exactly one stale copy in the
  delete-time baseline. The earlier read-only sweep over 2026-07-17 to 08-20
  saw a single activity per session only because the athlete had already
  deleted the duplicates by hand; the three observed stale copies went 404 the
  same way. Garmin's deletion never propagated to any of them.
- ``device_name`` does not decide it. On 2026-08-25 the watch copy reported
  ``Garmin Enduro 3`` and ours ``None``, but merge-era activities — definitely
  watch recordings, since merge neither uploads nor deletes — report ``None``
  too.
- ``start_date`` does not decide it either, and this is the trap: Strava reports
  the first *record* timestamp rather than the FIT session start, and HR fusion
  gives our upload the watch's samples, so on 2026-08-25 **both copies reported
  the same start**, 64 s after the Hevy start.
- The **end** does not decide it, though for three sessions it looked like it
  might. Strava takes the end from the last record too, so our copy ends at
  ``min(watch_end, hevy_end)``: when the watch ran past the Hevy end ours was
  clipped to it (0 s on 2026-08-25 and 2026-08-05, -8 s on 2026-08-20) and the
  watch copy kept its overhang (+16 s on 2026-08-25), but when the watch stops
  early both copies land on the same end — 2026-09-07, watch stopped 32 s
  early, **both copies -14 s**. The end measures the watch, not the copy.

So the observation below identifies the stale copy by **provenance, not
timing**: whatever is already in the window when the watch copy is deleted from
Garmin predates our upload and therefore cannot be ours. The timings are kept
to rule out unrelated recordings and as the (weak, never-writing) fallback when
that baseline could not be taken.

The safety rule any future write must keep: **only ever mute a stale copy in a
window where our own copy is confirmed present.**
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

# What the cleanup is allowed to do:
#   off     — nothing at all, not even the read-only observation
#   report  — observe and log; never touches Strava (default)
#   mute    — observe, and once a duplicate is confirmed, rename the stale copy
#             with DUP_PREFIX and hide it from followers' feeds
#
# The default is deliberately not "mute". Strava has no DELETE endpoint, so the
# write is a rename plus hide_from_home on a public feed, and every earlier
# attempt to identify the stale copy from timings alone was wrong. Arm it per
# deployment once its own observations look right.
_MODES = ("off", "report", "mute")


def _mode() -> str:
    mode = os.environ.get("STRAVA_CLEANUP_MODE", "report").strip().lower()
    if mode not in _MODES:
        logger.warning("Strava: unknown STRAVA_CLEANUP_MODE %r, treating as 'report'", mode)
        return "report"
    return mode


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

# A sanity bound on the shape of our own copy, not a discriminator — provenance
# below is what actually decides.
#
# Strava reports ``start_date`` and ``elapsed_time`` from the first and last
# *record*, not from the FIT session bounds, and HR fusion gives our upload the
# watch's samples clipped to our session. So our copy's Strava span is always
# *contained* in the Hevy window: it starts at or after the Hevy start (both
# copies reported 15:59:58Z on 2026-08-25, 64 s in) and ends at
# ``min(watch_end, hevy_end)``, never meaningfully later.
#
# Which way the end falls therefore depends on the watch, not on which copy it
# is. When the watch ran past the Hevy end our copy was clipped to it (0 s on
# 2026-08-25 and 2026-08-05, -8 s on 2026-08-20) while the watch copy kept its
# overhang (+16 s on 2026-08-25). When the watch stopped early there is nothing
# to clip and both copies report the same end: on 2026-09-07 the watch stopped
# 32 s before the Hevy workout closed and both landed on -14 s. An ``abs()``
# test on the end delta therefore rejected our own copy that day, which is why
# the bound below is one-sided: it can rule an activity *out* of being ours, and
# never in.
_SPAN_TOLERANCE_S = 10


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_iso(value: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def _delta(value: object) -> str:
    """``+64s`` / ``-8s`` / ``?`` — used by both the log lines and the timeline."""
    return f"{value:+}s" if isinstance(value, int) else "?"


def _classify(entry: dict, baseline_ids: set | None) -> str:
    """Label one Strava activity. Provenance decides; timing only rules out.

    ``baseline_ids`` is what the window held at the moment we deleted the watch
    copy from Garmin — before our replacement existed anywhere, so before Garmin
    could have pushed it. Anything in that set therefore *cannot* be ours, no
    matter how its timings look, and anything that shows up later is ours unless
    it arrived by some other route. That is the whole point of snapshotting at
    delete time, and it is the only identification here that is not a heuristic.

    Timing's only job is to catch that other route: a late arrival whose span
    does not fit inside the Hevy window is a different recording, not our
    replacement. It must never be asked to confirm a copy *is* ours, because on
    2026-09-07 both copies of one session reported identical timings.
    """
    if entry.get("manual") or (entry.get("device_name") or "") == "Hevy":
        return "hevy_direct"
    # Our copy reaches Strava through Garmin's push like any other, so the
    # external_id shape is a precondition, not a discriminator — it only rules
    # out anything that arrived by some other route.
    if not str(entry.get("external_id") or "").startswith("garmin_ping_"):
        return "unknown"

    # Our copy's span sits inside the Hevy window (see _SPAN_TOLERANCE_S): it
    # cannot start before the Hevy start, and it cannot end after the Hevy end.
    # Anything outside that is some other recording, whichever way it leans.
    delta_start, delta_end = entry.get("delta_start_s"), entry.get("delta_end_s")
    within_hevy_span = (
        delta_start is not None
        and delta_end is not None
        and delta_start >= -_SPAN_TOLERANCE_S
        and delta_end <= _SPAN_TOLERANCE_S
    )
    if baseline_ids is None:
        # No usable baseline (the delete-time fetch failed). Fall back to the
        # weak signal and say so, rather than pretending to know. Neither of
        # these verdicts can drive a write.
        return "ours?" if within_hevy_span else "stale?"
    if entry.get("id") in baseline_ids:
        return "stale"
    return "ours" if within_hevy_span else "unknown"


def _summarize(act: dict) -> dict:
    """The raw Strava fields worth keeping. No interpretation — see ``_derive``."""
    return {
        "id": act.get("id"),
        "start_date": act.get("start_date"),
        "elapsed_time": act.get("elapsed_time"),
        "moving_time": act.get("moving_time"),
        "sport_type": act.get("sport_type") or act.get("type"),
        "name": act.get("name"),
        "external_id": act.get("external_id"),
        "upload_id": act.get("upload_id"),
        "manual": act.get("manual"),
        "device_name": act.get("device_name"),
        "hide_from_home": act.get("hide_from_home"),
    }


def _derive(entry: dict, record: dict) -> dict:
    """Entry plus the deltas and the verdict, computed against ``record``.

    Interpretation is derived on read rather than frozen into the stored
    snapshot, so a rule change re-reads the whole history correctly instead of
    leaving old entries labelled by a rule that has since been disproved —
    which is exactly what happened to the 2026-08-25 pair.
    """
    hevy_start = _parse_iso(record.get("hevy_start"))
    hevy_duration_s = record.get("hevy_duration_s")
    start = _parse_iso(entry.get("start_date"))
    elapsed = entry.get("elapsed_time")
    baseline = record.get("baseline_ids")
    baseline_ids = set(baseline) if isinstance(baseline, list) else None

    out = dict(entry)
    out["delta_start_s"] = int((start - hevy_start).total_seconds()) if start and hevy_start else None
    out["delta_elapsed_s"] = (
        int(elapsed) - hevy_duration_s if isinstance(elapsed, int) and hevy_duration_s else None
    )
    if start and hevy_start and hevy_duration_s and isinstance(elapsed, int):
        hevy_end = hevy_start + timedelta(seconds=hevy_duration_s)
        out["delta_end_s"] = int((start + timedelta(seconds=elapsed) - hevy_end).total_seconds())
    else:
        out["delta_end_s"] = None
    out["verdict"] = _classify(out, baseline_ids)
    return out


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

    # Everything present when the watch copy was deleted predates our upload and
    # so cannot be ours. Only that moment can establish it: a baseline taken on
    # any later pass may already contain our own replacement, which would make
    # it worse than no baseline at all. So if the delete-time fetch failed, the
    # record stays baseline-less for good and falls back to the weak signal.
    if "baseline_ids" not in record:
        if phase == "watch_copy_deleted":
            record["baseline_ids"] = [a.get("id") for a in raw]
            record["baseline_at"] = _utcnow_iso()
        else:
            # A record written before the baseline was tracked still carries the
            # delete-time snapshot, which is the same observation in an older
            # shape — recover it from there rather than throwing it away.
            prior = next(
                (s for s in record.get("snapshots") or [] if s.get("phase") == "watch_copy_deleted"),
                None,
            )
            record["baseline_ids"] = [a.get("id") for a in prior["activities"]] if prior else None
            record["baseline_at"] = prior.get("at") if prior else None
    entries = sorted((_summarize(a) for a in raw), key=lambda e: str(e.get("start_date")))
    snapshots = record.setdefault("snapshots", [])
    previous = snapshots[-1]["activities"] if snapshots else None

    # Ids alone would miss a rename or a mute done elsewhere, so compare the
    # fields we would act on.
    def fingerprint(items):
        return [(i.get("id"), i.get("name"), i.get("hide_from_home")) for i in items]

    changed = previous is None or fingerprint(previous) != fingerprint(entries)
    if changed:
        snapshots.append({"at": _utcnow_iso(), "phase": phase, "activities": entries})
        del snapshots[:-_OBSERVE_MAX_SNAPSHOTS]

    # Refresh the summary even on an unchanged window: recovering a baseline, or
    # a change to the rule, can move a verdict without the window moving at all.
    derived = [_derive(e, record) for e in entries]
    verdicts = [e["verdict"] for e in derived]
    ours, stale = verdicts.count("ours"), verdicts.count("stale")
    record["ours_present"] = ours > 0
    record["stale_count"] = stale
    record["basis"] = "baseline" if isinstance(record.get("baseline_ids"), list) else "time_only"
    if not changed:
        return False

    logger.info(
        "  Strava observe [%s, %s] hevy=%s: %d strength activit(y/ies) in window — "
        "ours=%d stale=%d hevy_direct=%d unknown=%d",
        phase, record["basis"], record.get("hevy_id"), len(entries), ours, stale,
        verdicts.count("hevy_direct"), verdicts.count("unknown"),
    )
    for e in derived:
        logger.info(
            "    %-11s id=%s start=%s (start%s end%s) elapsed=%ss name=%r "
            "external_id=%r upload_id=%s manual=%s device=%r hidden=%s",
            e["verdict"], e["id"], e["start_date"], _delta(e["delta_start_s"]),
            _delta(e["delta_end_s"]), e["elapsed_time"], e["name"], e["external_id"],
            e["upload_id"], e["manual"], e["device_name"], e["hide_from_home"],
        )
    if ours and stale:
        logger.warning(
            "  Strava observe: CONFIRMED DUPLICATE for hevy=%s — our copy and %d stale cop(y/ies) "
            "coexist. This is the evidence the cleanup rule needs.",
            record.get("hevy_id"), stale,
        )
    return True


def _mute(headers: dict, base_url: str, entry: dict) -> bool:
    """Rename an activity with DUP_PREFIX and hide it from followers' feeds.

    The only cleanup Strava's API permits — there is no DELETE for activities —
    so the stale copy stays in the athlete's totals and stays findable, just
    marked and out of the feed. Never raises.
    """
    name = entry.get("name") or "Workout"
    new_name = name if name.startswith(DUP_PREFIX) else f"{DUP_PREFIX}{name}"
    try:
        resp = requests.put(
            f"{base_url}/activities/{entry['id']}",
            headers=headers,
            json={"hide_from_home": True, "name": new_name},
            timeout=15,
        )
        resp.raise_for_status()
    except Exception as e:
        logger.warning("Strava cleanup: failed to mute activity %s: %s", entry.get("id"), e)
        return False
    logger.info("  Strava cleanup: muted activity %s as %r", entry["id"], new_name)
    return True


def _clean_up(record: dict, headers: dict, base_url: str) -> list[dict]:
    """Mute every stale copy in ``record``'s latest snapshot. Returns the results.

    Only ever called once ``ours_present`` is true, so the workout is guaranteed
    to keep a visible representation on Strava. The targets come from the
    baseline — what was already in the window before our upload existed — never
    from a timing match.
    """
    snapshots = record.get("snapshots") or []
    if not snapshots:
        return []
    results = []
    for raw in snapshots[-1].get("activities") or []:
        entry = _derive(raw, record)
        if entry["verdict"] != "stale":
            continue
        results.append({
            "id": entry["id"],
            "at": _utcnow_iso(),
            "muted": _mute(headers, base_url, entry),
        })
    return results


def _baseline_cleared(record: dict) -> bool:
    """True once every activity the baseline held has left the window.

    Someone deleting the stale copy by hand before our own copy arrives is the
    other way a duplicate resolves, and it leaves a record with nothing left to
    watch — which would otherwise keep polling Strava for the full
    ``_OBSERVE_DAYS`` and keep reporting itself as open.

    An empty baseline does not count: if Garmin had not yet pushed the watch
    copy when we snapshotted, a stale copy can still arrive *after* ours, so
    that record has to stay open.
    """
    baseline = record.get("baseline_ids")
    snapshots = record.get("snapshots") or []
    if not isinstance(baseline, list) or not baseline or not snapshots:
        return False
    present = {a.get("id") for a in snapshots[-1].get("activities") or []}
    return not (set(baseline) & present)


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
        if _mode() == "off":
            return
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
        mode = _mode()
        if mode == "off":
            return
        records = _load_records()
        open_records = [r for r in records if not r.get("closed")]
        if not open_records:
            return
        # Age out *before* polling. The age test used to also gate the list of
        # records to visit, which meant the branch that was supposed to close an
        # aged record could never be reached: the record simply stopped being
        # rechecked while still reporting itself open, for good.
        cutoff = datetime.now(timezone.utc) - timedelta(days=_OBSERVE_DAYS)
        live, aged = [], 0
        for record in open_records:
            if (_parse_iso(record.get("opened_at")) or cutoff) <= cutoff:
                record["closed"] = True
                record["closed_reason"] = "aged_out"
                aged += 1
            else:
                live.append(record)
        session = _session() if live else None
        if session is None:
            if aged:
                _save_records(records)
            return
        headers, base_url = session
        for record in live:
            _snapshot(record, headers, base_url, phase="recheck")
            # Our copy and a stale one seen together is the whole point of
            # watching: it is the only state in which a write is safe, because
            # the workout provably keeps a visible copy on Strava afterwards.
            if record.get("ours_present") and record.get("stale_count"):
                if mode == "mute":
                    record["cleanup"] = _clean_up(record, headers, base_url)
                    # Re-read so the timeline shows the write as Strava has it,
                    # rather than as we assume it landed.
                    _snapshot(record, headers, base_url, phase="after_mute")
                record["closed"] = True
                record["closed_reason"] = "duplicate_cleaned" if mode == "mute" else "duplicate_confirmed"
            elif record.get("ours_present") and _baseline_cleared(record):
                record["closed"] = True
                record["closed_reason"] = "stale_copy_gone"
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
            f"last={r.get('last_checked_at')} basis={r.get('basis')} "
            f"baseline={r.get('baseline_ids')} closed={r.get('closed')} "
            f"{r.get('closed_reason') or ''}"
        )
        for snap in r.get("snapshots") or []:
            lines.append(f"    --- {snap.get('at')} [{snap.get('phase')}]")
            for raw in snap.get("activities") or []:
                e = _derive(raw, r)
                lines.append(
                    f"        {str(e.get('verdict')):<11} id={e.get('id')} "
                    f"start={e.get('start_date')} (start{_delta(e.get('delta_start_s'))} "
                    f"end{_delta(e.get('delta_end_s'))}) elapsed={e.get('elapsed_time')}s "
                    f"name={e.get('name')!r} external_id={e.get('external_id')!r} "
                    f"upload_id={e.get('upload_id')} manual={e.get('manual')} "
                    f"device={e.get('device_name')!r} hidden={e.get('hide_from_home')}"
                )
    return "\n".join(lines)
