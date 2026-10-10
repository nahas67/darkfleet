# Local browser harness integrity review — 2026-10-11

## Scope and evidence status

Independent **read-only source review and fast assertion-test execution** of the DarkFleet browser fixture, UI route reachability, Vite dev source identity, and production bundle provenance. No Chrome, hardware benchmark, Vite service, live network request, operator dataset, or performance timing job was launched in this acceptance lane. No production source, existing operator data, or master document was modified.

**Verified against the current repository without a browser:**

- `python -m pytest build-tools/test_local_browser_harness_integrity.py -q`: **7 passed**. These are meaningful positive and negative checks of pinned/Git file identity, index drift, a changed UI mount source, stale Vite raw-module bodies, and an omitted Cesium-style output file.
- `python -m pytest backend/tests/test_route_reachability_product.py backend/tests/test_route_reachability.py -q`: **31 passed**. The actual frontend import closure and backend route-discovery algorithm are exercised by existing tests; separate unit tests enforce the difference between a literal caller and a product-reachable route.
- `node node_modules/vitest/vitest.mjs run src/intelligence/AdvancedWorkspace.test.tsx src/scenes/LocalSarImportPanel.test.tsx`: **10 passed**, 2 test files. The Local GeoTIFF tab and intake/receipt contract retain their expected shape.
- Ruff on the three scoped Python files and `py_compile`: **PASS**.

The earlier browser acceptance report `docs/LOCAL_SAR_BROWSER_E2E_2026-10-11.md` documents a successfully executed live headless UI import and persistent PNG from a deterministic raster. Its previous measured HTTP/PDF/image behavior remains historical evidence. The newly introduced provenance preflight and Vite `?raw` browser checks have **not been exercised in a fresh browser run**, because this lane was explicitly limited to nonconcurrent lightweight integrity work.

## Corrected fixture provenance gap

**Original defect:** `build-tools/local_sar_browser_e2e.py` previously computed SHA-256 from the current repository TIFF, copied that current TIFF into its temporary inbox, and compared the copy with the dynamically calculated hash. A silently replaced/modified local TIFF could satisfy every one of those self-consistency checks while no longer representing the committed fixture. A `gitHead` string did not anchor the bytes.

**New fail-closed preflight:** `build-tools/local_browser_harness_integrity.py` pins both expected source assets and requires matching **working bytes, Git index blob and Git HEAD blob** before the headless test can start. The preflight runs again at the end. The path must be a regular nonsymlink file. The original source comes from `backend/tests/fixtures/make_fixtures.py`, with seeded RNG `20261001` and a documented sidecar; all pixels are deterministic **synthetic test data**, not observed Sentinel-1 or AIS.

| Git-tracked fixture | File bytes | Pinned SHA-256 | Git blob OID |
|---|---:|---|---|
| `backend/tests/fixtures/cog/fixture_32648.tif` | 703,707 | `c1b231e9b398a285eaa76637078fbcd73db7f18cf5c84e904ccabe75a872b3e4` | `71243062ef15f63f28c06511cb173ef9dd8c6caa` |
| `backend/tests/fixtures/cog/fixture_unreferenced.tif` | 703,279 | `13dc98dfcc7fc2e655a1928aae8882bb6865f14aa5a4fded51d83964c8f0d428` | `9847e1f0627ac91a1893e8abf637697b24cbacf6` |

Negative tests now demonstrate refusal of changed fixture bytes even when the altered bytes could match their own disposable copy, and refusal of a staged Git blob that differs from `HEAD` while the working file itself still matches the pin. Future intentional fixture regeneration requires explicit review/update of pinned sizes and hashes; it cannot pass silently.

## Browser route source and build-identity boundary

**Original gap:** the Local GeoTIFF browser harness hashed only four files before and after execution. It omitted `src/main.tsx`, `src/command/OperationRail.tsx`, `src/command/DarkFleetCommandApp.tsx`, `src/intelligence/AdvancedWorkspace.tsx`, `index.html`, and the FastAPI app router, any of which could change the route while the four measured files remained identical.

