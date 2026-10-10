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
| Create case | Chrome POST 201, visible persisted case ID | **PASS** |
| Create case-wide annotation | Chrome POST 201, item visible | **PASS** |
| Create operator geometry | Chrome POST 201, measured geometry response | **PASS** |
| Edit geometry | Chrome PUT 200, changed label/vertices visible, UI persistence receipt | **PASS** |
| Download case report JSON | Chrome download containing canonical case, operator material, valid SHA-256 and honest source status | **PASS** |
| Download case report PDF | Chrome download, valid PDF header and nonempty body | **PASS** |
| Create mission | Chrome POST 201 | **PASS** |
| Change mission status | Chrome PUT 200, status ACTIVE | **PASS** |
| Save/update viewpoint | Chrome POST 201, EDIT NAME focuses input, PUT 200 and revision increases to 2 | **PASS** |
| Backend restart + browser reopen | New backend PID, new browser page, server-retrieved records visible | **PASS** |
| Saved-view restore | Click UI RESTORE VIEW after restart and inspect feedback | **PASS** |
| Binary evidence attachment | No production UI/API for a binary investigation attachment | **FEATURE_NOT_IMPLEMENTED** |
| General persistent settings editor | SYSTEM workspace reports operational diagnostics; no persisted edit API/control | **FEATURE_NOT_IMPLEMENTED** |
| Case title update | Investigation routes implement create/get/list/delete but no PUT/PATCH | **FEATURE_NOT_IMPLEMENTED** |
| Target-linked attachment to verified REAL scan | Requires a source from a genuine completed scan; none fabricated | **NOT_RUN — REAL source unavailable** |

## Already executed independent backend tests

`python -m pytest -q backend/tests/test_investigations.py backend/tests/test_investigation_geometry.py backend/tests/test_missions_alerts.py backend/tests/test_saved_views.py backend/tests/test_investigation_reports.py backend/tests/test_restart_workflows_reverify.py`: **40 passed**. These use isolated pytest data roots and TestClient; useful backend evidence **but do not satisfy browser acceptance on their own**.

`python -m py_compile build-tools/operator_workflow_browser_e2e.py`: **PASS**.

`python -m ruff check build-tools/operator_workflow_browser_e2e.py`: **PASS**.

## Executed real-browser evidence

The exact command `python build-tools/operator_workflow_browser_e2e.py` exited
**0 / PASS_SUPPORTED_WORKFLOWS** on 2026-10-11 local time (recorded UTC:
`2026-10-10T22:55:56.297776+00:00`).

- Git HEAD at start of browser execution:
  `235c92d6b028a10865faceffb133116b52f73d5f`.
  Worker-3's integration UI fix `a98993d` was already committed in that
  history; the browser verified its EDIT NAME focus and geometry saved/reloaded
  receipt after actual server writes.
  After the run, `git diff --name-only 235c92d --` over the four
  production persistence routers and all five exercised frontend operator
  modules was empty, and `git status --short --` for those paths was empty.
  This proves no remaining source changes in those paths relative to the
  execution commit (not a per-frame source snapshot).
- Real Chrome Stable version: `154.0.8037.98`, headless through Playwright,
  viewport `1500×950`. No mocked HTTP response or fake receipt was supplied.
- Independent FastAPI PID **21220** (first session) terminated and restarted
  as PID **372**, with Vite held on its own PID **23500**. After reopening an
  entirely fresh browser page, the previously created case, annotation,
  updated WGS84 polyline, ACTIVE mission and revision-2 saved view were visible
  and confirmed again by fresh direct GET requests to the restarted API.
  The view RESTORE control was clicked and success text observed.
- The unlinked case report JSON downloaded through the UI contained
  `source_status=NO_SCAN_LINKED`, the operator annotation and updated
  geometry, with SHA-256
  `8461e280b4d94767a3caba8bc1c8dc95db1a56fcc1be55a0c023ee87a64b36f0`.
  Its **canonical `content_sha256` was independently recomputed and matched**;
  a fresh Chrome download after backend restart had the identical byte hash.
- The PDF was actually downloaded through Chrome, nonempty and beginning with
  `%PDF-`; SHA-256
  `3490da63ef9f0b3ba2895d62deacbbdd2cd07046e190ab1aaf94578308a8dfee`.
- Observed browser API write statuses: investigation POST **201**,
  annotation POST **201**, geometry POST **201**, geometry PUT **200**,
  mission POST **201**, mission PUT **200**, saved view POST **201**,
  saved view PUT **200**. Reopened state was cross-checked with real GET
  responses. No page JavaScript exceptions were captured.
- Private-browser network policy blocked **15 OSM tile requests** and
  **15 Esri tile requests**; backend provider health attempted outbound
  DNS for Planetary Computer, EarthSearch and CDSE, which the child-process
  network guard blocked before transport. Therefore, no live SAR/AIS provider
  observations or map-tile availability are claimed by this test.
- Disposable data root under
  `%TEMP%/darkfleet-operator-browser-*/data` held only
  `investigations.sqlite3` and `missions.sqlite3` when inspected.
  The temporary root was deleted on exit; no existing user `data/` content
  was written. Both dedicated service process trees and the owned Chrome
  context/browser were closed. Browser slot released to worker-7.

## Limitations

1. **FEATURE_NOT_IMPLEMENTED:** No binary case evidence-upload endpoint,
   general writable SYSTEM settings, or case-title mutation exists. Do not
   reinterpret case annotations or saved views as binary attachments or a
   durable settings administration feature.
2. **NOT_RUN — external source:** Target-linked analyst material, REAL scan
   exports and live AIS/SAR verification require actually persisted,
   independently verified REAL observations. No fake scan was created.
3. **Browser access:** This is a genuine local Chrome UI acceptance test
   with real API processes, but a headless browser, not a human-operated
   desktop session. No hardware/WebGL performance claim is made here.
4. **Replay:** The harness binds fixed dedicated loopback ports and refuses
   to attach to existing services; those ports must be free. The run
   establishes survival across one backend restart and one fresh page, not
   adversarial process crashes during SQLite commit or all possible session
   sequences.
