"""Tests for merge mode: matching heuristic, payload builder, and strategies."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hevy2garmin.merge import (
    MergeResult,
    attempt_merge,
    build_exercise_sets_payload,
    reset_circuit_breaker,
    _category_to_string,
    _exercise_to_string,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_garmin_activity(
    activity_id: int = 12345,
    start: str = "2026-03-15 18:02:00",
    duration_s: float = 43 * 60,
    type_key: str = "strength_training",
) -> dict:
    return {
        "activityId": activity_id,
        "startTimeGMT": start,
        "startTimeLocal": start,
        "duration": duration_s,
        "activityType": {"typeKey": type_key},
    }


HEVY_WORKOUT = {
    "id": "test-123",
    "title": "Push",
    "start_time": "2026-03-15T18:00:00+00:00",
    "end_time": "2026-03-15T18:45:00+00:00",
    "exercises": [
        {
            "title": "Bench Press (Barbell)",
            "sets": [
                {"type": "warmup", "weight_kg": 40, "reps": 12},
                {"type": "normal", "weight_kg": 60, "reps": 10},
                {"type": "normal", "weight_kg": 60, "reps": 8},
            ],
        },
        {
            "title": "Shoulder Press (Dumbbell)",
            "sets": [
                {"type": "normal", "weight_kg": 14, "reps": 12},
                {"type": "normal", "weight_kg": 14, "reps": 10},
            ],
        },
    ],
}


# ---------------------------------------------------------------------------
# Matching heuristic tests
# ---------------------------------------------------------------------------

class TestFindMatchingActivity:

    def test_exact_overlap_matches(self):
        """Strength training with high overlap → match."""
        from hevy2garmin.garmin import find_matching_garmin_activity

        client = MagicMock()
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(start="2026-03-15 18:02:00", duration_s=43 * 60),
        ]
        match = find_matching_garmin_activity(client, HEVY_WORKOUT)
        assert match is not None
        assert match["activityId"] == 12345

    def test_low_overlap_rejected(self):
        """Activity with only 50% overlap is below 70% threshold → no match."""
        from hevy2garmin.garmin import find_matching_garmin_activity

        client = MagicMock()
        # Activity starts 22 min late, only ~50% overlap with 45-min hevy workout
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(start="2026-03-15 18:22:00", duration_s=23 * 60),
        ]
        match = find_matching_garmin_activity(client, HEVY_WORKOUT)
        assert match is None

    def test_wrong_type_rejected(self):
        """Running activity with perfect overlap → no match."""
        from hevy2garmin.garmin import find_matching_garmin_activity

        client = MagicMock()
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(type_key="running"),
        ]
        match = find_matching_garmin_activity(client, HEVY_WORKOUT)
        assert match is None

    def test_incomplete_activity_rejected(self):
        """Activity still in progress (end time in future) → no match."""
        from datetime import datetime, timezone
        from hevy2garmin.garmin import find_matching_garmin_activity

        now = datetime.now(timezone.utc)
        # Activity started 10 min ago with a very long duration (still recording)
        recent_start = now.strftime("%Y-%m-%d %H:%M:%S")
        hevy_now = {
            **HEVY_WORKOUT,
            "start_time": now.isoformat(),
            "end_time": (now + __import__("datetime").timedelta(minutes=45)).isoformat(),
        }
        client = MagicMock()
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(start=recent_start, duration_s=999999),
        ]
        match = find_matching_garmin_activity(client, hevy_now)
        assert match is None

    def test_best_of_multiple_candidates(self):
        """When multiple candidates overlap, pick the highest-scoring one."""
        from hevy2garmin.garmin import find_matching_garmin_activity

        client = MagicMock()
        client.get_activities_by_date.return_value = [
            _make_garmin_activity(activity_id=1, start="2026-03-15 18:10:00", duration_s=35 * 60),
            _make_garmin_activity(activity_id=2, start="2026-03-15 18:01:00", duration_s=44 * 60),
        ]
        match = find_matching_garmin_activity(client, HEVY_WORKOUT)
        assert match is not None
        assert match["activityId"] == 2  # Better overlap + closer start


# ---------------------------------------------------------------------------
# Payload builder tests
# ---------------------------------------------------------------------------

class TestBuildPayload:

    def test_payload_structure(self):
        """Payload has activityId and exerciseSets list."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        assert payload["activityId"] == 12345
        assert isinstance(payload["exerciseSets"], list)
        assert len(payload["exerciseSets"]) > 0

    def test_active_and_rest_sets(self):
        """Payload contains both ACTIVE and REST sets."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        types = {s["setType"] for s in payload["exerciseSets"]}
        assert "ACTIVE" in types
        assert "REST" in types

    def test_exercise_count_matches(self):
        """Number of ACTIVE sets matches total sets in Hevy workout."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        active = [s for s in payload["exerciseSets"] if s["setType"] == "ACTIVE"]
        # 3 bench sets + 2 shoulder sets = 5
        assert len(active) == 5

    def test_weight_in_grams(self):
        """Weight is converted from kg to grams."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        first_active = next(s for s in payload["exerciseSets"] if s["setType"] == "ACTIVE")
        assert first_active["weight"] == 40000  # 40 kg warmup = 40000 grams

    def test_wkt_step_index_groups_exercises(self):
        """wktStepIndex groups sets by exercise (0 for bench, 1 for shoulder)."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        active = [s for s in payload["exerciseSets"] if s["setType"] == "ACTIVE"]
        bench_steps = {s["wktStepIndex"] for s in active[:3]}
        shoulder_steps = {s["wktStepIndex"] for s in active[3:]}
        assert bench_steps == {0}
        assert shoulder_steps == {1}

    def test_category_string_mapping(self):
        """Exercise categories are strings, not ints."""
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        first_active = next(s for s in payload["exerciseSets"] if s["setType"] == "ACTIVE")
        assert first_active["exercises"][0]["category"] == "BENCH_PRESS"
        assert isinstance(first_active["exercises"][0]["name"], str)

    def test_exercise_objects_match_garmin_shape(self):
        """Every exercise object must have category (str) + name (str|None) + probability.

        Verified against the real Garmin exerciseSets response shape:
        {"category": "BENCH_PRESS", "name": "INCLINE_DUMBBELL_BENCH_PRESS", "probability": ...}
        — `name` is the SUBCATEGORY, never the parent or "TOTAL_BODY", or Garmin
        renders it as "Unknown" (#138).
        """
        payload = build_exercise_sets_payload(
            HEVY_WORKOUT,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        for s in payload["exerciseSets"]:
            if s["setType"] != "ACTIVE":
                assert s["exercises"] == []
                continue
            for ex in s["exercises"]:
                assert set(ex) == {"category", "name", "probability"}
                assert isinstance(ex["category"], str) and ex["category"] != "UNKNOWN"
                assert ex["name"] is None or isinstance(ex["name"], str)
                # name must never echo the parent or the TOTAL_BODY placeholder
                assert ex["name"] != ex["category"]
                assert ex["name"] != "TOTAL_BODY"

    def test_unknown_exercise_uses_total_body_parent_with_null_name(self):
        """An unmapped exercise → category=TOTAL_BODY parent, name=None (not 'TOTAL_BODY')."""
        workout = {
            "title": "Odd",
            "start_time": "2026-03-15T18:00:00+00:00",
            "end_time": "2026-03-15T18:10:00+00:00",
            "exercises": [
                {"title": "Totally Invented Movement 9000",
                 "sets": [{"type": "normal", "weight_kg": 10, "reps": 5}]},
            ],
        }
        payload = build_exercise_sets_payload(
            workout, activity_id=1, activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=10 * 60,
        )
        active = next(s for s in payload["exerciseSets"] if s["setType"] == "ACTIVE")
        ex = active["exercises"][0]
        assert ex["category"] == "TOTAL_BODY"
        assert ex["name"] is None  # never "TOTAL_BODY" as the name

    def test_empty_workout(self):
        """Workout with no exercises produces empty sets list."""
        workout = {**HEVY_WORKOUT, "exercises": []}
        payload = build_exercise_sets_payload(
            workout,
            activity_id=12345,
            activity_start_time="2026-03-15 18:00:00",
            activity_duration_s=45 * 60,
        )
        assert payload["exerciseSets"] == []


# ---------------------------------------------------------------------------
# Category string conversion tests
# ---------------------------------------------------------------------------

class TestCategoryConversion:

    def test_known_category(self):
        assert _category_to_string(0) == "BENCH_PRESS"
        assert _category_to_string(28) == "SQUAT"
        assert _category_to_string(23) == "ROW"

    def test_unknown_category(self):
        assert _category_to_string(65534) == "UNKNOWN"
        assert _category_to_string(9999) == "UNKNOWN"

    def test_subcategory_resolves_to_valid_enum_string(self):
        # (0, 1) BENCH_PRESS → a real FIT subcategory string
        result = _exercise_to_string(0, 1)
        assert isinstance(result, str) and result  # e.g. "BARBELL_BENCH_PRESS"

    def test_subcategory_returns_none_when_unresolvable(self):
        # Out-of-range subcategory must yield None, NOT the parent name (#138)
        assert _exercise_to_string(0, 9999) is None
        # Unknown category likewise yields None (never "UNKNOWN" / parent fallback)
        assert _exercise_to_string(65534, 0) is None


# ---------------------------------------------------------------------------
# Integration: attempt_merge
# ---------------------------------------------------------------------------

class TestAttemptMerge:

    def setup_method(self):
        reset_circuit_breaker()

    @patch("hevy2garmin.merge.find_matching_garmin_activity")
    @patch("hevy2garmin.merge.get_activity_exercise_sets")
    @patch("hevy2garmin.merge.push_exercise_sets")
    @patch("hevy2garmin.merge.rename_activity")
    @patch("hevy2garmin.merge.set_description")
    def test_merge_path_taken(self, mock_desc, mock_rename, mock_push, mock_get_sets, mock_find):
        """When a match is found, PUT is called and result is merged=True."""
        mock_find.return_value = _make_garmin_activity()
        mock_get_sets.return_value = {"exerciseSets": []}
        mock_db = MagicMock()

        result = attempt_merge(MagicMock(), HEVY_WORKOUT, mock_db)

        assert result.merged is True
        assert result.activity_id == 12345
        mock_push.assert_called_once()
        mock_rename.assert_called_once()

    @patch("hevy2garmin.merge.find_matching_garmin_activity")
    def test_no_match_fallback(self, mock_find):
        """When no match, result is merged=False with reason."""
        mock_find.return_value = None
        mock_db = MagicMock()

        result = attempt_merge(MagicMock(), HEVY_WORKOUT, mock_db)

        assert result.merged is False
        assert "No matching" in result.fallback_reason

    @patch("hevy2garmin.merge.find_matching_garmin_activity")
    @patch("hevy2garmin.merge.get_activity_exercise_sets")
    @patch("hevy2garmin.merge.push_exercise_sets")
    def test_circuit_breaker_trips(self, mock_push, mock_get_sets, mock_find):
        """After 3 consecutive PUT failures, merge is disabled."""
        mock_find.return_value = _make_garmin_activity()
        mock_get_sets.return_value = {"exerciseSets": []}
        mock_push.side_effect = RuntimeError("PUT failed")
        mock_db = MagicMock()

        for _ in range(3):
            attempt_merge(MagicMock(), HEVY_WORKOUT, mock_db)

        # 4th attempt should be blocked by circuit breaker
        result = attempt_merge(MagicMock(), HEVY_WORKOUT, mock_db)
        assert result.merged is False
        assert "Circuit breaker" in result.fallback_reason


# ---------------------------------------------------------------------------
# Strategy dispatch: attempt_merge routes on config["merge_strategy"]
# ---------------------------------------------------------------------------

class TestMergeStrategyDispatch:
    """attempt_merge picks the path named by config['merge_strategy']."""

    def setup_method(self):
        reset_circuit_breaker()

    @patch("hevy2garmin.merge.load_config")
    @patch("hevy2garmin.merge.find_matching_garmin_activity")
    @patch("hevy2garmin.merge.get_activity_exercise_sets")
    @patch("hevy2garmin.merge.push_exercise_sets")
    @patch("hevy2garmin.merge.rename_activity")
    @patch("hevy2garmin.merge.set_description")
    @patch("hevy2garmin.merge.download_activity_fit")
    def test_default_routes_to_exercise_sets(self, mock_dl, mock_desc, mock_rename, mock_push, mock_get_sets, mock_find, mock_cfg):
        """No merge_strategy in config → exercise_sets path (PUT), never the FIT path."""
        mock_cfg.return_value = {}  # absent key → default "exercise_sets"
        mock_find.return_value = _make_garmin_activity()
        mock_get_sets.return_value = {"exerciseSets": []}

        result = attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())

        assert result.merged is True
        mock_push.assert_called_once()
        mock_dl.assert_not_called()

    @patch("hevy2garmin.merge.load_config")
    @patch("hevy2garmin.merge.find_matching_garmin_activity")
    @patch("hevy2garmin.merge.push_exercise_sets")
    @patch("hevy2garmin.merge.download_activity_fit")
    @patch("hevy2garmin.merge.extract_hr_samples")
    @patch("hevy2garmin.merge.generate_fit")
    @patch("hevy2garmin.merge.upload_fit")
    @patch("hevy2garmin.merge.rename_activity")
    @patch("hevy2garmin.merge.set_description")
    @patch("hevy2garmin.merge.delete_activity")
    def test_fit_replace_routes_to_fit_path(self, mock_del, mock_desc, mock_rename, mock_upload, mock_gen, mock_extract, mock_dl, mock_push, mock_find, mock_cfg):
        """merge_strategy=fit_replace → FIT upload path, never the exerciseSets PUT."""
        mock_cfg.return_value = {"merge_strategy": "fit_replace", "merge_delete_original": True}
        mock_find.return_value = _make_garmin_activity()
        mock_dl.return_value = b"fit"
        mock_extract.return_value = [120]
        mock_gen.return_value = {"exercises": 1, "total_sets": 1, "calories": 50, "avg_hr": 120}
        mock_upload.return_value = {"activity_id": 42}

        result = attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())

        assert result.merged is True
        assert result.activity_id == 42
        mock_upload.assert_called_once()
        mock_push.assert_not_called()


