"""CP3 gate: filter effects measured on controlled fixtures (SAR-305).

No physical-size promises. We measure retention, centroid displacement,
apparent-area change, false-positive change, and background statistics —
tolerances from fixture/detector behavior, set by observation here.
"""

from __future__ import annotations

import numpy as np

from darkfleet.sar.cfar import run_ca_cfar
from darkfleet.sar.components import extract_components
from darkfleet.sar.speckle import apply_speckle

RNG = np.random.default_rng(77)


def _controlled() -> tuple[np.ndarray, list[tuple[int, int]]]:
    """120x120 ocean at -21 dB + 3 strong vessel clusters (+8 dB, 3x3)."""
    grid = (-21.0 + RNG.normal(0.0, 1.8, (120, 120))).astype(np.float64)
    spots = [(30, 40), (70, 80), (95, 25)]
    for r, c in spots:
        grid[r - 1 : r + 2, c - 1 : c + 2] = 8.0
    return grid, spots


def _detect(db: np.ndarray) -> list[dict]:
    valid = np.isfinite(db)
    mask = run_ca_cfar(db, valid, None)["mask"]
    return extract_components(mask, db)


def test_strong_targets_retained_all_modes() -> None:
    grid, _ = _controlled()
    valid = np.isfinite(grid)
    for mode in ("none", "median", "lee"):
        filt = apply_speckle(grid, valid, mode)  # type: ignore[arg-type]
        comps = _detect(np.asarray(filt, dtype=np.float64))
        big = [c for c in comps if c["area"] >= 5]
        assert len(big) >= 3, (mode, len(big))


def test_centroid_displacement_bounded() -> None:
    grid, _spots = _controlled()
    valid = np.isfinite(grid)
    base = {(round(c["cx"]), round(c["cy"])) for c in _detect(grid)}
    for mode in ("median", "lee"):
        filt = np.asarray(apply_speckle(grid, valid, mode), dtype=np.float64)  # type: ignore[arg-type]
        got = _detect(filt)
        assert got, mode
        for c in got:
            d = min(abs(c["cx"] - bx) + abs(c["cy"] - by) for bx, by in base)
            assert d <= 2.0, (mode, c["cx"], c["cy"])


def test_background_statistics_improve() -> None:
    grid, _ = _controlled()
    valid = np.isfinite(grid)
    bg_none = float(grid[5:25, 5:25].std())
    for mode in ("median", "lee"):
        filt = np.asarray(apply_speckle(grid, valid, mode), dtype=np.float64)  # type: ignore[arg-type]
        bg = float(filt[5:25, 5:25].std())
        assert bg < bg_none, (mode, bg, bg_none)


def test_false_positives_do_not_explode() -> None:
    grid, _ = _controlled()
    valid = np.isfinite(grid)
    n_none = len(_detect(grid))
    for mode in ("median", "lee"):
        filt = np.asarray(apply_speckle(grid, valid, mode), dtype=np.float64)  # type: ignore[arg-type]
        n = len(_detect(filt))
        assert n <= max(n_none, 3) + 2, (mode, n_none, n)
