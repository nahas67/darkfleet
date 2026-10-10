# SAR imagery visual evidence: independent RTC acquisition viewer

## Scope and authority

`backend/darkfleet/sar_scene_imagery.py` reads the locally persisted scan record and
its checksum-verified `normalized` cache artifact. Eligibility requires
`runtime_mode=REAL`, `synthetic=false`, RTC product, matching scene/provenance
metadata, an acquisition timestamp with timezone, a valid CRS, a non-singular
affine window transform, and a cache key tied to the recorded scene identity.
The backend never accepts a URL or raster file path from the client, opens a
remote provider, or synthesizes pixels. Invalid/no-data floats are transparent.

**Real-source-gated** means that the source is a persisted scan marked REAL and
the exact local cache bytes pass the storage checksum. This does **not** make
the imagery independently authenticated by a satellite operator. Source
provenance is a persisted record assertion; neither this viewer nor the cache
certifies the identity or radiometric calibration of the upstream supplier.

All successful previews are actual sampled source pixels. The image is grayscale
with a fixed gamma0 display window **−30 to +5 dB** across both panels; values
outside that window clip for display only. The backend uses nearest sample
decimation with an explicit stride to fit within 1024 pixels on the longest
side. It does not interpolate, average dB values, claim native resolution for
decimated images, resample into a common grid, or calculate differences.

## API mounting

Mount `darkfleet.api.sar_imagery_routes.router` in the application factory:

```python
from darkfleet.api.sar_imagery_routes import router as sar_imagery_router
application.include_router(sar_imagery_router)
```

| Route | Result |
| --- | --- |
| `GET /api/sar/imagery/scans` | Up to 100 persisted REAL candidate scan summaries, without claiming readiness |
| `POST /api/sar/imagery/pair` | `{first_scan_id,second_scan_id}` → independent READY/UNAVAILABLE scene metadata, explicit reason per source |
| `GET /api/sar/imagery/scans/{scan_id}/image` | Checksum-gated native-source RGBA PNG or HTTP 409 with failure reason; `private, no-store` |

In the Advanced analysis UI add a tab rendering
`src/advanced/SceneImageryWorkspace.tsx` → `SceneImageryWorkspace`.
The widget retrieves only relative local image URLs and does not load provider
links. Each pane pans/zooms **independently**; no shared transform or sync is
implied even if the metadata appears to have the same CRS. Selecting scans or
reloading supersedes stale pair requests; a failed image is presented as an
explicit error, rather than a blank or a successful observation.

## Conditions for scientific use

The native scene dimensions must exactly match the persisted raster window
`[row_offset, column_offset, height, width]`.
The four window corners are computed from the recorded window-local affine,
then transformed into WGS84 and reported as **[longitude, latitude]** in
top-left/top-right/bottom-right/bottom-left order. Invalid projected corners
refuse rendering. No guessed AOI geolocation or geographic overlay is used.

Missing/corrupt source artifacts,
provenance drift, invalid references, out-of-range values, invalid georeferences,
all non-finite pixels, or oversized source arrays return explicit
`UNAVAILABLE` reasons. The hard source limit is **8,000,000 pixels** and the
compressed cache maximum is **96 MiB** before decompression. A pixel mask is
based on finite values of the authoritative cached RTC output.

**These views do not establish change detection or co-registration.** The
pixel lattice, acquisition geometry, spatial coverage, polarization, and
calibration may differ. A bright/dark contrast cannot be interpreted as a
vessel, a disappearance, an AIS event, an attribution, or radiometric change.
For numerical exact-grid comparison use the separately gated existing
`/api/sar/compare` capability and review its refusals and provenance.

## Verification

The isolated Python tests use locally constructed fixtures to exercise expected
behavior; **fixtures are not real observations**. They cover alpha masking,
fixed scale, real-scan isolation, mismatched grids, malformed records,
tampered checksums, unsafe sizes, independently reopenable cache, strict
request boundaries, PNG content type and HTTP refusals. Frontend tests
exercise its response contract, source validation, route usage, and pre-load
status. Current production imagery remains unavailable until the operator
provides actual persisted REAL acquisitions with valid cached RTC pixels.
