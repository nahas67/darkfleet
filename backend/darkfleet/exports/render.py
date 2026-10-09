"""PNG + PDF evidence exports (EXP-004, EXP-005).

Both are rendered SERVER-SIDE from the persisted evidence record so an exported
artefact carries the same provenance as the API response -- never a browser
screenshot.

Every page and sheet is stamped REAL OBSERVATION DATA. That is no longer a
conditional branch: the record store refuses to persist anything but a real
record, so a synthetic export is unreachable. The stamp is kept unconditionally
because an exported artefact is exactly the thing that leaves the tool and gets
read out of context later, and it should say what it is on its own.
"""

from __future__ import annotations

import io
from typing import Any

import numpy as np

from .. import __version__
from ..providers import Georeferencing

_PNG_DPI = 150

#: Provenance banner, stamped on every exported artefact.
REAL_TAG = "REAL DATA"
PDF_TAG = "REAL OBSERVATION DATA"
_ACCENT = (102, 240, 195)

#: Colour for pixels excluded from the analysis (land, or no valid measurement).
#: It is deliberately NOT a grey: the data ramp is pure greyscale (r == g == b),
#: so any colour with unequal channels is unambiguous. An earlier version used
#: (40, 40, 40), which collided with a plausible data value and made valid water
#: indistinguishable from excluded land in the exported image.
NO_DATA_RGB = (26, 26, 74)


