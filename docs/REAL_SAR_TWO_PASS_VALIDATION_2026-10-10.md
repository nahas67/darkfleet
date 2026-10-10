# DF-X10/X11 — Two genuine Sentinel-1 RTC acquisitions, local restart acceptance

**Date:** 2026-10-10 UTC. **Classification:** *REAL provider and measured
source pixels*; **not** a vessel, AIS coverage, illegality, or change-detection
validation. These checks were run on the live local FastAPI app and persisted
data in the normal `data/` runtime directory, not a seeded unit-test fixture.
Preserve those runtime records and do **not** check in signed COG URLs/tokens.

## Acquisition and reproducible identifiers

The real Planetary Computer provider health probe returned `AVAILABLE` and
`GET /api/scenes` on bbox `[103.82,1.24,103.84,1.26]`, datetime
`2025-01-01T00:00:00Z/2026-10-01T00:00:00Z`, returned 10 real RTC catalogue
entries (`synthetic=false`). Two different acquisitions were then pinned via
`POST /api/scans`, using provider `planetary-computer`, product `rtc`, the
same bbox, and datetime `2026-09-01T00:00:00Z/2026-09-30T23:59:59Z`:

| Persisted ID | Real source catalogue item | Acquisition UTC | Result |
|---|---|---|---|
| `DF-0001` | `S1D_IW_GRDH_1SDV_20260927T112445_20260927T112510_004762_008EC4_rtc` | 2026-09-27 11:24:58.180786 | `COMPLETE`, RTC VV, `synthetic=false`; measured one **SEA_CLUTTER** target, no AIS matches |
| `DF-0002` | `S1D_IW_GRDH_1SDV_20260916T224721_20260916T224746_004609_00897D_rtc` | 2026-09-16 22:47:33.583752 | `COMPLETE`, RTC VV, `synthetic=false`; zero connected components at the chosen CFAR settings |

The backend emitted real source-read/computation logs:

- Both: RTC window **223 × 221**, 10 m raster, Planetary Computer STAC,
  calibration RTC, median speckle filter and land mask (91.2% land-buffer mask),
  CA-CFAR training 16, guard 4, alpha 3.5. Processing times **7.303 s** and
  **6.901 s**, measured by the local job runner (not provider p95 SLA).
- First scan: 4 CFAR candidate pixels → 1 connected component; WGS84 target
  position **(lon 103.82656510323231, lat 1.2564822786737102)**, type
  **SEA_CLUTTER**, SAR confidence 0.44, 3 px, apparent length 15 m,
  width 10 m, no detected wake. This classification is **not** a confirmed
  vessel, and its dimensions do not prove hull length.
- Both scans loaded **zero AIS observations** because the local AIS archive is
  `NOT_CONFIGURED`; empty association is **not** evidence of AIS silence.
  Single-channel VV is authentic; no VH pixels/ratios were fabricated.

## Scientifically gated two-scene numerical measurement

`POST /api/sar/imagery/pair` with IDs `DF-0001`, `DF-0002` returned
**`READY`** for each with
`source=PERSISTED_REAL_SCAN_CHECKSUM_VERIFIED_RTC`, recorded raster arrays
**[221,223]**, 49,283 finite source pixels per scene. Both local PNG image
routes returned HTTP **200**; `/api/sar/imagery/scans/DF-0001/image` returned
59,344 bytes after backend restart. Images use identical fixed grayscale
display window, not rescaled independently to imply contrast changes.

`POST /api/sar/compare` with the same IDs returned **`MEASURED`** and reason
`EXACT_SAME_AFFINE_PIXEL_LATTICE_RTC_GAMMA0_DB`. Both scenes were
`EPSG:32648`, with the identical 10 m affine window transform
`[10,0,368710,0,-10,139300]`, raster dimensions `[221,223]`, processing
version `DarkFleet-Core 3.0.0`, RTC gamma0 VV and zero pixel offset.

