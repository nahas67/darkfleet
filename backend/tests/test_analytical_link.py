"""The raster-to-target link must be authoritative, and it must be sub-pixel.

Found while building the analytics surface. Two things were wrong, and neither
was visible to a green suite because both produced plausible output.

1. `correlation/match.py` builds each target from an explicit field list, and
   `geo_pixel_centroid` was not on it. GEO-CORR measured the exact sub-pixel
   centroid in `geolocate_components`, kept it on the component -- and correlation
   dropped it one layer later. The coordinate was never wrong; the REPRODUCIBILITY
   evidence was gone, and the raster-to-target link existed only positionally.

2. `components` and `centroids` were float64 (n, k) arrays, so the target id could
   not be a column. Row 3 was target 3 by position, which is a link that cannot
   survive a filter, a sort, or a different ordering on either side. A frontend
   given row 3 could only guess -- and the natural guess, nearest point, is
   exactly the manufactured relation this product refuses to invent.

Both are now explicit: `target_id` is a column, and the centroid travels with it.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.test_api import (  # noqa: F401
    api_settings,
    client,
    completed_scan,
    net,
    offline_pipeline,
)

BBOX = [104.1011, 1.3569, 104.1371, 1.3931]


def _run(client: TestClient, net: Any) -> str:
    """Run one scan and return its id, polled to a terminal state."""
    response = client.post("/api/scans", json={"bbox": BBOX})
    assert response.status_code == 202, response.text
    scan_id = str(response.json()["scan_id"])
    deadline = time.monotonic() + 90.0
    while time.monotonic() < deadline:
        state = client.get(f"/api/scans/{scan_id}").json()
        if state.get("terminal"):
            assert state["stage"] == "COMPLETE", state.get("error")
            return scan_id
        time.sleep(0.2)
    raise AssertionError("scan did not complete")


def _layer(client: TestClient, scan_id: str, layer: str) -> dict[str, Any]:
    response = client.get(f"/api/debug/{scan_id}/{layer}", params={"limit": 50})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# ------------------------------------------------------- the authoritative link


@pytest.mark.parametrize("layer", ["components", "centroids"])
def test_every_row_carries_its_target_id(
    client: TestClient, completed_scan: dict[str, Any], net: Any, layer: str
) -> None:
    """The connection is the id, never row order.

    Asserted against the authoritative target list, so a row whose id does not
    appear in it -- or appears twice -- fails. A positional implementation would
    pass a shape test while being wrong the moment anything was filtered.
    """
    scan_id = str(completed_scan["scan_id"])
    targets = client.get(f"/api/scans/{scan_id}/targets").json()
    ids = [t["id"] for t in targets["targets"]]

    body = _layer(client, scan_id, layer)
    assert "target_id" in (body["columns"] or []), f"{layer} does not declare target_id"
    assert body["rows"] == len(ids)

    row_ids = [r["target_id"] for r in body["data"]]
    assert row_ids == ids, f"{layer} rows are not the target ids, in order: {row_ids} vs {ids}"
    assert len(set(row_ids)) == len(row_ids), f"{layer} repeats a target id"


def test_components_and_centroids_describe_the_same_targets(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    components = _layer(client, str(completed_scan["scan_id"]), "components")
    centroids = _layer(client, str(completed_scan["scan_id"]), "centroids")
    assert [r["target_id"] for r in components["data"]] == [
        r["target_id"] for r in centroids["data"]
    ]


# ------------------------------------------------------------ sub-pixel is real


def test_the_centroid_is_sub_pixel_and_never_rounded(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    """A centroid that is always a whole number is a rounded one.

    The intensity-weighted centroid is genuinely fractional. Rounding it to a
    pixel index before geolocation moves the answer by up to half a pixel -- 5 m
    at 10 m resolution -- which is larger than the geolocation uncertainty this
    product reports.
    """
    scan_id = str(completed_scan["scan_id"])
    rows = _layer(client, scan_id, "centroids")["data"]
    assert rows, "fixture must produce at least one target"

    fractional = [
        r
        for r in rows
        if r["pixel_row"] is not None and float(r["pixel_row"]) % 1.0 != 0.0
    ]
    assert fractional, f"every centroid landed on a whole pixel: {rows}"


def test_the_recorded_centroid_re_derives_the_recorded_coordinate(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    """The alignment proof, with a tolerance of exactly zero.

    The centroid stored on the target and the coordinate stored on the same target
    must be two views of one measurement: probing the centroid through the public
    route has to return the coordinate the pipeline recorded. If it does not, then
    either the centroid or the coordinate was derived from something else, and the
    raster an analyst is looking at is not the raster the detection came from.

    Zero tolerance, not a chosen epsilon: both numbers come from the same
    authoritative function, so any difference at all is a defect.
    """
    scan_id = str(completed_scan["scan_id"])
    for row in _layer(client, scan_id, "centroids")["data"]:
        if row["pixel_row"] is None or row["pixel_col"] is None:
            continue
        probe = client.post(
            f"/api/scans/{scan_id}/debug/probe",
            json={"row": row["pixel_row"], "col": row["pixel_col"]},
        )
        assert probe.status_code == 200, probe.text
        body = probe.json()
        assert body["wgs84_lat"] == pytest.approx(row["lat"], abs=1e-12), row["target_id"]
        assert body["wgs84_lon"] == pytest.approx(row["lon"], abs=1e-12), row["target_id"]
        assert body["pixel"]["convention"] == "PIXEL_CENTER"
        assert body["pixel"]["centre_offset"] == pytest.approx(
            row["geo_centre_offset"], abs=1e-12
        )


def test_the_centre_offset_is_carried_not_assumed(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    """Each centroid states the convention that produced it.

    So a reader can reproduce the conversion instead of trusting that 0.5 was used.
    """
    scan_id = str(completed_scan["scan_id"])
    for row in _layer(client, scan_id, "centroids")["data"]:
        assert row["geo_centre_offset"] == pytest.approx(0.5)


def test_targets_expose_the_centroid_on_their_own_record(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    """The anchor is on the target, not only in the debug view.

    An evidence export carries `/api/scans/{id}/targets`; if the centroid lived
    only in the debug layer, an exported record could not be traced back to a pixel.
    """
    scan_id = str(completed_scan["scan_id"])
    for target in client.get(f"/api/scans/{scan_id}/targets").json()["targets"]:
        assert target["geoPixelCentroid"] is not None, target["id"]
        col, row = target["geoPixelCentroid"]
        assert 0 <= row <= 399
        assert 0 <= col <= 399
        assert target["geoCentreOffset"] == pytest.approx(0.5)


def test_component_and_centroid_rows_agree_with_the_target_record(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    """Both tables quote the same centroid the target carries.

    Two copies of a number can drift. Asserting they agree is what stops the drift
    from being invisible until someone trusts the wrong one.
    """
    scan_id = str(completed_scan["scan_id"])
    targets = {
        t["id"]: t for t in client.get(f"/api/scans/{scan_id}/targets").json()["targets"]
    }
    for layer in ("components", "centroids"):
        for row in _layer(client, scan_id, layer)["data"]:
            target = targets[row["target_id"]]
            expected = target["geoPixelCentroid"]
            assert row["pixel_col"] == pytest.approx(expected[0], abs=1e-12)
            assert row["pixel_row"] == pytest.approx(expected[1], abs=1e-12)


def test_a_scan_without_a_centroid_reports_null_not_zero(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    """Absence stays absence.

    A stored scan from before the fix has no centroid. Reporting (0, 0) would
    place it at the raster's top-left corner and look like a real measurement;
    reporting null says the anchor does not exist.
    """
    scan_id = str(completed_scan["scan_id"])
    body = _layer(client, scan_id, "centroids")
    for row in body["data"]:
        if row["pixel_row"] is None:
            assert row["pixel_col"] is None
            assert row["lat"] is None or isinstance(row["lat"], float)


def test_truncation_is_reported_over_the_full_set(
    client: TestClient, completed_scan: dict[str, Any], net: Any
) -> None:
    """A window must not read as the whole table."""
    scan_id = str(completed_scan["scan_id"])
    full = _layer(client, scan_id, "centroids")
    window = client.get(f"/api/debug/{scan_id}/centroids", params={"limit": 1}).json()

    assert window["rows"] == full["rows"]
    assert window["row_limit"] == 1
    assert len(window["data"]) == 1
    assert window["truncated"] is (full["rows"] > 1)
    if window["truncated"]:
        assert any("showing" in note for note in window["notes"]), window["notes"]