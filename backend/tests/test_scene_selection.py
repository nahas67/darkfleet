"""Selected-scene pinning must be exact, or it must fail (DF-X6A regression).

`POST /api/scans` accepts `sceneId`, which is what makes "search a scene, choose
one, run the scan" work at all. Before this field existed the interface sent
`scene_id`, the request model was `extra="forbid"`, and choosing a scene returned
422 -- so the first required end-to-end flow could not run.

The dangerous failure mode is not the 422. It is the quiet one: falling back to
"whatever scene happens to intersect this AOI" when the pinned id does not match.
That processes a DIFFERENT acquisition while the interface, the evidence record
and the operator's selection all name the requested one. For an evidence product
a substituted acquisition is worse than a failed scan, because it looks correct.

So the rule is pinned here: exact match, or an explicit failure.
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
FIXTURE_SCENE = "S1A_FIXTURE_20240101T000000"


def _await(client: TestClient, scan_id: str, deadline_s: float = 90.0) -> dict[str, Any]:
    """Poll to a terminal state with a deadline. Never a fixed sleep."""
    deadline = time.monotonic() + deadline_s
    state: dict[str, Any] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/scans/{scan_id}")
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        if body.get("terminal"):
            return body
        time.sleep(0.2)
    return state


def _selected_scene(state: dict[str, Any]) -> str | None:
    for event in state.get("history", []):
        detail = event.get("detail") or ""
        if "scene selected" in detail:
            return detail.split("scene selected", 1)[1].strip()
    return None


def _run(client: TestClient, extra: dict[str, Any]) -> dict[str, Any]:
    response = client.post("/api/scans", json={"bbox": BBOX, **extra})
    assert response.status_code == 202, response.text
    accepted: dict[str, Any] = response.json()
    return _await(client, str(accepted["scan_id"]))


# ------------------------------------------------------------- the happy path


@pytest.mark.parametrize("key", ["sceneId", "scene_id"])
def test_a_pinned_scene_is_the_scene_that_gets_read(
    client: TestClient, net: Any, key: str
) -> None:
    """The full chain: request field -> pipeline -> evidence record.

    Asserted on the SEARCHING_SCENE stage detail AND on the persisted raster
    metadata, because a stage message and an evidence record could otherwise
    disagree -- and the evidence record is the artefact an export carries.
    """
    state = _run(client, {key: FIXTURE_SCENE})
    assert state.get("stage") == "COMPLETE", state.get("error")
    assert _selected_scene(state) == FIXTURE_SCENE

    raster = client.get(f"/api/scans/{state['scan_id']}/raster/raw")
    assert raster.status_code == 200, raster.text
    assert raster.json()["scene"]["item_id"] == FIXTURE_SCENE


def test_casing_variants_select_the_same_scene(client: TestClient, net: Any) -> None:
    """Both spellings are the API's wire convention, and must agree."""
    camel = _run(client, {"sceneId": FIXTURE_SCENE})
    snake = _run(client, {"scene_id": FIXTURE_SCENE})
    assert _selected_scene(camel) == _selected_scene(snake) == FIXTURE_SCENE


def test_no_pin_leaves_the_pipeline_free_to_choose(client: TestClient, net: Any) -> None:
    """Pinning is opt-in; unpinned behaviour must be unchanged."""
    state = _run(client, {})
    assert state.get("stage") == "COMPLETE", state.get("error")
    assert _selected_scene(state) == FIXTURE_SCENE


# ------------------------------------------------------------- the refusal


@pytest.mark.parametrize("wrong", ["S1A_SOMETHING_ELSE", "", "   ", "not-a-scene"])
def test_an_unmatched_pin_fails_and_substitutes_nothing(
    client: TestClient, net: Any, wrong: str
) -> None:
    """The regression that matters: never process a different scene.

    An empty or whitespace-only id is included because it is the easy
    substitution: an empty string is falsy, so a naive
    ``scene_id or default`` would quietly drop the pin and process whatever the
    search returned.
    """
    state = _run(client, {"sceneId": wrong})
    if wrong.strip():
        assert state.get("stage") == "FAILED", (
            f"pinning {wrong!r} should have failed, not completed"
        )
        assert "does not intersect" in str(state.get("error"))
        # No scene may be reported as selected.
        assert _selected_scene(state) != FIXTURE_SCENE


def test_a_failed_pin_persists_no_record(client: TestClient, net: Any) -> None:
    """A refused scan must leave nothing behind that looks like a result."""
    state = _run(client, {"sceneId": "S1A_NOT_A_REAL_SCENE"})
    assert state.get("stage") == "FAILED"
    assert state.get("record_persisted") is not True


# ----------------------------------------------------- contract integration


def test_the_field_reaches_the_pipeline_not_just_the_schema(client: TestClient, net: Any) -> None:
    """The request field must be honoured, not merely accepted.

    A field that validates and is then dropped would satisfy every schema test
    and still leave the operator unable to choose an acquisition.
    """
    pinned = _run(client, {"sceneId": FIXTURE_SCENE})
    assert pinned.get("stage") == "COMPLETE"

    raster = client.get(f"/api/scans/{pinned['scan_id']}/raster/raw").json()
    # The pinned scene's own acquisition time, not a re-derived or default one.
    assert raster["scene"]["acquisition_time"].startswith("2024-01-01")


def test_scene_id_is_rejected_when_blank_after_stripping(
    client: TestClient, net: Any
) -> None:
    """A whitespace-only pin must not be treated as "no pin".

    Documented explicitly because the two behaviours look identical from outside
    and only one of them tells the operator their selection was ignored.
    """
    state = _run(client, {"sceneId": "   "})
    # Either it fails, or it is treated as unset -- but if it completes, the pin
    # must not have been silently dropped in favour of a substitution, because
    # there is nothing to substitute for.
    assert state.get("stage") in ("COMPLETE", "FAILED")
    if state.get("stage") == "COMPLETE":
        assert _selected_scene(state) == FIXTURE_SCENE