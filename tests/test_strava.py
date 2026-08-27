"""Tests for the optional Strava mute-duplicate cleanup after a replace-merge."""

from __future__ import annotations

from unittest.mock import ANY, MagicMock, patch

import pytest

from hevy2garmin.strava import DUP_PREFIX, _get_access_token

ENV = {
    "STRAVA_CLIENT_ID": "123",
    "STRAVA_CLIENT_SECRET": "sec",
    "STRAVA_REFRESH_TOKEN": "refresh-1",
}


@pytest.fixture
def strava_env(monkeypatch):
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("STRAVA_BASE_URL", "https://www.strava.com/api/v3")


def _resp(json_data=None, raise_exc=None):
    resp = MagicMock()
    if raise_exc is not None:
        resp.raise_for_status.side_effect = raise_exc
    else:
        resp.raise_for_status.return_value = None
    resp.json.return_value = json_data
    return resp


def _no_db():
    """Force the env-var refresh-token path (no app-config store)."""
    return patch("hevy2garmin.strava._load_refresh_token", return_value="refresh-1")


def test_token_refresh_failure_yields_no_session(strava_env):
    with _no_db(), patch("hevy2garmin.strava.requests.post", return_value=_resp(raise_exc=RuntimeError("nope"))):
        assert _get_access_token("123", "sec") is None


def test_rotated_refresh_token_is_persisted(strava_env):
    tokens = {"access_token": "at", "refresh_token": "refresh-2"}
    with _no_db(), patch("hevy2garmin.strava.requests.post", return_value=_resp(tokens)), \
         patch("hevy2garmin.strava._store_refresh_token") as store_tok:
        assert _get_access_token("123", "sec") == "at"
        store_tok.assert_called_once_with("refresh-2")


def test_unrotated_refresh_token_is_not_rewritten(strava_env):
    tokens = {"access_token": "at", "refresh_token": "refresh-1"}
    with _no_db(), patch("hevy2garmin.strava.requests.post", return_value=_resp(tokens)), \
         patch("hevy2garmin.strava._store_refresh_token") as store_tok:
        assert _get_access_token("123", "sec") == "at"
        store_tok.assert_not_called()


# ---------------------------------------------------------------------------
# Report-only observation
# ---------------------------------------------------------------------------

from hevy2garmin.strava import (  # noqa: E402
    format_observations,
    observe_window,
    recheck_observations,
)

# The one pair whose members can be named with certainty: 2026-08-25, where the
# baseline snapshot proved which copy predated our upload. Hevy 15:58:54 +3976s
# ends 17:05:10.
HEVY_START = "2026-08-25T15:58:54+00:00"
HEVY_END = "2026-08-25T17:05:10+00:00"


def _act(**over):
    """The real 2026-08-25 watch copy: same start as ours, ending 16 s later."""
    base = {
        "id": 19896022976,
        "start_date": "2026-08-25T15:59:58Z",
        "elapsed_time": 3928,
        "moving_time": 3928,
        "sport_type": "WeightTraining",
        "name": "Afternoon Weight Training",
        "external_id": "garmin_ping_618773181080",
        "upload_id": 21031752727,
        "manual": False,
        "device_name": "Garmin Enduro 3",
        "hide_from_home": False,
    }
    base.update(over)
    return base


# Our replacement as Strava actually reported it the same day: an identical
# start_date to the watch copy, because HR fusion gives our FIT the watch's
# first sample — and an end exactly on the Hevy end.
_OURS = _act(id=19896395261, elapsed_time=3912, moving_time=3912,
             external_id="garmin_ping_618781907232", upload_id=21032129988,
             device_name=None)


class _Store:
    """Minimal app-config store standing in for the DB."""

    def __init__(self):
        self.data = {}

    def get_app_config(self, key):
        return self.data.get(key)

    def set_app_config(self, key, value):
        self.data[key] = value


@pytest.fixture
def store(monkeypatch):
    s = _Store()
    import hevy2garmin.db as real_db

    monkeypatch.setattr(real_db, "get_db", lambda: s)
    return s


def _window(activities):
    """Patch the activity listing and the token so no network is touched."""
    return (
        patch("hevy2garmin.strava._get_access_token", return_value="tok"),
        patch("hevy2garmin.strava.requests.get", return_value=_resp(activities)),
    )


def _entries(record, index=-1):
    """Snapshots store raw fields; interpretation is derived on read."""
    from hevy2garmin.strava import _derive

    return [_derive(a, record) for a in record["snapshots"][index]["activities"]]


