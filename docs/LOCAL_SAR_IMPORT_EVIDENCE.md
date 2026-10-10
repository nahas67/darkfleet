# DF-X10: Operator-owned local GeoTIFF intake

## Boundary and availability

The independent endpoints are mounted at `/api/sar/local` in the FastAPI application.
They accept **only loopback clients**, enforced from the ASGI connection peer rather
than `Host`, `Origin`, or `X-Forwarded-For`. Starlette's synthetic `testclient` peer
is allowed during offline tests. The default API listener may otherwise bind to
`0.0.0.0`; nonlocal clients receive HTTP 403 on **every** local SAR endpoint.

The default operator inbox is `<configured data_dir>/local-sar-inbox`. An operator
can place a GeoTIFF there using normal local filesystem access, then pass **only the
filename** to the API. Filename subdirectories, URL schemes, absolute paths,
backslashes, NTFS streams, `..` sequences, and symlinks are denied. A trusted
deployment operator may explicitly set `DARKFLEET_LOCAL_SAR_ROOT` to a preexisting
absolute, nonsymlink directory. The API cannot change that path. The service never
downloads URLs or reaches STAC.

There is no automatic SAR scan after an import. The endpoint returns
`IMPORTED_NOT_ANALYZED`; this does **not** mean `COMPLETE`, usable calibrated
backscatter, a detected target, a geolocated observation, or AIS correlation.
The original GeoTIFF, rather than a synthetic sample or a generated substitute,
is the only pixel source.

## API

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/sar/local/status` | `status`, `enabled`, `inbox_name`, `max_file_bytes`, `max_pixels`, `scope`, `analysis`, `extensions` |
| `POST` | `/api/sar/local/import` | HTTP 201; receipt plus current source and snapshot integrity |
| `GET` | `/api/sar/local/imports?limit=100` | `{status: "READY", total, imports: [...]}` |
| `GET` | `/api/sar/local/imports/{import_id}` | Persistent receipt, including current integrity |
| `GET` | `/api/sar/local/imports/{import_id}/image` | RGBA PNG preview or HTTP 409 |

Example request (the file must already exist in the controlled inbox):

```json
{
  "relative_path": "operator-scene-vv.tif",
  "product": "RTC",
  "polarization": "VV",
  "acquisition_time": "2026-09-18T06:30:00Z",
  "calibration": "GAMMA0_LINEAR"
}
```

`product` accepts `RTC` or `GRD`; `polarization` accepts `VV` or `VH`, or can be
omitted; `acquisition_time` must be timezone-qualified when supplied; `calibration`
accepts `UNKNOWN`, `RAW_DN`, `GAMMA0_LINEAR`, `SIGMA0_LINEAR`, `GAMMA0_DB`, or
`SIGMA0_DB`. These values are **explicit operator claims**, not inferred from TIFF
tags or verified against radar calibration LUTs or acquisition metadata.
`calibration_verified` and `acquisition_verified` are always `false`.

An accepted import returns a deterministic 32-character hex `import_id`, source
`sha256`, `status: "IMPORTED_NOT_ANALYZED"`, a persisted creation timestamp,
`source` (including `relative_path` and `origin: "OPERATOR_LOCAL_INBOX"`),
`metadata`, `limitations`, `source_integrity`, `snapshot_integrity`, and `image_url`.
`metadata` includes the measured `width`, `height`, `dtype`, `nodata`, source CRS,
six-value affine, four transformed WGS84 image corners, the WGS84 position of the
**first pixel center** (column/row 0.5/0.5), actual usable/total pixel counts, and
preview sampling shape/stride. It does not claim measured meters per pixel.

## Persistence and integrity

The intake copies at most **64 MiB** while computing SHA-256. It compares the
original file's identity, length and modification time before and after copying.
Hardlinks and symlinks are refused where exposed by filesystem metadata. On
Windows, Python does not expose `O_NOFOLLOW`; the code checks the path before
opening it and the opened file identity during copying, but resistance to a
malicious privileged, concurrent NTFS reparse-point swap is **not proven**.
The Windows symlink test skipped for lack of creation privilege; avoid granting
untrusted local writers access to the inbox. The
snapshot is saved at `<data_dir>/local-sar-imports/{import_id}.tif` by exclusive
creation; an append-only JSON receipt is created at `{import_id}.json` in the
same directory. Repeating the same file, hash, and declarations returns the
same import ID and receipt; changing either creates a distinct historical record.
The source bytes remain available in the snapshot if the inbox file is removed.

Both source and snapshot are rehashed when a receipt is read. Integrity is
reported separately as `VERIFIED`, `MISSING`, `CHANGED`, or `UNAVAILABLE`. A
removed/changed inbox original does **not** silently cause the saved preview to
switch to another source. The image endpoint first checks the archived file's
hash against the persisted receipt, returning HTTP 409 when unavailable or
tampered. A valid snapshot can be viewed after restart even when
`source_integrity: "MISSING"`, with its current status visible on receipt queries.

The GeoTIFF must have one numeric band, finite nonsingular affine, valid CRS,
transformed corners inside the WGS84 domain, and at least one valid pixel.
Raster dimensions are capped at **8 million pixels**, **8192 pixels per axis**.
Inspection scans bounded 512 × 512 windows; the PNG uses bounded nearest-pixel
sampling to a maximum of 768 × 768 RGBA pixels. Masked/no-data and nonfinite
pixels are transparent. Display grayscale is stretched from sampled source values
at the 2nd/98th percentiles, without interpreting the units or fabricating
additional pixels. No GRD calibration, orthorectification, coregistration,
polarization synthesis, or completed analysis is performed.

## Reproducible verification

Execute at the project root with the backend environment installed:

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests/test_local_sar_import.py -q
backend/.venv/Scripts/python.exe -m ruff check backend/darkfleet/local_sar_import.py backend/darkfleet/api/local_sar_routes.py backend/tests/test_local_sar_import.py
```

