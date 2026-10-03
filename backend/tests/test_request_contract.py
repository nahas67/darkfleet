"""The request contract must be generated, and the frontend must use it (DF-X6).

The asymmetry this file closes
------------------------------
The contract generator emitted RESPONSE schemas from a hand-maintained allowlist
and no request bodies at all. So the interface could name a request field however
it liked and nothing would notice until a live request failed. That is not
hypothetical: it happened twice.

    frontend camelCase + backend snake_case -> every CFAR control destroyed the
                                              run it touched (9a7157e)
    frontend scene_id + no such field     -> choosing a scene and running a
                                              scan returned 422

Both were invisible to a green suite, because a hand-written request body has no
type to be checked against. These tests make the wire shape generated, and make
the frontend consume the generated type, so the next rename is a compile error
or a failing test rather than a failed run.

What is asserted
----------------
1. Every request body reachable from a path is emitted into ``contract.ts``.
   Discovered from the document, not listed, so the next mission/watchlist/
   annotation route is covered the moment it exists.
2. The generated field names are the names the frontend actually sends.
3. The frontend builds its request bodies against the generated types rather
   than an inline literal.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
sys.path.insert(0, str(BACKEND))

from darkfleet.api.app import create_app
from darkfleet.api.models import CfarConfig, ScanCreateRequest
from darkfleet.config.settings import Settings

CONTRACT = ROOT / "src" / "api" / "contract.ts"
CLIENT = ROOT / "src" / "api" / "client.ts"
CFAR_TS = ROOT / "src" / "analysis" / "cfar.ts"


def _openapi() -> dict[str, Any]:
    settings = Settings(data_dir="C:/tmp/contract-gate")
    settings.log_level = "WARNING"
    document: dict[str, Any] = create_app(settings).openapi()
    return document


def _defs() -> dict[str, Any]:
    defs: dict[str, Any] = _openapi().get("components", {}).get("schemas", {})
    return defs


def _contract() -> str:
    return CONTRACT.read_text(encoding="utf-8")


def _request_schema_names() -> set[str]:
    """Schema names reachable as a request body, by the same walk the exporter uses."""
    document = _openapi()
    found: set[str] = set()
    for operations in document.get("paths", {}).values():
        if not isinstance(operations, dict):
            continue
        for operation in operations.values():
            if not isinstance(operation, dict):
                continue
            body = operation.get("requestBody")
            if not isinstance(body, dict):
                continue
            for media in body.get("content", {}).values():
                if not isinstance(media, dict):
                    continue
                schema = media.get("schema")
                stack: list[Any] = [schema]
                while stack:
                    node = stack.pop()
                    if isinstance(node, dict):
                        ref = node.get("$ref")
                        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
                            found.add(ref.rsplit("/", 1)[-1])
                        stack.extend(node.values())
                    elif isinstance(node, list):
                        stack.extend(node)
    return found


# ------------------------------------------------------- emission is complete


def test_every_request_schema_is_emitted() -> None:
    """The gate itself: a request body with no generated type is a hole.

    Discovered from the paths rather than listed, which is what stops the list
    from going stale the way the response allowlist could.
    """
    contract = _contract()
    for name in sorted(_request_schema_names()):
        assert f"export interface {name} " in contract, (
            f"{name} is a request body but is not generated into contract.ts; "
            "the frontend would have to hand-write it"
        )


def test_request_schema_names_are_declared_in_the_union() -> None:
    """Emitting an interface is not enough; it must be discoverable as a request."""
    contract = _contract()
    match = re.search(r"export type ContractRequestSchemaName =(.*?);", contract, re.DOTALL)
    assert match, "contract.ts declares no ContractRequestSchemaName union"
    declared = set(re.findall(r"'([^']+)'", match.group(1)))
    assert _request_schema_names() <= declared, (
        f"missing from the union: {sorted(_request_schema_names() - declared)}"
    )


def test_scan_create_request_is_generated() -> None:
    assert "export interface ScanCreateRequest " in _contract()
    assert "export interface CfarConfig " in _contract()


# --------------------------------------- the generated names are the wire names


def test_generated_cfar_config_uses_the_names_the_frontend_sends() -> None:
    """camelCase, because that is the API's wire convention.

    FastAPI generates request schemas in validation mode and takes the first
    ``AliasChoices`` entry, so the order inside the model is what lands in
    OpenAPI. Putting the snake_case field name first -- which is what this model
    originally did -- produces a generated type the frontend cannot satisfy
    without a cast, which reintroduces the original hole from the other side.
    """
    properties = _defs()["CfarConfig"]["properties"]
    assert set(properties) == {
        "trainingCells",
        "guardCells",
        "thresholdFactor",
        "minPixels",
        "maxPixels",
        "speckleFilter",
        "kernelSize",
        "coastlineBufferMeters",
    }, f"OpenAPI exposes {sorted(properties)}"

    # And the same names must be what the model accepts. Values sit inside the
    # declared bounds, so this checks naming rather than re-testing validation.
    wire_to_field: dict[str, tuple[str, Any]] = {
        "trainingCells": ("training_cells", 16),
        "guardCells": ("guard_cells", 4),
        "thresholdFactor": ("threshold_factor", 3.5),
        "minPixels": ("min_pixels", 3),
        "maxPixels": ("max_pixels", 1000),
        "speckleFilter": ("speckle_filter", "lee"),
        "kernelSize": ("kernel_size", 3),
        "coastlineBufferMeters": ("coastline_buffer_meters", 150),
    }
    for wire, (field, value) in wire_to_field.items():
        overrides = CfarConfig.model_validate({wire: value}).overrides()
        assert overrides == {field: value}, (
            f"{wire} did not normalise to {field}: got {overrides}"
        )


def test_generated_contract_text_matches_openapi() -> None:
    """The emitted TypeScript names, read back out of the file.

    Parsed from the generated text rather than trusted from the model, so this
    also covers the exporter itself rather than only Pydantic.
    """
    contract = _contract()
    block = contract.split("export interface CfarConfig", 1)[1].split("}", 1)[0]
    emitted = set(re.findall(r"readonly (\w+)\??:", block))
    expected = set(_defs()["CfarConfig"]["properties"])
    assert emitted == expected, f"contract.ts has {sorted(emitted)}, OpenAPI has {sorted(expected)}"


def test_scene_id_is_generated_as_the_wire_name() -> None:
    """The field that returned 422 when the interface invented it."""
    properties = _defs()["ScanCreateRequest"]["properties"]
    assert "sceneId" in properties
    assert "scene_id" not in properties


# ------------------------------------------- the frontend consumes the types


def test_client_types_its_request_body() -> None:
    """An inline literal is what let `scene_id` through unchecked.

    The regression: `api.post('/api/scans', { bbox, ...(sceneId ? { scene_id: sceneId } : {}) })`
    type-checked perfectly and returned 422 at runtime, because the field did not
    exist on the schema.
    """
    source = CLIENT.read_text(encoding="utf-8")
    assert "ScanCreateRequest" in source, "client.ts does not reference the generated request type"

    start = source.index("export async function startScan")
    body = source[start : source.index("\n}", start)]
    assert ": ScanCreateRequest" in body, (
        "startScan must annotate its body with the generated ScanCreateRequest"
    )
    # Checked as an object KEY, not as a substring: the function's comment
    # deliberately names `scene_id` while explaining why it is wrong, and a
    # naive substring search would fail on its own explanation.
    assert not re.search(r"\bscene_id\s*[,:]", body), (
        "startScan sends `scene_id`, which the schema rejects; the declared field is `sceneId`"
    )
    assert re.search(r"\bsceneId\b", body), "startScan must forward the declared `sceneId` field"


def test_cfar_params_are_typed_against_the_contract() -> None:
    """`toCfarRequestParams` must return the generated type, not a loose record.

    A ``Record<string, number | string>`` return type accepts any key the backend
    happens to use, which is exactly how the casing drift survived.
    """
    source = CFAR_TS.read_text(encoding="utf-8")
    start = source.index("export function toCfarRequestParams")
    signature = source[start : source.index("{", source.index(")", start))]
    assert "CfarConfigContract" in signature, (
        "toCfarRequestParams must be typed against the generated contract"
    )
    assert "Record<string," not in signature, (
        "a Record<string, ...> return type accepts any field name and cannot detect drift"
    )
    assert "CfarConfig as CfarConfigContract" in source, (
        "cfar.ts must import the generated contract rather than redeclaring the shape"
    )


def test_no_hand_written_cfar_shape_duplicates_the_contract() -> None:
    """`interface CfarConfig` in cfar.ts is the internal model, which is allowed.

    What is not allowed is a second declaration of the WIRE shape. So the check is
    that the internal model is not typed as the contract and vice versa.
    """
    source = CFAR_TS.read_text(encoding="utf-8")
    internal = source.split("export interface CfarConfig {", 1)[1].split("\n}", 1)[0]
    for field in re.findall(r"readonly (\w+):", internal):
        assert field in set(_defs()["CfarConfig"]["properties"]), (
            f"cfar.ts declares {field!r}, which the generated contract does not have"
        )


def test_request_model_forbids_unknown_keys() -> None:
    """The runtime half: a typo must be a 422, not a silent no-op."""
    assert ScanCreateRequest.model_config.get("extra") == "forbid"
    assert CfarConfig.model_config.get("extra") == "forbid"


def test_openapi_marks_request_bodies_closed() -> None:
    """`additionalProperties: false` is what makes the generated TS interface honest.

    Without it the schema permits fields the backend will reject, and a generated
    type would advertise a request the API cannot accept.
    """
    defs = _defs()
    for name in ("ScanCreateRequest", "CfarConfig"):
        assert defs[name].get("additionalProperties") is False, (
            f"{name} is not closed in OpenAPI"
        )


def test_the_generator_walk_finds_what_the_gate_expects() -> None:
    """Guards the guard: if the walk silently found nothing, every test above
    would pass vacuously."""
    names = _request_schema_names()
    assert "ScanCreateRequest" in names, f"walk found {sorted(names)}"
    assert json.dumps(sorted(names)), "walk produced nothing"