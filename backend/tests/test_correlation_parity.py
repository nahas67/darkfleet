"""CP5 gate: correlation parity (COR, TST-002 second half).

Positions, associations, classifications, and radii must match the golden run.

GEO-CORR: the golden coordinates were recalibrated from the pixel-centre
convention. This test no longer hands raw pixel centroids and a bbox to
``correlate`` -- it geolocates them from the grid's own affine transform first,
which is the architecture the checkpoint mandates. The AOI-vs-window defect and
the corner-vs-centre defect are both exercised and closed in
``tests/test_geolocation.py``, which derives its expectations analytically
rather than from this fixture.
"""

from __future__ import annotations

import json
from pathlib import Path

from darkfleet.correlation.geodesy import dynamic_radius, geodesic_meters, orient_diff, propagate
from darkfleet.correlation.match import correlate
from darkfleet.geolocation import geolocate_components

GOLDEN_DIR = Path(__file__).parent / "fixtures" / "golden"
GOLDEN = json.loads((GOLDEN_DIR / "ts_engine_golden.json").read_text())
AIS = json.loads((GOLDEN_DIR / "ts_ais.json").read_text())["aisObservations"]
META = GOLDEN["meta"]
BBOX = tuple(META["bbox"])
GEO = META["geolocation"]


def _run() -> dict:
    comps = geolocate_components(
        GOLDEN["components"], crs=GEO["crs"], transform=GEO["transform"]
    )
    return correlate(
        comps,
        AIS,
        META["acquisitionTime"],
        META["resolutionMeters"],
        "SCAN-GOLDEN-001",
    )


def test_geodesy_spot() -> None:
    assert 1104.0 < geodesic_meters(1.20, 103.80, 1.21, 103.80) < 1108.0
    assert dynamic_radius(1200, 60, 15, 2800) == 1200 + 60 * 15 * 0.514444444 * 0.20
    assert orient_diff(122, 125) == 3
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
    # GEO-CORR: a synthetic grid over the same AOI, with a real affine transform.
    min_lon, min_lat, max_lon, max_lat = 103.65, 1.10, 104.05, 1.40
    w = h = 180
    transform = [
        (max_lon - min_lon) / w, 0.0, min_lon,
        0.0, -(max_lat - min_lat) / h, max_lat,
    ]

    def _place(comp: dict) -> dict:
        return geolocate_components([comp], crs="EPSG:4326", transform=transform)[0]

    weak_comp = _place({
        "cx": 90.0, "cy": 90.0, "area": 4, "major": 2.0, "minor": 1.5,
        "orient": 45, "maxDb": -22.0, "meanDb": -23.0, "wake": False,
        "wakeHdg": None, "clutterMeanDb": -21.0,
    })
    out2 = correlate([weak_comp], [], acq.isoformat(), 10, "S")
    assert out2["targets"][0]["cls"] == "SEA_CLUTTER"

    # Sub-threshold candidate in [0.30, 0.40): LOW_CONFIDENCE (probed config).
    low_comp = _place(dict(
        {k: weak_comp[k] for k in ("cx", "cy", "wake", "wakeHdg", "clutterMeanDb")},
        maxDb=2.0, meanDb=-5.0, area=8, major=2.5, minor=1.8, orient=45,
    ))
    low_ais = [{
        "mmsi": "111111111", "shipName": "X", "shipType": "Cargo",
        "lat": 1.25, "lon": 103.856, "sog": 5.0, "cog": 200.0,
        "timestamp": (acq - timedelta(seconds=500)).isoformat(), "length": 400,
    }]
    out3 = correlate([low_comp], low_ais, acq.isoformat(), 10, "S")
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
        acq.isoformat(), 10, "S",
    )
    assert out4["targets"][0]["cls"] == "UNRESOLVED"


def test_correlation_cannot_be_fed_raw_pixels() -> None:
    """The architectural guarantee, asserted at the parity gate itself.

    ``correlate`` no longer accepts a width/height/bbox, so there is no argument
    under which a caller can reintroduce AOI interpolation.
    """
    import inspect

    params = set(inspect.signature(correlate).parameters)
    assert not (params & {"width", "height", "bbox"}), params