**New assertions:** the entry/route/backend chain is included in 11 source hashes, compared again at completion. Five critical UI modules are requested from the existing Vite instance as `?raw` modules, decoded and compared byte-for-byte against their source and pre-captured hashes. Static tests cover malformed/stale raw-module responses and a mutation to `OperationRail.tsx`. The Vite raw-source probes establish a **development server** source correspondence; they do not establish a production deployment's bundle identity or reproduce the browser's executed JavaScript instructions. The earlier harness's `vite_hmr_suppressed` mode is still recorded; suppressed HMR means the tester must re-run after any source changes, even when the initial loaded page remains visible.

`build-tools/buildIdentity.ts` emits production `darkfleet-build-*` metadata and `build-manifest.json`. `build-tools/release_build_verifier.py` separately checks Git HEAD, clean tree, source contract hash, manifest digest, and served production preview bytes. That verifier must be used against an actual clean strict build; a Vite development harness result cannot substitute for it.

## Independent production bundle coverage defect

**Reproduced high-priority gap — prime notified and owns production repair.** In the existing `dist` inspected during this lane, `build-manifest.json` listed **3** bundle files while the directory contained **394** total physical files, including the manifest: **390 served files were unlisted**. The unlisted examples included `cesium/Assets/IAU2006_XYS/IAU2006_XYS_0.json`, `_1.json`, `_10.json`, and further Cesium assets. This is consistent with `buildIdentity.ts` constructing the manifest from `Object.keys(bundle)` while the Cesium plugin copies additional public/static assets. The release verifier iterated `manifest["files"]` and could match an internally consistent digest even though these separately served assets were not covered. The observation is from the inspected local `dist`, and should not be generalized to another build without rechecking its file set.

The reusable `assert_manifest_covers_dist(dist, manifest_files)` assertion rejects physical files absent from a manifest, declared files absent from `dist`, and duplicate/malformed names. Its test builds a disposable tiny bundle, proves the complete-file positive case, then adds a served Cesium-like asset to prove rejection, then proves correct recovery once listed and rejection of a missing listed asset. The test itself does not mutate the real `dist` or production builder. The prime has acknowledged the finding and taken ownership of `build-tools/buildIdentity.ts`, `build-tools/release_build_verifier.py`, and release verification. **Production bundle coverage closure remains PENDING** until the corrected builder and actual clean-preview verifier succeed.

## Read-only notes on other proposed harnesses

The newly available `build-tools/ais_10k_cpu_benchmark.ts` declares a deterministic 10,000-contact synthetic fixture and fixed reference digests, measuring process thread CPU rather than asserting actual GPU frames. `build-tools/ais_webgl_hardware_benchmark.py` has an explicit `--run` gate, checks renderer/vendor against software fallbacks, and uses the existing Cesium application canvas; its default/static mode must never be reported as a hardware run. `build-tools/ais_operator_browser_e2e.py` explicitly labels its 100-contact temporary archive non-live and records source hashes before/after; those hashes alone are insufficient to establish which production build served the source. `build-tools/operator_workflow_browser_e2e.py` uses dedicated loopback ports, a temporary data root and declared non-live evidence limits. All were reviewed **from source only**; neither GPU metrics nor browser workflows from these scripts were run or independently certified in this lane.

An older `build-tools/browser_harness_reverify.py` records `headChangedDuringRun` and `sourceChangedDuringRun` but its `BROWSER_EXECUTED` condition does not include both recorded warnings as a gating criterion. A moving HEAD could therefore leave a successful smoke status. This remains a **separate unmodified reviewer finding** for its owner, not a claim that its previously recorded browser observations are false.

## Handoff

The reusable fast provenance and coverage assertions were added only under `build-tools/`, with the new evidence in this document. **PASS:** fast fixture/source/route unit suites. **PARTIALLY VERIFIED:** the updated Local GeoTIFF browser runner requires a future isolated browser rerun to verify its new `?raw` checks. **BLOCKED on owning production build lane:** authoritative full tree manifest coverage and served strict release proof. No out-of-scope source or release verifier edits were made.
