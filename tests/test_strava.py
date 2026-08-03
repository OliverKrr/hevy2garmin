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
