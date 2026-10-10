# Case attachment and operator settings real-browser acceptance

**Date:** 2026-10-11. **Owned harness:** `build-tools/case_attachment_settings_browser_e2e.py`. Execution must be through a **real Chrome browser** against independently started localhost FastAPI and Vite on **8015/5179**, with a unique disposable data root, zero HTTP response mocks, no live/synthetic sensor observations, all unrelated data and services untouched.

The harness reuses the existing proven offline child-process network guard. External HTTP/WebSocket requests are blocked in the browser and external DNS/TCP in backend. No user database under the repository's `data/` is read or written. The harness aborts when either dedicated loopback port is occupied and terminates only processes it started.

## Exact acceptance criteria and outcome

| Workflow | Expected production evidence | Status |
| --- | --- | --- |
| Case create/title update | Real browser POST 201; PUT 200; case ID and scan link invariant | **PENDING BROWSER SLOT** |
| Attachment upload | Browser file picker sends raw bytes; real POST 201, provenance `OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE`, source-derived SHA-256 | **PENDING BROWSER SLOT** |
| Listing/download | File appears under selected case; browser download exact original byte hash | **PENDING BROWSER SLOT** |
| Report JSON/PDF | Actual downloaded reports include filename/type/size/digest/operator provenance, no binary BLOB; canonical JSON hash verifies | **PENDING BROWSER SLOT** |
| Settings save | Real UI checkbox mutation, server PUT 200, revision increment, source status visible | **PENDING BROWSER SLOT** |
| Stale setting conflict | Independent real API write advances revision, old browser PUT returns genuine 409 and error shown | **PENDING BROWSER SLOT** |
| Settings reload/reset | UI reload authoritative revision; reset POST 200 increases revision and restores defaults | **PENDING BROWSER SLOT** |
| Backend restart and browser reopen | New owned backend PID and new browser page; case/title/file + exact binary/JSON checksums and settings revision restored | **PENDING BROWSER SLOT** |
| Attachment deletion/reopen | Real browser DELETE 204, refreshed and reopened inventory count 0 | **PENDING BROWSER SLOT** |
| Actual SAR/AIS source validation | No real provider data or source scan supplied | **NOT RUN — EXTERNAL SOURCE** |

## Independent backend evidence (not a browser substitute)

`python -m pytest -q backend/tests/test_investigation_attachments.py backend/tests/test_investigation_reports.py backend/tests/test_investigations.py backend/tests/test_investigation_geometry.py backend/tests/test_restart_workflows_reverify.py`: **41 passed / 0 failed** on the committed backend attachment implementation.

`python -m ruff check backend/darkfleet/api/investigations.py backend/darkfleet/api/investigation_attachments.py backend/darkfleet/investigation_reports.py backend/tests/test_investigation_attachments.py`: **PASS**.

The new Chrome acceptance script compiles and passes Ruff. **Do not infer browser PASS from these tests or this document.** After the GPU worker releases Chrome, run the harness, update this document with its real outcome, source hashes, backend PIDs, verified SHA-256s, HTTP statuses, remaining gaps, and commit only the files owned in this lane.
