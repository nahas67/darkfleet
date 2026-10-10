# DarkFleet — exact historical AIS canvas observation / adverse ordering

**Status (2026-10-11): PARTIAL / EXACT HISTORICAL CANVAS PICK NOT VERIFIED.**
The existence of `AIS_OBSERVATION` tags and passing decoder tests is not
substituted for a real `LEFT_CLICK` on a visible historical Cesium billboard.
All AIS content in this evidence is deliberately **NONLIVE TEST DATA**, not
an authenticated AIS radio observation or a completed real SAR scan.

## Actual source and executable reachability (HEAD `b5bdc675480ad7cc6ff78b3c81fcb0534065bad7`)

The existing production path is reachable in source, with no new feature
implementation required to attempt a physical click:

1. Temporary `AisArchive` Parquet → real `GET /api/scans/{id}/ais` →
   `loadScanAis` → `state.aisObservations` (raw, source-preserving fixes).
2. `TacticalWorld` computes `observationMarkers`; `aisRenderer.ts`
   `#renderObservationMarkers` adds a **7 × 7 px** Cesium billboard at each
   exact source position, tagged `aisObservationTag(mmsi, at)` in its `id`.
   Note: the same vessel's contact glyph and `AIS_TRACK` polyline may overlap
   the historical marker pixel; screen projection is **not** a proof of which
   primitive Cesium's depth-ordered pick returns.
3. `engine.ts #installPicking` handles real Cesium `LEFT_CLICK` and calls
   `viewer.scene.pick(movement.position)` then `decodeAisPick`. If the actual
   hit is `AIS_OBSERVATION`, the engine writes the **exact raw timestamp**
   to `store.selectAis({mmsi,observationAt:at})` and the renderer highlight.
   The separate `AisPlaybackBar` displays the raw fix in
   `data-df-ais-selected-observation`. SAR selection is not overwritten.
4. No existing `scene.drillPick` fallback prefers a source observation tag
   underneath an occluding contact/track. Whether that omission is a **bug**
   depends on a real overlap stack at the native pointer pixel; no fix is
   authorized solely on a conjectured stack.

## Browser run 1 — real single-pixel canvas click, source-stable FAIL

Executed from the actual Windows repo in an isolated temp data root with
real Chrome **154.0.8037.98**, private ephemeral loopback FastAPI/Vite,
browser external network blocked, no writes to operator `data/`, and one
explicitly non-live scan window descriptor (`FIXTURE_NONLIVE`, `synthetic=true`,
`stage=FIXTURE_ONLY_NOT_A_SCAN`). It did not use the prior 100-contact data.

- Fixture: **2 MMSIs / 7 timestamped raw fixes**; stable
  `fixture-ais-pointer-NONLIVE` source, raw Parquet SHA-256
  `a68972af5dae9c2ac79dd0db013467ba96ad0a13df301cff4d6937faf6d22334`.
  The genuine API returned HTTP 200 with all 7 rows. Browser `loadScanAis`
  preserved 7 observations and 2 contacts, playback bar visible, one canvas,
  zero uncaught JS errors. Initial selected AIS = `null`.
- Actual Cesium `engine.projectToCanvas` returned four different in-view
  historical fix pixels for MMSI `257771001` after settling a 45-km top-down
  camera: 12:00 at `(692,481)`, 12:04 at **`(723,471)`**, 12:08 at `(755,462)`,
  and 12:16 at `(786,452)`. These are actual projected canvas CSS pixels,
  not a guessed window coordinate or synthetic click event.
- Actual Playwright `page.mouse.click(canvasBoundingBox + (723,471))` on the
  **12:04 raw-source fix** selected MMSI **`257771001`**, but the resulting
  `selectedAis.observationAt`, `highlightedObservation`, renderer highlight
  and raw-fix DOM were all **`null`**. The exact source timestamp returned by
  the API was `2026-10-10T12:04:00Z`; that assertion **FAILED**.
- Git HEAD before/after was `b5bdc675480ad7cc6ff78b3c81fcb0534065bad7`,
  and all **17 monitored** original AIS source hashes matched. The Vite log
  nevertheless included unrelated concurrent `SystemPanel.tsx` HMR edits.
  No frame-navigation event was captured in this first harness version.

