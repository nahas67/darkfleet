"""Cell-averaging CFAR, ported 1:1 from the verified legacy TS implementation.

Geometry (identical to legacy):
  guard_radius = ceil(sqrt(guard_cells) / 2)
  train_radius = guard_radius + ceil(sqrt(training_cells) / 2)
  guard square (incl. test cell) skipped; training = rest of train square.
Power domain: P = 10^(dB/10); threshold = training_mean * threshold_factor.

NOTE (methodology, kept honest): the legacy uses a plain multiplier, not the
textbook Pfa-derived alpha = N*(Pfa^(-1/N) - 1). The port preserves behavior
for parity; a Pfa-calibrated variant is future work, not a silent change.
Integral images make it O(pixels) instead of O(pixels * window^2).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np


def _box_sum_interior(integral: np.ndarray, r: int, lo: int, hi_h: int, hi_w: int) -> np.ndarray:
    """Box sums for the interior window [lo, hi) only — never reads out of bounds."""
    h = np.zeros((hi_h - lo, hi_w - lo))
    if h.size == 0:
        return h
    y, x = np.ogrid[lo:hi_h, lo:hi_w]
    total: np.ndarray = (
        integral[y + r + 1, x + r + 1]
        - integral[y - r, x + r + 1]
        - integral[y + r + 1, x - r]
        + integral[y - r, x - r]
    )
    return total


def run_ca_cfar(
    db: np.ndarray,
    valid: np.ndarray,
    land: np.ndarray | None,
    training_cells: int = 16,
    guard_cells: int = 4,
    threshold_factor: float = 3.5,
) -> dict[str, Any]:
    water = valid.copy()
    if land is not None:
        water &= ~land
    power = np.where(water, 10.0 ** (np.asarray(db, dtype=np.float64) / 10.0), 0.0)
    w = water.astype(np.float64)

    guard_r = math.ceil(math.sqrt(guard_cells) / 2)
    train_r = guard_r + math.ceil(math.sqrt(training_cells) / 2)

    int_p = np.zeros((power.shape[0] + 1, power.shape[1] + 1))
    int_w = np.zeros_like(int_p)
    int_p[1:, 1:] = np.cumsum(np.cumsum(power, axis=0), axis=1)
    int_w[1:, 1:] = np.cumsum(np.cumsum(w, axis=0), axis=1)

    h, w_px = db.shape
    sum_t = np.zeros((h, w_px))
    cnt_t = np.zeros((h, w_px))
    lo, hi_h, hi_w = train_r, h - train_r, w_px - train_r
    sum_t[lo:hi_h, lo:hi_w] = _box_sum_interior(int_p, train_r, lo, hi_h, hi_w) - _box_sum_interior(
        int_p, guard_r, lo, hi_h, hi_w
    )
    cnt_t[lo:hi_h, lo:hi_w] = _box_sum_interior(int_w, train_r, lo, hi_h, hi_w) - _box_sum_interior(
        int_w, guard_r, lo, hi_h, hi_w
    )
    mask = np.zeros((h, w_px), dtype=bool)
    threshold_db = np.full((h, w_px), np.nan, dtype=np.float32)
    interior = np.zeros((h, w_px), dtype=bool)
    interior[train_r : h - train_r, train_r : w_px - train_r] = True

    test_power = np.where(water, 10.0 ** (np.asarray(db, dtype=np.float64) / 10.0), 0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        mean = sum_t / np.maximum(cnt_t, 1)
    detect = interior & water & (cnt_t >= 6) & (test_power > mean * threshold_factor)
    mask |= detect
    with np.errstate(divide="ignore", invalid="ignore"):
        threshold_db[detect] = (10.0 * np.log10(np.maximum(mean[detect] * threshold_factor, 1e-12))).astype(
            np.float32
        )
    return {"mask": mask, "threshold_db": threshold_db, "guard_r": guard_r, "train_r": train_r}
