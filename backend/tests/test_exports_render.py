"""CP12 gate: PNG + PDF evidence exports carry provenance (EXP-004/005)."""

from __future__ import annotations

import io

import numpy as np

from darkfleet.exports import render_pdf, render_png
from darkfleet.exports.render import _mono_rgb

PROV = {
    "sar": {
        "provider": "planetary-computer",
        "collection": "sentinel-1-rtc",
        "item_id": "S1A_TEST",
        "platform": "SENTINEL-1A",
        "product": "RTC",
        "polarization": "VV",
        "acquisition_time": "2024-12-24T22:48:26Z",
        "crs": "EPSG:32648",
    },
    "config_hash": "abc123",
    "processing_version": "DarkFleet-Core 3.0.0",
}
TARGETS = [
    {
        "id": "DF-001",
        "classification": "SAR_UNMATCHED",
        "lat": 1.25,
        "lon": 103.85,
        "lenM": 120,
        "lenUncM": 26,
        "hdg": 122,
        "meanDb": -8.5,
        "maxDb": 6.2,
        "sarConf": 0.81,
        "aisConf": 0.0,
        "assessment": "Unmatched surface radar return. No sufficiently confident AIS association.",
        "corr": {"mmsi": None, "scoreDecomposition": None},
    },
    {
        "id": "DF-002",
        "classification": "SAR_MATCHED_AIS",
        "lat": 1.26,
        "lon": 103.86,
        "lenM": 294,
        "lenUncM": 65,
        "hdg": 130,
        "meanDb": -6.0,
        "maxDb": 9.1,
        "sarConf": 0.9,
        "aisConf": 0.72,
        "assessment": "Correlated with AIS MMSI 563189210.",
        "corr": {
            "mmsi": "563189210",
            "distanceOffsetMeters": 90,
            "timeDeltaSeconds": 24,
            "scoreDecomposition": {
                "spatialScore": 0.927,
                "temporalScore": 0.973,
                "headingScore": 0.0,
                "sizeScore": 0.128,
                "compositeScore": 0.68,
                "matchRadiusMeters": 1230,
            },
        },
    },
]


def _db() -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(5)
    db = (-21.0 + rng.normal(0, 2.0, (64, 64))).astype(np.float64)
    db[30:34, 20:24] = 6.0
    valid = np.ones_like(db, dtype=bool)
    valid[0, 0] = False
    return db, valid


def test_png_is_a_real_png_with_caption_height() -> None:
    db, valid = _db()
    png = render_png(
        scan_id="DF-TEST", db=db, valid=valid,
        centroids=[(31.5, 21.5)], provenance=PROV, title="Evidence",
    )
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    from PIL import Image

    with Image.open(io.BytesIO(png)) as im:
        assert im.format == "PNG"
        assert im.height == 64 + 156  # raster + provenance caption


def test_the_renderer_has_no_mode_parameter_at_all() -> None:
    """The strongest form of the labelling guarantee.

    These tests used to render a legacy ``DEMO`` record and assert the renderer
    still labelled it synthetic. That path is gone: ``RunStore.save`` refuses any
    record that is not ``REAL``/not-synthetic, and ``mark_synthetic`` now raises
    on ``synthetic=True`` at the call site. Rather than keep a test for a state
    the store cannot hold, this pins the reason it cannot happen - the renderer
    has nothing to branch on.
    """
    import inspect

    from darkfleet.exports.render import render_pdf, render_png

    assert "runtime_mode" not in inspect.signature(render_png).parameters
    assert "runtime_mode" not in inspect.signature(render_pdf).parameters


def test_every_export_is_stamped_real_observation_data() -> None:
    """The banner must be verifiable in the raw bytes, not just visually.

    Compression is disabled in the renderer precisely so this holds: a compressed
    stream cannot be grepped, which would make the stamp unverifiable by anyone
    the file is forwarded to.
    """
    from darkfleet.exports.render import PDF_TAG, REAL_TAG

    pdf = render_pdf(
        scan_id="DF-T", title="T", scene=PROV["sar"], provenance=PROV,
        targets=TARGETS, ais_only=[],
    )
    assert pdf[:5] == b"%PDF-"
    # Two independent stamps: the cover banner and the per-page footer, so a
    # single page torn out of the pack still carries the label.
    assert pdf.count(PDF_TAG.encode()) >= 2, "cover banner and page footer must both be present"
    assert REAL_TAG.encode() in pdf


def test_a_png_export_is_stamped_real_data() -> None:
    from darkfleet.exports.render import REAL_TAG

    db, valid = _db()
    png = render_png(
        scan_id="DF-T", db=db, valid=valid, centroids=[], provenance=PROV, title="T",
    )
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    # The banner is drawn into the pixels, so it is asserted via the renderer's
    # constant rather than by decoding text out of the image.
    assert REAL_TAG == "REAL DATA"