# ---------------------------------------------------------------------------
# HR round-trip: extract_hr_samples reads back what generate_fit wrote
# ---------------------------------------------------------------------------

class TestExtractHrSamples:
    """Round-trip: write a FIT with known HR, read it back via the extractor."""

    def test_round_trip(self, sample_profile: dict, tmp_path: Path) -> None:
        from hevy2garmin.fit import generate_fit
        from hevy2garmin.garmin import extract_hr_samples

        workout = {
            "id": "hr-rt",
            "title": "HR Round Trip",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:30:00+00:00",
            "exercises": [{
                "index": 0, "title": "Bench Press (Barbell)", "exercise_template_id": "X",
                "sets": [{"type": "normal", "weight_kg": 60, "reps": 8}],
            }],
        }
        hr_in = [110, 112, 115, 118, 120, 119, 117, 115, 113, 110]
        fit_path = tmp_path / "rt.fit"
        generate_fit(workout, hr_samples=hr_in, output_path=str(fit_path), profile=sample_profile)

        hr_out = extract_hr_samples(fit_path.read_bytes())
        assert hr_out == hr_in, f"Round-trip mismatch: in={hr_in} out={hr_out}"

    def test_no_hr_records_returns_empty(self, sample_profile: dict, tmp_path: Path) -> None:
        """FIT generated with hr_samples=None has zero RecordMessage HR → extractor returns []."""
        from hevy2garmin.fit import generate_fit
        from hevy2garmin.garmin import extract_hr_samples

        workout = {
            "id": "no-hr",
            "title": "No HR",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:30:00+00:00",
            "exercises": [{
                "index": 0, "title": "Bench Press (Barbell)", "exercise_template_id": "X",
                "sets": [{"type": "normal", "weight_kg": 60, "reps": 8}],
            }],
        }
        fit_path = tmp_path / "no-hr.fit"
        generate_fit(workout, hr_samples=None, output_path=str(fit_path), profile=sample_profile)

        assert extract_hr_samples(fit_path.read_bytes()) == []


