# Feature Preservation Contract

> Complements `UI_FEATURE_MIGRATION.md` (UI surface) with **non-UI** capabilities
> that must survive the rebuild. Each row: capability → where it lives now →
> where it must live → gate that proves it.
>
> **Status note, 2026-10-02.** This table was written at CP0, when the
> TypeScript engine was the incumbent and Python was the port. Every "Lives now"
> cell below therefore names a file that has since been **deleted**, and each is
> annotated with where the capability actually lives now. Two rows are retired
> outright rather than migrated, because the capability itself is gone. See
> `REMOVALS.md` for the dated entries.

| Capability | Lives now (CP0 — all deleted since) | Must live / actually lives now | Proof gate |
|---|---|---|---|
| Deterministic DEMO synthesis (seeded) | ~~`rasterSynthesis.ts` + `server.ts`~~ | **RETIRED, not preserved.** The capability is gone from the product: `backend/darkfleet/demo.py` was deleted 2026-10-02, and no scene synthesiser exists anywhere in the repo. Test determinism is now provided by a checked-in COG fixture, not by a generator. | Retired at `REMOVALS.md` 2026-10-02. `tests/test_no_synthetic_in_product.py::test_the_scene_synthesiser_module_does_not_exist` |
| CA-CFAR + components + correlation math | TS engine (3 copies) | Single Python authority, parity-proven: `backend/darkfleet/sar/{cfar,components}.py` + `backend/darkfleet/correlation/match.py` | CP3 (TST-002) — `tests/test_cfar_parity.py`, `tests/test_correlation_parity.py` |
| Geodesy (haversine→geodesic upgrade) | `geodesy.ts` | Python `sar`/`correlation` (pyproj.Geod) — `backend/darkfleet/correlation/geodesy.py` | CP5 (TST-001) |
| Score decomposition | `correlation.ts` | Backend-persisted per candidate — `backend/darkfleet/correlation/match.py` | CP5 |
| Provenance object | `ScanResult.provenance` | Persisted evidence record — `backend/darkfleet/evidence.py` | CP6 |
| GeoJSON/KML/analytical-JSON generators | `export.ts` | Backend `exports/` (+PNG/PDF) — `backend/darkfleet/exports/render.py` | CP12 |
| REAL-mode refusal honesty | ~~`server.ts` 503 block~~ | Capability-based provider errors — `backend/darkfleet/providers/__init__.py` raises `RealDataUnavailableError`; `backend/darkfleet/pipeline.py` has no fallback branch to degrade into; `api/routes.py` renders it as an explicit 4xx/5xx and persists nothing. | CP7 (TST-012) — `tests/test_pipeline.py::test_unknown_provider_raises_and_writes_nothing`, `tests/test_pipeline_integration.py::test_provider_failure_persists_nothing` |
| Scenario fixtures (5 regions) | `scenes.ts` | **RETIRED as scenarios.** `src/data/scenes.ts` was deleted 2026-10-02. Real water-body naming is served instead by `backend/darkfleet/marine.py` (GEO-001, Natural Earth public domain), and real scene discovery by `GET /api/scenes` proxying the provider. There is no synthetic scenario pack to preserve. | `tests/test_marine.py`; `REMOVALS.md` 2026-10-02 |
| SAR chip (24×24 + clutter stats) | `cfar.ts` chip extraction | Evidence imagery — `backend/darkfleet/sar/components.py` | CP3/CP10 |
| Proximity-pair detection | `correlation.ts:281-294` | **NOT YET PORTED.** The TS implementation is deleted and no Python equivalent exists; `backend/darkfleet/temporal.py` covers association-gap, repeated-unmatched and convergence patterns, not proximity pairs. Tracked open as COR-015 ⚪ NOT IMPLEMENTED. | CP5 (unmet — see `MASTER_FEATURE_PARITY.md`) |
| Ghost/AIS-only counting | `correlation.ts:296-302` | Real AIS_ONLY targets — `backend/darkfleet/correlation/match.py` | CP5 |
| SAR overlay colormaps (sar-mono/contrast/thermal) | `sarOverlay.ts` | Unified colormap system — `src/analysis/AnalysisWorkbench.tsx` (`RASTER_COLORMAPS`) | CP9 |
| AIS dead-reckoning tracks | `aisTracks.ts` | Propagation maths — `backend/darkfleet/correlation/geodesy.py`. Drawn as the `AIS_CONTACTS` / `AIS_TRAILS` registry layers in `src/globe/registry.ts`. Multi-pass track *hypotheses* are `backend/darkfleet/tracks.py` (`/api/tracks`), which never claims a confirmed identity. | CP9 |
| Footprint + uncertainty visuals | `sceneFootprint.ts` + 2D rings | Registry layers `SAR_SCENE_FOOTPRINT` and `UNCERTAINTY_RADII` in `src/globe/registry.ts` | CP9 |

## Non-negotiables

1. No capability above disappears without a `REMOVED_WITH_JUSTIFICATION` row.
2. The TS engine is retired only after TST-002 parity passes (REMOVALS.md entry).
   **Satisfied 2026-10-02:** the parity suites still pass against the golden
   fixture, and the TS engine is deleted.
3. UI copy neutralization (UI-022) is a preservation fix, not a removal.
4. Final audit (CP16) diffs this list against the shipped product.
5. **Added 2026-10-02:** the single analytical authority is not only a rule, it
   is the reason the second TypeScript implementation had to go. If a future
   capability appears to need a frontend implementation of detection or
   correlation, that is a preservation failure, not a new capability.
