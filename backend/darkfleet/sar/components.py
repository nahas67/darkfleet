"""Connected components + spatial moments + SAR chips, ported from the legacy.

Label order matches scan order (like the legacy BFS), so DF-00k IDs are stable.

TWO WAKE FIELDS, AND WHY

wake / wakeHdg
    The legacy _kelvin_sampler: six points on the hull axis against absolute dB
    thresholds. It cannot detect a Kelvin wake -- a bright hull satisfies it, and a
    real arm lies about 19.5 degrees off the axis -- and it measured False for all
    84 stored targets. Correlation still reads these, so every SAR confidence,
    classification, heading tolerance and assessment narrative is unchanged by the
    presence of wakeAnalysis.

wakeAnalysis
    The real detector, nalyse_wake: a 360-degree ray sweep, an arm profile and
    a symmetric-pair search, reporting its measured contrast, arm geometry,
    apparent length and method. Evidence only.

Keeping them apart is deliberate. Replacing the legacy verdict outright shifts six
SAR confidences by exactly the +-0.08 the confidence model grants a wake, and on
the legacy parity fixture it reassigns two vessels between matched and unmatched.
That is a decision about whether a detected wake should move detection confidence
at all, and it should not be made as a side effect of adding a readout.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy.ndimage import label

from .wake import R_END_PX, analyse_wake

CHIP = 24
HALF_CHIP = CHIP // 2

#: Chip half-width the wake DETECTOR needs. It measures rays out to R_END_PX, so
#: its chip must contain that reach. HALF_CHIP is the footprint crop used for the
#: spatial moments and is smaller; passing it produced a chip the ray search could
#: not fit inside. One pixel of margin keeps the outermost sample in bounds.
WAKE_HALF_CHIP = int(R_END_PX) + 1


def extract_components(
    mask: np.ndarray,
    db: np.ndarray,
    min_pixels: int = 3,
    max_pixels: int = 1000,
    pixel_spacing_m: float = 1.0,
) -> list[dict[str, Any]]:
    height, width = mask.shape
    labeled, n = label(mask, structure=np.ones((3, 3), dtype=int))
    out: list[dict[str, Any]] = []
    for lab in range(1, n + 1):
        ys, xs = np.nonzero(labeled == lab)
        area = len(xs)
        if area < min_pixels or area > max_pixels:
            continue
        vals = db[ys, xs].astype(np.float64)
        weights = 10.0 ** ((vals + 30.0) / 10.0)
        m00 = float(weights.sum())
        cx = float((xs * weights).sum() / m00)
        cy = float((ys * weights).sum() / m00)
        dx = xs - cx
        dy = ys - cy
        mu20 = float((dx * dx * weights).sum() / m00)
        mu02 = float((dy * dy * weights).sum() / m00)
        mu11 = float((dx * dy * weights).sum() / m00)
        common = math.sqrt(max(0.0, (mu20 - mu02) ** 2 + 4.0 * mu11**2))
        major = max(1.5, 2.0 * math.sqrt(max(0.0, (mu20 + mu02 + common) / 2.0)))
        minor = max(1.0, 2.0 * math.sqrt(max(0.0, (mu20 + mu02 - common) / 2.0)))
        theta = 0.5 * math.atan2(2.0 * mu11, mu20 - mu02)
        orient = (theta * 180.0 / math.pi) % 180.0

        max_db = round(float(vals.max()), 1)
        mean_db = round(float(vals.mean()), 1)

        chip = np.full((CHIP, CHIP), -24.0)
        corners: list[dict[str, float]] = []
        for crow in range(CHIP):
            py = math.floor(cy) - HALF_CHIP + crow
            for ccol in range(CHIP):
                px = math.floor(cx) - HALF_CHIP + ccol
                if 0 <= px < width and 0 <= py < height:
                    v = float(db[py, px])
                    chip[crow, ccol] = v
                    if v > -6.0 and len(corners) < 5:
                        corners.append({"x": ccol, "y": crow, "intensity": v})
        dist = np.hypot(
            np.arange(CHIP)[None, :] - HALF_CHIP, np.arange(CHIP)[:, None] - HALF_CHIP
        )
        clutter_vals = chip[dist > 7]
        clutter_mean = round(float(clutter_vals.mean()), 1)

        # The real detector is the ONLY wake measurement.
        #
        # `_kelvin_sampler` was a six-point hull-axis brightness threshold: it
        # could not detect a Kelvin wake (a bright hull satisfied it, and a real
        # arm lies ~19.5 degrees off the axis), it reported False for all 84
        # stored targets, and it held scoring authority it had not earned. It is
        # DELETED rather than replaced -- substituting one unvalidated authority
        # for another is not a fix.
        #
        # The result is evidence. It does not touch SAR confidence, AIS
        # association, heading tolerance or classification. See
        # `SCORING_MODEL_VERSION` in darkfleet.correlation.match and
        # docs/WAKE_SCORING_DELTA.md for the measurements behind that decision.
        wake_analysis = analyse_wake(
            db, cy, cx, round(orient), pixel_spacing_m, half_chip=WAKE_HALF_CHIP
        )
        out.append(
            {
                "cx": cx,
                "cy": cy,
                "area": area,
                "major": major,
                "minor": minor,
                "orient": round(orient),
                "maxDb": max_db,
                "meanDb": mean_db,
                "wake": wake_analysis.detected,
                "wakeHdg": wake_analysis.heading_deg,
                # Measured wake evidence. Named so that no existing consumer of
                # `wake` can pick these up by accident -- correlation must not
                # change because a readout was added.
                "wakeAnalysis": wake_analysis.to_dict(),
                "bbox": {
                    "minX": xs.min().item(),
                    "minY": ys.min().item(),
                    "maxX": xs.max().item(),
                    "maxY": ys.max().item(),
                },
                "clutterMeanDb": clutter_mean,
            }
        )
    return out
