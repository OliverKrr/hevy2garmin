"""A serverless deploy with no database attached must show a friendly, actionable
page instead of a raw 500 (#145, #142).

The dashboard's first DB call (get_synced_count) hits the SQLite fallback, whose
_get_conn() can't create ~/.hevy2garmin on a read-only filesystem. That now
raises NoWritableDatabaseError, and the app renders a "add a Neon database" page.
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from hevy2garmin.db_interface import NoWritableDatabaseError


@pytest.fixture
def client():
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("HEVY2GARMIN_SECRET", None)
        os.environ.pop("DEMO_MODE", None)
        for v in ("POSTGRES_URL", "DATABASE_URL", "STORAGE_URL", "NEON_DATABASE_URL"):
            os.environ.pop(v, None)
        os.environ["HEVY_API_KEY"] = "k"  # configured, so no /setup redirect
        import hevy2garmin.server as srv
        srv._is_configured_cache = None
        from hevy2garmin import db
        db.reset()
        yield TestClient(srv.app, follow_redirects=False)
        db.reset()


def test_no_database_shows_friendly_page(client):
    """No Postgres + unwritable SQLite -> 503 friendly page reaching through the
    HTTP middleware, not an unhandled 500."""
    from hevy2garmin.db_sqlite import SQLiteDatabase

    def _boom(self):
        raise NoWritableDatabaseError("read-only fs")

    with patch.object(SQLiteDatabase, "_get_conn", _boom):
        resp = client.get("/")

    assert resp.status_code == 503
    body = resp.text.lower()
    assert "database" in body
    assert "neon" in body
    assert "redeploy" in body


def test_sqlite_maps_readonly_fs_to_no_writable_error(tmp_path):
    """SQLiteDatabase._get_conn turns a read-only-FS OSError into the typed
    NoWritableDatabaseError the handler keys on."""
    from hevy2garmin.db_sqlite import SQLiteDatabase

    dbf = SQLiteDatabase(db_path=tmp_path / "sub" / "sync.db")

    def _raise(*a, **k):
        raise OSError(30, "Read-only file system")

    with patch.object(Path, "mkdir", _raise):
        with pytest.raises(NoWritableDatabaseError):
            dbf._get_conn()
