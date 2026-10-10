# DF-X14 — Real public-domain coastline installed locally

**Date:** 2026-10-10 UTC. **Status:** `CHECKSUM_UNRECORDED`, usable local
cartographic context, **NOT independent publisher-checksum verification**.
This is evidence from an actual source download and real runtime data directory,
not the installer's isolated synthetic tests.

## Source and acquisition

- Published dataset: Natural Earth (`NACIS`) `ne_10m_coastline`, 1:10m,
  coastline theme version **4.1.0** per the publisher's
  `https://www.naturalearthdata.com/downloads/10m-physical-vectors/`.
- Published upstream file: `geojson/ne_10m_coastline.geojson` in
  `https://github.com/nvkelso/natural-earth-vector`; fetched over normal
  certificate-validating HTTPS from
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson`.
- Last GitHub file-touching commit observed through the public repository API:
  `a726d63745ff99cf26a03ae1c7cfb0d4f12fa517`, authored 2021-12-05
  (repository commit identity, **not** a publisher-signed file checksum).
- Raw local file `data/reference-input/ne_10m_coastline.geojson`:
  **10,110,735 bytes**, local SHA-256
  `6f75ae0e0de157b14946e2255eb1f5486d9a13819032e26d4610852d296788f6`.
  Contains **4,133** `LineString` features, WGS84 CRS84, and no synthetic
  geometry. Retrieved timestamp recorded in the installer receipt:
  `2026-10-10T10:53:06+00:00`.
- Natural Earth releases these cartographic vectors in the public domain.
  The publisher cautions that shorelines are generalized, exclude some minor
  islands and are **not for navigation**.

## Local import and integrity

The executable local installer committed as `4bece16` was run with the actual
raw GeoJSON and existing project registry version 4.1.0. It validated geometry
and installed **4,133** features with **410,957** WGS84 vertices into:

`data/reference/natural_earth_coastline/4.1.0/`

The canonical prepared payload SHA-256 is
`32866e314ca2450e8c7204281113230751ef2f0696cd1b918e9ce202fb764738`.
The prepared digest differs from the raw file digest because the installer
normalizes and records additional local provenance. The receipt explicitly
sets `publisher_verified=false`; **neither digest is misrepresented as an
independent publisher-supplied hash**. The data files are intentionally local
runtime records; no user dataset or signed source URL is committed to Git.

The normal running backend's `GET /api/maritime/datasets` reported:

- `natural_earth_coastline.install_status = CHECKSUM_UNRECORDED`
- `natural_earth_coastline.usable = true`
- `usable_count = 1`, `verified_count = 0`

With the authentic (not fixture) processed SAR target `DF-0001 / DF-001`,
`GET /api/scans/DF-0001/targets/DF-001/maritime-context` reported
`nearest_coast.status=AVAILABLE`, distance **867.6 m**, method
`DENSIFIED_POINT_METER`, sample spacing **5,000 m**, source version **4.1.0**,
and `install_status=CHECKSUM_UNRECORDED`. The estimate is **not nautical or
hydrographic precision** and cannot establish shipping activity or intent.

The genuine coastline display route
`GET /api/maritime/layers/REFERENCE_COASTLINE` also returned HTTP **200**,
status `CHECKSUM_UNRECORDED`, **4,133 independent line parts**, 410,957
source vertices and **84,393 simplified display vertices** with matching
Natural Earth v4.1.0 attribution. The 1,994,061-byte response states clearly
that simplification is for rendering only; source-geodesic context stays
authoritative and unmodified.

At the same time, maritime zones, ports and bathymetry returned their real
`NOT_INSTALLED` statuses, not fabricated boundaries or depths. The Marine
Regions full source/snapshot and NGA/GEBCO sources were not implicitly fetched.

## Remaining gates

- **Restart verified (2026-10-10):** stopped and restarted the actual backend
  process. `GET /api/scans/DF-0001` returned `COMPLETE` from persisted source;
  `GET /api/maritime/datasets` still reported the coastline
  `CHECKSUM_UNRECORDED`; the real target maritime context still reported
  `nearest_coast.status=AVAILABLE`, **867.6 m**. In the same request,
  `maritime_zone`, `nearest_port` and `bathymetry` correctly stayed
  `NOT_INSTALLED`. The source-linked case PDF was independently served after
  restart with HTTP 200, 7,306 bytes. The global coastline layer's actual
  vertex loading/draw count on the 3D globe is not yet accepted: unlike
  authoritative source availability it depends on separate layer controls and
  scene lifecycle.
- Verify full globe-layer rendering/selection/attribution in a fresh browser
  session, with special attention to a 410,957-vertex source and 0–360 longitude.
- Marine Regions EEZ and high seas require attributable, legally obtained
  source data and completeness evidence. Port/depth/anchorage data remain
  optional with explicit missing-source states.
- An independently publisher-authenticated prepared checksum does not exist;
  retain `CHECKSUM_UNRECORDED` rather than marking a false `READY`.