2026-10-11 local evidence: **24 passed, 1 skipped**, Ruff clean. The skipped test
requires Windows symlink creation privileges that were unavailable; production
code explicitly checks for a symlink and denies it. Tests cover source checksum,
actual transparent grayscale pixels and center georeferencing, idempotent
reimport, restart, inbox removal, archived snapshot tampering, changed source,
invalid CRS/affine/nodata, oversized rasters, hard path rejection, strict body,
hardlink denial, nonaligned/rotated affine transforms, remote connection denial
including spoofed forwarded headers, and explicit
uncertified calibration. This is offline validation with test-created GeoTIFF
files; **no sensor-provided source was examined** and no live STAC integration is
claimed.

An additional local ingestion check copied the previously persisted **derived**
`DF-0001-derived-real-RTC-VV.tif` scene into an isolated temporary inbox; no
runtime data was altered. The importer returned `IMPORTED_NOT_ANALYZED`, SHA-256
`c5d03b07a85fd5c266fa902dfadc3611c6d5ce211eaecff395e618b173776451`,
EPSG:32648, 221 × 223 pixels, 49,283 valid pixels, a 39,958-byte PNG preview,
and `source_integrity: VERIFIED`. This is a **derivative of an existing observed
scene**, not an original provider GeoTIFF or independently validated RTC
calibration. The successful check establishes that the local importer can read
its measured pixel content and georeferencing; it does not establish that this
derivative can be used for new detection analysis.

## Integration and remaining limits

### Live local integration acceptance (2026-10-11)

The prime mounted the new FastAPI router and **Advanced → Local GeoTIFF**
panel, regenerated the canonical OpenAPI-derived TypeScript contract, and ran
the live loopback backend and Vite frontend. The operator inbox contained
`DF-0001-derived-real-RTC-VV.tif`, **a derived copy**, not the original provider
GeoTIFF. It was produced from the persisted **genuine Planetary Computer**
`DF-0001` Sentinel-1 RTC VV scan's measured gamma0-dB raster cache by
conversion back to positive linear values (`10 ** (dB / 10)`), preserving the
recorded native affine grid, pixel geometry and CRS. Derivation/source identity
were explicitly written to GeoTIFF tags. This establishes intake of pixels
derived from a real acquisition; it does **not** independently authenticate
the copied GeoTIFF's calibration, provider asset or sensor metadata.

- The local derived GeoTIFF measured **182,232 bytes**, SHA-256
  `c5d03b07a85fd5c266fa902dfadc3611c6d5ce211eaecff395e618b173776451`.
- `POST /api/sar/local/import` returned HTTP **201** and import ID
  `1fa7533e24cc9c3f968b688ddfc5df5c`, status
  `IMPORTED_NOT_ANALYZED`, separate source and snapshot `VERIFIED` integrity,
  real image shape **221 rows × 223 columns**, **49,283 usable pixels**,
  `EPSG:32648`, and the recorded first-pixel-center WGS84 point
  `(103.8199753363927, 1.259974539433782)` (lon, lat).
