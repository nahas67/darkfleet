# Revisit / Multipass independent re-verification — 2026-10-11

**Scope:** `backend/darkfleet/revisit.py`, `backend/tests/test_revisit*.py`,
`src/dossier/api.ts`, `src/dossier/tabs/RevisitTab.tsx`,
`src/dossier/tabs/MultipassTab.tsx` and new focused frontend tests.
Base revision at assignment: `d4e667a8b66d1986b881bbd24f39cc33eed89fd9`.
The prime owns `backend/darkfleet/api/routes.py`,
`backend/darkfleet/api/advanced.py`, `backend/darkfleet/temporal.py`,
`src/intelligence/AdvancedWorkspace.tsx` and master verification documents.

## Substantive verified defects and repairs

1. **Identity and count:** Revisit originally deduplicated strictly by timestamp.
   Different STAC scene IDs acquired at the same instant disappeared from the
   acquisition inventory. The planner now deduplicates by catalogue
   `(collection, item_id)`, preserving distinct scenes while merging polarization
   evidence from duplicate rows for one scene. Intervals use **distinct measured
   acquisition instants**, so two scenes at the same timestamp do not fabricate a
   `0.00 day` revisit.
2. **Window integrity:** `plan_revisit` accepted window bounds but reported
   all input acquisitions, including those outside the requested period. It now
   filters inclusively to the query interval; an inverted window raises
   `ValueError`. Edge intervals are not reported as coverage holes.
3. **Time truth:** Naive/aware mixed timestamps previously raised
   `TypeError` during sorting, and `window_for` emitted local clock times with
   a misleading `Z`. All comparisons, intervals and query bounds now normalize
   timestamps to UTC, treating offset-free inputs as UTC. `next_after` and
   `last_before` accept offset-free moments without crashing.
4. **Source provenance:** STAC `collection` normally lives at the root of an
   item; the parser only inspected properties and emitted a blank collection.
   It now checks the root first. Only actually listed VV/VH/HH/HV polarization
   assets are reported. Missing assets remain unknown.
5. **Antimeridian:** `loadRevisitAround` now wraps both longitudes to the
   legal interval instead of generating >180° or <-180° longitude. A symmetric
   AOI crossing the seam uses `min_lon > max_lon`. `tracksForPosition`
   compares shortest wrapped longitude differences so observations on either
   side of the seam remain discoverable within the explicit 400 m display radius.
   The prime independently owns backend `/api/revisit` logic that splits such
   requests into two valid STAC bboxes and merges source item IDs **before**
   calculating one plan; both halves must succeed. Focused HTTP tests verified
   the prime's uncommitted shared-file implementation locally, but this worker
   does not own that route or its integration commit.
6. **Operator interpretation:** Revisit dossier now displays the actual
   `requested_bbox` and window returned by the API, plus provider/collection.
   Nominal orbital repeat remains explicitly `ORBIT-DERIVED`, never rendered
   as measured revisit. Zero acquisitions is a completed empty catalogue query,
   and request failure is a separate visible error. Multipass calls a hypothesis
   **near** this coordinate rather than asserting that geometric proximity
   identifies this target. Its scene caption discloses when a scan ID serves
   as the stored scene reference. No panel infers vessel intent or AIS being off.

## Reproduction and test evidence

Initial new pure-backend regressions against old planner: **6 failed, 1 passed**,
including dropped distinct scene, records outside window, mixed-offset sort
crash, false-Z local time, missing collection and incomplete merged polarizations.
All seven pass after the changes.

- `python -m pytest -q backend/tests/test_revisit.py backend/tests/test_revisit_reverify.py backend/tests/test_revisit_api_reverify.py`: **27 passed**.
- API tests instantiate the actual FastAPI `TestClient(create_app(...))` with
  locally stubbed `stac_items` returning explicit synthetic test input.
  They exercise real response-model validation, measured arithmetic,
  antimeridian split, deduplication and rejection of a partial-half failure.
  **These fixtures are not live satellite observations.**
- `npx vitest run src/dossier/api.revisitMultipass.test.ts src/dossier/tabs/RevisitMultipassReverify.test.tsx src/intelligence/AdvancedWorkspace.test.tsx src/intelligence/advancedSemantics.test.ts src/dossier/format.test.ts`:
  **53 passed** in 5 files. Covers client request AOI, crossing-longitude
  nearest-track, direct panel rendering of loading/failure/empty states, and
  AdvancedWorkspace tab reachability.
- `npx tsc --noEmit`: **PASS**.
- Scoped `python -m ruff check` on planner and new tests: **PASS**.

## Visibility, external availability and remaining limitations

- Production source wiring: `src/dossier/DossierWorkspace.tsx` conditionally
  mounts `MultipassTab` and `RevisitTab` for their respective selected tabs;
  `AdvancedWorkspace.tsx` independently mounts its REVISIT and MULTIPASS
  panels. SSR mounting/contents and accessible workspace tab markup were
  tested. The existing browser had a DarkFleet tab at localhost:5174 owned by
  another agent, but a read-only DOM snapshot yielded `about:blank`. Real
  interactive click-to-open visibility **NOT VERIFIED** from that browser.
- Live `test_revisit_live.py` was **NOT RUN**. Planetary Computer and
  EarthSearch availability/current coverage were **EXTERNAL / UNVERIFIED** in
  this lane; no remote requests were sent. Provider-down status is tested with
  a real HTTP error response using local instrumentation.
- `stac_items` currently requests one page of up to 200 features. The prime's
  route appends an explicit response limitation when a result reaches the
  cap. A capped sample cannot establish complete catalogue coverage or
  definitive longest gaps; full pagination remains unresolved.
- The coarse 400 m proximity filter identifies nearby *hypotheses* for display,
  **not target identity**. The backend track pipeline may group repeated
  MMSI observations despite contradictory inter-pass speed evidence; the
  operator-facing contradictions remain visible. Verified continuity would
  require additional multi-pass identity research.
- Original `/api/scenes` strict longitude parsing is intentionally separate
  from dateline-capable `/api/revisit`. The shared antimeridian API change is
  prime-owned, so release-level integration remains dependent on the prime's
  final commit and full-system tests.
