# DarkFleet Removal Log

> Hard rule: no useful capability disappears silently. Every intentional removal
> records old feature, reason, replacement, migration, and verification.
> An undocumented removal is a failure.

| Date | Old feature | Reason | Replacement | Migration | Verification |
|---|---|---|---|---|---|
| 2026-10-01 | `server.ts` DEMO pipeline | Duplicate TypeScript implementation of a detector that now has one Python authority. Three copies existed (`App.tsx:141`, `server.ts:139`, `src/engine/*`); two agreeing implementations cannot be trusted. | `backend/darkfleet/pipeline.py` + `darkfleet/demo.py` | Python port verified field-by-field against a golden fixture captured from the live TS engine (97 detected px, 12 components, 12 targets). | `tests/test_cfar_parity.py` (mask 100%, 0/97 differ) · `tests/test_correlation_parity.py` (12/12 classifications, positions, associations exact; ≤1.11% distance delta from the mandated geodesic upgrade) |
| 2026-10-01 | `App.tsx:238-246` silent REAL→DEMO fallback | Spec-forbidden anti-pattern: a REAL request silently returned synthetic evidence. | Explicit `RealDataUnavailableError` with a `ProviderStatus` code; the API returns 503/400 and persists nothing. | Pipeline raises; `RunStore` rejects mismatched mode/synthetic pairs. | `tests/test_pipeline.py::test_real_mode_without_provider_raises_no_synthetic_data` · `tests/test_pipeline_integration.py::test_real_mode_failure_persists_nothing` |
| 2026-10-01 | `App.tsx:212-217` + `:253-256` fake timer stage progression | Fabricated progress. | Real 15-state job machine; stages fire from the pipeline callback as work completes. | `jobs/` + `pipeline.run_scan(on_stage=...)`. | `tests/test_jobs.py` (19) · `tests/test_pipeline.py::test_demo_scan_walks_every_stage_in_order` |
| 2026-10-01 | `src/engine/{cfar,correlation,geodesy,rasterSynthesis}.ts` business logic | After the Python authority reached full parity, keeping a second detector implementation risks divergence — explicitly forbidden. | `backend/darkfleet/sar/*`, `correlation/*`, `demo.py` | Frontend becomes an API consumer; `types/darkfleet.ts` is retained as the wire-contract mirror only. | Parity suites above; frontend typecheck + unit tests at CP8 |

## Frontend removals — queued, NOT yet executed

These are pending UI parity verification (CP8–CP11) and will be executed only
once `docs/UI_FEATURE_MIGRATION.md` shows the replacement shipped. See that file
for the per-capability disposition.

1. `src/App.tsx:runLocalScan` — third TS copy of the pipeline.
2. `src/components/Header.tsx` — legacy top bar.
3. `src/components/TacticalMap.tsx` — demoted to ANALYSIS workbench first; the
   file is deleted only after its dB probe, AOI box-select, and colormaps are
   reimplemented (UI-016).
4. `src/components/ScanWorkflowBar.tsx` — superseded by real job events.
5. `src/components/TargetInspector.tsx` / `components/target/TargetCard.tsx` —
   merged into one progressive-disclosure evidence inspector.
6. `src/components/AISTelemetryTable.tsx` / `panels/TelemetryOverlay.tsx` —
   merged into the Contacts surface with sorting and bidirectional sync.
7. `src/index.css` unused tokens and the dead `.scanlines` class.