- `GET /api/sar/local/imports/{id}/image` served HTTP **200**,
  **39,958-byte** valid PNG. The genuine running Chrome DarkFleet tab opened
  Advanced → Local GeoTIFF (DOM click), displayed the full persisted receipt,
  `GAMMA0_LINEAR · NOT VERIFIED`, original/snapshot checksums and limitations;
  the actual loaded browser image reported **223 × 221** native dimensions.
- New per-file tests **24 passed, 1 skipped** (Windows symlink privilege);
  integration contract/local-import tests **51 passed, 1 skipped**;
  full backend suite **1,246 passed, 12 skipped, 4 deselected**;
  frontend suite **842 passed across 61 test files**;
  Ruff, scoped mypy, TypeScript checking, contract regeneration/check, and
  production Vite build passed. Vite retained its existing >500 kB chunk
  advisory, now **931.75 kB** for the main JS asset.

The backend process was restarted after the import. The original JSON receipt
was created at **2026-10-11 01:05:13 Asia/Kolkata**; the currently running
Uvicorn parent/child processes started at **01:11:44**, later than that receipt.
At this continuation, fresh HTTP requests to the restarted loopback service
returned `GET /status` **200 READY** (`LOOPBACK_ONLY`, `IMPORT_ONLY`),
`GET /imports` **200** (one persisted record), and `GET /imports/{id}` **200**
with the original ID, `IMPORTED_NOT_ANALYZED`, `source_integrity: VERIFIED`,
`snapshot_integrity: VERIFIED`, SHA-256 and 223×221 EPSG:32648 metadata.
`GET /imports/{id}/image` returned **200 image/png**, **39,958 bytes**.
Independent read-only source and archived TIFF checksum checks matched the
receipt digest. This **closes the live post-restart read gate**; no extra import,
sensor scan, synthetic observation or analysis was created by these checks.
The restart durability/missing-source behavior is also exercised in offline
integration tests. No imported source was promoted into a canonical scan.

### Final follow-up fixes and fresh gates

- Local backend commit `cf5eafb` handles a source disappearing after path
  validation but before file stat/open: safe `SOURCE_NOT_FOUND` HTTP 404 or
  `SOURCE_UNAVAILABLE` HTTP 409 rather than an unhandled file-path-bearing 500.
  Three injected-race cases assert refusal status, unchanged original/receipt,
  independent snapshot integrity and no temporary-file residue. **27 focused
  backend tests passed, 1 skipped** for Windows symlink privilege.
- Frontend commit `c1fb4f0` preserves the real FastAPI refusal code from
  `ApiError.detail` without rendering arbitrary server messages; Advanced's
  eight tabs now scroll horizontally without losing keyboard Arrow/Home/End
  focus or tabpanel labelling. A real-envelope error regression and an Advanced
  layout/semantics regression were added.
- Post-fix full offline gates: **1,249 backend passed, 12 skipped,
  4 deselected, 0 failed** (4 warnings); **844 frontend passed in 62 files**;
  Ruff, scoped mypy, TypeScript, generated API contract `--check`, and Vite
  production build passed. The production JS chunk remained **932.15 kB**
  with the existing >500 kB advisory.
- The updated backend was intentionally restarted again at **2026-10-11
  01:26:44 Asia/Kolkata**, listening on **127.0.0.1:8000**. Fresh status/list/
  detail/image requests still returned `READY`, one durable
  `IMPORTED_NOT_ANALYZED` import, `VERIFIED` source/snapshot integrity,
  EPSG:32648 **223×221** pixels and PNG HTTP 200 (**39,958 bytes**). A POST
  for a definitely absent inbox basename returned **HTTP 404** with structured
  `LOCAL_SAR_IMPORT_ERROR` / `SOURCE_NOT_FOUND`; no import was created. The
  browser had earlier loaded the genuine saved record and PNG, but the shared
  Chrome tab was claimed by another owner during this final follow-up; **no
  new post-fix browser DOM interaction is claimed**.

### Scope boundary

The API router lives in `darkfleet.api.local_sar_routes` and exposes `router`.
Register it once in `darkfleet.api.app.create_app` using
`application.include_router(local_sar_router)`. The owner of `app.py` performs
that mount; the import implementation does not edit shared application files.

The intake records isolated source provenance only. The canonical SAR/AIS pipeline
requires separate verified, calibrated data and a deliberately designed contract
before ingesting archived pixels. Operators must verify calibration, source
authorization, acquisition time and additional SAR-specific metadata externally
before treating source pixels as suitable for detection. Existing scans and
their persistence semantics remain unchanged.
