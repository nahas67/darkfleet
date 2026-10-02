# UI Data Recovery — what the interface can honestly claim today

Checkpoint deliverable. Written before the military shell work so the UI is built
against what the backend actually knows, rather than against what it is assumed
to know.

## The governing constraint

There is no DEMO mode, no synthetic scene, and no second world. Every value the
interface renders comes from a real Sentinel-1 RTC product, a real AIS feed, or
real persisted analysis. Where a fact is not established, the interface must say
so rather than render a plausible default.

**Absence of coverage is not absence of events.** These are different claims and
the UI must not collapse them:

| Claim | Meaning | How it is expressed |
|---|---|---|
| Provider not configured | no credential / no endpoint | `NOT_CONFIGURED` + reason |
| Provider unreachable | tried, failed | `UNAVAILABLE` + detail |
| No AIS in window | queried successfully, none nearby | `0 observations`, real count |
| Detection with no AIS | radar contact, no match | `SAR_UNMATCHED` |

A phantom `NO_COVERAGE` provider state existed in the frontend union and was
removed during IR1 because the backend can never emit it.

## What is real and available

- **Scan pipeline** — 16 stages, streamed live over SSE from the runner. Now
  includes `GEOLOCATING`, which is a real stage because it is where a target stops
  being a request and becomes a measurement.
- **Targets** — classification, position, score decomposition, correlation
  detail, SAR confidence.
- **Raster layers** — six renderable layers (`raw`, `normalized`, `filtered`,
  `landmask`, `cfar_threshold`, `detection_mask`), server-rendered to PNG over the
  **measured** window transform, with the display window reported alongside the
  image.
- **Providers** — live capability status per provider.
- **Evidence / debug layers** — compact per-stage summaries.
- **Exports** — PNG and PDF, rendered server-side, carrying provenance.

## What the interface must NOT display

| Forbidden | Why |
|---|---|
| `SIGINT ONLINE`, `DARK VESSEL`, `HOSTILE`, `THREAT` | asserts intent/intelligence the product does not have. A radar contact is not a hostile vessel. |
| Any synthetic or demo scene | deleted at the type level, not just hidden |
| A percentage or ETA for a scan | the pipeline has no measurable completion estimate; it shows a **stage counter**, not progress |
| Confidence implied by colour | colour is a contrast aid over measured dB, labelled as such, never classification |
| An invented classification | `DarkFleet-Neutral-v1` only; unknowns stay unknown |

## Trustworthy coordinate display

GEO-CORR changed what a target coordinate *is*. It is now a measured position
derived from the window transform, carrying:

`source transform` · `source CRS` · `window transform` · `window bounds` ·
`pixel centroid` · `WGS84 coordinate` · `geolocation uncertainty`

Rules for the UI:

1. **Never recompute a position in the browser.** Consume `lat`/`lon` as given.
   Two implementations of the same projection drift, which is exactly what
   happened.
2. **Show the uncertainty, or show nothing.** For an affine product it is half the
   pixel spacing. For GCP or unreferenced products it is **not established** — the
   backend returns `null`, and the UI must render "not established", never a number.
3. **Do not round for display and then reuse the rounded value.** The measurement
   layer keeps full precision; rounding belongs to presentation only.

## Data flow

```
STAC / Sentinel-1 RTC ──► scene search, asset read (window transform retained)
AIS feed              ──► observations, propagated to acquisition time
                              │
                              ▼
                     geolocate (measured transform)
                              │
                              ▼
                    correlate: spatial / temporal / heading / size
                              │
                              ▼
                    classify (DarkFleet-Neutral-v1) ──► persist
                              │
                              ▼
              FastAPI (single backend authority) ──► generated TS contract
                              │
                              ▼
                          UI + Cesium
```

`src/api/contract.ts` is **generated** from the live OpenAPI schema by
`backend/tools/export_contract.py` and gated by `--check`. The frontend derives
its types from it. Do not hand-write a wire shape: IR1 deleted 13 such mirrors
after they drifted.

## Cesium integration status

The globe renders **47 entities** from real scan state, and layer toggles are
verified to drive Cesium entity visibility.

Raster imagery uses `SingleTileImageryProvider`, which requires the geographic
rectangle **before** it fetches. That is why the metadata and image are separate
endpoints:

```
GET /api/scans/{id}/raster              → layer index
GET /api/scans/{id}/raster/{layer}      → JSON: rectangle, CRS, transform, report
GET /api/scans/{id}/raster/{layer}/image → PNG bytes + report headers
```

Cesium cannot decode GeoTIFF/COG, so the render must be server-side. The rectangle
is derived from the **measured** transform — not from the requested AOI. That is
the same correction GEO-CORR applied to targets, and it is why the alignment
assertion (`every detection falls inside the rendered rectangle`) now passes.

## Still outstanding

- AIS observation/track endpoints, so a track is a first-class object rather than
  a per-target correlation detail.
- The military/HUD shell itself — to be built against this document, not against
  assumptions about the data.