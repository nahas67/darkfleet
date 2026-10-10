# DF-X10/X11 — Verified-Grid SAR Scene Comparison

**State:** Implemented as isolated backend route and standalone React workbench; router and UI integration await prime-owned mount. No live acquisition, sensor simulation, provider calls, or synthetic operational data. This reports differences between saved source pixels, **not vessel change**.

## Inspection of existing flow

The current real acquisition pipeline selects an actual STAC scene, validates georeferencing, reads a raster window with rasterio, and persists its native source CRS and measured **window affine transform** alongside acquisition identity, product and polarization. The scan record resides in data/scans/SCAN_ID.json and its normalized debug raster in the content-addressed cache beneath data/cache/. Its normalized cache layer maps to pipeline RTC raw_db (gamma0 decibels). ArtifactCache validates original bytes with SHA-256, dtype and shape. No new storage format was invented here.

The existing visual-only Analytics ScanComparePane displays two independently rendered rasters and mirrors zoom/scroll. It expressly does **not** align source pixels or compute scientific change. Existing AdvancedWorkspace multi-pass functionality constructs tentative track hypotheses and acquisition revisits but lacks a pixel-domain calibrated scene difference comparison. Those prime-owned modules remain unchanged.

## Scientific and evidence constraints

The new pure read-only compare_scenes(data_dir, first_scan_id, second_scan_id) reads only existing RunStore files and checksum-verified cached arrays. It refuses numeric comparison unless all constraints pass:

1. Two distinct persisted REAL, synthetic-false records with distinct item identifiers and valid, distinct timezone-aware acquisition times.
2. Both are RTC, gamma0 dB products from the same provider, collection, platform, polarization and processing version. GRD is refused because radiometric calibration LUT and normalization cannot be assumed.
3. Saved source SAR provenance agrees with the recorded scene item, acquisition, provider, processing domain, CRS, native window transform and raster window.
4. Both CRSs parse and represent the same CRS; their six-parameter affine linear grids match pixel spacing, skew and orientation. Their origin shift must resolve to **whole pixel** row/column offsets within 1e-6 pixel. No reproject, warp or interpolated co-registration occurs.
5. The two original 2-D float arrays exist in checksum-verified cache, with shapes matching their recorded window sizes, and a positive common pixel overlap.
6. At least one corresponding overlap pixel is finite in both sources. Nonfinite values are excluded, never assumed to be zero.

Pixels are sliced from the native source arrays at the identical integer affine lattice locations. A nominal AOI intersection is **not** used to infer pixel identity or resolution. Even an identical affine lattice is not proof of sub-pixel coregistration or radiometric stability. Differences can reflect weather, tides, incidence angle, thermal/noise conditions and acquisition geometry. No identity, target change, SAR vessel alert, causality, or illicit-activity inference is made.

If valid, the response status is MEASURED, with the source scan IDs, source item identifiers, acquisition times, CRS, native window affine, source shape, processing version and calibrated source assertion. The descriptive SAME_PIXEL_RTC_GAMMA0_DB_DIFFERENCE metrics are: overlap shape, relative integer offset, overlap pixels, valid paired pixels/fraction, mean second-minus-first dB, mean absolute dB, root-mean-square dB, median and fifth/95th percentile dB, and sample counts for positive, negative and exactly zero differences.

If any precondition fails, the response is NOT_COMPARABLE, metrics=null, and an explicit reason. Supported reasons include PERSISTED_REAL_SCAN_MISSING; DISTINCT_REAL_ACQUISITIONS_REQUIRED; DISTINCT_ACQUISITION_TIMES_REQUIRED; ACQUISITION_TIMESTAMPS_NOT_VERIFIED; RTC_GAMMA0_CALIBRATION_REQUIRED; SAR_CALIBRATION_OR_GEOREFERENCE_PROVENANCE_MISSING; DIFFERENT_SOURCE_PROCESSING_DOMAIN; POLARIZATION_MISMATCH_OR_MISSING; PROCESSING_VERSION_MISMATCH_OR_MISSING; MEASURED_WINDOW_GEOREFERENCE_MISSING; CRS_INVALID; CRS_MISMATCH_NO_WARP; AFFINE_GRIDS_NOT_IDENTICAL_NO_COREGISTRATION; CALIBRATED_CACHE_MISSING_OR_CORRUPT; RASTER_WINDOW_SHAPE_INCONSISTENT; NO_OVERLAPPING_MEASURED_PIXELS; NO_SHARED_VALID_RTC_SAMPLES; and NUMERIC_DIFFERENCE_INVALID. It does not return synthetic zero differences.