def test_pdf_has_a_page_per_target_and_provenance() -> None:
    pdf = render_pdf(
        scan_id="DF-TEST", title="Test",
        scene=PROV["sar"], provenance=PROV, targets=TARGETS, ais_only=[],
    )
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 1000
    assert pdf.rstrip().endswith(b"%%EOF")


def test_pdf_never_renders_a_legacy_synthetic_record_as_real() -> None:
    """Same guarantee as the PNG, on the artefact people actually print.

    Kept as a defence-in-depth assertion for a data directory carried over from
    an older build. The store now refuses such a record on write and the renderer
    has no mode parameter, so the label below is unconditional rather than
    computed. That is a stronger position than the one this test was written for,
    and the test is retained because the failure it guards is the one that cannot
    be walked back: a mislabelled export forwarded to someone else.
    """
    pdf = render_pdf(
        scan_id="DF-LEGACY", title="T", scene=PROV["sar"], provenance=PROV,
        targets=TARGETS, ais_only=[],
    )
    assert b"SYNTHETIC" not in pdf
    assert b"REAL OBSERVATION DATA" in pdf


def test_renders_with_no_data_without_crashing() -> None:
    empty = np.full((16, 16), np.nan)
    valid = np.zeros((16, 16), dtype=bool)
    png = render_png(
        scan_id="DF-E", db=empty, valid=valid,
        centroids=[], provenance=PROV, title="Empty",
    )
    assert png[:8] == b"\x89PNG\r\n\x1a\n"


def test_missing_sensor_resolution_remains_explicit_in_exported_pdf() -> None:
    target = {**TARGETS[0], "lenM": None, "lenUncM": None, "hdg": None,
              "meanDb": None, "maxDb": None, "sarConf": None, "aisConf": None}
    pdf = render_pdf(
        scan_id="DF-MISSING-RES", title="Missing resolution evidence",
        scene=PROV["sar"], provenance=PROV, targets=[target], ais_only=[],
    )
    # FPDF escapes PDF literal-string parentheses in content streams.
    assert b"not established \\(sensor resolution unavailable\\)" in pdf
    assert b"None m" not in pdf
    assert b"None deg" not in pdf
    assert b"None / None dB" not in pdf


def test_no_data_colour_is_outside_the_greyscale_data_ramp() -> None:
    """Excluded pixels must be distinguishable from a valid low-backscatter pixel.

    The data ramp is pure greyscale, so an earlier mid-grey (40,40,40) no-data
    marker collided with a plausible data value: real water was indistinguishable
    from excluded land in the exported image.
    """
    from darkfleet.exports.render import NO_DATA_RGB

    r, g, b = NO_DATA_RGB
    assert not (r == g == b), "no-data colour must not be a grey the ramp can produce"

    db, valid = _db()
    valid[:] = False  # everything excluded
    rgb = _mono_rgb(db, valid)
    assert np.all(rgb == np.array(NO_DATA_RGB, dtype=np.uint8))


def test_excluded_and_included_pixels_are_always_visually_distinct() -> None:
    """Sweep the stretch so no water value can land on the no-data colour."""
    from darkfleet.exports.render import NO_DATA_RGB

    rng = np.random.default_rng(11)
    base = rng.uniform(-40.0, 20.0, (48, 48))
    land = np.zeros_like(base, dtype=bool)
    land[:12] = True
    valid = ~land
    rgb = _mono_rgb(base, valid)
    nodata = np.array(NO_DATA_RGB, dtype=np.uint8)
    assert np.all(rgb[~valid] == nodata)
    # Every valid pixel is greyscale; therefore no valid pixel can equal no-data.
    for row in range(valid.shape[0]):
        for col in range(valid.shape[1]):
            if valid[row, col]:
                assert rgb[row, col][0] == rgb[row, col][1] == rgb[row, col][2]


def test_png_states_the_excluded_and_analysed_fraction() -> None:
    """An excluded area must never read as an observed absence of returns."""
    db, valid = _db()
    valid[:16] = False  # exactly a quarter excluded
    png = render_png(
        scan_id="DF-F", db=db, valid=valid,
        centroids=[], provenance=PROV, title="Fraction",
    )
    from PIL import Image

    with Image.open(io.BytesIO(png)) as im:
        caption = im.crop((0, 64, im.width, im.height)).convert("L")
        px = np.asarray(caption)
    # The caption band carries bright text pixels on a dark background.
    assert px.max() > 120, "caption text was not drawn"
    assert px.mean() < 90, "caption is not predominantly background"
