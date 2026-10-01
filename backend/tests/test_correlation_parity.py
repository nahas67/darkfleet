"""CP5 gate: correlation parity (COR, TST-002 second half).

Positions, associations, classifications, and radii must match the golden run.
Distances/scores carry tolerance ONLY for the mandated haversine->WGS84-Geod
upgrade; the measured deltas are recorded in the CP5 ledger entry.
"""

from __future__ import annotations

import json
from pathlib import Path

from darkfleet.correlation.geodesy import dynamic_radius, geodesic_meters, orient_diff, propagate
from darkfleet.correlation.match import correlate

GOLDEN_DIR = Path(__file__).parent / "fixtures" / "golden"
GOLDEN = json.loads((GOLDEN_DIR / "ts_engine_golden.json").read_text())
AIS = json.loads((GOLDEN_DIR / "ts_ais.json").read_text())["aisObservations"]
META = GOLDEN["meta"]
BBOX = tuple(META["bbox"])


def _run() -> dict:
    return correlate(
        GOLDEN["components"],
        AIS,
        META["acquisitionTime"],
        META["width"],
        META["height"],
        BBOX,  # type: ignore[arg-type]
        META["resolutionMeters"],
        "SCAN-GOLDEN-001",
    )


def test_geodesy_spot() -> None:
    assert 1104.0 < geodesic_meters(1.20, 103.80, 1.21, 103.80) < 1108.0
    assert dynamic_radius(1200, 60, 15, 2800) == 1200 + 60 * 15 * 0.514444444 * 0.20
    assert orient_diff(122, 125, False) == 3
    p = propagate(1.20, 103.80, 20, 90, 60)
    assert abs(p["lon"] - 103.805547) < 1e-6


def test_associations_and_classifications_exact() -> None:
    out = _run()
    got, want = out["targets"], GOLDEN["targets"]
    assert len(got) == len(want) == 12
    for g, w in zip(got, want):
        assert g["id"] == w["id"]
        assert g["cls"] == w["cls"], (g["id"], g["cls"], w["cls"])
        # toFixed(6) vs round(6) can differ on exact ties; 2e-6 deg ~= 0.2 mm.
        assert abs(g["lat"] - w["lat"]) < 2e-6 and abs(g["lon"] - w["lon"]) < 2e-6
        assert g["corr"]["mmsi"] == (w["corr"]["mmsi"])
        assert g["sarConf"] == w["sarConf"], (g["id"], g["sarConf"], w["sarConf"])


def test_scores_within_geod_upgrade_band() -> None:
    out = _run()
    for g, w in zip(out["targets"], GOLDEN["targets"]):
        assert abs(g["aisConf"] - w["aisConf"]) <= 0.02, (g["id"], g["aisConf"], w["aisConf"])
        gd, wd = g["corr"].get("distanceOffsetMeters"), w["corr"]["distanceOffsetMeters"]
        if gd is None:
            assert wd is None
        else:
            # Ellipsoidal-vs-sphere delta on sub-km baselines (~1%); honest cost
            # of the mandated geodesic upgrade, recorded in the CP5 entry.
            assert abs(gd - wd) / max(wd, 1) <= 0.025, (g["id"], gd, wd)
        gs, ws = g["corr"].get("scoreDecomposition"), w["corr"].get("scoreDecomposition")
        if gs is None:
            assert ws is None
        else:
            assert ws is not None
            for k in ("spatialScore", "temporalScore", "headingScore", "sizeScore", "compositeScore"):
                assert abs(gs[k] - ws[k]) <= 0.005, (g["id"], k, gs[k], ws[k])
            assert gs["matchRadiusMeters"] == ws["matchRadiusMeters"]
            assert gs["timeDeltaSeconds"] == ws["timeDeltaSeconds"]
        # Predicted positions live at corr level in both schemas.
        for k in ("predictedLat", "predictedLon"):
            gv, wv = g["corr"].get(k), w["corr"].get(k)
            if gv is None:
                assert wv is None
            else:
                assert wv is not None and abs(gv - wv) < 2e-6, (g["id"], k, gv, wv)


def test_ais_only_emitted() -> None:
    out = _run()
    assert len(out["ais_only"]) == GOLDEN["counts"]["aisOnly"] == 2
    for a in out["ais_only"]:
        assert a["cls"] == "AIS_ONLY" and len(a["mmsi"]) == 9


def test_new_states_reachable_synthetically() -> None:
    from datetime import UTC, datetime, timedelta

    acq = datetime(2026, 9, 18, 14, 32, 18, tzinfo=UTC)
    bbox = (103.65, 1.10, 104.05, 1.40)
    weak_comp = {
        "cx": 90.0, "cy": 90.0, "area": 4, "major": 2.0, "minor": 1.5,
        "orient": 45, "maxDb": -22.0, "meanDb": -23.0, "wake": False,
        "wakeHdg": None, "clutterMeanDb": -21.0,
    }
    out2 = correlate([weak_comp], [], acq.isoformat(), 180, 180, bbox, 10, "S")
    assert out2["targets"][0]["cls"] == "SEA_CLUTTER"

    # Sub-threshold candidate in [0.30, 0.40): LOW_CONFIDENCE (probed config).
    low_comp = dict(weak_comp, maxDb=2.0, meanDb=-5.0, area=8, major=2.5, minor=1.8)
    low_ais = [{
        "mmsi": "111111111", "shipName": "X", "shipType": "Cargo",
        "lat": 1.25, "lon": 103.856, "sog": 5.0, "cog": 200.0,
        "timestamp": (acq - timedelta(seconds=500)).isoformat(), "length": 400,
    }]
    out3 = correlate([low_comp], low_ais, acq.isoformat(), 180, 180, bbox, 10, "S")
    assert out3["targets"][0]["cls"] == "LOW_CONFIDENCE"

    # Two near-equal claimants: UNRESOLVED (probed config).
    def _ais(mmsi: str, lon: float, lat: float) -> dict:
        return {
            "mmsi": mmsi, "shipName": "X", "shipType": "Cargo", "lat": lat, "lon": lon,
            "sog": 10.0, "cog": 45.0,
            "timestamp": (acq - timedelta(seconds=30)).isoformat(), "length": 25,
        }

    out4 = correlate(
        [low_comp], [_ais("111111111", 103.8505, 1.2505), _ais("222222222", 103.8507, 1.2503)],
        acq.isoformat(), 180, 180, bbox, 10, "S",
    )
    assert out4["targets"][0]["cls"] == "UNRESOLVED"
