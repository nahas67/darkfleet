# Data source registry

Every source DarkFleet reads, what it is actually used for, and what it cannot
tell you. Written before the sources were integrated, and updated as they land.

The rule this file enforces: **a source that is not configured is reported as not
configured, never as empty.** A missing feed is a gap in observation. Rendering it
as "0 vessels" would present an unobserved sea as an empty one, which is the single
most damaging thing this product could do.

## Provider states

| State | Meaning |
|---|---|
| `AVAILABLE` | A real probe returned data |
| `DEGRADED` | Reachable, serving something other than what was asked |
| `STALE` | Data present but older than its useful window |
| `RATE_LIMITED` | Quota or throttle |
| `AUTH_REQUIRED` | Credential missing or rejected |
| `NO_COVERAGE` | The source cannot speak to this place or time |
| `UNAVAILABLE` | Probed and failed |
| `NOT_CONFIGURED` | No credential or no ingest in this deployment |

A configured credential is **not** availability. Status comes from a probe, never
from reading an environment variable.

## SAR — Sentinel-1

| | |
|---|---|
| Provider | Planetary Computer STAC (`planetary-computer`) |
| Dataset | Sentinel-1 GRD, collection `sentinel-1-rtc` |
| Official source | https://planetarycomputer.microsoft.com/api/stac/v1 |
| Licence | Copernicus / ESA open data |
| Cost | None |
| Auth | None for public collections; token raises rate limits |
| Coverage | Global |
| Resolution | Product dependent; GRD ~10 m |
| Polarisation used | VV, VH |
| DarkFleet usage | The **only** source of radar truth. Every detection, footprint and raster comes from it |
| Limitations | Revisit is not uniform. A window with no acquisition is not evidence the area is never observed. RTC products are terrain-corrected and calibrated; do not compare dB across products without checking the calibration branch |

| | |
|---|---|
| Provider | Earth Search (`earthsearch`) |
| Licence |varies per collection; verify before operational use |
| DarkFleet usage | Secondary scene discovery |
| Limitations | GCP-referenced assets require a reprojection step. Reported `DEGRADED` for that reason rather than silently reprojected |

| | |
|---|---|
| Provider | CDSE |
| Status observed | `UNAVAILABLE` — publishes no Sentinel-1 collections (Sentinel-2 L2A and COP-DEM only) |
| DarkFleet usage | Configured for discovery; finds nothing |

## AIS

| | |
|---|---|
| Storage | Local Parquet archive partitioned by day and source (`<data_dir>/ais/YYYY/MM/DD/part-<source>.parquet`) |
| Query | DuckDB over the partitions, with time range, AOI, MMSI and source filters |
| Formats ingested | AISStream, AISHub, MarineCadastre, pyais/NMEA, file import |
| DarkFleet usage | The correlation partner. A detection is scored against observations in a window around the acquisition |
| Limitations | **Absence of AIS is not absence of a vessel.** Coverage depends entirely on receiver density, and the archive reflects what was received, not what was transmitted |

**Coverage semantics are returned with every AIS response**, because they change
what a count means:

| State | Meaning | Count reported? |
|---|---|---|
| `AVAILABLE` | The archive spans the requested window | Yes — including a legitimate zero |
| `PARTIAL` | Overlaps but does not span the window | Yes, and labelled incomplete |
| `NO_COVERAGE` | Archive does not reach the window | **No.** There is nothing to count |
| `NOT_CONFIGURED` | No archive in this deployment | **No** |

`observation_count` is deliberately `null` when there is nothing to count. A `0`
there would assert a measurement nobody made.

### Optional measurements

`sog`, `cog`, `heading`, `nav_status`, `name`, `callsign`, `imo`, `ship_type`,
`length_m`, `width_m` are **nullable**, and `null` means the source did not report
them. The archive previously defaulted all of them to `0.0`, which made "no speed
reported" and "0.0 knots" the same stored value — and a fabricated zero that then
entered correlation arithmetic. Absent is now absent end to end.

AIS sentinels are removed at ingest, not clamped: `511` heading and `3600`
course both mean "not available", and clamping either to `0` would invent a vessel
pointing north.

### Legacy partition ambiguity

Partitions written **before** this change stored `0.0` for unreported optional
fields. That ambiguity is unresolvable after the fact, so the delivery layer
reports what is stored rather than reinterpreting it. This trades a possible false
zero in old data for never inventing data that was not reported.

## Basemap

| | |
|---|---|
| Source | OpenStreetMap raster tiles |
| Licence | ODbL — attribution required and never removed |
| Auth | None |
| DarkFleet usage | Globe context only. **Not** an analysis source |
| Limitations | A general basemap carries no maritime meaning. It is context, never evidence |

## NOT YET INTEGRATED

Named here rather than left as absent toggles, because "we might add it" is not a
capability.

| Candidate | Licence / availability | Status |
|---|---|---|
| EEZ boundaries | MarineCadastre, public | Not integrated. Requires attribution and a coverage decision |
| Maritime boundaries | MarineCadastre, public | Not integrated |
| Global ports | MarineCadastre / WRI, public | Not integrated; anchorages need a reliability review |
| Bathymetry | GEBCO, public | Not integrated. Would need an analytic justification, not decoration |
| Marine protected areas | WDPA, public | Not integrated |
| Wind / wave / sea state | Copernicus Marine, public | Not integrated. No analysis currently consumes them |
| AIS live stream | AISStream / GFW, token required | Not configured in this deployment. Archive-only |

Each is listed with its real licensing position so the next integration starts from
fact rather than from a menu entry.

## Last probe

Provider status is probed live on application start and on demand from the SYSTEM
workspace. A failed probe renders as a failure with the backend's own reason; it
never falls back to "online".

| Provider | Last observed status | Detail |
|---|---|---|
| planetary-computer | `AVAILABLE` | collection `sentinel-1-rtc` published |
| earthsearch | `DEGRADED` | assets are GCP-referenced |
| cdse | `UNAVAILABLE` | publishes no Sentinel-1 collections |
| ais-local | `NOT_CONFIGURED` | no AIS partitions and no AIS credential |