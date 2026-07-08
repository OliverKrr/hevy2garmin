"""Tests for reverse-proxy sub-path awareness.

When this app is served under a sub-path (e.g. behind a proxy that mounts it at
"/apps/hevy2garmin"), the proxy can rewrite root-absolute references in HTML
attributes (href/src/hx-*) but it cannot rewrite URLs built inside JavaScript.
So every client-side fetch() must be prefixed with the X-Forwarded-Prefix value,
which templates expose as `window.APP_PREFIX`. A missing header (served at the
root) must yield an empty prefix so standalone installs keep working.
"""

from __future__ import annotations

import os
import re

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    os.environ.pop("HEVY2GARMIN_SECRET", None)
    os.environ.pop("DEMO_MODE", None)
    from hevy2garmin.server import app

    yield TestClient(app, follow_redirects=False)


def _app_prefix(html: str) -> str:
    m = re.search(r"window\.APP_PREFIX = (.*?);", html)
    assert m, "window.APP_PREFIX global not rendered"
    return m.group(1)


class TestReverseProxyPrefix:
    def test_prefix_injected_from_forwarded_header(self, client):
        """X-Forwarded-Prefix flows into window.APP_PREFIX (trailing slash trimmed)."""
        resp = client.get("/setup", headers={"X-Forwarded-Prefix": "/apps/hevy2garmin/"})
        assert resp.status_code == 200
        assert _app_prefix(resp.text) == '"/apps/hevy2garmin"'

    def test_no_header_means_empty_prefix(self, client):
        """Served at the root (no proxy header) → empty prefix, fetch() hits root."""
        resp = client.get("/setup")
        assert resp.status_code == 200
        assert _app_prefix(resp.text) == '""'

    def test_client_side_fetch_uses_the_prefix(self, client):
        """Setup page's JS fetch calls are built from window.APP_PREFIX, not '/api/...'."""
        resp = client.get("/setup", headers={"X-Forwarded-Prefix": "/apps/hevy2garmin"})
        assert "fetch(window.APP_PREFIX + '/api/garmin-ticket'" in resp.text
        # No bare root-absolute fetch to an /api/ path must remain in the page.
        assert "fetch('/api/" not in resp.text