# ---------------------------------------------------------------------------
# Strategy: fit_replace end-to-end (mocked I/O)
# ---------------------------------------------------------------------------

class TestFitReplaceMerge:
    """End-to-end attempt_merge with the FIT-replace strategy (mocked I/O)."""

    def setup_method(self):
        reset_circuit_breaker()

    def _patches(self):
        """Common patch stack for attempt_merge tests."""
        return {
            "find": patch("hevy2garmin.merge.find_matching_garmin_activity"),
            "download": patch("hevy2garmin.merge.download_activity_fit"),
            "extract": patch("hevy2garmin.merge.extract_hr_samples"),
            "generate": patch("hevy2garmin.merge.generate_fit"),
            "upload": patch("hevy2garmin.merge.upload_fit"),
            "rename": patch("hevy2garmin.merge.rename_activity"),
            "set_desc": patch("hevy2garmin.merge.set_description"),
            "delete": patch("hevy2garmin.merge.delete_activity"),
            "load_cfg": patch("hevy2garmin.merge.load_config"),
        }

    def test_calls_in_order_with_delete_default(self):
        """Match → download → extract → generate → upload → rename → set_desc → delete."""
        ps = self._patches()
        mocks = {k: p.start() for k, p in ps.items()}
        try:
            mocks["find"].return_value = _make_garmin_activity()
            mocks["download"].return_value = b"fake-fit-bytes"
            mocks["extract"].return_value = [120, 121, 122]
            mocks["generate"].return_value = {"exercises": 2, "total_sets": 5, "calories": 200, "avg_hr": 121}
            mocks["upload"].return_value = {"activity_id": 99999}
            mocks["load_cfg"].return_value = {"merge_strategy": "fit_replace", "merge_delete_original": True}

            result = attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())

            assert result.merged is True
            assert result.activity_id == 99999
            mocks["download"].assert_called_once()
            mocks["extract"].assert_called_once_with(b"fake-fit-bytes")
            mocks["generate"].assert_called_once()
            # generate_fit was called with hr_samples = the extracted list
            assert mocks["generate"].call_args.kwargs.get("hr_samples") == [120, 121, 122]
            mocks["upload"].assert_called_once()
            mocks["rename"].assert_called_once()
            mocks["set_desc"].assert_called_once()
            mocks["delete"].assert_called_once_with(mocks["delete"].call_args.args[0], 12345)
        finally:
            for p in ps.values():
                p.stop()

    def test_keeps_original_when_flag_off(self):
        """merge_delete_original=False → delete_activity is NOT called."""
        ps = self._patches()
        mocks = {k: p.start() for k, p in ps.items()}
        try:
            mocks["find"].return_value = _make_garmin_activity()
            mocks["download"].return_value = b"fake"
            mocks["extract"].return_value = [120]
            mocks["generate"].return_value = {"exercises": 1, "total_sets": 1, "calories": 50, "avg_hr": 120}
            mocks["upload"].return_value = {"activity_id": 88888}
            mocks["load_cfg"].return_value = {"merge_strategy": "fit_replace", "merge_delete_original": False}

            result = attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())

            assert result.merged is True
            assert result.activity_id == 88888
            mocks["delete"].assert_not_called()
        finally:
            for p in ps.values():
                p.stop()

    def test_falls_back_to_no_hr_on_download_error(self):
        """download_activity_fit raises → generate_fit called with hr_samples=None."""
        ps = self._patches()
        mocks = {k: p.start() for k, p in ps.items()}
        try:
            mocks["find"].return_value = _make_garmin_activity()
            mocks["download"].side_effect = RuntimeError("network down")
            mocks["generate"].return_value = {"exercises": 1, "total_sets": 1, "calories": 50, "avg_hr": 90}
            mocks["upload"].return_value = {"activity_id": 77777}
            mocks["load_cfg"].return_value = {"merge_strategy": "fit_replace", "merge_delete_original": True}

            result = attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())

            assert result.merged is True
            mocks["extract"].assert_not_called()  # download blew up before extract
            assert mocks["generate"].call_args.kwargs.get("hr_samples") is None
            mocks["upload"].assert_called_once()
            mocks["delete"].assert_called_once()
        finally:
            for p in ps.values():
                p.stop()

    def test_empty_hr_samples_passed_as_none(self):
        """extract_hr_samples returns [] → generate_fit called with hr_samples=None."""
        ps = self._patches()
        mocks = {k: p.start() for k, p in ps.items()}
        try:
            mocks["find"].return_value = _make_garmin_activity()
            mocks["download"].return_value = b"fake"
            mocks["extract"].return_value = []
            mocks["generate"].return_value = {"exercises": 1, "total_sets": 1, "calories": 50, "avg_hr": 90}
            mocks["upload"].return_value = {"activity_id": 66666}
            mocks["load_cfg"].return_value = {"merge_strategy": "fit_replace", "merge_delete_original": True}

            attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())

            assert mocks["generate"].call_args.kwargs.get("hr_samples") is None
        finally:
            for p in ps.values():
                p.stop()

    def test_returns_merged_even_if_delete_fails(self):
        """delete_activity raises → still merged=True; both activities exist."""
        ps = self._patches()
        mocks = {k: p.start() for k, p in ps.items()}
        try:
            mocks["find"].return_value = _make_garmin_activity()
            mocks["download"].return_value = b"fake"
            mocks["extract"].return_value = [120]
            mocks["generate"].return_value = {"exercises": 1, "total_sets": 1, "calories": 50, "avg_hr": 120}
            mocks["upload"].return_value = {"activity_id": 55555}
            mocks["delete"].side_effect = RuntimeError("delete API down")
            mocks["load_cfg"].return_value = {"merge_strategy": "fit_replace", "merge_delete_original": True}

            result = attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())

            assert result.merged is True
            assert result.activity_id == 55555
        finally:
            for p in ps.values():
                p.stop()

    def test_no_match_returns_fallback(self):
        """find_matching_garmin_activity returns None → no upload/delete attempted."""
        ps = self._patches()
        mocks = {k: p.start() for k, p in ps.items()}
        try:
            mocks["find"].return_value = None
            mocks["load_cfg"].return_value = {"merge_strategy": "fit_replace"}

            result = attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())

            assert result.merged is False
            assert result.fallback_reason is not None
            assert "No matching" in result.fallback_reason
            mocks["download"].assert_not_called()
            mocks["upload"].assert_not_called()
            mocks["delete"].assert_not_called()
        finally:
            for p in ps.values():
                p.stop()

    def test_circuit_breaker_trips_after_upload_failures(self):
        """3 consecutive upload failures → 4th call is short-circuited."""
        ps = self._patches()
        mocks = {k: p.start() for k, p in ps.items()}
        try:
            mocks["find"].return_value = _make_garmin_activity()
            mocks["download"].return_value = b"fake"
            mocks["extract"].return_value = [120]
            mocks["generate"].return_value = {"exercises": 1, "total_sets": 1, "calories": 50, "avg_hr": 120}
            mocks["upload"].side_effect = RuntimeError("upload failed")
            mocks["load_cfg"].return_value = {"merge_strategy": "fit_replace", "merge_delete_original": True}

            for _ in range(3):
                attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())

            result = attempt_merge(MagicMock(), HEVY_WORKOUT, MagicMock())
            assert result.merged is False
            assert result.fallback_reason is not None
            assert "Circuit breaker" in result.fallback_reason
        finally:
            for p in ps.values():
                p.stop()


