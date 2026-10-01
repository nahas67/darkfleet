"""Speckle filtering. Operates in dB for median (legacy-exact) and in linear
power for Lee (documented domain). Refined-Lee/Frost are interface slots."""

from __future__ import annotations

from typing import Literal

import numpy as np
from scipy.ndimage import median_filter, uniform_filter

SpeckleMode = Literal["none", "median", "lee"]


def apply_median(db: np.ndarray, kernel_size: int = 3) -> np.ndarray:
    """3x3 median, edge-clamped ('nearest'), bit-exact selection like the legacy."""
    out: np.ndarray = median_filter(db, size=kernel_size, mode="nearest")
    return out


def apply_lee(
    db: np.ndarray, valid: np.ndarray, window: int = 3, sigma_v: float = 0.30
) -> np.ndarray:
    """Standard Lee adaptive filter in the linear-power domain.

    out = mean + K*(x - mean), K = var / (var + mean^2 * sigma_v^2).
    sigma_v is the a-priori speckle std (0.30 default for multi-looked GRD-like data).
    Invalid pixels are restored to NaN after filtering (edge bleed documented).
    """
    power = np.where(valid, 10.0 ** (db / 10.0), np.nan)
    filled = np.where(valid, power, np.nanmean(power))
    mean = uniform_filter(filled, size=window, mode="nearest")
    sq = uniform_filter(filled * filled, size=window, mode="nearest")
    var = np.maximum(sq - mean * mean, 0.0)
    k = var / (var + mean * mean * sigma_v * sigma_v + 1e-12)
    out_power = mean + k * (filled - mean)
    out_db = 10.0 * np.log10(np.maximum(out_power, 1e-9))
    return np.where(valid, out_db, np.nan).astype(np.float32)


def apply_speckle(
    db: np.ndarray, valid: np.ndarray, mode: SpeckleMode, kernel_size: int = 3
) -> np.ndarray:
    if mode == "none":
        return db.copy()
    if mode == "median":
        out = apply_median(np.where(valid, db, np.nan), kernel_size)
        return np.where(valid, out, np.nan).astype(np.float32)
    if mode == "lee":
        return apply_lee(db, valid, window=kernel_size)
    raise ValueError(f"unknown speckle mode: {mode}")
