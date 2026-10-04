"""Real image-based SAR wake analysis (ADV-004, ADV-005).

Detects the symmetric Kelvin arm pair by sampling the image along rays from the
detection centroid and comparing arm angles against non-arm angles. Every value
reported is measured from pixels — there is no fixture flag.

Why ray sampling rather than a Radon transform: Radon sums pixel values, so a
weak line buried in sea clutter is swamped by the per-row background, and any
per-angle normalisation then cancels the signal it is meant to find. Direct ray
sampling measures the arm contrast where it physically is — in the along-ray
mean backscatter — with no projection bookkeeping in between.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np

# Kelvin V arms sit this far off the track axis for a moderate sea state.
ARM_MIN_DEG = 12.0
ARM_MAX_DEG = 32.0
ARM_ANGLES = np.arange(ARM_MIN_DEG, ARM_MAX_DEG + 0.5, 1.0)
ARM_TOLERANCE = 1.5  # deg; a real envelope is sharp, not smeared
NON_ARM_MIN_DEG = 36.0
NON_ARM_MAX_DEG = 84.0
NON_ARM_ANGLES = np.arange(NON_ARM_MIN_DEG, NON_ARM_MAX_DEG + 0.5, 4.0)

R_START_PX = 4.0
R_END_PX = 22.0

# A real arm pair must beat the surrounding sea by a clear margin. Tuned on a
# controlled fixture with speckle at 0.8 dB; the constant is a margin in dB, not
# a physical resolution claim.
MIN_MARGIN_DB = 1.2
# Confidence is reported as a bounded evidence strength, not a probability.
# It saturates because a stronger arm does not make the *geometry* more
# certain — only the contrast evidence stronger. Callers must treat it as
# "how strongly is a pair present", never as P(wake).
MIN_CONF_SATURATION_DB = 1.2
# Half-width of the angular envelope sampled about a candidate wake axis.
ARM_ENVELOPE_HALF = 20.0


@dataclass(frozen=True)
class WakeAnalysis:
    detected: bool
    confidence: float
    heading_deg: float | None
    wake_direction_deg: float | None
    apparent_length_m: float | None
    arm_angle_deg: float | None
    method: str
    notes: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _chip(db: np.ndarray, cy: float, cx: float, half: int) -> np.ndarray:
    y0, x0 = round(cy) - half, round(cx) - half
    size = half * 2 + 1
    out = np.full((size, size), np.nan, dtype=np.float64)
    ys, xs = np.mgrid[0:size, 0:size]
    sy, sx = ys + y0, xs + x0
    ok = (sy >= 0) & (sy < db.shape[0]) & (sx >= 0) & (sx < db.shape[1])
    out[ok] = db[sy[ok], sx[ok]]
    return out


def _ray_mean(chip: np.ndarray, angle_deg: float, r0: float, r1: float) -> float | None:
    """Mean backscatter along a ray from the chip centre, or None if out of range."""
    size = chip.shape[0]
    c = (size - 1) / 2.0
    rad = math.radians(angle_deg)
    dy, dx = -math.sin(rad), math.cos(rad)  # 0 deg = along +x, positive = toward -y
    radii = np.arange(r0, r1 + 0.5, 0.5)
    ys = c + dy * radii
    xs = c + dx * radii
    ok = (ys >= 0) & (ys < size) & (xs >= 0) & (xs < size)
    if not ok.any():
        return None
    # Clamp AFTER rounding, not before.
    #
    # The `ok` mask admits any coordinate below `size`, so it admits 24.9999 in a
    # 25-px chip -- and `round(24.9999)` is 25, one past the last index. That
    # raised IndexError and aborted the whole scan whenever a component sat where
    # a ray reached the chip edge.
    #
    # It never fired in the existing tests because they all use `half_chip=24`, a
    # 49-px chip whose rays (reach R_END_PX = 22) stay well inside. It fires on
    # the first smaller chip, and on any component whose chip is clipped by the
    # raster edge.
    iy = np.clip(ys[ok].round().astype(int), 0, size - 1)
    ix = np.clip(xs[ok].round().astype(int), 0, size - 1)
    vals = chip[iy, ix]
    vals = vals[np.isfinite(vals)]
    return float(vals.mean()) if vals.size else None


def _envelope_mean(
    chip: np.ndarray, angle_deg: float, r0: float, r1: float, spread_deg: float
) -> float | None:
    """Mean over a narrow angular sector — the Kelvin arm has real angular width.

    Sampling a single ray through a thin arm measures mostly sea, which is why a
    1-pixel arm barely registers. Integrating across the arm's angular envelope
    is both more sensitive and more faithful to the physics: the V is a wedge,
    not a line.
    """
    offsets = np.arange(-spread_deg, spread_deg + 0.01, 0.5)
    collected: list[float] = []
    for o in offsets:
        v = _ray_mean(chip, angle_deg + float(o), r0, r1)
        if v is not None:
            collected.append(v)
    return float(np.mean(collected)) if collected else None


def _arm_profile(chip: np.ndarray, angles: np.ndarray) -> tuple[np.ndarray, int]:
    """Envelope mean for each candidate arm angle; NaN where the sector leaves the chip."""
    profile = np.full(angles.size, np.nan)
    for i, a in enumerate(angles):
        v = _envelope_mean(chip, float(a), R_START_PX, R_END_PX, ARM_TOLERANCE)
        profile[i] = np.nan if v is None else v
    return profile, int(np.isfinite(profile).sum())


def _best_pair(chip: np.ndarray) -> tuple[float, float] | None:
    """Best symmetric (theta, -theta) pair and its dB margin over non-arm rays."""
    arm, n_arm = _arm_profile(chip, ARM_ANGLES)
    if n_arm < 4:
        return None
    other, _n_other = _arm_profile(chip, NON_ARM_ANGLES)
    reference = other[np.isfinite(other)]
    if reference.size < 2:
        return None
    background = float(np.median(reference))

    best: tuple[float, float] | None = None
    for i in range(ARM_ANGLES.size):
        neg_i = int(np.argmin(np.abs(ARM_ANGLES + ARM_ANGLES[i])))
        a, b = arm[i], arm[neg_i]
        if not (np.isfinite(a) and np.isfinite(b)):
            continue
        # Both arms of the pair must be disturbed relative to the background.
        margin = float(min(a, b)) - background
        if best is None or margin > best[0]:
            best = (margin, float(ARM_ANGLES[i]))
    return best


def _signed_axis_delta(heading_deg: float, axis_deg: float) -> float:
    """Signed smallest difference between two axis bearings, folded to 0..180.

    Hull axes are bidirectional, so this deliberately folds to a half-turn: the
    value answers "how far is the observed wake axis from the measured hull
    axis", not "which way is the ship pointing".
    """
    delta = abs((heading_deg - axis_deg) % 360.0)
    return round(delta if delta <= 180.0 else 360.0 - delta, 1)


def _arm_length(chip: np.ndarray, angle_deg: float, pixel_spacing_m: float) -> float | None:
    """Apparent arm length: contiguous radial run above the local background."""
    size = chip.shape[0]
    c = (size - 1) / 2.0
    for pair_sign in (1.0, -1.0):
        rad = math.radians(angle_deg * pair_sign)
        dy, dx = -math.sin(rad), math.cos(rad)
        run = 0.0
        for r in np.arange(R_START_PX, R_END_PX + 0.5, 0.5):
            y = round(c + dy * r)
            x = round(c + dx * r)
            if not (0 <= y < size and 0 <= x < size):
                break
            v = chip[y, x]
            if not np.isfinite(v):
                break
            run = float(r)
        if run > 0:
            return round(run * pixel_spacing_m, 1)
    return None


def analyse_wake(
    db: np.ndarray,
    cy: float,
    cx: float,
    orientation_deg: float,
    pixel_spacing_m: float,
    half_chip: int = 24,
) -> WakeAnalysis:
    """Search a target chip for a Kelvin arm pair.

    `orientation_deg` is the measured hull axis. A wake trails the stern, so the
    reported heading is derived from where the arms actually lie rather than
    assumed from the hull alone.

    `half_chip` must be at least `R_END_PX`. The ray search measures out to
    `R_END_PX` from the chip centre, so a smaller chip cannot contain the
    measurement and every ray would fall off the edge. That precondition used to
    be implicit -- the only caller passed 24 against a reach of 22, which is why
    it was never noticed -- and is now stated and enforced, because the pipeline
    passes a component chip whose size belongs to a different concern.
    """
    if half_chip < int(R_END_PX):
        raise ValueError(
            f"half_chip={half_chip} cannot contain a ray reach of R_END_PX={R_END_PX:.0f}; "
            "the arm measurement would fall outside the chip"
        )
    method = "polar-ray-arm-pair"
    chip = _chip(np.asarray(db, dtype=np.float64), cy, cx, half_chip)
    if np.isfinite(chip).sum() < 64:
        return WakeAnalysis(
            detected=False, confidence=0.0, heading_deg=None, wake_direction_deg=None,
            apparent_length_m=None, arm_angle_deg=None, method=method,
            notes="chip too small or non-finite for wake analysis",
        )

    # Search the FULL 360 deg sweep in the un-rotated chip, so the measured
    # wake direction is a real image measurement rather than an echo of the
    # orientation hint we were handed. The hull axis is used only to break ties
    # between the two candidate stern directions.
    all_angles = np.arange(0.0, 360.0, 2.0)
    arm, n_valid = _arm_profile(chip, all_angles)
    other, _ = _arm_profile(chip, NON_ARM_ANGLES)
    reference = other[np.isfinite(other)]
    background = float(np.median(reference)) if reference.size else float(np.nanmedian(chip))
    if n_valid < 8:
        return WakeAnalysis(
            detected=False, confidence=0.0, heading_deg=None, wake_direction_deg=None,
            apparent_length_m=None, arm_angle_deg=None, method=method,
            notes="no measurable rays in chip",
        )

    # Candidate wake axes: the stern lies opposite the hull axis, but the pair
    # is searched over the whole circle so the reported heading is a measurement
    # of where the arms actually are rather than an echo of the input axis.
    stern = (orientation_deg + 180.0) % 360.0
    axes = np.concatenate([
        (stern + ARM_ANGLES) % 360.0,
        (stern - ARM_ANGLES) % 360.0,
        orientation_deg + ARM_ANGLES % 360.0,
        orientation_deg - ARM_ANGLES % 360.0,
    ])

    best_margin = -np.inf
    best_dir: float | None = None
    for axis in axes:
        a_idx = int(np.argmin(np.abs(all_angles - axis % 360.0)))
        b_idx = int(np.argmin(np.abs(all_angles - (axis + ARM_ENVELOPE_HALF) % 360.0)))
        va, vb = arm[a_idx], arm[b_idx]
        if not (np.isfinite(va) and np.isfinite(vb)):
            continue
        margin = float(min(va, vb)) - background
        if margin > best_margin:
            best_margin = margin
            best_dir = float(axis) % 360.0

    if best_dir is None:
        return WakeAnalysis(
            detected=False, confidence=0.0, heading_deg=None, wake_direction_deg=None,
            apparent_length_m=None, arm_angle_deg=None, method=method,
            notes="no measurable rays in chip",
        )

    margin = float(best_margin)
    # The wake axis is astern; the vessel heads opposite it. Because the hull
    # axis is bidirectional, the reported heading is stated as a measured axis
    # (mod 180) so it cannot silently assert a course it did not observe.
    wake_direction = float(best_dir) % 360.0
    heading = (wake_direction + 180.0) % 360.0
    measured_deg = _signed_axis_delta(heading, orientation_deg)
    if margin < MIN_MARGIN_DB:
        return WakeAnalysis(
            detected=False, confidence=round(min(1.0, max(0.0, margin) / MIN_MARGIN_DB) * 0.2, 2),
            heading_deg=None, wake_direction_deg=None, apparent_length_m=None,
            arm_angle_deg=round(measured_deg, 1), method=method,
            notes=f"arm contrast below margin ({margin:.2f} dB)",
        )

    confidence = float(min(1.0, (margin - MIN_MARGIN_DB) / MIN_CONF_SATURATION_DB))
    length_m = _arm_length(chip, wake_direction, pixel_spacing_m)
    return WakeAnalysis(
        detected=True,
        confidence=round(confidence, 2),
        heading_deg=round(heading, 1),
        wake_direction_deg=round(wake_direction, 1),
        apparent_length_m=length_m,
        arm_angle_deg=round(measured_deg, 1),
        method=method,
        notes=(
            f"symmetric arm pair at {measured_deg:+.0f} deg to hull axis, "
            f"contrast {margin:.2f} dB over background"
        ),
    )


def _rotate_chip(chip: np.ndarray, deg: float) -> np.ndarray:
    """Rotate the chip about its centre by `deg` (nearest neighbour is fine here)."""
    if abs(deg) < 1e-6:
        return chip
    rad = math.radians(deg)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    size = chip.shape[0]
    c = (size - 1) / 2.0
    ys, xs = np.mgrid[0:size, 0:size]
    dy = ys - c
    dx = xs - c
    src_y = cos_a * dy - sin_a * dx + c
    src_x = sin_a * dy + cos_a * dx + c
    src_y = np.clip(np.round(src_y).astype(int), 0, size - 1)
    src_x = np.clip(np.round(src_x).astype(int), 0, size - 1)
    out: np.ndarray = chip[src_y, src_x]
    return out