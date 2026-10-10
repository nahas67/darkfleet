"""Independent, browser-free acceptance provenance and hook-order regressions.

This suite creates only temporary repositories, Rollup bundles and FastAPI
storage. It makes no claim about a real sensor, GPU or delivered deployment.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "build-tools"))

from browser_harness_reverify import (
    MODULE_PROBES,
    SOURCES,
    certify_browser_source_identity,
)
from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from fastapi.testclient import TestClient

# Executes the actual installed Rolldown native production hook runner with
# two ordinary plugins. The earlier hook awaits its file copy; the latter must
# see the completed copy before creating a simulated manifest.
ROLLDOWN_PROBE = r"""
import { rolldown } from 'rolldown';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[1], variant = process.argv[2];
const target = path.join(root, 'copied-cesium.bin');
const events = [];
const producer = {
  name: 'cesium-analog',
  async closeBundle() {
    events.push('copy-start');
    await new Promise(resolve => setTimeout(resolve, 45));
    await fs.writeFile(target, 'CESIUM-COPY-COMPLETE');
    events.push('copy-done');
  },
};
const reader = async () => {
  events.push('manifest-start');
  const contents = await fs.readFile(target, 'utf8');
  if (contents !== 'CESIUM-COPY-COMPLETE') throw new Error('manifest raced copy');
  events.push('manifest-done');
};
const consumer = variant === 'post'
  ? { name: 'identity-analog', closeBundle: {
      order: 'post', sequential: true, handler: reader } }
  : { name: 'identity-analog', closeBundle: reader };
