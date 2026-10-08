"""Tests for Garmin activity description generation."""

from __future__ import annotations

from hevy2garmin.garmin import generate_description


class TestDescriptionGeneration:
    def test_standard_workout(self, sample_workout: dict) -> None:
        desc = generate_description(sample_workout, calories=350, avg_hr=120)
        assert "Push" in desc
        assert "350 kcal" in desc
        assert "avg 120 bpm" in desc
        assert "Bench Press" in desc

    def test_warmup_only_exercise(self) -> None:
        workout = {
            "title": "Warmup Only",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:10:00+00:00",
            "exercises": [
                {
                    "title": "Band Pull Apart",
                    "sets": [
                        {"type": "warmup", "weight_kg": 0, "reps": 15},
                        {"type": "warmup", "weight_kg": 0, "reps": 15},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "Band Pull Apart" in desc
        assert "warmup" in desc

    def test_cardio_exercise_shows_distance(self) -> None:
        workout = {
            "title": "Cardio Day",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:30:00+00:00",
            "exercises": [
                {
                    "title": "Treadmill",
                    "sets": [
                        {"type": "normal", "distance_meters": 5000, "duration_seconds": 1800},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "Treadmill" in desc
        assert "5.0km" in desc
        assert "30min" in desc

    def test_cardio_duration_only(self) -> None:
        workout = {
            "title": "Bike",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:20:00+00:00",
            "exercises": [
                {
                    "title": "Stationary Bike",
                    "sets": [
                        {"type": "normal", "duration_seconds": 1200},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "Stationary Bike" in desc
        assert "20min" in desc

    def test_empty_exercises(self) -> None:
        workout = {
            "title": "Empty",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:10:00+00:00",
            "exercises": [],
        }
        desc = generate_description(workout)
        assert "Empty" in desc
        assert "hevy2garmin" in desc

    def test_special_characters_in_name(self) -> None:
        workout = {
            "title": "Test",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:30:00+00:00",
            "exercises": [
                {
                    "title": "André's Über-Exercise™ (50% off!)",
                    "sets": [
                        {"type": "normal", "weight_kg": 40, "reps": 10},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "André's Über-Exercise™" in desc

    def test_no_calories_no_hr(self) -> None:
        workout = {
            "title": "Minimal",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:10:00+00:00",
            "exercises": [],
        }
        desc = generate_description(workout)
        assert "kcal" not in desc
        assert "bpm" not in desc

    def test_mixed_cardio_and_strength(self) -> None:
        workout = {
            "title": "Mixed",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T21:00:00+00:00",
            "exercises": [
                {
                    "title": "Bench Press",
                    "sets": [
                        {"type": "normal", "weight_kg": 80, "reps": 8},
                        {"type": "normal", "weight_kg": 80, "reps": 6},
                    ],
                },
                {
                    "title": "Treadmill",
                    "sets": [
                        {"type": "normal", "distance_meters": 3000, "duration_seconds": 900},
                    ],
                },
            ],
        }
        desc = generate_description(workout)
        assert "80.0kg" in desc
        assert "3.0km" in desc

    def test_null_reps_and_weight_do_not_crash(self) -> None:
        # Hevy sends reps/weight present but set to None for bodyweight and
        # isometric sets. These must not crash generate_description. Regression
        # for #309 (max() over [None, None] raised TypeError).
        workout = {
            "title": "Bodyweight Day",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:30:00+00:00",
            "exercises": [
                {
                    "title": "Pull Up",
                    "sets": [
                        {"type": "normal", "weight_kg": None, "reps": None},
                        {"type": "normal", "weight_kg": None, "reps": None},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "Pull Up" in desc
        assert "0.0kg × 0" in desc

    def test_mixed_null_and_weighted_sets_use_weighted_top(self) -> None:
        # A null set alongside real weighted sets must be ignored, not crash,
        # and the top figures must come from the weighted set. Regression for #309.
        workout = {
            "title": "Mixed Nulls",
            "start_time": "2026-04-01T20:00:00+00:00",
            "end_time": "2026-04-01T20:30:00+00:00",
            "exercises": [
                {
                    "title": "Row",
                    "sets": [
                        {"type": "normal", "weight_kg": 60, "reps": 10},
                        {"type": "normal", "weight_kg": None, "reps": None},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "60.0kg × 10" in desc

    def test_failure_and_drop_sets_count_as_working_sets(self) -> None:
        workout = {
            "title": "Push",
            "exercises": [
                {
                    "title": "Bench Press",
                    "sets": [
                        {"type": "normal", "weight_kg": 80, "reps": 8},
                        {"type": "normal", "weight_kg": 80, "reps": 8},
                        {"type": "failure", "weight_kg": 80, "reps": 6},
                        {"type": "dropset", "weight_kg": 60, "reps": 10},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "• Bench Press: 4 sets · 80.0kg × 10" in desc

    def test_failure_only_exercise_is_listed(self) -> None:
        workout = {
            "title": "Pull",
            "exercises": [
                {
                    "title": "Pull Up",
                    "sets": [
                        {"type": "failure", "weight_kg": 0, "reps": 12},
                        {"type": "failure", "weight_kg": 0, "reps": 9},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "• Pull Up: 2 sets · 0.0kg × 12" in desc

    def test_warmups_excluded_from_working_count(self) -> None:
        workout = {
            "title": "Legs",
            "exercises": [
                {
                    "title": "Squat",
                    "sets": [
                        {"type": "warmup", "weight_kg": 60, "reps": 10},
                        {"type": "warmup", "weight_kg": 80, "reps": 5},
                        {"type": "normal", "weight_kg": 120, "reps": 5},
                        {"type": "failure", "weight_kg": 120, "reps": 4},
                    ],
                },
                {
                    "title": "Band Pull Apart",
                    "sets": [
                        {"type": "warmup", "weight_kg": 0, "reps": 15},
                        {"type": "warmup", "weight_kg": 0, "reps": 15},
                    ],
                },
            ],
        }
        desc = generate_description(workout)
        assert "• Squat: 2 sets · 120.0kg × 5" in desc
        assert "• Band Pull Apart: 2 warmup sets" in desc

    def test_set_without_type_counts_as_working_set(self) -> None:
        workout = {
            "title": "Arms",
            "exercises": [
                {
                    "title": "Curl",
                    "sets": [
                        {"type": "normal", "weight_kg": 15, "reps": 10},
                        {"weight_kg": 15, "reps": 10},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "• Curl: 2 sets · 15.0kg × 10" in desc

    def test_failure_set_can_hold_top_weight_and_reps(self) -> None:
        workout = {
            "title": "Push",
            "exercises": [
                {
                    "title": "Overhead Press",
                    "sets": [
                        {"type": "normal", "weight_kg": 40, "reps": 8},
                        {"type": "failure", "weight_kg": 45, "reps": 11},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "• Overhead Press: 2 sets · 45.0kg × 11" in desc

    def test_failure_cardio_sets_are_counted(self) -> None:
        workout = {
            "title": "Cardio",
            "exercises": [
                {
                    "title": "Treadmill",
                    "sets": [
                        {"type": "normal", "distance_meters": 3000, "duration_seconds": 900},
                        {"type": "failure", "distance_meters": 2000, "duration_seconds": 900},
                    ],
                }
            ],
        }
        desc = generate_description(workout)
        assert "• Treadmill: 2 sets · 5.0km · 30min" in desc
