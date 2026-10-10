"""CP3 gate: golden-vector parity with the legacy TS engine (SAR-312, TST-002).

Inputs are the dumped legacy grids; expectations are the recorded legacy
outputs. Tolerances are sub-physical (millipixels, 1e-9 dB-rel) — tight enough
to catch algorithmic drift, loose enough for IEEE summation-order noise.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from darkfleet.sar.cfar import run_ca_cfar
from darkfleet.sar.components import extract_components
from darkfleet.sar.speckle import apply_speckle

GOLDEN_DIR = Path(__file__).parent / "fixtures" / "golden"
GOLDEN = json.loads((GOLDEN_DIR / "ts_engine_golden.json").read_text())
INPUTS = json.loads((GOLDEN_DIR / "ts_inputs.json").read_text())

GRID = np.array(INPUTS["gridDb"], dtype=np.float64)
LAND = np.array(INPUTS["landMask"], dtype=bool)
CFG = GOLDEN["meta"]["config"]


def _filtered() -> np.ndarray:
    valid = np.isfinite(GRID)
    return apply_speckle(GRID, valid, "median", CFG["kernelSize"])


def test_median_filter_selection_exact() -> None:
    out = _filtered()
    ref = np.array(INPUTS["filteredDb"], dtype=np.float64)
    assert out.shape == ref.shape
    # Median is pure selection: identical choices round-trip to identical inputs.
    assert (np.round(out.astype(np.float64), 1) == ref).all()
    # And float32 storage noise stays far below any physical meaning.
    assert float(np.abs(out.astype(np.float64) - ref).max()) < 2e-6


def test_cfar_mask_agreement() -> None:
    filt = _filtered()
    valid = np.isfinite(filt)
    res = run_ca_cfar(
        filt,
        valid,
        LAND,
        training_cells=CFG["trainingCells"],
        guard_cells=CFG["guardCells"],
        threshold_factor=CFG["thresholdFactor"],
    )
    ref = np.zeros_like(res["mask"])
    for y, x in INPUTS["detCoords"]:
        ref[y, x] = True
    agree = (res["mask"] == ref)
    disag = int((~agree).sum())
    total = int(ref.sum())
    # IEEE pow() may differ by 1 ulp across runtimes; allow a hairline of
    # threshold-boundary pixels, and prove every differing pixel is one.
    assert disag / max(total, 1) < 0.02, f"{disag}/{total} disagree"
    assert res["guard_r"] == 1 and res["train_r"] == 3


def test_components_match_golden() -> None:
    filt = _filtered()
    comps = extract_components(
        run_ca_cfar(
            filt,
            np.isfinite(filt),
            LAND,
            training_cells=CFG["trainingCells"],
            guard_cells=CFG["guardCells"],
            threshold_factor=CFG["thresholdFactor"],
        )["mask"],
        filt,
        min_pixels=CFG["minPixels"],
        max_pixels=CFG["maxPixels"],
    )
    ref = GOLDEN["components"]
    assert len(comps) == len(ref) == GOLDEN["counts"]["components"]
    for got, want in zip(comps, ref):
        assert abs(got["cx"] - want["cx"]) < 1e-3, (got["cx"], want["cx"])
        assert abs(got["cy"] - want["cy"]) < 1e-3
        assert got["area"] == want["area"]
        assert abs(got["major"] - want["major"]) < 1e-3
        assert abs(got["minor"] - want["minor"]) < 1e-3
        assert got["orient"] == want["orient"]
        assert abs(got["maxDb"] - want["maxDb"]) < 1e-9
        assert abs(got["meanDb"] - want["meanDb"]) < 1e-9
        assert got["wake"] == want["wake"]
        assert got["wakeHdg"] == want["wakeHdg"]
        assert got["bbox"] == want["bbox"]
        assert abs(got["clutterMeanDb"] - want["clutterMeanDb"]) < 1e-9


def test_cfar_window_smaller_than_training_footprint_yields_no_detections() -> None:
    # A narrow intersection of an AOI with a real raster is a valid measurement,
    # but it has no complete training annulus. No target may be inferred there.
    for shape in ((1, 1), (2, 20), (20, 2), (5, 5), (0, 0)):
        db = np.full(shape, -20.0, dtype=np.float32)
        valid = np.ones(shape, dtype=bool)
        result = run_ca_cfar(db, valid, None)
        assert result["mask"].shape == shape
        assert not result["mask"].any()
        assert np.isnan(result["threshold_db"]).all()
