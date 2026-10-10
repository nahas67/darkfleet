# DF-X20 — Local-first Grounded Investigation Analyst

**Status:** deterministic read-only core, API and standalone React workspace implemented.
Prime owns mounts. **No LLM or network inference is active**. No remote egress,
API credentials, provider calls, freeform prompts or simulated observations.

## Inspected authority

The existing investigation SQLite database stores cases, watchlists, operator
notes and WGS84 geometry. RunStore stores the original REAL, synthetic-false
SAR scan records with acquisition scene metadata, detected targets and optional
AIS association fields. The existing read-only MCP toolset exposes saved data;
investigation JSON/PDF reports provide canonical source exports. DF-X20 adds
bounded questions with explicit citations and unknowns, not another model
or evidence-generation pipeline.

All SQLite access uses read-only mode=ro, without migration or database creation.
Each analyst request fetches current persisted case and original linked scan.
The scan identity, REAL runtime and false synthetic flag are verified. An
optional processing stage must be COMPLETE when present. A canonical SHA-256
over the source JSON accompanies verified scan output, not unavailable sources.
Operator annotation TEXT IS NOT READ: only its SQL COUNT is selected; a stored
operator prompt-injection cannot affect output and is never sent to a model.

## Explicit analyst questions and evidence contract

The only accepted intents are SUMMARY, WATCHLIST, SAR_AIS and GAPS. Optional
target_id is strictly validated and narrows target inspection. Watch entries
and detailed targets are bounded to 30 and 20 respectively; truncated data
receives an explicit warning rather than fabricated completeness.

Every factual claim includes its stable ID, fixed-template statement, original
saved scalar value, SENSOR_RECORD or OPERATOR_RECORD classification, specific
uncertainty statement, and at least one exact evidence citation with source
kind, source ID, relative record path and JSON field path or SQLite row field.

| Claim type | Example field citation | Interpretation boundary |
| --- | --- | --- |
| SAR acquisition | scans/REAL-001.json :: $.scene.item_id | Recorded scene ID only |
| SAR detector result | scans/REAL-001.json :: $.targets[0].sarConf | Algorithm score, not vessel identity or intent |
| SAR processing class | scans/REAL-001.json :: $.targets[0].cls | SAR_UNMATCHED does not imply intentional AIS disablement |
| AIS correlation | scans/REAL-001.json :: $.targets[0].corr.matched | Saved association outcome, not reception coverage |
| AIS identifier | scans/REAL-001.json :: $.targets[0].corr.mmsi | Stored association, not independently verified identity |
| AIS coverage | scans/REAL-001.json :: $.ais_coverage.status | Only known recorded coverage status |
| Operator watch entry | investigations.sqlite3 :: investigation_watchlist[id=...].target_id | Saved operator selection, not sensor evidence |
| Operator note count | investigations.sqlite3 :: investigation_annotations[investigation_id=...].COUNT | Count only; no operator text exposed |

Untrusted scene narratives, signed asset URLs, tokens, note bodies and freeform
provider fields are deliberately excluded from claims. All source labels are
bounded and whitelist-validated. Source statuses include PERSISTED_REAL,
NO_SCAN_LINKED, SOURCE_MISSING and SOURCE_UNVERIFIED.

Missing scans, target arrays, classifications, correlation, confidence,
independent AIS coverage, and georeferencing are *unknowns*, never zero
observations. Each unknown includes code, explanation, source ID, expected
field path and next check. A stored unmatched SAR target alone cannot prove
intentional AIS non-reporting. A case without source yields operator-only
claims and explicit source uncertainty; deleting a scan removes all subsequent
sensor claims and the scan digest. Restarts recompute identical responses
from identical persisted source bytes. Nothing is written by analysis.

## API — separate router awaiting prime mounting

New file: backend/darkfleet/api/analyst_routes.py

| Method | Route | Meaning |
| --- | --- | --- |
| GET | /api/analyst/cases?limit=100 | List saved case IDs, titles, scan links; 404 when DB absent |
| POST | /api/analyst/cases/{case_id}/analyze | Analyze one persisted case with fixed intent and optional target_id |

Example POST body:

~~~json
{"intent":"SAR_AIS","target_id":"DF-001"}
~~~

Unknown fields, a prompt, a model URL, path traversal or unsupported intent
are rejected as HTTP 422. Unknown case gets HTTP 404. Backend Pydantic
response schemas are AnalystSource, AnalystClaim, AnalystUnknown,
GroundedAnalystOut, AnalystCaseBrief, AnalystCaseListOut; request schema
is AnalystRequest.

Prime mount in backend/darkfleet/api/app.py, intentionally untouched here:

~~~python
from darkfleet.api.analyst_routes import router as analyst_router
application.include_router(analyst_router)
~~~

Prime owns backend/tools/export_contract.py and src/api/contract.ts.
Register the listed schemas there if generated contract coverage is desired;
the worker must not modify them.

## Standalone operator UI

New: src/analyst/AnalystWorkspace.tsx, exported AnalystWorkspace.
The panel fetches saved cases, shows model disabled, offers four fixed
questions and optional target ID, and renders source status, evidence claims
with precise source references and uncertainty, and separate unknowns with
recommended checks. It has explicit no DB, no cases, missing scan, loading
and API error states; stale results are invalidated on scope change. It never
passes operator notes or arbitrary prompts to an inference service.

Prime should mount the component as a tab/workspace inside a prime-owned
frontend navigation surface. No existing src/reports, src/command or
src/globe files were touched.

## Verification

Backend commands from backend:

~~~powershell
.venv/Scripts/python.exe -m pytest tests/test_analyst.py -q
.venv/Scripts/python.exe -m ruff check darkfleet/analyst.py darkfleet/api/analyst_routes.py tests/test_analyst.py
.venv/Scripts/python.exe -m mypy --follow-imports=silent --disable-error-code=valid-type darkfleet/analyst.py darkfleet/api/analyst_routes.py
~~~

Frontend commands from repo root:

~~~powershell
npm test -- --run src/analyst/AnalystWorkspace.test.tsx
npm run lint
npm run build
~~~

Tests use temporary REAL-shaped scan **fixtures**, never presented as
real-world data. They verify exact field-path citations, actual saved numeric
scores and MMSI associations, source-file immutability, restart stability,
source deletion, forged synthetic scan rejection, absent target/coverage
unknowns, unlinked cases, missing DB, invalid input and explicit malicious
operator note injection. Frontend tests assert strict response provenance,
source availability, offline model identity, HTTP payloads and SSR UI controls.

## Limitations

There is deliberately **no optional local LLM** enabled here. A later model
requires independently verified loopback-only binding, isolation against
remote egress, strict request timeouts, credential redaction, injection
boundaries and evidence-citation validation before enabling. The current
fallback is fully working and deterministic, not a simulation of model output.
Saved AIS correlation fields are analyzed; the independent AIS Parquet archive
is not queried by this analyst. No autonomous surveillance, external news,
cross-pass identity confirmation, illicit-activity inference, freeform
reasoning, durable conclusions history or edits to case or sensor sources.
