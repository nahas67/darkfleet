"""Gate 0A proof: the legacy TS engine golden fixture is intact and self-consistent.

The full port-parity suite (Python detector output == this fixture) lands in Gate 3.
Here we prove the fixture exists, is well-formed, and matches the recorded run.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "ts_engine_golden.json"

CANONICAL = {
    "SAR_MATCHED_AIS",
    "SAR_UNMATCHED",
    "AIS_ONLY",
    "STATIONARY_OR_INFRASTRUCTURE",
    "SEA_CLUTTER",
    "LOW_CONFIDENCE",
    "UNRESOLVED",
}


def _load() -> dict:
    assert GOLDEN.exists(), f"missing golden fixture: {GOLDEN}"
    return json.loads(GOLDEN.read_text())


def test_golden_meta_matches_recorded_run() -> None:
    g = _load()
    assert g["meta"]["generator"] == "legacy-ts-engine"
    assert g["meta"]["sceneId"] == "SIM-S1C-MALACCA-001"
    assert g["meta"]["width"] == 180 and g["meta"]["height"] == 180
    assert g["meta"]["resolutionMeters"] == 10


def test_golden_counts_match_recorded_run() -> None:
    g = _load()
    assert g["counts"]["detPixels"] == 97
    assert g["counts"]["components"] == 12
    assert g["counts"]["targets"] == 12
    assert g["counts"]["aisOnly"] == 2
    assert g["counts"]["matched"] == 4
    assert g["counts"]["unmatched"] == 7
    assert g["counts"]["infra"] == 1


def test_golden_uses_only_canonical_classifications() -> None:
    g = _load()
    for t in g["targets"]:
        assert t["cls"] in CANONICAL, t


def test_golden_geodesy_spot_values() -> None:
    g = _load()
    assert math.isclose(g["geodesy"]["dist"], 1113.194907932737, rel_tol=1e-9)
    assert math.isclose(g["geodesy"]["radius"], 1292.59999992, rel_tol=1e-9)
    assert g["geodesy"]["headingDiff"] == 3
    assert g["geodesy"]["propagated"]["lon"] > 103.80


def test_golden_targets_carry_evidence_fields() -> None:
    g = _load()
    required = {"id", "cls", "lat", "lon", "sarConf", "aisConf", "corr"}
    for t in g["targets"]:
        assert required.issubset(t.keys()), t["id"]