# ---------------------------------------------------------------------------
# Sync integration tests
# ---------------------------------------------------------------------------

class TestSyncIntegration:
    """Test merge mode wired into sync.py."""

    WORKOUTS = [
        {
            "id": "w1", "title": "Push",
            "start_time": "2026-03-15T18:00:00+00:00", "end_time": "2026-03-15T18:45:00+00:00",
            "updated_at": "2026-03-15T18:45:00+00:00",
            "exercises": [{"title": "Bench Press (Barbell)", "sets": [{"type": "normal", "weight_kg": 60, "reps": 8}]}],
        },
        {
            "id": "w2", "title": "Pull",
            "start_time": "2026-03-16T18:00:00+00:00", "end_time": "2026-03-16T18:45:00+00:00",
            "updated_at": "2026-03-16T18:45:00+00:00",
            "exercises": [{"title": "Bent Over Row (Barbell)", "sets": [{"type": "normal", "weight_kg": 50, "reps": 10}]}],
        },
    ]

    def _mock_hevy(self):
        h = MagicMock()
        h.get_workout_count.return_value = 2
        h.get_workouts.return_value = {"workouts": self.WORKOUTS, "page_count": 1}
        return h

    @patch("hevy2garmin.sync.db")
    @patch("hevy2garmin.sync.get_client")
    @patch("hevy2garmin.sync.HevyClient")
    @patch("hevy2garmin.sync.attempt_merge")
    def test_merge_on_both_match(self, mock_merge, mock_hevy_cls, mock_gclient, mock_db):
        """merge ON, both match → both use merge path."""
        mock_hevy_cls.return_value = self._mock_hevy()
        mock_gclient.return_value = MagicMock()
        mock_db.is_synced.return_value = False
        mock_merge.return_value = MergeResult(merged=True, activity_id=12345)

        from hevy2garmin.sync import sync
        stats = sync(config={"hevy_api_key": "t", "merge_mode": True}, limit=2)

        assert stats["merged"] == 2
        assert stats["merge_fallback"] == 0
        assert mock_merge.call_count == 2
        calls = mock_db.mark_synced.call_args_list
        assert all(c.kwargs.get("sync_method") == "merge" for c in calls)

    @patch("hevy2garmin.sync.db")
    @patch("hevy2garmin.sync.get_client")
    @patch("hevy2garmin.sync.HevyClient")
    @patch("hevy2garmin.sync.attempt_merge")
    @patch("hevy2garmin.sync.generate_fit", return_value={"exercises": 1, "total_sets": 1, "calories": 100, "avg_hr": 90})
    @patch("hevy2garmin.sync.upload_fit", return_value={"activity_id": 222})
    @patch("hevy2garmin.sync.find_activity_by_start_time", return_value=None)
    @patch("hevy2garmin.sync.rename_activity")
    @patch("hevy2garmin.sync.set_description")
    @patch("hevy2garmin.sync.generate_description", return_value="test")
    def test_merge_on_second_falls_back(self, *mocks):
        """merge ON, first matches, second doesn't → fallback to upload."""
        (mock_desc, mock_setdesc, mock_rename, mock_find, mock_upload,
         mock_fit, mock_merge, mock_hevy_cls, mock_gclient, mock_db) = mocks

        mock_hevy_cls.return_value = self._mock_hevy()
        mock_gclient.return_value = MagicMock()
        mock_db.is_synced.return_value = False
        call_count = [0]
        def alt(c, w, d, **kwargs):
            call_count[0] += 1
            return MergeResult(merged=True, activity_id=111) if call_count[0] == 1 else MergeResult(merged=False, fallback_reason="No match")
        mock_merge.side_effect = alt

        from hevy2garmin.sync import sync
        stats = sync(config={"hevy_api_key": "t", "merge_mode": True}, limit=2)

        assert stats["merged"] == 1
        assert stats["merge_fallback"] == 1
        calls = mock_db.mark_synced.call_args_list
        assert calls[0].kwargs.get("sync_method") == "merge"
        assert calls[1].kwargs.get("sync_method") == "upload_fallback"

    @patch("hevy2garmin.sync.db")
    @patch("hevy2garmin.sync.get_client")
    @patch("hevy2garmin.sync.HevyClient")
    @patch("hevy2garmin.sync.attempt_merge")
    @patch("hevy2garmin.sync.generate_fit", return_value={"exercises": 1, "total_sets": 1, "calories": 100, "avg_hr": 90})
    @patch("hevy2garmin.sync.upload_fit", return_value={"activity_id": 333})
    @patch("hevy2garmin.sync.find_activity_by_start_time", return_value=None)
    @patch("hevy2garmin.sync.rename_activity")
    @patch("hevy2garmin.sync.set_description")
    @patch("hevy2garmin.sync.generate_description", return_value="test")
    def test_merge_off_normal_upload(self, *mocks):
        """merge OFF → normal upload, merge never attempted."""
        (mock_desc, mock_setdesc, mock_rename, mock_find, mock_upload,
         mock_fit, mock_merge, mock_hevy_cls, mock_gclient, mock_db) = mocks

        mock_hevy_cls.return_value = self._mock_hevy()
        mock_gclient.return_value = MagicMock()
        mock_db.is_synced.return_value = False

        from hevy2garmin.sync import sync
        stats = sync(config={"hevy_api_key": "t", "merge_mode": False}, limit=2)

        assert stats["merged"] == 0
        assert mock_merge.call_count == 0
        calls = mock_db.mark_synced.call_args_list
        assert all(c.kwargs.get("sync_method") == "upload" for c in calls)
