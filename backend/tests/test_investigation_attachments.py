"""Real HTTP investigation attachment lifecycle and isolated, adversarial storage tests."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from darkfleet.api import investigation_attachments as attachments
from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings


def _client(tmp_path):
    return TestClient(create_app(Settings(data_dir=str(tmp_path), log_level="WARNING")))


def _add(client, case_id, data=b"%PDF-1.7\nOperator report\n%%EOF", *,
         filename="report.pdf", mime="application/pdf"):
    return client.post(
        f"/api/investigations/{case_id}/attachments",
        content=data,
        headers={"X-Attachment-Filename": filename, "Content-Type": mime},
    )


def test_binary_roundtrip_restart_provenance_and_db_atomicity(tmp_path):
    contents = b"%PDF-1.7\nOperator-authored report; NO SENSOR EVIDENCE.\n%%EOF"
    with _client(tmp_path) as client:
        case = client.post("/api/investigations", json={"title": "Original"}).json()
        cid = case["id"]
        created = _add(client, cid, contents)
        assert created.status_code == 201, created.text
        item = created.json()
        assert item["provenance"] == "OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE"
        assert item["investigation_id"] == cid
        assert item["media_type"] == "application/pdf"
        assert item["sha256"] == hashlib.sha256(contents).hexdigest()
        assert item["size_bytes"] == len(contents)
        assert item["download_url"].startswith(f"/api/investigations/{cid}/")
        aid = item["id"]
        listing = client.get(f"/api/investigations/{cid}/attachments")
        assert listing.status_code == 200
        assert listing.json() == {"attachments": [item], "count": 1}
        assert client.get(f"/api/investigations/{cid}/attachments/{aid}").json() == item
        download = client.get(item["download_url"])
        assert download.status_code == 200
        assert download.content == contents
        assert download.headers["content-type"] == "application/octet-stream"
        assert download.headers["content-disposition"] == 'attachment; filename="report.pdf"'
        assert download.headers["cache-control"] == "no-store"
        assert download.headers["x-content-type-options"] == "nosniff"
        assert download.headers["content-security-policy"] == "sandbox"
        assert download.headers["x-darkfleet-content-sha256"] == item["sha256"]

        updated = client.put(f"/api/investigations/{cid}",
                             json={"title": "Retitled manually"}).json()
        assert updated["title"] == "Retitled manually"
        assert updated["id"] == cid and updated["scan_id"] is None
        assert client.put(f"/api/investigations/{cid}",
                          json={"title": "Invalid", "scan_id": "forged"}).status_code == 422
        assert client.get(f"/api/investigations/{cid}").json()["title"] == "Retitled manually"

    # A new independent app and connection must recover both metadata and bytes.
    with _client(tmp_path) as client:
        assert client.get(f"/api/investigations/{cid}").json()["title"] == "Retitled manually"
        assert client.get(f"/api/investigations/{cid}/attachments/{aid}").json() == item
        assert client.get(item["download_url"]).content == contents
        assert client.delete(f"/api/investigations/{cid}/attachments/{aid}").status_code == 204
        assert client.get(item["download_url"]).status_code == 404
        assert client.get(f"/api/investigations/{cid}/attachments").json()["count"] == 0
        assert client.delete(f"/api/investigations/{cid}/attachments/{aid}").status_code == 404

    # Bytes live only in the investigation SQLite file, not user-derived paths.
    assert (tmp_path / "investigations.sqlite3").is_file()
    assert not (tmp_path / "attachments").exists()
    assert not (tmp_path / "investigation_attachments").exists()


def test_rejects_path_traversal_active_content_and_malformed_bytes_without_receipts(tmp_path):
    with _client(tmp_path) as client:
        cid = client.post("/api/investigations", json={"title": "Safety"}).json()["id"]
        attempts = [
            ("../forged.pdf", "application/pdf", b"%PDF-1.7", 422),
            ("..\\forged.pdf", "application/pdf", b"%PDF-1.7", 422),
            ("C:\\secret.pdf", "application/pdf", b"%PDF-1.7", 422),
            ("file://file.pdf", "application/pdf", b"%PDF-1.7", 422),
            ("name\r\nX-Test:1.pdf", "application/pdf", b"%PDF-1.7", 422),
            ("../a.txt", "text/plain", b"valid", 422),
            ("attack.html", "text/html", b"<script>x()</script>", 415),
            ("vector.svg", "image/svg+xml", b"<svg/>", 415),
            ("script.js", "application/octet-stream", b"alert(1)", 415),
            ("evil.exe", "application/octet-stream", b"MZ", 415),
            ("report.pdf", "application/pdf", b"<html>evil</html>", 422),
            ("image.png", "image/png", b"not PNG", 422),
            ("photo.jpg", "image/jpeg", b"not JPEG", 422),
            ("scan.pdf", "text/plain", b"%PDF-1.7", 415),
            ("comment.txt", "text/plain", b"bad\x00text", 422),
            ("data.json", "application/json", b"{bad", 422),
            ("data.json", "application/json", b"\xff", 422),
            ("empty.txt", "text/plain", b"", 422),
        ]
        for filename, mime, data, expected in attempts:
            response = _add(client, cid, data, filename=filename, mime=mime)
            assert response.status_code == expected, (filename, response.text)
        assert client.get(f"/api/investigations/{cid}/attachments").json()["count"] == 0

        # Successful text/JSON stays operator provenance, even if the title
        # contains claims of sensor authority.
        payload = json.dumps({"provenance": "REAL", "claim": "satellite confirmed"}).encode()
        response = _add(
            client, cid, payload, filename="source.json", mime="application/json",
        )
        assert response.status_code == 201, response.text
        assert response.json()["provenance"] == "OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE"
        assert client.get(response.json()["download_url"]).content == payload


def test_missing_case_cross_case_scoping_case_cascade_and_integrity_failure(tmp_path):
    with _client(tmp_path) as client:
        c1 = client.post("/api/investigations", json={"title": "One"}).json()["id"]
        c2 = client.post("/api/investigations", json={"title": "Two"}).json()["id"]
        assert _add(client, "absent", b"%PDF-1.4").status_code == 404
        made = _add(client, c1)
        assert made.status_code == 201
        aid = made.json()["id"]
        assert client.get(f"/api/investigations/{c2}/attachments/{aid}").status_code == 404
        assert client.get(f"/api/investigations/{c2}/attachments/{aid}/content").status_code == 404
        assert client.delete(f"/api/investigations/{c2}/attachments/{aid}").status_code == 404

        with sqlite3.connect(tmp_path / "investigations.sqlite3") as conn:
            conn.execute("UPDATE investigation_attachments SET data=? WHERE id=?",
                         (b"%PDF-TAMPER", aid))
        corrupted = client.get(made.json()["download_url"])
        assert corrupted.status_code == 409
        assert corrupted.json()["status"] == "ATTACHMENT_INTEGRITY_FAILURE"
        # Metadata may still be listed with original immutable recorded digest.
        assert client.get(f"/api/investigations/{c1}/attachments").json()["count"] == 1
        assert client.delete(f"/api/investigations/{c1}").status_code == 204
        assert client.get(f"/api/investigations/{c1}/attachments").status_code == 404
    with sqlite3.connect(tmp_path / "investigations.sqlite3") as conn:
        assert conn.execute("SELECT COUNT(*) FROM investigation_attachments").fetchone()[0] == 0


def test_duplicate_hash_rejected_with_no_second_receipt_or_cross_case_leak(tmp_path):
    with _client(tmp_path) as client:
        c1 = client.post("/api/investigations", json={"title": "One"}).json()["id"]
        c2 = client.post("/api/investigations", json={"title": "Two"}).json()["id"]
        source = b"%PDF-1.7\nCanary\n%%EOF"
        first = _add(client, c1, source)
        assert first.status_code == 201
        duplicate = _add(client, c1, source, filename="another.pdf")
        assert duplicate.status_code == 409
        assert duplicate.json()["status"] == "ATTACHMENT_ALREADY_EXISTS"
        assert client.get(f"/api/investigations/{c1}/attachments").json()["count"] == 1
        other_case = _add(client, c2, source)
        assert other_case.status_code == 201
        assert other_case.json()["id"] != first.json()["id"]
        assert client.get(f"/api/investigations/{c2}/attachments").json()["count"] == 1


def test_size_limit_and_case_quota_do_not_write_partial_entries(tmp_path, monkeypatch):
    monkeypatch.setattr(attachments, "MAX_ATTACHMENT_BYTES", 13)
    monkeypatch.setattr(attachments, "MAX_ATTACHMENTS_PER_CASE", 2)
    monkeypatch.setattr(attachments, "MAX_CASE_BYTES", 15)
    with _client(tmp_path) as client:
        cid = client.post("/api/investigations", json={"title": "Budget"}).json()["id"]
        too_large = _add(client, cid, b"A" * 15, filename="data.txt", mime="text/plain")
        assert too_large.status_code == 413
        assert too_large.json()["status"] == "ATTACHMENT_TOO_LARGE"
        assert client.get(f"/api/investigations/{cid}/attachments").json()["count"] == 0
        assert _add(client, cid, b"first123", filename="a.txt", mime="text/plain").status_code == 201
        assert _add(client, cid, b"second123", filename="b.txt", mime="text/plain").status_code == 409
        assert _add(client, cid, b"second", filename="b.txt", mime="text/plain").status_code == 201
        assert _add(client, cid, b"more", filename="c.txt", mime="text/plain").status_code == 409
        assert client.get(f"/api/investigations/{cid}/attachments").json()["count"] == 2


def test_streamed_upload_without_content_length_cannot_exceed_bound(tmp_path, monkeypatch):
    monkeypatch.setattr(attachments, "MAX_ATTACHMENT_BYTES", 12)
    with _client(tmp_path) as client:
        cid = client.post("/api/investigations", json={"title": "Streaming"}).json()["id"]

        def chunks():
            yield b"abc123"
            yield b"def456"
            yield b"overflow"

        response = client.post(
            f"/api/investigations/{cid}/attachments",
            content=chunks(),
            headers={"X-Attachment-Filename": "source.txt", "Content-Type": "text/plain"},
        )
        assert response.status_code == 413, response.text
        assert client.get(f"/api/investigations/{cid}/attachments").json()["count"] == 0


def test_filename_matching_external_symlink_never_opens_or_overwrites_target(tmp_path):
    outside = tmp_path / "external-canary.txt"
    outside.write_text("UNMODIFIED OUTSIDE CONTENT", encoding="utf-8")
    symlink = tmp_path / "outside.txt"
    try:
        symlink.symlink_to(outside)
    except (OSError, NotImplementedError):
        # Windows developer profiles may lack Create symbolic links privilege;
        # no symlink is required by the attachment storage implementation.
        pass
    with _client(tmp_path) as client:
        cid = client.post("/api/investigations", json={"title": "Symlink"}).json()["id"]
        response = _add(
            client, cid, b"operator binary body", filename="outside.txt", mime="text/plain",
        )
        assert response.status_code == 201
        assert client.get(response.json()["download_url"]).content == b"operator binary body"
    assert outside.read_text(encoding="utf-8") == "UNMODIFIED OUTSIDE CONTENT"
    if symlink.is_symlink():
        assert os.path.samefile(symlink, outside)


def test_cross_connection_atomic_count_quota_under_parallel_post(tmp_path, monkeypatch):
    monkeypatch.setattr(attachments, "MAX_ATTACHMENTS_PER_CASE", 3)
    with _client(tmp_path) as client:
        cid = client.post("/api/investigations", json={"title": "Concurrent"}).json()["id"]

    def submit(i: int) -> int:
        with _client(tmp_path) as client:
            return _add(client, cid, f"author {i}".encode(), filename=f"n{i}.txt",
                        mime="text/plain").status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        statuses = list(pool.map(submit, range(6)))
    assert sorted(statuses) == [201, 201, 201, 409, 409, 409]
    with _client(tmp_path) as client:
        listing = client.get(f"/api/investigations/{cid}/attachments").json()
        assert listing["count"] == 3
        for item in listing["attachments"]:
            blob = client.get(item["download_url"]).content
            assert hashlib.sha256(blob).hexdigest() == item["sha256"]


def test_invalid_title_update_never_changes_original_case_identity(tmp_path):
    with _client(tmp_path) as client:
        cid = client.post("/api/investigations", json={"title": "Keep"}).json()["id"]
        endpoint = f"/api/investigations/{cid}"
        assert client.put(endpoint, json={"title": "  "}).status_code == 422
        assert client.put(endpoint, json={"title": "a" * 121}).status_code == 422
        assert client.put("/api/investigations/absent",
                          json={"title": "Hello"}).status_code == 404
        renamed = client.put(endpoint, json={"title": " Revised "})
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "Revised"
        assert renamed.json()["id"] == cid and renamed.json()["scan_id"] is None


def test_report_metadata_manifest_updates_after_attach_delete_and_restart(tmp_path):
    blob = b"%PDF-1.4\nOPERATOR-BINARY-CANARY\n%%EOF"
    with _client(tmp_path) as client:
        cid = client.post("/api/investigations", json={"title": "Report linkage"}).json()["id"]
        report_url = f"/api/investigation-reports/{cid}/json"
        before = client.get(report_url).json()
        assert before["source_status"] == "NO_SCAN_LINKED"
        assert "attachments" not in before["operator_material"]
        entry = _add(client, cid, blob, filename="operator.pdf").json()
        attached = client.get(report_url)
        assert attached.status_code == 200
        body = attached.json()
        manifest = body["operator_material"]["attachments"]
        assert len(manifest) == 1
        assert manifest[0] == {
            "id": entry["id"], "filename": "operator.pdf",
            "media_type": "application/pdf", "size_bytes": len(blob),
            "sha256": hashlib.sha256(blob).hexdigest(),
            "created_at": entry["created_at"],
            "provenance": "OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE",
        }
        assert body["source_status"] == "NO_SCAN_LINKED"
        assert blob.decode() not in attached.text
        assert body["content_sha256"] != before["content_sha256"]
        pdf = client.get(f"/api/investigation-reports/{cid}/pdf")
        assert pdf.status_code == 200
        assert b"operator.pdf" in pdf.content
        assert manifest[0]["sha256"].encode() in pdf.content
        assert b"OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE" in pdf.content
        assert b"OPERATOR-BINARY-CANARY" not in pdf.content

    with _client(tmp_path) as client:
        assert client.get(report_url).json() == body
        assert client.delete(f"/api/investigations/{cid}/attachments/{entry['id']}").status_code == 204
        after = client.get(report_url).json()
        assert "attachments" not in after["operator_material"]
        assert after["content_sha256"] == before["content_sha256"]


def test_report_legacy_case_db_without_attachment_schema_stays_readable(tmp_path):
    with _client(tmp_path) as client:
        cid = client.post("/api/investigations", json={"title": "Old"}).json()["id"]
    with sqlite3.connect(tmp_path / "investigations.sqlite3") as conn:
        conn.execute("DROP TABLE investigation_attachments")
    # Report is read only: reading old schema must not migrate or create tables.
    from darkfleet.investigation_reports import build_report
    from darkfleet.storage.runs import run_store_for_data_dir

    report = build_report(
        data_dir=tmp_path, store=run_store_for_data_dir(tmp_path), case_id=cid,
    )
    assert "attachments" not in report["operator_material"]
    with sqlite3.connect(tmp_path / "investigations.sqlite3") as conn:
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name='investigation_attachments'"
        ).fetchone() is None
