# DarkFleet Investigation / Analyst Saved-State Implementation

Date: 2026-10-10. Scope: local investigation records, saved scan references,
SAR target watch entries, analyst notes, and Reports UI.

## Code audit: initial state

- `backend/darkfleet/api/routes.py` exposed acquisition and target evidence, scan jobs,
  stage streams, and exports, but no investigation, watchlist, or annotation routes.
- `backend/darkfleet/storage/runs.py` persisted REAL scan records atomically under
  `data/scans`; it rejects synthetic-mode records. Evidence data must remain separate
  from operator-authored assertions.
- `src/reports/ReportsWorkspace.tsx` had an unsaved, component-local analyst
  note with an explicit warning that no persistence endpoint existed.
- `src/state/store.ts` tracked the selected scan/target and AOI for the running
  app, but it did not persist analyst case records across process restarts.

## Implemented

1. Added `backend/darkfleet/api/investigations.py`, registering its router
   through `api/app.py`. The SQLite database
   `<DARKFLEET_DATA_DIR>/investigations.sqlite3` stores investigations,
   annotations, and watched SAR target references using real transactions,
   foreign-key cascade deletion, and a per-case target uniqueness constraint.
2. Added typed API operations:
   - `GET/POST /api/investigations`
   - `GET/DELETE /api/investigations/{id}`
   - `POST /api/investigations/{id}/annotations`,
     `DELETE /api/investigations/{id}/annotations/{note_id}`
   - `POST /api/investigations/{id}/watchlist`,
     `DELETE /api/investigations/{id}/watchlist/{entry_id}`
3. Linking an investigation to a scan requires a persisted `REAL`,
   `synthetic=false` run record. Linking a note or watchlist item to a SAR
   target requires that exact target in the investigation's scan record. Missing,
   malformed, and duplicate references fail explicitly with 4xx responses.
   An unlinked case supports general notes without asserting a nonexistent target.
4. Case reads derive AOI from the authoritative persisted scan, rather than
   copying freeform coordinates into investigation storage. Deleting a case or
   its annotations never removes scan evidence. No synthetic contact, coordinate,
   classification, or source data is generated.
5. Added `src/api/investigations.ts`, wired to the generated OpenAPI contract.
   Restoring a saved case verifies the original persisted scan on the server
   before replacing the active client selection and reloading SAR/AIS data.
6. Replaced the former ephemeral note in Reports with
   `src/reports/InvestigationNotebook.tsx`: create/select cases; persist and
   remove general or target-scoped notes; watch/unwatch targets; restore a
   saved scan; inspect a watched target in its originating scan; confirm before
   deleting a case. Failures render as errors.
7. Added HTTP `204` handling in the API client, registered DELETE for local
   frontend CORS, regenerated `src/api/contract.ts`, and corrected the
   outdated annotation-persistence statement in the dossier History view.
   The contract also includes the concurrent scan-catalogue response schema
   introduced by the coordinator.

## Verification evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| API restart persistence | PASS | `tests/test_investigations.py`: new TestClient over same temp data_dir reopens case, note, watched target |
| Source validation | PASS | Unknown REAL scan, unknown target, duplicate watch, invalid body and unlinked-case errors tested |
| Deletion isolation | PASS | Case, annotation and watch deletion tested; original RunStore scan remains untouched |
| Generated contract | PASS | `python -m tools.export_contract --check`; request types from actual FastAPI OpenAPI |
| Backend targeted regression | PASS | `python -m pytest tests/test_investigations.py tests/test_request_contract.py -q`: 15 passed |
| Python style | PASS | Scoped `python -m ruff check` on modified backend code and generator |
| Python strict typing | PASS | `python -m mypy darkfleet/api/investigations.py`: no issues in the new module |
| Frontend integration checks | PASS | `src/api/investigations.test.ts`: request fields, 204 delete, saved-run verification, malformed response refusal; `src/reports/InvestigationNotebook.test.tsx`: Reports entry point renders |
| Frontend static check | PASS | `npm run lint`: TypeScript noEmit |
| Frontend build | PASS | `npm run build`: Vite generated assets (existing large-chunk warning) |

## Remaining limitations

- Investigation identifiers are local to one configured `data_dir`; cases are
  durable on that local filesystem but this feature does not implement
  multi-user ownership, RBAC, distributed storage, backups, or migrations.
  Access follows the app's existing API deployment boundary.
- Watched entries reference SAR targets in one saved scan. They do not create
  cross-scan identity, live AIS/MMSI subscriptions, alerts, globe styling,
  or automatic case investigation.
- Saved state restores the scan and derived AOI, and can focus a bookmarked
  target. Camera pose, layer visibility, active timeline instant and editor layout
  are not part of a saved case.
- Analyst notes are a separate editable corpus and are not appended to the
  immutable observation history. Provenance is the originating scan reference,
  the optional original target id, and annotation creation time; no reviewer
  identity or sign-off workflow exists.
- This scope was tested with local, deterministic persisted fixtures, API requests,
  and frontend checks. A full human-operated real-provider/browser investigation
  workflow has not been claimed or run in this report.
