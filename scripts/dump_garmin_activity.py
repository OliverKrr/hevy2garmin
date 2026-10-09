"""Dump one Garmin activity's raw JSON, to confirm the field names a resync reads.

The web resync (#701) reads a synced workout's stored activity with
``GET /activity-service/activity/{id}``, and takes from it only whether the
activity exists and its start time: ``summaryDTO.startTimeGMT`` (or
``summaryDTO.startTimeLocal``). This read-only script prints that response as
Garmin sends it, so those names can be checked against ground truth. The other
fields the TypeScript ``getActivity`` maps (``activityTypeDTO.typeKey``,
``metadataDTO.manufacturer``, ``summaryDTO.duration``) are visible here too.

Credentials come from a ``.env`` file exactly as for
``dump_garmin_workout.py`` (GARMIN_EMAIL / GARMIN_PASSWORD, and optionally
DATABASE_URL to reuse the same Postgres token store as your deployment). Real
environment variables take precedence over the file.

Usage:

    PYTHONPATH=src python scripts/dump_garmin_activity.py --id 123456789
    PYTHONPATH=src python scripts/dump_garmin_activity.py --id 123456789 -o out.json
    PYTHONPATH=src python scripts/dump_garmin_activity.py --env path/to/.env --id 123456789

Nothing is created, changed, or deleted: one GET request is made.
"""

from __future__ import annotations

import argparse
import json
import sys

from dump_garmin_workout import _client, _load_dotenv


def cmd_dump(client, activity_id: str, out_path: str | None) -> None:
    data = client.get_activity(activity_id)
    text = json.dumps(data, indent=2, ensure_ascii=False)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"Wrote {len(text)} bytes to {out_path}")
    print(text)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", required=True, help="activityId to dump as JSON")
    parser.add_argument("-o", "--out", help="Also write the JSON to this file")
    parser.add_argument("--env", help="Path to a .env file (default: ./.env or repo root)")
    args = parser.parse_args()

    _load_dotenv(args.env)
    print("Authenticating with Garmin Connect...", file=sys.stderr)
    cmd_dump(_client(), args.id, args.out)


if __name__ == "__main__":
    main()
