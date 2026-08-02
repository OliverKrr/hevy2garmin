"""Tests for the /api/cron/webhook receiver + staged retry worker."""

from __future__ import annotations

import asyncio
import os
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient


@pytest.fixture
def client_with_cron_secret():
    with patch.dict(os.environ, {"CRON_SECRET": "cron-123"}):
        from hevy2garmin.server import app
        yield TestClient(app)


class TestWebhookEndpoint:
    def test_rejects_missing_bearer(self, client_with_cron_secret) -> None:
        resp = client_with_cron_secret.post("/api/cron/webhook")
        assert resp.status_code == 401

    def test_rejects_wrong_bearer(self, client_with_cron_secret) -> None:
        resp = client_with_cron_secret.post(
            "/api/cron/webhook", headers={"Authorization": "Bearer nope"}
        )
        assert resp.status_code == 401

    def test_accepts_and_schedules_background_sync(self, client_with_cron_secret) -> None:
        """Valid Bearer → immediate 200 (Hevy requires an answer within 5 s)."""
        with patch("hevy2garmin.server._webhook_sync", new_callable=AsyncMock) as worker:
            resp = client_with_cron_secret.post(
                "/api/cron/webhook", headers={"Authorization": "Bearer cron-123"}
            )
        assert resp.status_code == 200
        assert resp.json() == {"status": "accepted"}
        worker.assert_called_once()

    def test_not_blocked_by_dashboard_auth(self) -> None:
        """POST /api/cron/webhook bypasses the cookie/X-Api-Key middleware."""
        with patch.dict(
            os.environ, {"HEVY2GARMIN_SECRET": "dash-secret", "CRON_SECRET": "cron-123"}
        ):
            from hevy2garmin.server import app
            client = TestClient(app)
            with patch("hevy2garmin.server._webhook_sync", new_callable=AsyncMock):
                resp = client.post(
                    "/api/cron/webhook", headers={"Authorization": "Bearer cron-123"}
                )
        assert resp.status_code == 200


class TestWebhookWorker:
    """Staged retry semantics (ported from the retired oauth-proxy forwarder):
    all but the last attempt are merge_only, the last does a full sync."""

    def _run(self, responses: list[dict]) -> list[bool]:
        from hevy2garmin import server

        calls: list[bool] = []

        async def fake_sync_one(request, merge_only=False, **kwargs):
            calls.append(merge_only)
            return JSONResponse(responses[len(calls) - 1])

        with (
            patch.object(server, "WEBHOOK_DELAY_SECONDS", 0),
            patch.object(server, "WEBHOOK_RETRY_INTERVAL_SECONDS", 0),
            patch.object(server, "_sync_one_recorded", fake_sync_one),
        ):
            asyncio.run(server._webhook_sync(None))
        return calls

    def test_merge_only_until_last_attempt(self) -> None:
        pending = {"synced": 0, "merge_pending": True, "done": False}
        calls = self._run([pending, pending, {"synced": 1, "done": True}])
        assert calls == [True, True, False]

    def test_stops_after_first_successful_sync(self) -> None:
        calls = self._run([{"synced": 1, "done": True}])
        assert calls == [True]

    def test_stops_when_nothing_is_pending(self) -> None:
        calls = self._run([{"synced": 0, "merge_pending": False, "done": False}])
        assert calls == [True]


class TestSyncLogRecording:
    """Every trigger path records a sync_log row (dashboard/webhook syncs
    used to leave no trace in /history)."""

    def _record_for(self, trigger_kwargs: dict, payload: dict) -> tuple[dict, str]:
        from hevy2garmin import server

        recorded: list = []

        async def fake_do_sync_one(request, *, respect_grace=False, merge_only=False):
            return JSONResponse(payload)

        with (
            patch.object(server, "_do_sync_one", fake_do_sync_one),
            patch.object(server, "_record_sync_log", lambda result, trigger: recorded.append((result, trigger))),
            patch.object(server, "is_demo_mode", lambda: False),
        ):
            asyncio.run(server._sync_one_recorded(None, **trigger_kwargs))
        assert len(recorded) == 1
        return recorded[0]

    def test_webhook_trigger_recorded(self) -> None:
        result, trigger = self._record_for(
            {"trigger": "webhook"}, {"synced": 1, "done": True}
        )
        assert trigger == "webhook"
        assert result["synced"] == 1

    def test_error_recorded_as_failed(self) -> None:
        result, trigger = self._record_for(
            {"trigger": "manual (one)"}, {"synced": 0, "skipped_error": True, "title": "x"}
        )
        assert trigger == "manual (one)"
        assert result["failed"] == 1
