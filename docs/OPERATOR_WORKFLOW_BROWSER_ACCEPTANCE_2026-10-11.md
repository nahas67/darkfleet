# Operator workflow real-browser acceptance — 2026-10-11

## Acceptance boundary

**Harness:** `build-tools/operator_workflow_browser_e2e.py`.
Runs Chrome Stable with Playwright and **actual UI clicks, form changes,
HTTP writes, browser file downloads, backend-process restart and fresh-page
reopening**. It creates its own temporary operator data root, starts independent
FastAPI and Vite processes on loopback ports **8013** and **5177**, refuses to
attach to or terminate unrelated processes, blocks external HTTP requests in
Chrome and external DNS/TCP in the backend, and deletes the disposable root
after completion. This is NOT a TestClient-only or mocked-response workflow.

**Source authenticity:** No scan records, sensor detections, satellite scene
catalogue returns, authorization receipts, or AIS observations are simulated.
Cases created without a verified REAL scan remain explicitly unlinked.
Their report `source_status` must be `NO_SCAN_LINKED`, and annotation
and geometry provenance must remain `OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE`.
Tests never write into the repository's existing `data/`.

## Operation matrix

| Acceptance | Evidence required | Status |
| --- | --- | --- |
| Create case | Chrome POST 201, visible persisted case ID | Pending Chrome slot |
| Create case-wide annotation | Chrome POST 201, item visible | Pending Chrome slot |
| Create operator geometry | Chrome POST 201, measured geometry response | Pending Chrome slot |
| Edit geometry | Chrome PUT 200, changed label/vertices visible | Pending Chrome slot |
| Download case report JSON | Chrome download containing canonical case, operator material and honest source status | Pending Chrome slot |
| Download case report PDF | Chrome download, valid PDF header and nonempty body | Pending Chrome slot |
| Create mission | Chrome POST 201 | Pending Chrome slot |
| Change mission status | Chrome PUT 200, status ACTIVE | Pending Chrome slot |
| Save/update viewpoint | Chrome POST 201, EDIT NAME focuses input, PUT 200 and revision increases to 2 | Pending Chrome slot |
| Backend restart + browser reopen | New backend PID, new browser page, server-retrieved records visible | Pending Chrome slot |
| Saved-view restore | Click UI RESTORE VIEW after restart and inspect feedback | Pending Chrome slot |
| Binary evidence attachment | No production UI/API for a binary investigation attachment | **FEATURE_NOT_IMPLEMENTED** |
| General persistent settings editor | SYSTEM workspace reports operational diagnostics; no persisted edit API/control | **FEATURE_NOT_IMPLEMENTED** |
| Case title update | Investigation routes implement create/get/list/delete but no PUT/PATCH | **FEATURE_NOT_IMPLEMENTED** |
| Target-linked attachment to verified REAL scan | Requires a source from a genuine completed scan; none fabricated | **NOT_RUN — REAL source unavailable** |

## Already executed independent backend tests

`python -m pytest -q backend/tests/test_investigations.py backend/tests/test_investigation_geometry.py backend/tests/test_missions_alerts.py backend/tests/test_saved_views.py backend/tests/test_investigation_reports.py backend/tests/test_restart_workflows_reverify.py`: **40 passed**. These use isolated pytest data roots and TestClient; useful backend evidence **but do not satisfy browser acceptance on their own**.

`python -m py_compile build-tools/operator_workflow_browser_e2e.py`: **PASS**.

`python -m ruff check build-tools/operator_workflow_browser_e2e.py`: **PASS**.

## Live browser evidence and residuals

The actual Chrome-run result, source commit, response statuses, download SHA-256s,
restarted PID, file inventory, and any unavailable or failed steps must be
recorded here **after** the browser slot is released and the harness is executed.
No status above may be promoted from pending to PASS based on TestClient output,
code inspection, or a made-up receipt.
