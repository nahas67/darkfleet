# SAR science and GeoTIFF intake reverification — 2026-10-11

## Scope and measurement status

Independent worker review of `backend/darkfleet/sar/`, `backend/darkfleet/detectors/`, `backend/darkfleet/geolocation.py`, `backend/darkfleet/local_sar_import.py`, and `backend/darkfleet/sar_scene_imagery.py`, tracing calls from the canonical `pipeline.py`. This record concerns deterministic scientific integrity and source handling; the checked-in SAR fixtures are **test inputs**, not independently observed or independently verified Sentinel-1 measurements. No live SAR acquisition, calibration LUT acquisition, live AIS matching, or in-situ ship-truth validation was performed.

## Reproduced defects and repairs

1. **AOI clamping selected unrequested pixels:** `sar/georef.py` previously changed a negative window offset to zero while preserving width, reading extraneous raster columns. In a reproducible 25-column request overlapping the scene by five columns, `read_window` returned 25 columns. An entirely disjoint request also returned data. Strict geometric intersection now returns only five overlapping columns and raises `RealDataUnavailableError` for no overlap. See `test_georef.py` partial/disjoint tests.
2. **Window transform guard missed critical information:** `geolocation.assert_window_consistency` omitted shear/rotation coefficients `b/d` and interpreted the stored window tuple as column/row when the SAR reader records row/column. Rotated-transform regression confirms all six affine elements are verified with the correct offset order. `pixel_to_wgs84` now refuses out-of-range WGS84 longitude/latitude, in addition to nonfinite coordinates. Sample indices continue to apply the `+0.5` pixel-centre rule in the authoritative implementation.
3. **CFAR small windows crashed instead of yielding zero candidates:** CA-CFAR attempted a negative-sized training box when a clipped SAR window was narrower than the training annulus, raising `ValueError`. It now returns a correctly shaped all-false detection mask and NaN thresholds. Golden parity remains unchanged for supported larger windows.
4. **WorldCover gaps were treated as surveyed water:** `sar/landmask.py` used `(class != 80) & (class != 0)` as its exclusion mask. Out-of-coverage destination pixels defaulted to class 0 and were silently treated as open water. The new mask excludes class 0 as **unknown** after coastline buffer and port exceptions, and separately reports `unknown_fraction`, `excluded_fraction` and `nodata_policy=EXCLUDED_UNKNOWN_NOT_WATER`. `land_fraction` still means classified/excluded land and does not disguise unknown pixels as land.

## Genuine WorldCover source clip for the UTM test fixture

The former `backend/tests/fixtures/mask/worldcover_sg_clip.tif` spans longitude **103.65–104.05 E**, whereas `fixture_32648.tif` lies around **104.101–104.137 E**. Their longitudinal footprints do not overlap. Thus the former landmask supplied **zero** WorldCover coverage for the 400×400 UTM fixture, and previous class-0 handling mistakenly passed all pixels as water. Independently, `fixture_source.FIXTURE_BBOX` had a north-shifted latitude range of **1.3569–1.3931 N**, despite the SAR fixture extending approximately **1.32075–1.35693 N**. Its previously complete-looking output depended on the erroneous clamp.

For a coverage-correct test fixture, a new clip was retrieved from the official ESA WorldCover v200 2021 N00E102 endpoint:

`https://esa-worldcover.s3.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N00E102_Map.tif`

- New fixture file: `backend/tests/fixtures/mask/worldcover_utm32648_clip.tif` (15,761 bytes)
- SHA-256 of **local extracted clip**: `582da459913dcda51a5030ffa00a9fea7da0ae6ffe930c2b2e1266e21786606f`
- Extraction: rasterio `/vsicurl/`, band 1, raster window `(row=19560, col=25080, height=720, width=720)`, GTiff DEFLATE-compressed.
- Measured CRS: EPSG:4326. Extent: `[104.09, 1.31, 104.15, 1.37]` (lon/lat). Pixel spacing: 0.00008333333333333333 degrees.
- Source class histogram: class 10: 21,356; 30: 11,235; 40: 19; 50: 17,123; 60: 61,610; **80: 406,975**; 90: 82.
- Reprojected onto the UTM fixture with 150 m coastline exclusion, result had **0% unknown coverage**, **9.243125% land exclusion**, and all three known fixture component centers `(row,col)=(120,200),(250,300),(310,150)` remained unmasked. Independent point sampling on the ESA tile also returned class 80 at each center.
- Companion provenance: `worldcover_utm32648_clip.provenance.json`, which pins the local checksum, upstream URL and extraction window. **A checksum of the entire upstream ESA tile was not independently verified.** Treat that upstream origin as an endpoint-based acquisition claim, not a full authenticated chain of custody.

The shared fixture source is coordinated separately with the prime to use the corrected bounding box and new mask clip; neither a disjoint AOI nor uncovered land pixels may be accepted as equivalent to genuine water coverage.

## Verification

Before repairs, focused regressions failed for AOI partial overlap, disjoint AOI, corrupted affine shear, undersized CFAR grid and out-of-range WGS84 coordinates. With the corrected UTM fixture/default mask, executed:

`python -m pytest -q backend/tests/test_pipeline.py backend/tests/test_cfar_parity.py backend/tests/test_preprocess_mask.py backend/tests/test_georef.py backend/tests/test_geolocation.py backend/tests/test_local_sar_import.py backend/tests/test_sar_scene_imagery.py`

Final rerun including the extracted WorldCover clip checksum assertion: **95 passed, 1 skipped**, six warnings. Windows source symlink creation test was skipped because the local account lacked privilege to create a symlink. The other local source race, path validation, archive checksum, pixel-centre and rendered-image checks passed. Ruff scoped to changed source/tests passed. The wake/correlation regression suite separately returned **16 passed** after replacing its stale AOI with the measured fixture footprint.

## Residual limitations / follow-up gates

- **CRS-aware coastline buffer distance (open, pipeline ownership):** `pipeline.rasterio_res` returns affine coordinate units and `_real_land_mask` passes that value to `coastline_buffer_m / pixel_spacing_m`. For geographic EPSG:4326 imagery at 0.0001 degree/pixel, it can calculate 1.5 million morphology iterations for a 150 m buffer instead of roughly 13–15 pixels. Geographic and non-metre projected sources need CRS-aware ground distance calculation, numerical guards and tests in the pipeline owner’s scope. The matched UTM test fixture uses measured 10 m pixels, so this defect does not explain its current passing fixture tests.
- **Windows filesystem race residual:** local GeoTIFF intake revalidates resolved path, regular-file stat, handle stat, read length and SHA-256. Windows does not provide POSIX `O_NOFOLLOW` semantics through this Python path; the tests do not establish complete protection from deliberately concurrent Windows reparse-point/handle substitution attacks. The symlink test is skipped under current account privileges. Filesystem ACL isolation and handle-level final-path verification would be separate hardening.
- **Radiometric authenticity:** `import_local_geotiff` is import/preview only (`IMPORTED_NOT_ANALYZED`). Its operator-supplied acquisition, product, polarization and calibration declarations remain unverified. The canonical GRD path correctly refuses to treat DN as sigma0 when calibration LUT is absent. Offline test fixture scenes establish code behavior, not real-scene radiometric accuracy, land-cover age applicability, a validated false-alarm rate, or vessel recognition performance.
- **Imagery provenance:** `sar_scene_imagery.py` verifies cached RTC NPZ checksum and shape/dtype/ZIP bounds before materialization. A locally recomputed checksum is tamper evidence against accidental changes, not a remote-provider signature, and the two-scene view asserts no coregistration or change detection.

No claim of live-production science validation is made here.
