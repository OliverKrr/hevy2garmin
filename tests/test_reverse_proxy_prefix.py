"""Tests for serving the dashboard under a reverse-proxy sub-path.

A proxy that mounts this app below the origin root (e.g. at
"/apps/hevy2garmin") can rewrite root-absolute references in the HTML it
forwards — href, src, action, hx-* — but it cannot rewrite URLs that the
page's JavaScript builds at runtime. Those are rendered against
``window.APP_PREFIX``, which carries the X-Forwarded-Prefix value. With no
such header (a normal root install) the prefix must be empty so the emitted
URLs are unchanged.
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
        """X-Forwarded-Prefix reaches the page, with the trailing slash trimmed."""
        resp = client.get("/setup", headers={"X-Forwarded-Prefix": "/apps/hevy2garmin/"})
        assert resp.status_code == 200
        assert _app_prefix(resp.text) == '"/apps/hevy2garmin"'

    def test_prefix_empty_without_header(self, client):
        """A root install is unaffected: the prefix is an empty string."""
        resp = client.get("/setup")
        assert resp.status_code == 200
        assert _app_prefix(resp.text) == '""'

    def test_prefix_does_not_leak_between_requests(self, client):
        """The prefix is per-request state, not sticky across requests."""
        client.get("/setup", headers={"X-Forwarded-Prefix": "/apps/hevy2garmin"})
        resp = client.get("/setup")
        assert _app_prefix(resp.text) == '""'

    def test_prefix_is_json_escaped(self, client):
        """The header is attacker-controllable, so it must be escaped, not interpolated."""
        resp = client.get("/setup", headers={"X-Forwarded-Prefix": '/x"</script><script>x'})
        assert "</script><script>x" not in _app_prefix(resp.text)

    def test_client_side_urls_are_prefixed(self, client):
        """Every JS-built API URL on the page resolves under the sub-path."""
        resp = client.get("/setup", headers={"X-Forwarded-Prefix": "/apps/hevy2garmin"})
        assert "window.APP_PREFIX + '/api/garmin-ticket'" in resp.text
        # No JS fetch() may target a root-absolute path.
        assert not re.search(r"fetch\((['\"])/(?!/)", resp.text)
