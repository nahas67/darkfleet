"""The CFAR request boundary must actually reach the detector (API-011).

Two defects lived here, and both were invisible to a green suite.

**``cfar_config`` replaced the defaults instead of merging.** The pipeline did
``dict(cfar_config or DEFAULT_CFAR)``, which returns the caller's dict untouched
whenever it is non-empty. Omitting a key therefore *removed* it, and the pipeline
subscripts these values directly, so the run died mid-scan::

    no cfar_config          -> COMPLETE  train=16 guard=4 alpha=3.5
    {"training_cells": 8}   -> FAILED    KeyError: 'coastline_buffer_meters'
    full snake_case         -> COMPLETE  train=32 guard=8 alpha=5.5

That contradicted ``ScanCreateRequest.cfar_config``, which documents "unset keys
keep pipeline defaults".

**The interface and the pipeline disagreed on key casing.** ``toCfarRequestParams``
emits camelCase (``trainingCells``); the pipeline subscripts snake_case
(``training_cells``). Because the field was an untyped ``dict[str, Any]``, nothing
rejected the mismatch -- so the CFAR controls in the workspace were capable of
destroying a run rather than configuring one.

The last test in this file is the one that matters most going forward: it reads
``src/analysis/cfar.ts`` and checks the ranges the interface advertises against
the ranges the backend enforces. "Parameter controls match backend" was an
unchecked claim; it is now a failing test when it stops being true.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from darkfleet.api.models import CfarConfig
from darkfleet.pipeline import DEFAULT_CFAR, merge_cfar_config
from tests.fixture_source import FIXTURE_BBOX
from tests.test_api import (  # noqa: F401
    api_settings,
    client,
    completed_scan,
    net,
    offline_pipeline,
)

# Keep the test AOI tied to the measured raster footprint. A stale, north-shifted
# bbox formerly appeared to work only because the reader moved it onto the image.
BBOX = FIXTURE_BBOX
CFAR_TS = Path(__file__).resolve().parents[2] / "src" / "analysis" / "cfar.ts"


# --------------------------------------------------------------- the merge


def test_partial_config_keeps_every_default() -> None:
    """The documented behaviour, which the old implementation did not have."""
    merged = merge_cfar_config({"training_cells": 8})
    assert merged["training_cells"] == 8
    for key, default in DEFAULT_CFAR.items():
        if key != "training_cells":
            assert merged[key] == default, f"{key} was dropped instead of defaulted"


def test_no_config_is_the_defaults() -> None:
    assert merge_cfar_config(None) == DEFAULT_CFAR
    assert merge_cfar_config({}) == DEFAULT_CFAR


def test_merge_never_loses_a_key_the_pipeline_subscripts() -> None:
    """The failure that killed runs: a missing key, not a wrong value.

    The pipeline indexes these directly rather than with ``.get``, so an absent
    key is a ``KeyError`` partway through a scan rather than a reported problem.
    """
    for overrides in ({"training_cells": 8}, {"speckle_filter": "lee"}, {"kernel_size": 5}):
        merged = merge_cfar_config(overrides)
        missing = set(DEFAULT_CFAR) - set(merged)
        assert not missing, f"{overrides} would raise KeyError on {sorted(missing)}"


def test_unknown_keys_survive_the_merge_so_they_stay_visible() -> None:
    """Not dropped here -- rejected earlier, at the request model.

    Carrying an unrecognised key into the persisted config (and its hash) is what
    makes a typo debuggable after the fact.
    """
    assert merge_cfar_config({"typo": 1})["typo"] == 1


# ------------------------------------------------------- casing and rejection


def test_camel_case_is_accepted_and_normalised_to_snake() -> None:
    """The interface emits camelCase; it has to reach the detector."""
    config = CfarConfig.model_validate(
        {
            "trainingCells": 32,
            "guardCells": 8,
            "thresholdFactor": 5.5,
            "minPixels": 50,
            "maxPixels": 5000,
            "speckleFilter": "lee",
            "kernelSize": 7,
            "coastlineBufferMeters": 500,
        }
    )
    overrides = config.overrides()
    assert overrides == {
        "training_cells": 32,
        "guard_cells": 8,
        "threshold_factor": 5.5,
        "min_pixels": 50,
        "max_pixels": 5000,
        "speckle_filter": "lee",
        "kernel_size": 7,
        "coastline_buffer_meters": 500,
    }


def test_snake_case_is_equally_accepted() -> None:
    assert CfarConfig.model_validate({"training_cells": 8}).overrides() == {"training_cells": 8}


def test_casing_variants_agree() -> None:
    camel = CfarConfig.model_validate({"trainingCells": 20, "speckleFilter": "lee"})
    snake = CfarConfig.model_validate({"training_cells": 20, "speckle_filter": "lee"})
    assert camel.overrides() == snake.overrides()


def test_overrides_omits_unset_keys_rather_than_nulling_them() -> None:
    """An explicit ``None`` would fail a numeric subscript just as badly.

    ``overrides()`` exists so the pipeline merges real values only; unset keys
    must stay absent from the dict, not present-and-null.
    """
    overrides = CfarConfig.model_validate({"training_cells": 8}).overrides()
    assert overrides == {"training_cells": 8}
    assert all(value is not None for value in overrides.values())


def test_unknown_key_is_rejected_loudly() -> None:
    """The defect this whole change exists to prevent, as a regression gate."""
    with pytest.raises(ValidationError):
        CfarConfig.model_validate({"trainning_cells": 8})


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"training_cells": 999}, "training_cells"),
        ({"training_cells": 1}, "training_cells"),
        ({"guard_cells": 99}, "guard_cells"),
        ({"threshold_factor": 99.0}, "threshold_factor"),
        ({"min_pixels": 0}, "min_pixels"),
        ({"max_pixels": 10**9}, "max_pixels"),
        ({"kernel_size": 99}, "kernel_size"),
        ({"coastline_buffer_meters": 1}, "coastline_buffer_meters"),
        ({"speckle_filter": "gaussian"}, "speckle_filter"),
    ],
)
def test_out_of_range_values_are_rejected(payload: dict[str, Any], field: str) -> None:
    with pytest.raises(ValidationError):
        CfarConfig.model_validate(payload)


def test_defaults_are_inside_the_declared_bounds() -> None:
    """A shipped default outside its own range would be unreachable by request."""
    for key, default in DEFAULT_CFAR.items():
        CfarConfig.model_validate({key: default})


# ------------------------------------------------ the end-to-end consequence


@pytest.mark.parametrize(
    "config",
    [
        pytest.param({"training_cells": 8}, id="partial-snake"),
        pytest.param({"trainingCells": 8}, id="partial-camel"),
        pytest.param({"speckle_filter": "lee"}, id="single-enum"),
        pytest.param({"coastlineBufferMeters": 300}, id="single-buffer"),
    ],
)
def test_a_partial_config_still_completes_a_scan(
    client: TestClient, config: dict[str, Any], net: Any
) -> None:
    """The regression that mattered: these used to raise ``KeyError`` mid-scan.

    Asserted on the DETECTING stage detail rather than only on a 202, because
    accepting the request is not the same as honouring it.
    """
    import time

    accepted = client.post("/api/scans", json={"bbox": BBOX, "cfar_config": config})
    assert accepted.status_code == 202, accepted.text
    scan_id = accepted.json()["scan_id"]

    deadline = time.monotonic() + 60.0
    state: dict[str, Any] = {}
    while time.monotonic() < deadline:
        state = client.get(f"/api/scans/{scan_id}").json()
        if state.get("terminal"):
            break
        time.sleep(0.2)
    assert state.get("stage") == "COMPLETE", state.get("error")


def test_a_camel_case_override_reaches_the_detector(client: TestClient, net: Any) -> None:
    """The interface's payload must change the detector, not just be accepted."""
    import time

    accepted = client.post(
        "/api/scans",
        json={"bbox": BBOX, "cfar_config": {"trainingCells": 32, "thresholdFactor": 5.0}},
    )
    assert accepted.status_code == 202, accepted.text
    scan_id = accepted.json()["scan_id"]

    deadline = time.monotonic() + 60.0
    state: dict[str, Any] = {}
    while time.monotonic() < deadline:
        state = client.get(f"/api/scans/{scan_id}").json()
        if state.get("terminal"):
            break
        time.sleep(0.2)
    assert state["stage"] == "COMPLETE", state.get("error")

    detail = next(h["detail"] for h in state["history"] if h["stage"] == "DETECTING")
    # The requested values, with the defaults kept for the keys not sent.
    assert "train=32" in detail, detail
    assert "alpha=5.0" in detail, detail
    assert "guard=4" in detail, detail  # default, because the UI did not send it


