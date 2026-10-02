"""CP15 API surface: /tracks, /patterns, /detectors, /targets/{id}/summary.

ADV-001..003, ADV-007/008, ADV-009..012.
"""

from __future__ import annotations

import re
import time
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings

DEMO_BBOX = [103.65, 1.1, 104.05, 1.4]


@pytest.fixture(scope="module")
def settings(tmp_path_factory: pytest.TempPathFactory) -> Settings:
    data_dir = tmp_path_factory.mktemp("darkfleet-cp15")
    conf = Settings(runtime_mode="DEMO", data_dir=str(data_dir))
    conf.log_level = "WARNING"
    return conf


@pytest.fixture(scope="module")
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def _await_terminal(client: TestClient, scan_id: str, timeout: float = 120.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        response = client.get(f"/api/scans/{scan_id}")
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        if body["terminal"]:
            return body
        if time.monotonic() > deadline:
            raise AssertionError(f"scan {scan_id} never finished; last state {body}")
        time.sleep(0.05)


@pytest.fixture(scope="module")
def scan_with_targets(client: TestClient) -> dict[str, Any]:
    """Two DEMO scans over the same AOI: enough history for the intel surfaces."""
    ids: list[str] = []
    for _ in range(2):
        started = client.post("/api/scans", json={"runtime_mode": "DEMO", "bbox": DEMO_BBOX})
        assert started.status_code == 202, started.text
        ids.append(str(started.json()["scan_id"]))
    return {"scan_ids": ids, "targets": _await_terminal(client, ids[-1])}


# ------------------------------------------------------------------ /detectors


def test_detectors_lists_cfar_as_the_shipped_baseline(client: TestClient) -> None:
    response = client.get("/api/detectors")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["default"] == "cfar"
    names = [d["name"] for d in body["detectors"]]
    assert names == ["cfar"]
    card = body["detectors"][0]
    assert card["kind"] == "CFAR"
    assert card["limitations"], "a detector must declare its limitations"
    assert card["validation_data"]
    assert card["weights_digest"] is None


def test_detectors_never_advertises_unvalidated_weights(client: TestClient) -> None:
    """ADV-008: nothing without weights and validation can appear here."""
    for detector in client.get("/api/detectors").json()["detectors"]:
        if detector["kind"] in {"ML", "ENSEMBLE"}:
            assert detector["weights_digest"], f"{detector['name']} has no weights digest"
            assert detector["validation_data"], f"{detector['name']} has no validation data"


# -------------------------------------------------------------------- /tracks


def test_tracks_endpoint_shape_and_honesty(client: TestClient, scan_with_targets: dict) -> None:
    response = client.get("/api/tracks")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["observations_considered"] > 0
    assert isinstance(body["track_count"], int)
    for track in body["tracks"]:
        assert track["track_id"].startswith("TRK-")
        assert track["confidence_statement"]
        assert 0.0 <= track["identity_strength"] <= 0.85
        statement = track["confidence_statement"].lower()
        assert "not confirmed" in statement or "not on geometry alone" in statement
        assert track["points"]


def test_tracks_never_link_a_detection_without_ais(client: TestClient) -> None:
    for track in client.get("/api/tracks").json()["tracks"]:
        for point in track["points"]:
            assert point["item_id"], "every track point names its source detection"


def test_tracks_on_empty_history_returns_zero_not_an_error(
    settings: Settings, tmp_path_factory: pytest.TempPathFactory
) -> None:
    empty = Settings(runtime_mode="DEMO", data_dir=str(tmp_path_factory.mktemp("empty")))
    empty.log_level = "WARNING"
    with TestClient(create_app(empty)) as fresh:
        body = fresh.get("/api/tracks").json()
        assert body["track_count"] == 0
        assert body["observations_considered"] == 0


# ------------------------------------------------------------------ /patterns


def test_patterns_endpoint_carries_hypothesis_confidence_and_unknowns(
    client: TestClient,
) -> None:
    response = client.get("/api/patterns")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["observations_considered"] > 0
    for pattern in body["patterns"]:
        assert pattern["pattern_id"].startswith("PAT-")
        assert pattern["observed"]
        assert pattern["hypothesis"]
        assert pattern["unknowns"], "every pattern must state what is not known"
        assert 0.0 <= pattern["confidence"] <= 1.0


def test_patterns_language_is_neutral(client: TestClient) -> None:
    forbidden = (
        "sanction",
        "evad",
        "illegal",
        "smuggl",
        "criminal",
        "dark vessel",
        "threat",
        "not transmitting",
    )
    body = client.get("/api/patterns").json()
    blob = str(body["patterns"]).lower() + str(body["note"]).lower()
    for word in forbidden:
        assert word not in blob, word


# -------------------------------------------------------------- /summary


def test_summary_returns_evidence_even_when_narrative_is_unavailable(
    client: TestClient, scan_with_targets: dict
) -> None:
    targets = client.get(f"/api/scans/{scan_with_targets['scan_ids'][-1]}/targets").json()["targets"]
    assert targets, "the demo scan produced no targets to summarise"
    target_id = str(targets[0]["id"])

    response = client.get(f"/api/targets/{target_id}/summary")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["target_id"] == target_id
    assert body["evidence"]["observed"]
    assert body["narrative"]["status"] in {"OK", "AI_UNAVAILABLE"}


def test_summary_default_narrative_is_valid_and_neutral(
    client: TestClient, scan_with_targets: dict
) -> None:
    targets = client.get(f"/api/scans/{scan_with_targets['scan_ids'][-1]}/targets").json()["targets"]
    response = client.get(f"/api/targets/{targets[0]['id']!s}/summary")
    narrative = response.json()["narrative"]
    assert narrative["status"] == "OK", narrative
    doc = narrative["document"]
    for section in ("observed", "hypotheses", "unknowns"):
        assert doc[section], f"{section} must not be empty"
    assert 0.0 <= doc["confidence"] <= 1.0
    assert doc["model"]["model_id"]


def test_summary_with_bad_model_id_still_returns_the_evidence(
    client: TestClient, scan_with_targets: dict
) -> None:
    targets = client.get(f"/api/scans/{scan_with_targets['scan_ids'][-1]}/targets").json()["targets"]
    response = client.get(f"/api/targets/{targets[0]['id']!s}/summary?model_id=nonsense")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["narrative"]["status"] == "AI_UNAVAILABLE"
    assert "auditable" in body["narrative"]["reason"]
    # ADV-012: the deterministic analysis is untouched by the narrative failure.
    assert body["evidence"]["observed"]
    assert body["classification"]


def test_summary_for_unknown_target_is_404(client: TestClient) -> None:
    response = client.get("/api/targets/DF-9999-T99/summary")
    assert response.status_code == 404
    assert response.json()["error"] == "UNKNOWN_TARGET"


def test_summary_language_never_accuses(
    client: TestClient, scan_with_targets: dict
) -> None:
    targets = client.get(f"/api/scans/{scan_with_targets['scan_ids'][-1]}/targets").json()["targets"]
    for target in targets:
        response = client.get(f"/api/targets/{target['id']!s}/summary")
        if response.status_code != 200:
            continue
        narrative = response.json()["narrative"]
        if narrative["status"] != "OK":
            continue
        blob = str(narrative["document"]).lower()
        for word in ("sanction", "dark vessel", "no transponder", "threat", "confirmed identity"):
            assert word not in blob, (target["id"], word)


def test_scan_id_shape_is_unchanged_by_the_new_endpoints(
    client: TestClient, scan_with_targets: dict
) -> None:
    for scan_id in scan_with_targets["scan_ids"]:
        assert re.fullmatch(r"DF-\d{4}", scan_id)