The handler also refuses unreferenced identity transforms, implausible saved RTC dB values outside [-200, 200] as RTC_DB_VALUES_OUT_OF_RANGE, and overlap larger than eight million paired samples as WINDOW_TOO_LARGE_FOR_BOUNDED_COMPARISON. These limits favor an explicit unmeasured status over unsupported precision or large unbounded numeric work.

## New unmounted API: prime integration

The separate router is backend/darkfleet/api/sar_compare_routes.py. It defines:

| HTTP | Path | Result |
| --- | --- | --- |
| GET | /api/sar/compare/scans?limit=100 | SceneCandidatesOut: source REAL scan catalogue and raster/georeference metadata availability (maximum 200) |
| POST | /api/sar/compare | SceneComparisonOut: MEASURED or NOT_COMPARABLE, with source provenance and metrics only when validated |

POST body: JSON fields first_scan_id and second_scan_id, both distinct safe bounded scan IDs. Invalid IDs, unknown parameters and traversal are HTTP 422; missing source scans or incompatible valid IDs produce an explicit NOT_COMPARABLE object.

**Prime mount instructions:** import router as sar_compare_router from darkfleet.api.sar_compare_routes into backend/darkfleet/api/app.py and include_router(sar_compare_router) beside the other independent routers. **This worker did not change api/app.py.**

For generated TypeScript contract coverage, prime may register SceneCompareRequest, SceneIdentity, ComparisonMetrics, SceneComparisonOut, SceneCandidateOut, SceneCandidatesOut in backend/tools/export_contract.py and regenerate src/api/contract.ts after the current concurrent writes reconcile. This worker did not modify either prime-owned file.

## New standalone UI: prime integration

src/advanced/SceneComparisonWorkbench.tsx exports the independently mountable SceneComparisonWorkbench React component. It loads the REAL saved scan catalogue, supports first and second acquisition selection, refresh, and explicit comparison. It displays source identifiers, acquisition and processing metadata, read-only overlap counts and dB statistics only for MEASURED, or a visible NOT_COMPARABLE explanation without fabricated metrics. Client-side input and response validators reject missing numeric values, invalid source classifications or mismatched scan IDs.

**Recommended mount:** import SceneComparisonWorkbench into src/intelligence/AdvancedWorkspace.tsx as a new Scene Comparison tab beside the current Revisit and Multipass tabs. Alternative placement inside Analytics is also possible; prime owns both. The existing visual-only ScanComparePane remains unchanged. No modifications to src/analytics, src/intelligence, src/command, src/globe, src/reports, backend/darkfleet/api/routes.py/models.py, or docs/master were made here.

## Verification

Commands from backend:

~~~powershell
.venv/Scripts/python.exe -m pytest tests/test_sar_scene_compare.py -q
.venv/Scripts/python.exe -m ruff check darkfleet/sar_scene_compare.py darkfleet/api/sar_compare_routes.py tests/test_sar_scene_compare.py
.venv/Scripts/python.exe -m mypy --follow-imports=silent --disable-error-code=valid-type darkfleet/sar_scene_compare.py darkfleet/api/sar_compare_routes.py
~~~

Commands from root:

~~~powershell
npm test -- --run src/advanced/SceneComparisonWorkbench.test.tsx
npm run lint
npm run build
~~~

Backend tests use only temporary explicit REAL/synthetic-false **test fixtures** stored with actual RunStore and ArtifactCache adapters. They test an integer-shifted known window overlap, exact 1/1/2 dB differences, exclusion of NaN, byte-for-byte read-only source integrity, repeated restart-safe access, all important incompatibilities, missing/corrupt caches, bogus legacy synthetic flags, altered provenance, and mounted-test application HTTP validation. These fixtures are scientific test inputs, not claims of real Sentinel acquisition.

Frontend tests check strict status and measurement response validation, source identity, real endpoint verbs/payloads, missing-difference refusal and standalone SSR controls.

## Remaining gaps

Mounting both backend router and UI tab is delegated to the prime agent to avoid editing shared ownership. No automatic scan scheduler, subpixel registration, multi-band or cross-platform calibration, GRD LUT support, full-scene warping, spectral ratio-based detection, CFAR-on-difference, vessel identity linkage, or live remote provider comparison is implemented. The read-only cache currently loads full stored window arrays to compute bounded aggregate metrics; very large sources may need a chunked numerical reader. Current visual comparison remains independent of numeric scientific comparison and should not be described as co-registration.