**Interpretation:** the pointer reached an AIS vessel pick, but did **not**
establish observation-level identity. Contact versus track occlusion is
plausible. The raw `scene.pick` tag at that particular pixel was **not
recorded**, so this observation is **not** proof of a specific pick-ordering
defect, nor proof that the intended billboard was actually picked.

## Browser run 2 — authorized bounded diagnostic rerun INCONCLUSIVE

The harness was extended to try at most **13 actual physical clicks** inside
the historical 7-pixel glyph footprint: center plus ±2/3 CSS pixel offsets,
each recording selected MMSI, exact timestamp, DOM fix and renderer
highlight. It also attempts a *diagnostic-only*, forwarding wrapper around
the actual Cesium `Scene.prototype.pick` and `scene.drillPick` to capture
topmost/underlying typed IDs at the same native pixel; that wrapper does
not modify the returned pick or write selection state.

Before any such instrumented hit, Playwright reported:

`Page.evaluate: Execution context was destroyed, most likely because of a navigation`.

The isolated Vite process logged concurrent HMR updates to
`src/design/tokens.css` at **04:59:49 local**. Git HEAD and the original 17
AIS hash anchors were stable, but this first iteration of the new harness
did **not** include `tokens.css`/`SystemPanel.tsx` in the fingerprint set.
The second attempt must therefore be labelled **INCONCLUSIVE_DEV_RELOAD**,
not a product pick failure and not a PASS. The code now detects that exact
context-loss error as `INCONCLUSIVE_DEV_RELOAD`, records frame navigations,
Vite diagnostic messages and hashes 20 sources including CSS/SystemPanel;
those new guards were **NOT rerun** after the exclusive Chrome slot was
released to worker-7.

All owned Chrome, FastAPI and Vite processes were closed after each run.
No production AIS decoder, renderer or engine code was changed. No push.

## Adverse ordering — executed vs. outstanding

| Acceptance | Evidence | Status |
|---|---|---|
| Archive API and source identity | Real FastAPI/Parquet, 7 fixes/2 MMSIs, expected raw time and source returned | **PASS (NONLIVE)** |
| Projection to different visible historical pixels | Four distinct in-view coordinates observed | **PASS (projection only)** |
| Native canvas marker exact source timestamp | 12:04 canvas click selected vessel but `observationAt=null`; bounded follow-up invalidated by HMR | **NOT VERIFIED** |
| Typed tag decoding independent of interleaved picks | `src/globe/aisPick.ordering.test.ts` three focused pure regression checks | **PASS (unit only)** |
| Highlighted marker on real canvas | Absent after first click; second run aborted before marker sampling | **NOT VERIFIED** |
| FOLLOW while source fix selected; seek/play/pause; another exact marker click | Script contains genuine click/seek/FOLLOW sequence, but guarded by the exact initial pick assertion | **NOT RUN** |
| Layer visibility/rail navigation, event listener ordering and page close/reopen following exact marker selection | Script gated after exact fix; isolated processes closed on both errors | **NOT RUN for successful marker-selection sequence** |
| Authenticated real AIS provider/acquisition | No such data or credentials supplied; fixture has explicit NONLIVE status | **NOT RUN** |

## Next controlled acceptance after other workers finish source writes

Prime reserved **one later quiet Chrome slot** after worker-7, worker-4
renderer and worker-3 UI writes. Do not run the pointer harness while Vite
source or CSS dependencies are being edited. Re-run:

```powershell
python -m ruff check build-tools/ais_observation_pointer_e2e.py
python -m py_compile build-tools/ais_observation_pointer_e2e.py
npx vitest run src/globe/aisPick.ordering.test.ts
python build-tools/ais_observation_pointer_e2e.py
```

For the one authoritative physical-click proof, require all source hashes
stable, one initial document load without HMR/reload, and **record actual
native `scene.pick` and `drillPick` IDs** at the pixel before any proposed
code change. If the topmost tag is vessel/track but `drillPick` contains a
visible `AIS_OBSERVATION` for the **same physical native click**, coordinate
with prime/worker-4 before considering a narrow production pick-order repair.
Such a repair must preserve SAR picks, honor AIS layer visibility, avoid
nearest-position guessing, be deterministic under overlap and have focused
regressions for contact fallback/marker hidden/cleanup. Otherwise report
the exact remaining blocker without inventing successful observation picks.