| Valid paired source-pixel metric | Measured result |
|---|---:|
| Overlap and valid paired pixels | 49,283 / 49,283 |
| Paired valid fraction | 1.0000 |
| Acquisition interval (absolute) | 252.623499176 h |
| Mean B − A (dB) | −0.0290979690 |
| Mean absolute difference (dB) | 3.7565446891 |
| RMS difference (dB) | 5.0424067226 |
| Median B − A (dB) | 0.0338287354 |
| 5th / 95th percentiles B − A (dB) | −8.2858850241 / 7.9714802742 |
| B brighter / B darker / equal valid pixels | 24,816 / 24,467 / 0 |

**Direction:** B is September 16 (older), A is September 27 (newer); the
reported B−A sign must never silently become a forward-in-time trend.
The computation demonstrates equal **recorded pixel lattice** and real
paired RTC backscatter differences. It does **not** establish subpixel
co-registration, absolute radiometric stability, causes of change, vessel
identity or illegal behavior. Geometry match alone is insufficient to call
any individual pixel an observed vessel change.

## Restart and negative acceptance

After both normal production scans finished, the backend process was stopped
and relaunched from `backend/.venv/Scripts/python.exe -m darkfleet`. Fresh
`POST /api/sar/imagery/pair` returned `READY` for both persisted scans, fresh
`POST /api/sar/compare` returned `MEASURED` with the exact same 49,283 valid
paired pixels, and local PNG GET returned HTTP 200. This verifies **local
storage restart recovery for these two real source records and cached arrays**.

## Real-browser paired imagery verification (later, same day)

In the existing actual Chrome DARKFLEET app tab, opened **Advanced → SAR
imagery** and observed source-backed selectors automatically populated with
`DF-0001` and `DF-0002` after the backend restart. Clicked **Display stored
imagery** (real browser input). The UI displayed `Pair availability: READY`,
`First · DF-0001`, `Second · DF-0002`, and `VERIFIED RTC CACHE` with distinct
acquisition IDs/times and identical fixed -30 to +5 dB display scale. Direct
page inspection verified **both image elements finished loading**, each with
`naturalWidth=223` and `naturalHeight=221`, through the two separate same-origin
`/api/sar/imagery/scans/{scan_id}/image` routes. Clicking **First zoom in**
changed only the first pane to `1.50×`; the second remained `1.00×`. This
verifies independent pan/zoom ownership without asserting subpixel alignment.

## Case-linked source and analyst verification

Created a local persisted operator investigation
`11b284a1-bdc3-4a85-bfdc-bdaa325e99cf` linked to authoritative REAL
`DF-0001` with bounded operator note linked to the one `SEA_CLUTTER` return
`DF-001` and one watched target for **validation/review only**. The actual
browser Reports notebook read back the new case, displayed its linked scan,
operator note and watched target, and kept the note separate from source
observations. The report JSON route returned `source_status=PERSISTED_REAL`,
one recorded target and operator material with distinct provenance; its
actual sensor metadata included Sentinel-1 RTC VV, EPSG:32648, 10 m and source
acquisition time. The source record had **no authoritative AIS coverage**,
correctly leaving that information not established.

The first real linked-case analyst run exposed a legitimate class-allowlist
defect: the persisted scan correctly stored `SEA_CLUTTER` in `$.targets[0].cls`
(the public HTTP target API serializes this as `classification`), but the
analyst's old five-class allowlist excluded it. Before the fix, it incorrectly
returned `CLASSIFICATION_NOT_ESTABLISHED`. Commit `a377d52` recognizes all
seven canonical processing classes, cites the original stored field rather
than the HTTP alias, supports an explicitly distinct migrated representation,
and refuses conflicting duplicate class fields.
After restarting the server, the same real-source case produced **7 claims,
2 explicit unknowns** instead of 6 claims / 3 unknowns. The classification
unknown disappeared; the unresolved fields remain `AIS_NONMATCH_NOT_NONREPORTING`
and `AIS_COVERAGE_NOT_ESTABLISHED`. Focused analyst tests **7/7 passed**.

**Remaining:** No genuine AIS history is configured, so no observed
SAR↔AIS correlation E2E; no subpixel co-registration, calibrated wake truth
corpus, dual-pol co-registered evidence or validated SAR vessel change
classification. Browser PNG display is acceptance evidence for this exact
real source pair only, not a blanket scene/provider benchmark.