def _observe(activities, store, **kw):
    tok, get = _window(activities)
    with tok, get:
        observe_window(
            hevy_id=kw.get("hevy_id", "w1"),
            workout_start=HEVY_START,
            workout_end=HEVY_END,
            watch_activity_id=24052777390,
            replacement_activity_id=24052777391,
        )
    return store.data.get("strava_observations", {}).get("records", [])


def test_observe_records_the_window_and_writes_nothing(strava_env, store):
    tok, get = _window([_act()])
    with tok, get, patch("hevy2garmin.strava.requests.put") as put:
        observe_window(hevy_id="w1", workout_start=HEVY_START, workout_end=HEVY_END,
                       watch_activity_id=1, replacement_activity_id=2)
        put.assert_not_called()
    records = store.data["strava_observations"]["records"]
    assert len(records) == 1
    assert records[0]["hevy_duration_s"] == 3976
    assert len(records[0]["snapshots"]) == 1


def test_anything_in_the_baseline_is_stale_whatever_its_timings(strava_env, store):
    """The baseline predates our upload, so membership beats any timing signal.

    _OURS ends exactly at the Hevy end — the shape of our own copy — yet if it
    was already there when we deleted the watch activity, it cannot be ours.
    """
    entry = _entries(_observe([_OURS], store)[0], 0)[0]
    assert entry["delta_end_s"] == 0
    assert entry["verdict"] == "stale"


def test_watch_copy_ends_after_the_hevy_workout(strava_env, store):
    """The real 2026-08-25 pair shared a start; only the end separated them."""
    entry = _entries(_observe([_act()], store)[0], 0)[0]
    assert (entry["delta_start_s"], entry["delta_end_s"]) == (64, 16)
    assert entry["verdict"] == "stale"


def test_a_late_arrival_ending_at_the_hevy_end_is_ours(strava_env, store):
    _observe([_act()], store)
    tok, get = _window([_act(), _OURS])
    with tok, get:
        recheck_observations()
    record = store.data["strava_observations"]["records"][0]
    verdicts = {a["id"]: a["verdict"] for a in _entries(record)}
    assert verdicts == {_act()["id"]: "stale", _OURS["id"]: "ours"}
    assert record["basis"] == "baseline"


def test_a_late_arrival_with_unrelated_timings_is_not_claimed_as_ours(strava_env, store):
    _observe([_act()], store)
    other = _act(id=7, start_date="2026-08-25T18:00:00Z", elapsed_time=1200,
                 name="Second session", device_name=None)
    tok, get = _window([_act(), other])
    with tok, get:
        recheck_observations()
    record = store.data["strava_observations"]["records"][0]
    verdicts = {a["id"]: a["verdict"] for a in _entries(record)}
    assert verdicts[7] == "unknown"
    assert record["ours_present"] is False
    assert record["closed"] is False


def test_a_failed_baseline_fetch_never_backfills_a_later_one(strava_env, store):
    """A baseline taken after our upload could contain our own copy — refuse it."""
    with patch("hevy2garmin.strava._get_access_token", return_value="tok"), \
         patch("hevy2garmin.strava.requests.get", side_effect=RuntimeError("down")):
        observe_window(hevy_id="w1", workout_start=HEVY_START, workout_end=HEVY_END,
                       watch_activity_id=1, replacement_activity_id=2)
    tok, get = _window([_act(), _OURS])
    with tok, get:
        recheck_observations()
    record = store.data["strava_observations"]["records"][0]
    assert record["baseline_ids"] is None
    assert record["basis"] == "time_only"
    verdicts = sorted(a["verdict"] for a in _entries(record))
    assert verdicts == ["ours?", "stale?"]


def test_hevy_direct_post_is_labelled_separately(strava_env, store):
    hevy_post = _act(id=3, start_date="2026-08-20T17:23:51Z", elapsed_time=3130,
                     manual=True, device_name="Hevy", external_id=None)
    verdicts = [a["verdict"] for a in _entries(_observe([hevy_post], store)[0], 0)]
    assert verdicts == ["hevy_direct"]


def test_non_strength_activities_are_ignored(strava_env, store):
    ride = _act(id=4, sport_type="Ride", name="Cool Down")
    ids = [a["id"] for a in _observe([ride, _act()], store)[0]["snapshots"][0]["activities"]]
    assert ids == [_act()["id"]]


def test_recheck_appends_only_when_the_window_changed(strava_env, store):
    _observe([_act()], store)
    tok, get = _window([_act()])
    with tok, get:
        recheck_observations()
    record = store.data["strava_observations"]["records"][0]
    assert len(record["snapshots"]) == 1  # unchanged → no new snapshot
    assert record["checks"] == 2

    tok, get = _window([_act(), _OURS])
    with tok, get:
        recheck_observations()
    record = store.data["strava_observations"]["records"][0]
    assert len(record["snapshots"]) == 2
    assert record["closed"] is True
    assert record["closed_reason"] == "duplicate_confirmed"
    assert record["ours_present"] is True and record["stale_count"] == 1


