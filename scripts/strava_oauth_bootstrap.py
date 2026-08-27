#!/usr/bin/env python3
"""One-time Strava OAuth bootstrap: obtain the refresh token for the cleanup.

Prerequisite: create an API application at https://www.strava.com/settings/api
(category doesn't matter; set Authorization Callback Domain to ``localhost``).

Usage:
    python scripts/strava_oauth_bootstrap.py CLIENT_ID CLIENT_SECRET

Opens the consent URL, waits for you to paste the redirected ``code=...``
value, exchanges it, and prints the three env values the sync needs
(STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN).
"""

from __future__ import annotations

import sys

import requests


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    client_id, client_secret = sys.argv[1], sys.argv[2]

    consent = (
        "https://www.strava.com/oauth/authorize"
        f"?client_id={client_id}&response_type=code"
        "&redirect_uri=http://localhost/exchange_token"
        "&approval_prompt=force&scope=activity:read_all,activity:write"
    )
    print("1. Open this URL in a browser and authorize:\n\n   " + consent + "\n")
    print("2. The browser lands on a dead localhost URL — copy the `code` parameter from it.")
    code = input("\nPaste code: ").strip()

    resp = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    athlete = data.get("athlete", {})
    print(f"\nAuthorized as: {athlete.get('firstname', '?')} {athlete.get('lastname', '?')}")
    print("\nAdd these to the deployment secrets:\n")
    print(f"STRAVA_CLIENT_ID={client_id}")
    print(f"STRAVA_CLIENT_SECRET={client_secret}")
    print(f"STRAVA_REFRESH_TOKEN={data['refresh_token']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