def test_an_unknown_key_is_a_422_not_a_silent_no_op(client: TestClient) -> None:
    response = client.post(
        "/api/scans", json={"bbox": BBOX, "cfar_config": {"trainning_cells": 8}}
    )
    assert response.status_code == 422
    assert "extra_forbidden" in response.text


# ------------------------------------- the interface and the backend must agree


def _ts_specs() -> dict[str, dict[str, float]]:
    """Parse ``CFAR_PARAM_SPECS`` out of the TypeScript source.

    Parsed rather than imported because the test suite is Python and the frontend
    has no compiled artifact at test time. Only the numeric min/max pairs are
    read, which is all this gate compares.
    """
    text = CFAR_TS.read_text(encoding="utf-8")
    block = text.split("export const CFAR_PARAM_SPECS", 1)[1].split("};", 1)[0]
    specs: dict[str, dict[str, float]] = {}
    for match in re.finditer(
        r"(\w+):\s*\{[^}]*?min:\s*(-?[\d.]+),[^}]*?max:\s*(-?[\d.]+),",
        block,
        re.DOTALL,
    ):
        specs[match.group(1)] = {"min": float(match.group(2)), "max": float(match.group(3))}
    return specs


def test_the_interface_declares_every_parameter_the_backend_accepts() -> None:
    """A control with no backend field, or a field with no control, is drift."""
    specs = _ts_specs()
    assert specs, "failed to parse CFAR_PARAM_SPECS from src/analysis/cfar.ts"

    backend_fields = {
        name
        for name in CfarConfig.model_fields
    }
    assert backend_fields, "CfarConfig declares no fields"

    # camelCase UI key -> snake_case backend field
    pairs = {
        "trainingCells": "training_cells",
        "guardCells": "guard_cells",
        "thresholdFactor": "threshold_factor",
        "minPixels": "min_pixels",
        "maxPixels": "max_pixels",
        "speckleFilter": "speckle_filter",
        "kernelSize": "kernel_size",
        "coastlineBufferMeters": "coastline_buffer_meters",
    }
    assert set(pairs) == set(specs), (
        f"UI keys {sorted(set(pairs) ^ set(specs))} have no CFAR_PARAM_SPECS entry"
    )
    assert set(pairs.values()) == set(backend_fields), (
        f"UI/backend key mismatch: {sorted(set(pairs.values()) ^ set(backend_fields))}"
    )