def test_recheck_never_writes_to_strava(strava_env, store):
    _observe([_act()], store)
    tok, get = _window([_act(), _OURS])
    with tok, get, patch("hevy2garmin.strava.requests.put") as put:
        recheck_observations()
        put.assert_not_called()


def test_observation_failures_never_raise(strava_env, store):
    with patch("hevy2garmin.strava._get_access_token", return_value="tok"), \
         patch("hevy2garmin.strava.requests.get", side_effect=RuntimeError("boom")):
        observe_window(hevy_id="w1", workout_start=HEVY_START, workout_end=HEVY_END)
        recheck_observations()


def test_observe_is_noop_without_credentials(monkeypatch, store):
    for k in ENV:
        monkeypatch.delenv(k, raising=False)
    with patch("hevy2garmin.strava.requests") as req:
        observe_window(hevy_id="w1", workout_start=HEVY_START, workout_end=HEVY_END)
        req.get.assert_not_called()
    assert store.data == {}


def test_format_observations_renders_a_timeline(strava_env, store):
    _observe([_act()], store)
    out = format_observations()
    assert "hevy=w1" in out and "watch_copy_deleted" in out and "stale" in out


def test_format_observations_with_no_records(store):
    assert "No Strava observations" in format_observations()


def test_baseline_is_recovered_from_a_pre_existing_delete_time_snapshot(strava_env, store):
    """Records written before baseline tracking still hold the same observation."""
    _observe([_act()], store)
    record = store.data["strava_observations"]["records"][0]
    del record["baseline_ids"], record["baseline_at"]  # shape from the older version
    store.set_app_config("strava_observations", {"records": [record]})

    tok, get = _window([_act(), _OURS])
    with tok, get:
        recheck_observations()
    record = store.data["strava_observations"]["records"][0]
    assert record["baseline_ids"] == [_act()["id"]]
    assert record["basis"] == "baseline"
    verdicts = {a["id"]: a["verdict"] for a in _entries(record)}
    assert verdicts == {_act()["id"]: "stale", _OURS["id"]: "ours"}


# ---------------------------------------------------------------------------
# STRAVA_CLEANUP_MODE
# ---------------------------------------------------------------------------


def _confirm_pair(store, monkeypatch, mode):
    """Drive a record to the confirmed-duplicate state under ``mode``."""
    monkeypatch.setenv("STRAVA_CLEANUP_MODE", mode)
    _observe([_act()], store)
    tok, get = _window([_act(), _OURS])
    with tok, get, patch("hevy2garmin.strava.requests.put") as put:
        recheck_observations()
    return store.data.get("strava_observations", {}).get("records", [{}])[0], put


def test_report_is_the_default_and_never_writes(strava_env, store, monkeypatch):
    monkeypatch.delenv("STRAVA_CLEANUP_MODE", raising=False)
    _observe([_act()], store)
    tok, get = _window([_act(), _OURS])
    with tok, get, patch("hevy2garmin.strava.requests.put") as put:
        recheck_observations()
        put.assert_not_called()
    record = store.data["strava_observations"]["records"][0]
    assert record["closed_reason"] == "duplicate_confirmed"
    assert "cleanup" not in record


def test_off_disables_observation_entirely(strava_env, store, monkeypatch):
    monkeypatch.setenv("STRAVA_CLEANUP_MODE", "off")
    with patch("hevy2garmin.strava.requests") as req:
        observe_window(hevy_id="w1", workout_start=HEVY_START, workout_end=HEVY_END)
        recheck_observations()
        req.get.assert_not_called()
    assert store.data == {}


def test_an_unknown_mode_falls_back_to_report(strava_env, store, monkeypatch):
    record, put = _confirm_pair(store, monkeypatch, "shout")
    put.assert_not_called()
    assert record["closed_reason"] == "duplicate_confirmed"


