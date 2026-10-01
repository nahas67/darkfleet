"""SAR preprocessing branches. GRD and RTC are NEVER treated identically."""

from __future__ import annotations

from typing import Any

import numpy as np

from ..providers import RealDataUnavailableError

_EPS = 1e-9

RTC_VERSION = "linear-gamma0-to-db v1"
GRD_VERSION = "dn-to-sigma0 v1"


def valid_data_mask(arr: np.ndarray, nodata: float | None) -> np.ndarray:
    """True where the pixel carries usable measurement."""
    ok = np.isfinite(arr)
    if nodata is not None:
        ok &= arr != nodata
    return ok


def linear_to_db(linear: np.ndarray) -> np.ndarray:
    """Linear power/gamma0 -> dB. Clips at eps; never log(0)."""
    out: np.ndarray = 10.0 * np.log10(np.maximum(linear, _EPS))
    return out.astype(np.float32)


def rtc_branch(linear: np.ndarray, nodata: float | None) -> dict[str, Any]:
    """Sentinel-1 RTC: linear gamma0 is already radiometrically terrain corrected."""
    valid = valid_data_mask(linear, nodata)
    db = np.full(linear.shape, np.nan, dtype=np.float32)
    db[valid] = linear_to_db(linear[valid])
    return {"db": db, "valid": valid, "branch": "RTC", "version": RTC_VERSION}


def grd_to_sigma0(dn: np.ndarray, lut: np.ndarray | None) -> np.ndarray:
    """Sentinel-1 GRD: DN -> sigma0 via calibration LUT. No LUT, no calibration.

    The LUT path is explicit because pretending DN == sigma0 is a radiometric lie.
    """
    if lut is None:
        raise RealDataUnavailableError(
            "GRD calibration LUT unavailable; refusing to treat DN as sigma0.",
            details={"branch": "GRD"},
            suggestions=["Provide the product calibration annotation LUT."],
        )
    return (dn.astype(np.float64) ** 2 / np.asarray(lut, dtype=np.float64)).astype(np.float32)


def grd_branch(
    dn: np.ndarray, nodata: float | None, lut: np.ndarray | None
) -> dict[str, Any]:
    """Sentinel-1 GRD: DN -> sigma0 (LUT) -> thermal-noise removal -> dB.

    Thermal-noise removal needs the noise annotation; without it we calibrate
    and flag `denoised=False` rather than faking the step.
    """
    sigma0 = grd_to_sigma0(dn, lut)
    valid = valid_data_mask(sigma0, nodata)
    db = np.full(sigma0.shape, np.nan, dtype=np.float32)
    db[valid] = linear_to_db(sigma0[valid])
    return {"db": db, "valid": valid, "branch": "GRD", "denoised": False, "version": GRD_VERSION}