const output = await rolldown({
  input: path.join(root, 'main.js'),
  plugins: [producer, consumer],
});
await output.write({ dir: path.join(root, 'out'), format: 'es' });
await output.close();
if (events.join(',') !== 'copy-start,copy-done,manifest-start,manifest-done') {
  throw new Error('unexpected closeBundle ordering: ' + events.join(','));
}
console.log(JSON.stringify({ variant, events, success: true }));
"""


def certified_smoke_receipt() -> dict:
    """The minimum complete, stable source provenance for a browser smoke PASS."""
    return {
        "status": "BROWSER_EXECUTED",
        "gitHead": "a" * 40,
        "gitHeadAfter": "a" * 40,
        "sourceSha256Before": {name: "b" * 64 for name in SOURCES},
        "sourceSha256After": {name: "b" * 64 for name in SOURCES},
        "moduleProbe": {
            path: {"status": 200, "hasExpectedMarker": True,
                   "rawSha256MatchesDisk": True}
            for path in MODULE_PROBES
        },
    }


def test_browser_smoke_stable_source_and_complete_raw_modules_can_pass() -> None:
    record = certified_smoke_receipt()
    assert certify_browser_source_identity(record) == []
    assert record["status"] == "BROWSER_EXECUTED"
    assert record["sourceIdentityFailures"] == []


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        ("new_head", "GIT_HEAD_CHANGED"),
        ("unavailable_head", "GIT_HEAD_UNAVAILABLE"),
        ("midrun_change", "SOURCE_CHANGED_DURING_RUN"),
        ("missing_source_digest", "SOURCE_HASH_SET_INCOMPLETE"),
        ("raw_probe_missing", "SERVED_VITE_SOURCE_UNVERIFIED"),
        ("raw_probe_mismatch", "SERVED_VITE_SOURCE_UNVERIFIED"),
    ],
)
def test_browser_smoke_source_drift_refuses_prior_pass(
    mutation: str, reason: str,
) -> None:
    record = certified_smoke_receipt()
    if mutation == "new_head":
        record["gitHeadAfter"] = "c" * 40
    elif mutation == "unavailable_head":
        record["gitHeadAfter"] = "UNKNOWN"
    elif mutation == "midrun_change":
        record["sourceSha256After"]["src/command/OperationRail.tsx"] = "c" * 64
    elif mutation == "missing_source_digest":
        del record["sourceSha256Before"]["src/main.tsx"]
    elif mutation == "raw_probe_missing":
        record["moduleProbe"].clear()
    elif mutation == "raw_probe_mismatch":
        record["moduleProbe"][MODULE_PROBES[0]]["rawSha256MatchesDisk"] = False
    failures = certify_browser_source_identity(record)
    assert reason in failures
    assert record["status"] == "PARTIAL_OR_BLOCKED"
    assert reason in record["reason"]


@pytest.mark.parametrize("variant", ["ordinary", "post"])
def test_installed_rolldown_awaits_prior_close_bundle_copy(
    tmp_path: Path, variant: str,
) -> None:
    """The actual bundler must await async Cesium-like copying, not just type claims."""
    (tmp_path / "main.js").write_text("export const real = 1;\n", encoding="utf-8")
    result = subprocess.run(
        ["node", "--input-type=module", "--eval", ROLLDOWN_PROBE,
         str(tmp_path), variant],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, (
        f"Rolldown {variant} closeBundle ordering unproven: "
        f"{result.stderr[-2500:]} {result.stdout[-1000:]}"
    )
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["success"] is True
    assert payload["events"] == [
        "copy-start", "copy-done", "manifest-start", "manifest-done",
    ]


def test_operator_claim_of_calibrated_sar_never_becomes_sensor_evidence(
    tmp_path: Path,
) -> None:
    """Operator language and payload fields cannot authenticate a scan."""
    app = create_app(Settings(data_dir=str(tmp_path), log_level="WARNING"))
    with TestClient(app) as client:
        fraudulent = client.post("/api/investigations", json={
            "title": "Analyst assertion only",
            "sensor_evidence": {"calibration_verified": True, "runtime_mode": "REAL"},
        })
        assert fraudulent.status_code == 422
        case = client.post("/api/investigations", json={
            "title": "Analyst assertion only",
        })
        assert case.status_code == 201, case.text
        case_id = case.json()["id"]
        injection = client.post(
            f"/api/investigations/{case_id}/annotations",
            json={"content": "Claim: calibrated Sentinel-1 VV, real AIS 123456789",
                  "calibration_verified": True, "synthetic": False},
        )
        assert injection.status_code == 422
        note = client.post(
            f"/api/investigations/{case_id}/annotations",
            json={"content": "Claim: calibrated Sentinel-1 VV, real AIS 123456789"},
        )
        assert note.status_code == 201, note.text
        report = client.get(f"/api/investigation-reports/{case_id}/json")
        assert report.status_code == 200, report.text
        body = report.json()
        assert body["source_status"] == "NO_SCAN_LINKED"
        assert body["sensor_evidence"]["metadata"] is None
        assert body["sensor_evidence"]["targets"] == []
        assert body["sensor_evidence"]["target_count"] is None
        assert len(body["operator_material"]["annotations"]) == 1
        assert body["operator_material"]["annotations"][0]["provenance"] == (
            "OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE"
        )
        assert "NO_SCAN_LINKED" in body["warnings"]
        assert client.get(f"/api/investigation-reports/{case_id}/pdf").status_code == 200


def test_unknown_nonlive_source_cannot_be_linked_as_real_scan(
    tmp_path: Path,
) -> None:
    """Known fixture identifiers have no default authority in an empty store."""
    with TestClient(create_app(Settings(data_dir=str(tmp_path), log_level="WARNING"))) as client:
        for fixture_scan_id in (
            "AIS-BROWSER-FIXTURE-NONLIVE",
            "DF-SYNTHETIC-TEST",
            "fixture_32648.tif",
        ):
            response = client.post("/api/investigations", json={
                "title": "Attempt to attach nonlive evidence",
                "scan_id": fixture_scan_id,
            })
            assert response.status_code == 404, (fixture_scan_id, response.text)
        assert client.get("/api/investigations").json()["investigations"] == []


def test_operator_uploaded_sensor_shaped_json_remains_unverified_after_restart(
    tmp_path: Path,
) -> None:
    """Upload metadata is operator material even when its bytes say REAL/verified."""
    filename = "sentinel1-calibrated.json"
    forged_bytes = json.dumps({
        "scene_id": "UNAUTHENTICATED_LOCAL_UPLOAD",
        "runtime_mode": "REAL",
        "synthetic": False,
        "calibration_verified": True,
        "provider": "sentinel-1",
        "ais_observations": [{"mmsi": "257000001", "source": "REAL_AIS"}],
    }).encode("utf-8")
    app = create_app(Settings(data_dir=str(tmp_path), log_level="WARNING"))
    with TestClient(app) as client:
        case = client.post("/api/investigations", json={"title": "Uploaded bytes unverified"})
        assert case.status_code == 201, case.text
        case_id = case.json()["id"]
        path = f"/api/investigations/{case_id}/attachments"
        uploaded = client.post(path, content=forged_bytes, headers={
            "X-Attachment-Filename": filename,
            "Content-Type": "application/json",
        })
        assert uploaded.status_code == 201, uploaded.text
        attachment = uploaded.json()
        assert attachment["provenance"] == "OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE"
        assert attachment["filename"] == filename
        assert attachment["size_bytes"] == len(forged_bytes)
        assert client.get(attachment["download_url"]).content == forged_bytes
        assert client.post(path, content=forged_bytes, headers={
            "X-Attachment-Filename": "not-a-real-satellite.tif",
            "Content-Type": "application/octet-stream",
        }).status_code == 415
        report = client.get(f"/api/investigation-reports/{case_id}/json")
        assert report.status_code == 200, report.text
        assert report.json()["source_status"] == "NO_SCAN_LINKED"
        assert report.json()["sensor_evidence"]["targets"] == []
        assert report.json()["sensor_evidence"]["metadata"] is None
    # A newly constructed app uses the same persisted case without acquiring
    # any sensor evidence from the uploaded bytes.
    with TestClient(create_app(Settings(data_dir=str(tmp_path), log_level="WARNING"))) as client:
        rows = client.get(path)
        assert rows.status_code == 200
        assert len(rows.json()["attachments"]) == 1
        assert rows.json()["attachments"][0]["provenance"] == (
            "OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE"
        )
        report = client.get(f"/api/investigation-reports/{case_id}/json")
        assert report.status_code == 200
        assert report.json()["source_status"] == "NO_SCAN_LINKED"
