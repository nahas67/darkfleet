# Third-party data and code provenance

This file records every external source whose **code or data** DarkFleet ships or
depends on, with its licence and what was actually taken. It exists so a future
maintainer can answer "may I use this commercially?" without archaeology.

DarkFleet itself is **Apache-2.0** (`backend/pyproject.toml`).

## Adopted

### Natural Earth 10m physical vectors — public domain

| | |
|---|---|
| Dataset | `ne_10m_geography_marine_polys` |
| Shipped as | `backend/darkfleet/data/marine_regions.json` |
| Licence | **Public domain** (naturalearthdata.com) — no attribution legally required |
| Credit given | "Made with Natural Earth" (courtesy) |
| Source commit | `ca96624a56bd078437bca8184e78163e5039ad19` |
| Fetched | 2026-07-28T01:36:39Z |
| Features | 292 named marine polygons |
| Used by | `darkfleet/marine.py` (GEO-001) |

Public domain means no share-alike obligation and no non-commercial clause, so it
is compatible with Apache-2.0 and with commercial use.

**Known limitation, carried forward:** Luzon Strait and Drake Passage are **absent**
from the pack. Both are sliver-only in the upstream source and were dropped by the
pack's own curation. `marine.provenance()` records this, and an unresolved lookup
states it rather than silently returning nothing.

### gods-eye-view — MIT (source code only)

| | |
|---|---|
| Archive | `gods-eye-view-0.1.1.zip`, sha256 `C36D7E57…67A7` |
| Licence | MIT, Copyright (c) 2026 Bilawal Sidhu |
| Taken | **Policy only**, ported to Python |
| Files consulted | `src/data/aisStreamAdapter.js`, `src/data/aisWatchdog.js` |
| Result | `darkfleet/ais/resilience.py` (AIS-016/017) |

The archive's MIT licence states explicitly that **the grant covers source code
only** and does not extend to bundled datasets. What was adopted is the failure
classification and backoff policy, reimplemented in Python rather than copied as
a file — the archive is JavaScript and DarkFleet's collector is Python, so this is
a documented reimplementation, not a code import. No JavaScript was vendored.

## Considered and rejected

Recorded rather than silently skipped, because "we looked and said no" is
information worth keeping.

| Asset | Licence | Why rejected |
|---|---|---|
| `src/data/local_data/telegeography_submarine_cables/` (712 cables, 1,917 landing points) | **CC BY-NC-SA 3.0** | **NonCommercial** clause is incompatible with any commercial use, and **ShareAlike** is incompatible with Apache-2.0. The archive's own licence file says commercial users must delete the folder. |
| `src/data/local_data/dams/`, `datacenters/` (OSM / Open Infrastructure Map) | **ODbL 1.0** | Share-alike applies to the derived database; distributing a modified version obliges you to offer it under ODbL. Also not maritime. |
| `src/data/local_data/neighborhoods/` (DataSF) | PDDL 1.0 (public domain) | Licences cleanly, but it is a city-neighbourhood polygon pack with no bearing on maritime SAR. |
| `public/models/*.glb` | Third-party, per-file | Not MIT. Irrelevant to a radar correlation engine. |
| OpenSky Network (live) | Non-commercial research/education | Non-commercial, and it is aircraft ADS-B, not AIS. |
| adsb.lol / CelesTrak / NASA FIRMS / USGS | Varies | Aircraft, satellite, wildfire and earthquake sources. No maritime value here. |

## Live providers

Fetched at runtime; none of them ship data with DarkFleet.

| Provider | Used for | Terms |
|---|---|---|
| Planetary Computer (`sentinel-1-rtc`, `sentinel-1-grd`) | Primary SAR | Anonymous search; asset access via SAS token. |
| Element 84 Earth Search (`sentinel-1-grd`) | Secondary SAR | Open, no credential. Assets are GCP-referenced. |
| CDSE | **Unavailable** | No Sentinel-1 collections are published on the public STAC endpoint; recorded rather than worked around. |
| AISStream | Live AIS | Free beta key required. |
| AISHub | AIS snapshots | Free username required. |
| Global Fishing Watch | Historical effort | Free token required. |

With no credentials configured, each provider reports its own real state
(`AUTH_REQUIRED` / `NOT_CONFIGURED`) through `GET /api/providers/health`. Nothing
is simulated in their place — see "No synthetic mode" below.

`GET /api/revisit` (GEO-002) queries the same catalogues and ships no data of its
own: every acquisition it reports is a STAC item the provider returned, with its
real item id, timestamp, platform and polarisation. It uses no orbit prediction —
`skyfield`/SGP4 is deliberately not a dependency — so there is no modelled pass to
license and no predicted acquisition to mistake for a measurement.

## No synthetic mode

DarkFleet has **no** synthetic runtime mode. Every scan is a REAL scan against a
live provider. This is now a deletion rather than a switch:

- `Settings.allow_synthetic_scenes` **does not exist** and cannot be set from the
  environment, so there is no flag to discover and no degraded path to reach.
- `backend/darkfleet/demo.py`, the scene/raster/AIS generator, is **deleted**.
  No synthesiser remains anywhere in the repository, product code or tests.
- `POST /api/scans` does not accept `runtime_mode` or `scene_id`; sending either
  is a **422 `extra_forbidden`**, and the OpenAPI schema advertises only
  `bbox`, `cfar_config`, `datetime_range`, `product`, `provider`.
- `GET /api/scenes` has no `runtime_mode` parameter and no fallback catalogue. It
  is a live provider proxy that requires an explicit
  `bbox=min_lon,min_lat,max_lon,max_lat`; there is no default extent and no
  synthetic list behind it, so every scene it returns is an acquisition the
  provider actually holds.
- `RunStore.save` rejects any record that is not `runtime_mode="REAL"` **and**
  `synthetic=False`, with both fields required to be present, and
  `mark_synthetic(record, synthetic=True)` raises at the call site.

The test suite still runs offline, and honestly: `backend/tests/fixture_source.py`
reads a checked-in GeoTIFF (`tests/fixtures/cog/fixture_32648.tif`, 400×400
EPSG:32648, 10 m) through `run_scan`'s existing `window_source` injection point.
A real GeoTIFF on disk needs neither a credential nor a network, and it keeps the
production CFAR, land-mask, correlation, evidence and persistence code in the
loop instead of exercising a parallel implementation of it.

The reason this is a correctness rule rather than a preference: **a user cannot
tell a fabricated observation from a measurement they relied on.**

> **Correction, 2026-10-02.** The previous version of this section claimed the
> synthetic scene catalogue "survives only as an automated-test harness behind
> `Settings.allow_synthetic_scenes`" and that `GET /api/scenes?runtime_mode=DEMO`
> is refused with `SYNTHETIC_SCENES_DISABLED`. Both were true when written and are
> false now: the switch and the generator are deleted, and there is no
> `SYNTHETIC_SCENES_DISABLED` status code anywhere in the backend.
