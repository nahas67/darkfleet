# Reports, investigation notebook, geometry and saved views — UI re-verification

Date: 2026-10-11. Scope: independent frontend product-surface review and bounded repairs. This is not a claim of a live SAR acquisition or a browser E2E run.

## Reachability and source authority

- `src/command/DarkFleetCommandApp.tsx` mounts `<ReportsWorkspace />` at `REPORTS` and `<SavedViewsWorkspace />` at `VIEWS`. Both have visible `OperationRail` entries. No shared app/rail edits were necessary.
- Report scan exports link to the existing `GET /api/scans/{scan_id}/export/{json,geojson,kml,png,pdf}` backend. `backend/darkfleet/api/routes.py::export_scan` requires a persisted scan record; missing/ongoing records return HTTP 404/409, not downloadable evidence. The UI now checks `GET /api/scans/{id}` for `record_persisted=true`, `runtime_mode=REAL`, `synthetic=false`, `stage=COMPLETE` before exposing download anchors; it rechecks on scan-stage changes and refuses an unverified lookup. A visible scan ID alone is **not** an export entitlement.
- Investigation case JSON/PDF links use `GET /api/investigation-reports/{case_uuid}/json|pdf`. The server exports direct attachment bytes, validates the canonical JSON SHA-256 and embeds the digest in PDF headers. A deleted case yields a real non-2xx response; neither the UI nor API fabricates report bytes. The user action is a same-origin anchor download, not a client-side fake renderer or mocked success. The UI does **not** recompute cryptographic digest client-side.
- Notebook create/list/delete, note create/delete, watch/unwatch and restore call `/api/investigations` handlers via `src/api/investigations.ts`. Geometry list/create/update/delete call `/api/investigations/{case_uuid}/geometries` via `src/api/investigationGeometry.ts`. WGS84 measurements and provenance are computed/verified by the backend; preview drawings are labelled `OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE`, never satellite observations.
- Saved views list/create/revision-checked replace/delete call `/api/views` via `src/api/savedViews.ts`; source status/missing-resource checks and snapshot allowlisting remain backend-owned. Capture excludes source bytes, provider credentials and target evidence. A view is a presentation bookmark, **not** an observed measurement.

## Operator controls and findings

| Surface | Operator controls and real effect | Failure/disabled/partial behavior |
| --- | --- | --- |
| Scan report exports | JSON, GeoJSON, KML, PNG, PDF links use persisted scan export routes | **Fixed**: no download links while scan incomplete, record not REAL/persisted, or readiness check unavailable. Stage changes recheck readiness. |
| Investigation notebook | Select case; create case; restore saved scan; add/remove case/target notes; watch/unwatch and inspect targets; delete with confirmation; download case JSON/PDF | **Fixed**: failed first list read is `unverified`, not "no cases"; retry control and no unverified detail actions. Case-to-scan text now says server verification is required. |
| Watched target restore | Inspects a target after persisted scan reload | **Fixed**: only selects a target ID actually present in the reloaded scan, not a stale watchlist reference. Error visible if source target is gone. |
| Geometry and WGS84 measuring | Point, polyline, polygon, range ring, longitude/latitude form, globe click drawing, undo/redo/clear, geodesic radius, notes, save/update/edit/cancel/delete with confirmation, frame persisted vertices | **Fixed**: before a successful geometry list read, controls are disabled; failed fetch displays unavailable+retry, never "no operator geometry". Following writes, a failed reconciliation makes the persisted inventory unverified instead of claiming stale item counts. Server remains sole measurement authority. |
| Saved views | Save new, choose view, update current snapshot with expected revision, restore, name edit, delete with confirmation, refresh | **Fixed**: if a server mutation succeeds but the following list refresh fails, UI acknowledges the server mutation while warning that library reconciliation failed, not declaring the refreshed list successful. Local returned record is used only as a provisional representation; refresh remains available. |

## Verification limits

- **Executed 2026-10-11:** `npm test -- --run src/reports src/views src/api/savedViews.test.ts src/api/investigations.test.ts src/api/investigationGeometry.test.ts`: **6 files / 20 tests PASS**; `npm run lint`: **PASS**; `npm test`: **68 files / 879 tests PASS**; `npm run build`: **PASS** (existing output chunk-size advisory); `git diff --check` on owned paths: **PASS**.
- **Executed isolated backend:** `python -m pytest backend/tests/test_investigation_reports.py backend/tests/test_saved_views.py -q`: **7 passed**; `python -m pytest backend/tests/test_api.py -k export -q`: **3 passed, 14 deselected**, with two Pillow `mode` deprecation warnings. These run local FastAPI TestClient paths with test fixtures, not a live SAR provider.
- Frontend focused Vitest checks verify reachable output, initial loading/disabled behavior, request signatures, replayed scan identity, saved-view revision semantics and persisted geometry validation. The saved-view list/create/update/delete HTTP tests use deterministic mocked responses; they are **not** proof of remote deployment persistence.
- Backend `test_investigation_reports.py` uses a temporary isolated app/store, calls real FastAPI JSON/PDF handlers, asserts `%PDF-`/`%%EOF`, content SHA-256, `Content-Disposition`, missing-source disclaimers and repeated same-case export. The backend saved-view test covers server storage and optimistic revision transitions; this validates direct endpoint behavior, **not** a browser click.
- Browser-level clicks, OS download prompts, external imagery fetch, any live provider observation, and user-existing installation data mutation were NOT RUN. No mock or fixture was presented as real-world sensing.

## Residual boundaries

- The UI uses backend-delivered export readiness, not a native download-completed receipt. A scan or case may be deleted after the readiness check and before clicking; the backend correctly rejects the later request. Download success still depends on real HTTP response and browser permissions.
- Background scan data hydration functions independently report unavailable sensor data through canonical state. Restoring a bookmarked scan does not generate missing evidence or synthesize targets.
- `SavedViewsWorkspace` and notebook have static control coverage and real API wire tests; no claim of interactive browser E2E, multi-user concurrent view merge or actual external source restoration is made.