def test_mute_writes_only_to_the_stale_copy(strava_env, store, monkeypatch):
    monkeypatch.setenv("STRAVA_CLEANUP_MODE", "mute")
    _observe([_act()], store)
    muted = _act(name=f"{DUP_PREFIX}{_act()['name']}", hide_from_home=True)
    tok = patch("hevy2garmin.strava._get_access_token", return_value="tok")
    get = patch("hevy2garmin.strava.requests.get",
                side_effect=[_resp([_act(), _OURS]), _resp([muted, _OURS])])
    with tok, get, patch("hevy2garmin.strava.requests.put", return_value=_resp({})) as put:
        recheck_observations()
    assert put.call_count == 1
    url, kwargs = put.call_args[0][0], put.call_args[1]
    assert str(_act()["id"]) in url and str(_OURS["id"]) not in url
    assert kwargs["json"] == {"hide_from_home": True, "name": f"{DUP_PREFIX}Afternoon Weight Training"}
    record = store.data["strava_observations"]["records"][0]
    assert record["cleanup"] == [{"id": _act()["id"], "at": ANY, "muted": True}]
    assert record["closed_reason"] == "duplicate_cleaned"
    assert record["snapshots"][-1]["phase"] == "after_mute"


def test_mute_never_fires_while_our_copy_is_absent(strava_env, store, monkeypatch):
    """The safety rule: no write in a window that holds only the stale copy."""
    monkeypatch.setenv("STRAVA_CLEANUP_MODE", "mute")
    _observe([_act()], store)
    tok, get = _window([_act()])
    with tok, get, patch("hevy2garmin.strava.requests.put") as put:
        recheck_observations()
        put.assert_not_called()
    record = store.data["strava_observations"]["records"][0]
    assert record["closed"] is False


def test_dup_prefix_is_not_stacked(strava_env, store, monkeypatch):
    monkeypatch.setenv("STRAVA_CLEANUP_MODE", "mute")
    already = _act(name=f"{DUP_PREFIX}Afternoon Weight Training")
    _observe([already], store)
    tok = patch("hevy2garmin.strava._get_access_token", return_value="tok")
    get = patch("hevy2garmin.strava.requests.get", return_value=_resp([already, _OURS]))
    with tok, get, patch("hevy2garmin.strava.requests.put", return_value=_resp({})) as put:
        recheck_observations()
    assert put.call_args[1]["json"]["name"] == f"{DUP_PREFIX}Afternoon Weight Training"


def test_a_failed_mute_is_recorded_not_raised(strava_env, store, monkeypatch):
    monkeypatch.setenv("STRAVA_CLEANUP_MODE", "mute")
    _observe([_act()], store)
    tok, get = _window([_act(), _OURS])
    with tok, get, patch("hevy2garmin.strava.requests.put", side_effect=RuntimeError("403")):
        recheck_observations()
    record = store.data["strava_observations"]["records"][0]
    assert record["cleanup"] == [{"id": _act()["id"], "at": ANY, "muted": False}]


# ---------------------------------------------------------------------------
# The recheck must be reachable from every sync trigger
# ---------------------------------------------------------------------------
#
# An observation is opened at delete time and is worthless until something looks
# at it again. The auto-sync loop is not enough: on Vercel the daily cron and the
# Hevy webhook both go through the single-sync path instead, so a deployment with
# auto-sync off would snapshot once and never revisit. This broke silently once
# already, when the auto-sync loop was extracted out of server.py — hence a test
# per call site rather than trust.


def test_autosync_run_once_rechecks_observations():
    from hevy2garmin import autosync, syncstate

    cfg = {"auto_sync": {"enabled": True, "interval_minutes": 90}}
    with patch.object(autosync, "load_config", lambda: cfg), \
         patch.object(syncstate, "acquire_sync_lock", lambda: True), \
         patch.object(syncstate, "release_sync_lock", lambda: None), \
         patch.object(syncstate, "mark_synced", lambda *a, **k: None), \
         patch.object(syncstate, "record_sync_log", lambda *a, **k: None), \
         patch.object(autosync, "sync", lambda **kw: {"synced": 1}), \
         patch("hevy2garmin.strava.recheck_observations") as recheck:
        assert autosync.run_once() == 90
        recheck.assert_called_once()


def test_the_single_sync_path_rechecks_observations():
    """Covers /api/cron/sync and the Hevy webhook, which never touch autosync."""
    import asyncio

    from fastapi.responses import JSONResponse

    from hevy2garmin import server, syncstate

    async def fake_sync_one(**kw):
        return JSONResponse({"synced": 1})

    with patch.object(server, "is_demo_mode", lambda: False), \
         patch.object(syncstate, "acquire_sync_lock", lambda: True), \
         patch.object(syncstate, "release_sync_lock", lambda: None), \
         patch.object(syncstate, "record_sync_log", lambda *a, **k: None), \
         patch.object(server, "_do_sync_one", fake_sync_one), \
         patch("hevy2garmin.strava.recheck_observations") as recheck:
        asyncio.run(server._sync_one_recorded(trigger="cron"))
        recheck.assert_called_once()
