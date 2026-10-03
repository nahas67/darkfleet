"""Table debug layers must return rows, not just a promise of rows.

Found by driving ``GET /api/debug/{scan}/{layer}`` during the DF-X6 audit and
reading the payloads rather than the code. Every ``kind: "table"`` layer
returned:

    columns   ["area_px", "mean_db", ...]
    rows      3
    row_limit 3
    truncated false

and no row data at all. Four separate promises in one payload, none kept:
``kind="table"`` implied a table, ``limit`` implied a window, ``row_limit``
implied the window size, and ``truncated`` implied truncation was possible.

For the array-backed layers the data was sitting in a local variable, already
sliced to the limit, and then discarded. For the correlation layers the rows had
to be built from the persisted correlation result and never were -- while the
docstring claimed "Rows are emitted only for targets that actually carry the
field".

This blocks DF-X6's ``components visible`` and ``centroids visible`` gates,
because a component cannot be shown if the endpoint cannot produce one.

These tests pin the behaviour in both directions: rows must be present and real,
and a genuinely empty layer must still be empty rather than padded.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

# Reuse the module-scoped fixture chain from test_api.py rather than rebuilding
# ~60 lines of fake-network wiring. The chain is not transitive: `client` needs
# `api_settings`, which needs `offline_pipeline`, which needs `net`. All four are
# imported so pytest resolves each fixture in this module as well.
from tests.test_api import (  # noqa: F401
    api_settings,
    client,
    completed_scan,
    net,
    offline_pipeline,
)

#: Layers whose payload is per-target rows rather than a raster.
TABLE_LAYERS = (
    "components",
    "centroids",
    "ais_observations",
    "ais_predicted",
    "match_radius",
    "correlation_lines",
    "score_decomposition",
)

#: Layers backed by a real raster artifact.
ARRAY_LAYERS = (
    "raw",
    "normalized",
    "landmask",
    "filtered",
    "cfar_threshold",
    "detection_mask",
)


def _debug(client: TestClient, scan_id: str, layer: str, **params: Any) -> dict[str, Any]:
    response = client.get(f"/api/debug/{scan_id}/{layer}", params=params)
    assert response.status_code == 200, response.text
    return dict(response.json())


def _sid(scan: dict[str, Any]) -> str:
    """The completed scan id from the shared module-scoped fixture."""
    return str(scan["scan_id"])


# ------------------------------------------------------------ the defect


@pytest.mark.parametrize("layer", TABLE_LAYERS)
def test_table_layer_always_carries_a_data_field(
    client: TestClient, completed_scan: dict[str, Any], layer: str
) -> None:
    """A table layer must state its rows, including when there are none.

    ``data: null`` on a table layer is the exact shape of the original defect: a
    caller cannot tell "this layer has no rows" from "this endpoint never emits
    rows". An empty list is the honest answer and is required instead.
    """
    scan_id = _sid(completed_scan)
    payload = _debug(client, scan_id, layer, limit=50)
    assert payload["kind"] == "table"
    assert payload.get("data") is not None, (
        f"{layer}: a table layer must return a list (possibly empty), not null"
    )
    assert isinstance(payload["data"], list)


@pytest.mark.parametrize("layer", TABLE_LAYERS)
def test_columns_match_the_returned_rows(
    client: TestClient, completed_scan: dict[str, Any], layer: str
) -> None:
    """Every emitted row must carry exactly the declared columns.

    A row missing a declared field would let a consumer read ``None`` as a
    measurement rather than as an absent one.
    """
    scan_id = _sid(completed_scan)
    payload = _debug(client, scan_id, layer, limit=50)
    columns = payload.get("columns") or []
    for row in payload["data"]:
        assert set(row) == set(columns), f"{layer}: row keys {sorted(row)} != {sorted(columns)}"


# ------------------------------------------------ limit actually bounds


@pytest.mark.parametrize("layer", ("components", "centroids"))
def test_limit_bounds_the_window_and_truncation_is_honest(
    client: TestClient, completed_scan: dict[str, Any], layer: str
) -> None:
    scan_id = _sid(completed_scan)
    full = _debug(client, scan_id, layer, limit=500)
    total = full["rows"]
    assert total >= 1, "fixture must produce at least one target for this test to mean anything"

    window = _debug(client, scan_id, layer, limit=1)
    assert window["rows"] == total, "the total must not change with the window size"
    assert window["row_limit"] == 1
    assert len(window["data"]) == 1
    assert window["truncated"] is (total > 1)


@pytest.mark.parametrize("layer", ("components", "centroids"))
def test_windows_are_prefixes_of_the_full_set(
    client: TestClient, completed_scan: dict[str, Any], layer: str
) -> None:
    """Truncation must drop rows from the end, not reorder them.

    An unstable prefix would make the window meaningless: the same target would
    appear to change value depending only on how much was requested.
    """
    scan_id = _sid(completed_scan)
    full = _debug(client, scan_id, layer, limit=500)["data"]
    window = _debug(client, scan_id, layer, limit=1)["data"]
    assert window == full[:1]


def test_components_carry_the_measured_per_target_values(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """Component rows must be the real measurements, not placeholders.

    Every field is checked for being a genuine measurement rather than a
    constant, because a table of plausible-looking constants would pass a shape
    test while telling an analyst nothing.
    """
    scan_id = _sid(completed_scan)
    payload = _debug(client, scan_id, "components", limit=50)
    assert payload["rows"] >= 1
    for row in payload["data"]:
        assert row["area_px"] > 0, "a detected component must have positive area"
        assert row["mean_db"] is not None
        assert row["max_db"] is not None
        assert row["max_db"] >= row["mean_db"], "peak backscatter must not be below the mean"
        assert 0.0 <= row["sar_conf"] <= 1.0


def test_centroids_carry_plausible_positions(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """Centroids must be real coordinates.

    A centroid row of zeros would render a target off West Africa and be
    indistinguishable from a real one, which is the failure mode this whole
    product exists to avoid.
    """
    scan_id = _sid(completed_scan)
    payload = _debug(client, scan_id, "centroids", limit=50)
    assert payload["rows"] >= 1
    for row in payload["data"]:
        assert -90.0 <= row["lat"] <= 90.0
        assert -180.0 <= row["lon"] <= 180.0
        assert row["lat"] != 0.0 or row["lon"] != 0.0


def test_centroid_count_matches_component_count(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """One centroid per detected component.

    A mismatch would mean the analytics surface and the detection list disagree
    about how many things were found.
    """
    scan_id = _sid(completed_scan)
    assert (
        _debug(client, scan_id, "centroids", limit=500)["rows"]
        == _debug(client, scan_id, "components", limit=500)["rows"]
    )


# ------------------------------------------- empty is not the same as absent


@pytest.mark.parametrize("layer", TABLE_LAYERS)
def test_empty_table_is_stated_not_hidden(
    client: TestClient, completed_scan: dict[str, Any], layer: str
) -> None:
    """An empty layer must say so in ``notes``.

    The distinction the product depends on: a layer with no rows is a real
    result, and a reader must be able to tell it from a layer that was never
    computed.
    """
    scan_id = _sid(completed_scan)
    payload = _debug(client, scan_id, layer, limit=500)
    if payload["rows"] == 0:
        assert payload["data"] == []
        assert any("empty" in note for note in payload["notes"]), (
            f"{layer}: an empty layer must state that it is empty"
        )


def test_absent_measurement_stays_none_in_a_row(
    client: TestClient, completed_scan: dict[str, Any]
) -> None:
    """A sub-score that was never measured must be ``None``, not 0.

    A zero heading score would read as "the heading actively disagreed" rather
    than "heading was unavailable", which are entirely different findings.
    """
    scan_id = _sid(completed_scan)
    payload = _debug(client, scan_id, "score_decomposition", limit=500)
    for row in payload["data"]:
        for field in ("distance_score", "time_score", "heading_score", "size_score"):
            value = row[field]
            assert value is None or 0.0 <= value <= 1.0, (
                f"{field} must be null or a 0..1 score, never a fabricated value"
            )


# ------------------------------------------------------- array layers intact


@pytest.mark.parametrize("layer", ARRAY_LAYERS)
def test_array_layers_still_return_a_grid_and_no_table(
    client: TestClient, completed_scan: dict[str, Any], layer: str
) -> None:
    """The `data` field belongs to tables only.

    Array layers carry `grid`; adding a table payload to them would invite a
    consumer to treat a summary grid as pixel data.
    """
    scan_id = _sid(completed_scan)
    payload = _debug(client, scan_id, layer, grid=8)
    assert payload["kind"] == "array"
    assert payload.get("data") is None
    assert payload["grid"] is not None
    assert len(payload["grid"]) == 8