"""Tests for exercise mapper."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from hevy2garmin.mapper import (
    HEVY_TO_GARMIN,
    _UNKNOWN_CATEGORY,
    lookup_exercise,
    save_custom_mapping,
    _custom_mappings,
    _ensure_custom_loaded,
)


class TestLookupBuiltIn:
    def test_known_exercise(self) -> None:
        cat, subcat, name = lookup_exercise("Bench Press (Barbell)")
        assert cat == 0
        assert subcat == 1
        assert name == "Bench Press (Barbell)"

    def test_squat(self) -> None:
        cat, subcat, name = lookup_exercise("Squat (Barbell)")
        assert cat == 28
        assert name == "Squat (Barbell)"

    def test_unknown_exercise(self) -> None:
        cat, subcat, name = lookup_exercise("Made Up Exercise 12345")
        assert cat == _UNKNOWN_CATEGORY
        assert subcat == 0
        assert name == "Made Up Exercise 12345"

    def test_empty_string(self) -> None:
        cat, subcat, name = lookup_exercise("")
        assert cat == _UNKNOWN_CATEGORY
        assert name == ""

    def test_mapping_count_minimum(self) -> None:
        assert len(HEVY_TO_GARMIN) >= 400

    def test_cable_core_pallof_press(self) -> None:
        # Hevy's exact name (single-f "Pallof") must map to the dedicated
        # FIT core/cable_core_press subcategory, not fall through to unknown.
        cat, subcat, name = lookup_exercise("Cable Core Pallof Press")
        assert cat == 5
        assert subcat == 6
        assert name == "Cable Core Pallof Press"

    def test_preserves_original_name(self) -> None:
        _, _, name = lookup_exercise("Deadlift (Barbell)")
        assert name == "Deadlift (Barbell)"


class TestGroundTruthMappings:
    """Mappings reconciled against garmin-fit-sdk 21.208.0 (see scripts/audit_mappings.py)."""

    NEWLY_MAPPED = {
        "Walking Lunge (Sandbag)": (17, 79),  # weighted_walking_lunge
        "Burpee Broad Jumps": (29, 0),        # burpee
        "Sled Pull": (45, 0),                 # sled / backward_drag
        "Ski Erg": (65534, 0),                # no FIT match
        "Tibialis Raise (Wand/BW)": (65534, 0),  # no FIT match
    }
    RELABELED = {
        "High Knees": (31, 26),        # was (2,0)=bob_and_weave_circle -> walking_high_knees
        "Downward Dog": (36, 21),      # was (31,0)=quadruped_rocking -> downward_facing_dog
        "Battle Ropes": (38, 12),      # was (38,0)=alternating_figure_eight -> double_arm_wave
        "Split Squat (Dumbbell)": (17, 21),  # was (17,28)=gunslinger_lunge -> dumbbell_lunge
        "Sled Push": (45, 4),          # was (20,29)=squat_jump_onto_box -> sled / push
    }
    # whole-activity entries with no exercise-level FIT match -> honest UNKNOWN
    NOW_UNKNOWN = ["Aerobics", "Climbing", "HIIT", "Pilates", "Skating", "Skiing",
                   "Snowboarding", "Swimming", "Yoga", "Warm Up", "Stretching"]

    def test_newly_mapped(self) -> None:
        for name, (cat, sub) in self.NEWLY_MAPPED.items():
            assert lookup_exercise(name)[:2] == (cat, sub), name

    def test_relabeled(self) -> None:
        for name, (cat, sub) in self.RELABELED.items():
            assert lookup_exercise(name)[:2] == (cat, sub), name

    def test_unmatched_map_to_unknown(self) -> None:
        for name in self.NOW_UNKNOWN:
            assert lookup_exercise(name)[:2] == (_UNKNOWN_CATEGORY, 0), name

    def test_every_mapping_is_valid_fit_pair(self) -> None:
        """Every (cat, sub) must exist in the official FIT catalog ground truth."""
        catalog_path = Path(__file__).resolve().parent.parent / "scripts" / "fit_exercise_catalog.json"
        catalog = json.loads(catalog_path.read_text())
        cats = catalog["categories"]
        names = catalog["exercise_names"]
        bad = []
        for ex_name, (cat, sub) in HEVY_TO_GARMIN.items():
            if cat == _UNKNOWN_CATEGORY:
                continue
            if str(cat) not in cats or str(sub) not in names.get(str(cat), {}):
                bad.append((ex_name, cat, sub))
        assert not bad, f"invalid FIT (cat, sub) pairs: {bad}"


class TestCustomMappings:
    def test_custom_overrides_builtin(self, tmp_path: Path) -> None:
        mappings_file = tmp_path / "custom_mappings.json"
        mappings_file.write_text(json.dumps({"Bench Press (Barbell)": [99, 88]}))

        # Reset custom state
        _custom_mappings.clear()
        import hevy2garmin.mapper as m
        m._custom_loaded = False

        with patch.object(Path, "expanduser", return_value=mappings_file):
            with patch("hevy2garmin.mapper._custom_loaded", False):
                # Force reload
                m._custom_loaded = False
                m._custom_mappings.clear()
                m._custom_mappings["Bench Press (Barbell)"] = (99, 88)
                cat, subcat, _ = lookup_exercise("Bench Press (Barbell)")
                assert cat == 99
                assert subcat == 88

        # Cleanup
        m._custom_mappings.clear()

    def test_custom_does_not_affect_other_exercises(self) -> None:
        import hevy2garmin.mapper as m
        m._custom_mappings["Only This One"] = (1, 2)
        cat, _, _ = lookup_exercise("Squat (Barbell)")
        assert cat == 28  # unchanged
        m._custom_mappings.clear()

    def test_save_custom_mapping_in_memory(self) -> None:
        import hevy2garmin.mapper as m
        m._custom_mappings["Test Exercise"] = (5, 10)
        cat, subcat, _ = lookup_exercise("Test Exercise")
        assert cat == 5
        assert subcat == 10
        m._custom_mappings.clear()

    def test_missing_custom_file_no_crash(self) -> None:
        import hevy2garmin.mapper as m
        m._custom_loaded = False
        m._custom_mappings.clear()
        # Should not crash when file doesn't exist
        _ensure_custom_loaded()


class TestSaveCustomMappingCloud:
    """save_custom_mapping must write to the DB on cloud (#142, #145).

    The old file-only write 500'd on Vercel's read-only filesystem, so custom
    mappings silently failed to persist (u/Zephyro7, u/fastcoconut).
    """

    def test_writes_to_db_on_cloud(self) -> None:
        from unittest.mock import MagicMock
        import hevy2garmin.mapper as m
        m._custom_mappings.clear()
        fake_db = MagicMock()
        with patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=fake_db):
            save_custom_mapping("Agachamento Búlgaro", 28, 9)
        fake_db.save_custom_mapping.assert_called_once_with("Agachamento Búlgaro", 28, 9)
        assert m._custom_mappings["Agachamento Búlgaro"] == (28, 9)
        m._custom_mappings.clear()

    def test_does_not_touch_filesystem_on_cloud(self, tmp_path: Path) -> None:
        from unittest.mock import MagicMock
        import hevy2garmin.mapper as m
        m._custom_mappings.clear()
        target = tmp_path / "custom_mappings.json"
        with patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"), \
             patch("hevy2garmin.db.get_db", return_value=MagicMock()), \
             patch.object(Path, "expanduser", return_value=target):
            save_custom_mapping("Foo (Bar)", 1, 2)
        assert not target.exists()  # DB path used, no file written
        m._custom_mappings.clear()

    def test_falls_back_to_file_when_local(self, tmp_path: Path) -> None:
        import hevy2garmin.mapper as m
        m._custom_mappings.clear()
        target = tmp_path / "custom_mappings.json"
        with patch("hevy2garmin.db.get_database_url", return_value=None), \
             patch.object(Path, "expanduser", return_value=target):
            save_custom_mapping("Foo (Bar)", 12, 34)
        assert json.loads(target.read_text())["Foo (Bar)"] == [12, 34]
        assert m._custom_mappings["Foo (Bar)"] == (12, 34)
        m._custom_mappings.clear()
