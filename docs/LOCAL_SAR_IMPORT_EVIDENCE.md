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
Hardlinks and symlinks are refused where exposed by filesystem metadata. The
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