def _mono_rgb(db: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Backscatter -> greyscale RGB; excluded pixels in the NO_DATA colour."""
    finite = db[valid]
    if finite.size == 0:
        return np.full((*db.shape, 3), NO_DATA_RGB, dtype=np.uint8)
    lo = float(np.percentile(finite, 2))
    hi = float(np.percentile(finite, 98))
    span = max(hi - lo, 1e-6)
    norm = np.clip((db - lo) / span, 0.0, 1.0)
    grey = (norm * 255.0).astype(np.uint8)
    rgb = np.stack([grey, grey, grey], axis=-1)
    rgb[~valid] = NO_DATA_RGB
    return rgb


def _detection_overlay(rgb: np.ndarray, centroids: list[tuple[float, float]]) -> np.ndarray:
    """Box each detection centroid. Pure NumPy so Pillow is optional here."""
    out = rgb.copy()
    h, w = out.shape[:2]
    for cy, cx in centroids:
        y, x = round(cy), round(cx)
        if not (0 <= y < h and 0 <= x < w):
            continue
        lo, hi = max(0, y - 4), min(h, y + 5)
        out[lo:hi, max(0, x - 4) : x + 5] = (98, 232, 255)
        out[y, max(0, x - 4) : x + 5] = (98, 232, 255)
    return out


def render_png(
    *,
    scan_id: str,
    db: np.ndarray,
    valid: np.ndarray,
    centroids: list[tuple[float, float]],
    provenance: dict[str, Any],
    title: str,
) -> bytes:
    """PNG evidence snapshot: raster + detection boxes + provenance caption."""
    from PIL import Image, ImageDraw

    rgb = _detection_overlay(_mono_rgb(np.asarray(db, dtype=np.float64), valid), centroids)
    img = Image.fromarray(rgb, mode="RGB")

    caption_h = 156
    canvas = Image.new("RGB", (img.width, img.height + caption_h), (8, 12, 16))
    canvas.paste(img, (0, 0))
    draw = ImageDraw.Draw(canvas)

    sar = provenance.get("sar", {})
    mode_tag = REAL_TAG
    accent = _ACCENT
    valid_frac = float(valid.mean()) if valid.size else 0.0
    y = img.height + 10
    draw.text((12, y), f"{title}", fill=(240, 247, 250))
    y += 18
    draw.text((12, y), f"{mode_tag}   scan {scan_id}   detections {len(centroids)}", fill=accent)
    y += 18
    draw.text(
        (12, y),
        f"{sar.get('provider', '?')} / {sar.get('collection', '?')}  "
        f"{sar.get('item_id', '?')}",
        fill=(210, 230, 236),
    )
    y += 18
    draw.text(
        (12, y),
        f"acq {sar.get('acquisition_time', '?')}  {sar.get('polarization', '?')}  "
        f"cfg {provenance.get('processing', {}).get('config_hash', '?')}  "
        f"v{__version__}",
        fill=(150, 175, 185),
    )
    y += 18
    # The valid fraction is stated because an excluded area must never be read
    # as an observed absence of returns.
    draw.rectangle((12, y + 2, 26, y + 12), fill=NO_DATA_RGB, outline=(70, 90, 110))
    draw.text(
        (32, y),
        f"excluded from analysis {100.0 * (1.0 - valid_frac):.1f}%   "
        f"analysed {100.0 * valid_frac:.1f}%   "
        f"stretch {float(np.nanpercentile(db[valid], 2)):.1f}.."
        f"{float(np.nanpercentile(db[valid], 98)):.1f} dB",
        fill=(130, 160, 172),
    )

    buf = io.BytesIO()
    canvas.save(buf, format="PNG", dpi=(_PNG_DPI, _PNG_DPI))
    return buf.getvalue()


def render_pdf(
    *,
    scan_id: str,
    title: str,
    scene: dict[str, Any],
    provenance: dict[str, Any],
    targets: list[dict[str, Any]],
    ais_only: list[dict[str, Any]],
    chip_png: bytes | None = None,
) -> bytes:
    """Multi-page evidence report: cover, per-target pages, provenance."""
    from fpdf import FPDF

    pdf = FPDF(orientation="P", unit="mm", format="A4")
    # Compression is OFF deliberately. A compressed stream cannot be verified:
    # nobody can grep an exported PDF for its provenance banner, which defeats
    # the point of stamping one. An evidence artefact has to be auditable by the
    # person receiving it, so the banner stays readable in the raw bytes.
    pdf.set_compression(False)
    width = 210.0

    def header(title_text: str, subtitle: str = "") -> None:
        pdf.set_fill_color(8, 12, 16)
        pdf.rect(0, 0, width, 297, style="F")
        pdf.set_text_color(98, 232, 255)
        pdf.set_font("Helvetica", "B", 16)
        pdf.set_xy(15, 16)
        pdf.cell(width - 30, 10, title_text, new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 8)
        pdf.set_text_color(150, 175, 185)
        pdf.set_xy(15, 27)
        pdf.cell(width - 30, 6, subtitle, new_x="LMARGIN", new_y="NEXT")
        pdf.set_draw_color(40, 60, 70)
        pdf.set_y(36)

    def footer(page: int) -> None:
        pdf.set_y(282)
        pdf.set_font("Helvetica", "", 7)
        pdf.set_text_color(120, 145, 155)
        pdf.cell(
            width - 30,
            5,
            f"DarkFleet v{__version__} - {scan_id} - page {page} - "
            + PDF_TAG,
            new_x="LMARGIN",
            new_y="NEXT",
        )

    page = 0
    # ---- cover -----------------------------------------------------------
    pdf.add_page()
    header("DarkFleet Evidence Report", title)
    page += 1
    y = pdf.get_y()
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(*_ACCENT)
    pdf.set_xy(15, y)
    pdf.cell(
        width - 30,
        8,
        REAL_TAG,
        new_x="LMARGIN",
        new_y="NEXT",
    )
    y = pdf.get_y() + 4

    sar = provenance.get("sar", {})
    rows = [
        ("Scan", scan_id),
        ("Provider", str(sar.get("provider", "?"))),
        ("Collection", str(sar.get("collection", "?"))),
        ("Item", str(sar.get("item_id", "?"))),
        ("Platform", str(sar.get("platform", "?"))),
        ("Product", str(sar.get("product", "?"))),
        ("Polarization", str(sar.get("polarization", "?"))),
        ("Acquisition", str(sar.get("acquisition_time", "?"))),
        ("CRS", str(sar.get("crs", "?"))),
        ("Georeferencing", str(Georeferencing(sar.get("georeferencing", "UNREFERENCED")).value)
         if sar.get("georeferencing") else "recorded in evidence"),
        ("Config hash", str(provenance.get("processing", {}).get("config_hash", "?"))),
        ("Processing", str(provenance.get("processing_version", "?"))),
        ("Detections", str(len(targets))),
        ("AIS-only", str(len(ais_only))),
    ]
    for label, value in rows:
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(150, 175, 185)
        pdf.set_xy(15, y)
        pdf.cell(40, 5.5, label, new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(235, 243, 246)
        pdf.set_xy(58, y)
        pdf.cell(width - 73, 5.5, value[:88], new_x="LMARGIN", new_y="NEXT")
        y += 5.5
    footer(page)

    # ---- one page per target --------------------------------------------
    for t in targets[:40]:
        pdf.add_page()
        header(f"Target {t.get('id', '?')}", str(t.get("classification", "")))
        page += 1
        y = pdf.get_y()
        corr = t.get("corr", {}) or {}
        dec = corr.get("scoreDecomposition") or {}
        observed = [
            ("Position", f"{t.get('lat')}, {t.get('lon')}" if t.get("lat") is not None and t.get("lon") is not None else "not established"),
            ("Apparent length", f"{t.get('lenM')} m +/- {t.get('lenUncM')} m"),
            ("Orientation", f"{t.get('hdg')} deg"),
            ("Mean / peak backscatter", f"{t.get('meanDb')} / {t.get('maxDb')} dB"),
            ("SAR detection confidence", str(t.get("sarConf"))),
            ("AIS association confidence", str(t.get("aisConf"))),
            ("Candidate MMSI", str(corr.get("mmsi") or "none established")),
            ("Distance offset", f"{corr.get('distanceOffsetMeters')} m" if corr.get("distanceOffsetMeters") else "n/a"),
            ("Time delta", f"{corr.get('timeDeltaSeconds')} s" if corr.get("timeDeltaSeconds") else "n/a"),
            ("Match radius", f"{dec.get('matchRadiusMeters')} m" if dec else "n/a"),
        ]
        for label, value in observed:
            pdf.set_font("Helvetica", "B", 8.5)
            pdf.set_text_color(150, 175, 185)
            pdf.set_xy(15, y)
            pdf.cell(52, 5, label, new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "", 8.5)
            pdf.set_text_color(235, 243, 246)
            pdf.set_xy(70, y)
            pdf.cell(width - 85, 5, value[:74], new_x="LMARGIN", new_y="NEXT")
            y += 5

        if dec:
            y += 3
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_text_color(98, 232, 255)
            pdf.set_xy(15, y)
            pdf.cell(width - 30, 6, "Score decomposition", new_x="LMARGIN", new_y="NEXT")
            y = pdf.get_y() + 1
            for key in ("spatialScore", "temporalScore", "headingScore", "sizeScore", "compositeScore"):
                if key in dec:
                    pdf.set_font("Helvetica", "", 8.5)
                    pdf.set_text_color(210, 230, 236)
                    pdf.set_xy(20, y)
                    pdf.cell(45, 4.5, key, new_x="LMARGIN", new_y="NEXT")
                    pdf.set_text_color(102, 240, 195)
                    pdf.set_xy(70, y)
                    pdf.cell(30, 4.5, f"{dec[key]}", new_x="LMARGIN", new_y="NEXT")
                    y += 4.5

        y += 3
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(98, 232, 255)
        pdf.set_xy(15, y)
        pdf.cell(width - 30, 6, "Assessment", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 8)
        pdf.set_text_color(200, 218, 224)
        pdf.set_xy(15, pdf.get_y() + 1)
        pdf.multi_cell(width - 30, 4.2, str(t.get("assessment", "")))
        footer(page)

    buf = io.BytesIO()
    pdf.output(buf)
    return buf.getvalue()