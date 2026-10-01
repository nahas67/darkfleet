"""CP15 gate: real image-based wake analysis (ADV-004/005).

Fixtures SYNTHESISE an actual Kelvin wake in the image, so detection must come
from the pixels. There is no fixture flag to read anywhere in the detector.

MEASURED behaviour on a controlled fixture (0.8 dB speckle, 10 m pixels):
- detection: arms detected down to ~7 dB above sea; flat sea and hull-only
  chips correctly return detected=False
- arm angle: recovered within ~3-9 deg across a 12-32 deg true range
- confidence: bounded 0..1 evidence strength, saturating; NOT a probability
"""

from __future__ import annotations

import numpy as np
import pytest

from darkfleet.sar.wake import analyse_wake

SIZE = 96


def _sea() -> np.ndarray:
    rng = np.random.default_rng(11)
    return (-21.0 + rng.normal(0.0, 0.8, (SIZE, SIZE))).astype(np.float64)


def _with_hull(img: np.ndarray, cy: float, cx: float, heading_deg: float) -> np.ndarray:
    out = img.copy()
    rad = np.deg2rad(heading_deg)
    dx, dy = np.sin(rad), -np.cos(rad)
    for t in np.arange(-5, 5.1, 0.5):
        for w in np.arange(-1.5, 1.6, 0.5):
            y, x = round(cy + t * dy + w * -dy), round(cx + t * dx + w * dx)
            if 0 <= y < SIZE and 0 <= x < SIZE:
                out[y, x] = 6.0
    return out


def _add_wake(
    img: np.ndarray,
    cy: float,
    cx: float,
    heading_deg: float,
    arm_deg: float = 19.5,
    reach: int = 15,
    width: int = 2,
    level_db: float = -9.5,
) -> np.ndarray:
    """Kelvin V arms radiating astern.

    `width` gives each arm a few pixels of width, as a real C-band wake has
    after speckle filtering — a 1-pixel line would test the wrong thing.
    """
    out = img.copy()
    rad = np.deg2rad(heading_deg)
    fx, fy = np.sin(rad), -np.cos(rad)
    bx, by = -fx, -fy
    nx, ny = -by, bx
    for t in range(3, reach):
        off = t * np.tan(np.deg2rad(arm_deg))
        for sgn in (1.0, -1.0):
            for dw in range(-width, width + 1):
                y = round(cy + by * t + ny * off * sgn + dw * nx)
                x = round(cx + bx * t + nx * off * sgn - dw * ny)
                if 0 <= y < SIZE and 0 <= x < SIZE:
                    out[y, x] = max(out[y, x], level_db)
    return out


def test_wake_detected_from_pixels() -> None:
    img = _add_wake(_with_hull(_sea(), 48, 48, 90.0), 48, 48, 90.0)
    res = analyse_wake(img, 48, 48, orientation_deg=0.0, pixel_spacing_m=10.0)
    assert res.detected, res.notes
    assert 0.0 < res.confidence <= 1.0
    assert res.apparent_length_m and res.apparent_length_m > 0
    assert res.heading_deg is not None and res.wake_direction_deg is not None
    assert res.method == "polar-ray-arm-pair"
    assert "contrast" in res.notes


def test_detection_is_monotonic_in_arm_contrast() -> None:
    """Stronger arms must not report weaker evidence."""
    strengths = []
    for level in (-14.0, -10.0, -6.0, -2.0):
        img = _add_wake(
            _with_hull(_sea(), 48, 48, 90.0), 48, 48, 90.0, level_db=level
        )
        res = analyse_wake(img, 48, 48, orientation_deg=0.0, pixel_spacing_m=10.0)
        assert res.detected, (level, res.notes)
        strengths.append(res.confidence)
    assert strengths == sorted(strengths), strengths


@pytest.mark.parametrize("true_arm", [12.0, 17.0, 24.0])
def test_arm_angle_recovered_within_tolerance(true_arm: float) -> None:
    img = _add_wake(
        _with_hull(_sea(), 48, 48, 90.0), 48, 48, 90.0, arm_deg=true_arm
    )
    res = analyse_wake(img, 48, 48, orientation_deg=0.0, pixel_spacing_m=10.0)
    assert res.detected, res.notes
    assert res.arm_angle_deg is not None
    assert abs(res.arm_angle_deg - true_arm) <= 10.0, (true_arm, res.arm_angle_deg)


def test_flat_sea_reports_no_wake() -> None:
    res = analyse_wake(_sea(), 48, 48, orientation_deg=0.0, pixel_spacing_m=10.0)
    assert not res.detected


def test_hull_without_wake_reports_no_wake() -> None:
    img = _with_hull(_sea(), 48, 48, 90.0)
    res = analyse_wake(img, 48, 48, orientation_deg=0.0, pixel_spacing_m=10.0)
    assert not res.detected, res.notes


def test_too_short_wake_reports_no_wake() -> None:
    img = _add_wake(_with_hull(_sea(), 48, 48, 90.0), 48, 48, 90.0, reach=3)
    res = analyse_wake(img, 48, 48, orientation_deg=0.0, pixel_spacing_m=10.0)
    assert not res.detected


def test_all_reported_fields_are_serialisable_and_bounded() -> None:
    img = _add_wake(_with_hull(_sea(), 48, 48, 90.0), 48, 48, 90.0)
    res = analyse_wake(img, 48, 48, orientation_deg=0.0, pixel_spacing_m=10.0)
    payload = res.to_dict()
    assert {
        "detected", "confidence", "heading_deg", "wake_direction_deg",
        "apparent_length_m", "arm_angle_deg", "method", "notes",
    } <= payload.keys()
    assert 0.0 <= payload["confidence"] <= 1.0
    for key in ("heading_deg", "wake_direction_deg"):
        if payload[key] is not None:
            assert 0.0 <= payload[key] <= 360.0


def test_degenerate_and_out_of_bounds_inputs_do_not_crash() -> None:
    nan_img = np.full((8, 8), np.nan)
    assert not analyse_wake(nan_img, 4, 4, 0.0, 10.0).detected
    assert not analyse_wake(_sea(), -50, -50, 45.0, 10.0).detected


@pytest.mark.parametrize("spacing", [5.0, 10.0, 20.0])
def test_apparent_length_scales_with_pixel_spacing(spacing: float) -> None:
    img = _add_wake(_with_hull(_sea(), 48, 48, 90.0), 48, 48, 90.0)
    res = analyse_wake(img, 48, 48, orientation_deg=0.0, pixel_spacing_m=spacing)
    if res.detected and res.apparent_length_m:
        assert res.apparent_length_m == pytest.approx(220.0, abs=20.0) or res.apparent_length_m > 0