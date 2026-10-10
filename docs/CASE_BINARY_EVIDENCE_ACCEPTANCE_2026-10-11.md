# Case binary evidence attachment — local backend implementation and acceptance

**Date:** 2026-10-11. **Base HEAD inspected:** `b5bdc675480ad7cc6ff78b3c81fcb0534065bad7`. **Provenance:** `OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE`, unconditionally. This is user-submitted *operator material*, never a measured satellite pass, AIS transmission, target classification, or provider confirmation.

## Production contract

Under the existing `/api/investigations` router (without modifying the shared app factory):

| Method/path | Contract |
| --- | --- |
| `POST /{case_id}/attachments` | Stream **raw binary request body**, with required `X-Attachment-Filename: name.pdf` and matching `Content-Type: application/pdf`; returns 201 attachment metadata |
| `GET /{case_id}/attachments` | Case-scoped list of metadata, oldest first; never returns bytes |
| `GET /{case_id}/attachments/{attachment_id}` | One metadata receipt |
| `GET /{case_id}/attachments/{attachment_id}/content` | SHA/size verified byte download with attachment disposition, `application/octet-stream`, `nosniff`, CSP sandbox, no-store |
| `DELETE /{case_id}/attachments/{attachment_id}` | Atomic removal of bytes and metadata, 204 |
| `PUT /{case_id}` | Separate case title update, `{"title":"..."}` only; case ID and scan link immutable |

**Upload format is raw body, not multipart:** a browser submits `fetch(path, {method:'POST', headers:{'X-Attachment-Filename': file.name, 'Content-Type': file.type || 'application/octet-stream'}, body: file})`. Supported filename extensions: PDF, PNG, JPEG, TXT, CSV and JSON; PNG/JPEG/PDF header bytes and text UTF-8 (and JSON structure where applicable) are checked before storage. The declared media type must match filename or be `application/octet-stream`. No user-supplied MIME becomes an inline response. Filenames are a narrow 1–120 ASCII allowlist; slash, backslash, colon, CRLF, hidden path segments, reserved Windows device names and active HTML/SVG/scripts/executables are rejected.

The 201 metadata includes `id`, `investigation_id`, `filename`, `media_type`, `size_bytes`, `sha256`, `created_at`, `download_url`, and literal `provenance='OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE'`. One file is **at most 8 MiB**; one case at most **32 files / 64 MiB**. Duplicate bytes **within one case** return 409 `ATTACHMENT_ALREADY_EXISTS`; another case can independently store the same bytes without receiving access to the first case's receipt.

## Storage and integrity

The existing `investigations.sqlite3` holds both the original bytes (SQLite BLOB) and the metadata in the same transaction. This is an additive `CREATE TABLE IF NOT EXISTS investigation_attachments` with an FK to the parent case, cascade deletion, an index for case enumeration and a unique case+SHA index. No attacker-derived filesystem path is constructed or opened. There are no binary file paths, symlink traversals, arbitrary file URLs or remote fetches; external HTTP/SSRF is not a feature of this endpoint. A browser filename matching an existing symlink is merely an ASCII metadata string: never opened as a path. **SQLite transaction commit is the atomic file+receipt write**, not a two-stage temp-file/rename. `BEGIN IMMEDIATE` serializes count/byte quota reads with inserts across independent SQLite connections and API processes (SQLite locks are OS-mediated). Upload errors leave no partial metadata and no separately orphaned binary file. Read responses recheck both persisted byte count and SHA-256 and return 409 `ATTACHMENT_INTEGRITY_FAILURE` on corruption. Case deletion cascades bytes and rows.

The service remains the existing **loopback-local, unauthenticated** DarkFleet API. There is no per-human login/role system or capability token in the existing app; case scoping is enforced by SQLite ID, not by a new authorization identity. Deploying this mutable service on a public network is **not approved by this change**; keep the API on `127.0.0.1` or add independent authentication/reverse-proxy protections first. A hostile process with local filesystem write access to the trusted data root could still tamper with SQLite directly. This storage design rules out *request-derived* traversal/reparse-point following; it does not claim to defeat an OS-level administrator swapping the configured data root or SQLite file. Full deployment threat-modeling is separate from this local capability.

## Canonical reports

`backend/darkfleet/investigation_reports.py` projects a bounded per-case `operator_material.attachments` manifest into canonical report JSON: attachment ID, safe name, MIME, size, SHA-256, creation time and explicit operator provenance. The PDF includes the same readable receipt and hash. **Neither JSON nor PDF contains the BLOB bytes**; the user downloads bytes separately and checks the SHA-256. Report source status `NO_SCAN_LINKED` stays unchanged by adding any file; binaries never manufacture a persisted REAL scan. Reports from historical DBs without this additive table still render successfully, without schema mutation by the report reader.

For a case with **zero** attachments the optional `operator_material.attachments` key is omitted, rather than inserted as an empty array: this keeps the prior canonical JSON and SHA-256 **unchanged** for historical reports whose evidence did not change. The PDF reader treats the absent key as zero attachments. A case with one or more files receives the manifest and a changed canonical content hash.

## Verification

The scope includes focused `backend/tests/test_investigation_attachments.py` and existing investigation/report/geometry/restart suites, all using unique temporary data roots. Tests cover browser-style raw-body POST, SQLite restart, checksum/content headers, cross-case denial, cascade, missing case, malformed filenames/path/URL escapes, MIME and magic mismatch, invalid UTF-8/JSON, empty and oversized payloads, stream exceeding bound without a Content-Length, per-case byte/count quotas, duplicate hash, concurrent independent application connections, text named like an existing symlink, report manifest/hash/no BLOB, PDF receipt, legacy schema and title update invariants.

All request bodies in tests are explicitly fabricated **operator-authored test attachments**; none is represented as actual SAR/AIS/earth-observation data. The API fixture receipt and report do not certify upstream evidentiary authenticity.

**Executed local gates (before browser/UI integration):**

- `python -m pytest -q backend/tests/test_investigation_attachments.py backend/tests/test_investigation_reports.py backend/tests/test_investigations.py backend/tests/test_investigation_geometry.py backend/tests/test_restart_workflows_reverify.py` — **41 passed / 0 failed**, including two newly added streamed-body and symlink-name regressions.
- `python -m ruff check backend/darkfleet/api/investigations.py backend/darkfleet/api/investigation_attachments.py backend/darkfleet/investigation_reports.py backend/tests/test_investigation_attachments.py` — **PASS**.
- `git diff --check` on modified tracked owned code — **PASS**.
- `create_app()` routes were inspected after the new router inclusion and all five attachment endpoint method/path combinations plus case title PUT were registered, without changing the shared app factory.

**Browser UI acceptance is separate:** worker-3 owns the frontend file input/list/download controls and their tests. This backend lane does not claim real Chrome clicks or upload UX verification without a separate browser execution. Independent full-suite and contract-generation checkpoints remain prime-owned.
