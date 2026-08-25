"""Tests for the optional Strava mute-duplicate cleanup after a replace-merge."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from hevy2garmin.strava import try_mute_strava_activity

ENV = {
    "STRAVA_CLIENT_ID": "123",
    "STRAVA_CLIENT_SECRET": "sec",
    "STRAVA_REFRESH_TOKEN": "refresh-1",
}
START = "2026-03-15T18:00:00+00:00"


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


def test_no_env_vars_is_noop(monkeypatch):
    for k in ENV:
        monkeypatch.delenv(k, raising=False)
    with patch("hevy2garmin.strava.requests") as req:
        assert try_mute_strava_activity(999, START) is False
        req.post.assert_not_called()
        req.get.assert_not_called()


def test_watch_copy_is_muted_and_renamed(strava_env):
    activities = [
        {"id": 11, "external_id": "garmin_ping_888.fit", "name": "Other"},
        {"id": 22, "external_id": "garmin_ping_999.fit", "name": "Strength"},
    ]
    with patch("hevy2garmin.strava.requests") as req, _no_db():
        req.post.return_value = _resp({"access_token": "at", "refresh_token": "refresh-1"})
        req.get.return_value = _resp(activities)
        req.put.return_value = _resp({})

        assert try_mute_strava_activity(999, START) is True

        put_args, put_kwargs = req.put.call_args
        assert put_args[0] == "https://www.strava.com/api/v3/activities/22"
        assert put_kwargs["json"] == {"hide_from_home": True, "name": "[dup] Strength"}


def test_dup_prefix_not_stacked(strava_env):
    activities = [{"id": 22, "external_id": "g999", "name": "[dup] Strength"}]
    with patch("hevy2garmin.strava.requests") as req, _no_db():
        req.post.return_value = _resp({"access_token": "at"})
        req.get.return_value = _resp(activities)
        req.put.return_value = _resp({})
        assert try_mute_strava_activity(999, START) is True
        assert req.put.call_args.kwargs["json"]["name"] == "[dup] Strength"


def test_no_external_id_match_touches_nothing(strava_env):
    # Time-window matches alone must never be trusted.
    activities = [{"id": 33, "external_id": "garmin_ping_777.fit", "name": "Strength"}]
    with patch("hevy2garmin.strava.requests") as req, _no_db():
        req.post.return_value = _resp({"access_token": "at"})
        req.get.return_value = _resp(activities)
        assert try_mute_strava_activity(999, START) is False
        req.put.assert_not_called()


def test_token_refresh_failure_is_noop(strava_env):
    with patch("hevy2garmin.strava.requests") as req, _no_db():
        req.post.return_value = _resp(raise_exc=RuntimeError("401"))
        assert try_mute_strava_activity(999, START) is False
        req.get.assert_not_called()


def test_rotated_refresh_token_is_persisted(strava_env):
    with (
        patch("hevy2garmin.strava.requests") as req,
        patch("hevy2garmin.strava._load_refresh_token", return_value="refresh-1"),
        patch("hevy2garmin.strava._store_refresh_token") as store,
    ):
        req.post.return_value = _resp({"access_token": "at", "refresh_token": "refresh-2"})
        req.get.return_value = _resp([])
        try_mute_strava_activity(999, START)
        store.assert_called_once_with("refresh-2")


def test_invalid_workout_start_is_noop(strava_env):
    with patch("hevy2garmin.strava.requests") as req, _no_db():
        assert try_mute_strava_activity(999, "not-a-date") is False
        req.get.assert_not_called()


def test_list_or_mute_failure_never_raises(strava_env):
    with patch("hevy2garmin.strava.requests") as req, _no_db():
        req.post.return_value = _resp({"access_token": "at"})
        req.get.side_effect = RuntimeError("network down")
        assert try_mute_strava_activity(999, START) is False

    with patch("hevy2garmin.strava.requests") as req, _no_db():
        req.post.return_value = _resp({"access_token": "at"})
        req.get.return_value = _resp([{"id": 22, "external_id": "g999", "name": "S"}])
        req.put.return_value = _resp(raise_exc=RuntimeError("403"))
        assert try_mute_strava_activity(999, START) is False


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
    entry = _observe([_OURS], store)[0]["snapshots"][0]["activities"][0]
    assert entry["delta_end_s"] == 0
    assert entry["verdict"] == "stale"


def test_watch_copy_ends_after_the_hevy_workout(strava_env, store):
    """The real 2026-08-25 pair shared a start; only the end separated them."""
    entry = _observe([_act()], store)[0]["snapshots"][0]["activities"][0]
    assert (entry["delta_start_s"], entry["delta_end_s"]) == (64, 16)
    assert entry["verdict"] == "stale"


def test_a_late_arrival_ending_at_the_hevy_end_is_ours(strava_env, store):
    _observe([_act()], store)
    tok, get = _window([_act(), _OURS])
    with tok, get:
        recheck_observations()
    record = store.data["strava_observations"]["records"][0]
    verdicts = {a["id"]: a["verdict"] for a in record["snapshots"][-1]["activities"]}
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
    verdicts = {a["id"]: a["verdict"] for a in record["snapshots"][-1]["activities"]}
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
    verdicts = sorted(a["verdict"] for a in record["snapshots"][-1]["activities"])
    assert verdicts == ["ours?", "stale?"]


def test_hevy_direct_post_is_labelled_separately(strava_env, store):
    hevy_post = _act(id=3, start_date="2026-08-20T17:23:51Z", elapsed_time=3130,
                     manual=True, device_name="Hevy", external_id=None)
    verdicts = [a["verdict"] for a in _observe([hevy_post], store)[0]["snapshots"][0]["activities"]]
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