def _bounds(field_name: str) -> tuple[float | None, float | None]:
    """``(ge, le)`` for a Pydantic field.

    Pydantic v2 keeps each constraint as its own ``annotated_types`` object in
    ``metadata``, so ``metadata[0]`` is only one of them. Reading the attribute
    that exists is the only way to get both.
    """
    ge: float | None = None
    le: float | None = None
    for constraint in CfarConfig.model_fields[field_name].metadata:
        ge = getattr(constraint, "ge", ge)
        le = getattr(constraint, "le", le)
    return ge, le


@pytest.mark.parametrize(
    ("ui_key", "backend_field"),
    [
        ("trainingCells", "training_cells"),
        ("guardCells", "guard_cells"),
        ("thresholdFactor", "threshold_factor"),
        ("minPixels", "min_pixels"),
        ("maxPixels", "max_pixels"),
        ("kernelSize", "kernel_size"),
        ("coastlineBufferMeters", "coastline_buffer_meters"),
    ],
)
def test_ui_ranges_match_the_backend_bounds(ui_key: str, backend_field: str) -> None:
    """The gate the brief asks for: "parameter controls match backend".

    The interface advertises a slider range; the backend enforces a bound. When
    they drift, either the slider can produce a value the API rejects, or the API
    accepts a value the slider cannot express. Both are silent until this fails.
    """
    spec = _ts_specs()[ui_key]
    ge, le = _bounds(backend_field)
    assert ge is not None and le is not None, f"{backend_field} declares no bounds"
    assert float(spec["min"]) == float(ge), f"{ui_key}: UI min {spec['min']} != backend ge {ge}"
    assert float(spec["max"]) == float(le), f"{ui_key}: UI max {spec['max']} != backend le {le}"


def test_the_shipped_default_preset_is_inside_the_ui_ranges() -> None:
    """``STANDARD_SENTINEL_1`` is what the lab opens with; it must be submittable."""
    specs = _ts_specs()
    preset = {
        "trainingCells": 16,
        "guardCells": 4,
        "thresholdFactor": 3.5,
        "minPixels": 3,
        "maxPixels": 1000,
        "kernelSize": 3,
        "coastlineBufferMeters": 150,
    }
    for key, value in preset.items():
        assert specs[key]["min"] <= value <= specs[key]["max"], f"{key}={value} out of range"
    assert all(value == DEFAULT_CFAR[snake] for (key, value), snake in zip(
        preset.items(),
        (
            "training_cells",
            "guard_cells",
            "threshold_factor",
            "min_pixels",
            "max_pixels",
            "kernel_size",
            "coastline_buffer_meters",
        ),
        strict=True,
    )), "the UI preset and the pipeline defaults have diverged"


def test_speckle_modes_match_the_backend_literal() -> None:
    """`lee` was unreachable in the legacy workbench; both sides must still offer it."""
    text = CFAR_TS.read_text(encoding="utf-8")
    # The array literal is what follows `SPECKLE_MODES` and `=`. Cutting at the
    # first `]` would land inside `SpeckleMode[]` and match nothing.
    tail = text.split("export const SPECKLE_MODES", 1)[1]
    literal = tail.split("=", 1)[1].split("[", 1)[1].split("]", 1)[0]
    modes = set(re.findall(r"'(\w+)'", literal))
    assert modes == {"none", "median", "lee"}

    # And every mode the interface offers must be accepted by the backend.
    for mode in sorted(modes):
        assert CfarConfig.model_validate({"speckle_filter": mode}).overrides() == {
            "speckle_filter": mode
        }
