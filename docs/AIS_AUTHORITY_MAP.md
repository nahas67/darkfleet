# DF-X9 — AIS authority map

Traced before any implementation, per §4. Every claim below cites the file and line that
produces it. Nothing here is inferred from a route name or a type name.

## The complete path

```
PROVIDER  aistream | aishub | gfw | marinecadastre | file-import
   |      normalize.py — every provider normalises to AisObservation
   v
MODEL     AisObservation                        backend/darkfleet/ais/models.py:34
   |      timestamp, mmsi, lat, lon  REQUIRED and total
   |      sog, cog, heading, nav_status, name, callsign, imo,
   |      ship_type, length_m, width_m, source   ALL NULLABLE
   v
ARCHIVE   AisArchive.append                     backend/darkfleet/ais/archive.py:106
   |      Parquet part-<source>.parquet, 15 columns, timestamp tz=UTC
   |      dedup by f"{mmsi}|{timestamp.isoformat()}"   models.py:58
   v
READ      AisArchive.query                      archive.py:128
   |      DuckDB, session pinned to UTC         archive.py:43-61
   |
   +--> ANALYTICAL (computed at scan time, persisted on the scan record)
   |      pipeline.py:369  ais_rows = archive.query(...)
   |      pipeline.py:380  correlate(comps, ais_rows, ...)
   |        match.py:170   propagate(ob.lat, ob.lon, ob.sog, ob.cog, dt)
   |        match.py:184   orient_diff(comp.orient, ob.cog)      <- COG only
   |        match.py:332   writes corr["predictedLat"] / corr["predictedLon"]
   |
   +--> API
          GET /api/ais/coverage                        routes.py:2664  AisCoverageOut
          GET /api/scans/{id}/ais                     routes.py:2694  ScanAisResponse
          GET /api/targets/{id}/ais-observations       routes.py:2744  TargetAisResponse
          GET /api/vessels/{mmsi}/track                routes.py:2809  VesselTrackResponse
          GET /api/debug/{id}/{layer}                  routes.py:1818  ais_observed / ais_predicted
   |
   v
CONTRACT  AisObservationOut                       src/api/contract.ts:311
   v
FRONTEND  loadScanAis(scanId)                     client.ts:351
   |      DISCARDS payload.observations; stores coverage only   client.ts:360
   |      NO runtime contract validation; SCANAISRESPONSE_FIELDS is exported and unused
   |
          loadTrack(mmsi)                          client.ts:372
   |      keeps observations, NO runtime validation
   |
          loadScanResults -> ais_only             client.ts:287-295
   |      builds AisContact, forcing sog: null, cog: null   client.ts:293-294
   v
STORE     aisOnly: AisContact[]                   store.ts:218
   |      { mmsi, lat, lon, timestamp, shipName, sog, cog }
   |      sog/cog are typed but ALWAYS null at every producer
   |
          track: VesselTrack | null               store.ts:225
   |      { mmsi, identity, observed: AisObservationOut[], coverage }
   v
RENDER    TacticalWorld.tsx:94  engine.setAisContacts(aisOnly, ...)
   |      TacticalWorld.tsx:110 engine.setTrack(observed, null)
   |                                     ^^^^^^^ always null -> AIS_PREDICTED dead
   v
ENGINE    setAisContacts                          engine.ts:371
   |      viewer.entities.add -> point + label, name `ais:${mmsi}`
   |      PointGraphics has NO rotation -> no glyph can point anywhere
   |
          setTrack                                engine.ts:1245
                  observed polyline + per-fix points + predicted polyline
   v
SURFACES  ContactList  contacts/ContactList.tsx:155  4 columns, CONF/DIST are em-dash for AIS
          AisTab       dossier/tabs/AisTab.tsx      tables only, no geometry
          MissionTimeline timeline/                 no clock, playback explicitly forbidden
```

## Where each thing originates

| Question | Answer | Authority |
|---|---|---|
| Observed coordinates | `archive.query` -> `delivery.to_out` (delivery.py:193) — a pure field rename. **No smoothing, ever.** | Parquet on disk |
| Predicted coordinates | `propagate()` geodesy.py:23 — legacy-exact *spherical* direct dead reckoning along COG | Computed during the scan, persisted in `corr` |
| Timestamps | `pa.timestamp("us", tz="UTC")`; DuckDB session pinned UTC; API via `as_utc()` | Parquet, UTC everywhere |
| Freshness | **Does not exist.** No per-observation age, no `stale`/`fresh`/`lastSeen` anywhere in the backend. `coverage()` reports archive EXTENT, not per-vessel recency. | — |
| Track grouping | **By MMSI only.** No IMO/callsign merging. Correlation enforces 1-to-1 per MMSI (`used_mmsi`, match.py:208). | `mmsi` |
| heading nullable? | **Yes**, and AIS sentinel 511/3600 is normalised to `None` at ingest (normalize.py:42) — not clamped to 0 | — |
| cog nullable? | **Yes** (models.py:43) | — |
| sog nullable? | **Yes** (models.py:41) | — |
| Interpolation | **None exists.** Zero interpolation code in the frontend or backend. `AisTab.tsx:246` states it; `noBrowserGeolocation.test.ts:149` asserts it. | — |

## Evidence for the thresholds DF-X9 must choose

Not guessed. Taken from the code and fixtures.

| Fact | Value | Source |
|---|---|---|
| Observed fixture cadence | **4 minutes** | `test_ais_delivery.py:65` — `for minute in (0, 4, 8, 12, 16)` |
| Correlation window | **+/- 900 s (15 min)** | `match.py:16` `WINDOW_S = 900`; `delivery.py:61` |
| Beyond that window | observation is **excluded from correlation entirely** | `match.py:168` |
| Existing minimum-motion rule | `sog < 0.1 kn` -> **no propagation at all** | `geodesy.py:29` |
| Live AIS feed | **none.** `/api/scans/{id}/events` carries scan-stage lifecycle only | `src/api/sse.ts:73` |
| Current deployment AIS | `NOT_CONFIGURED`, `ais/` empty | `GET /api/ais/coverage` |

Consequences for DF-X9, stated rather than assumed:

- **Freshness cannot be measured against wall clock.** There is no live feed, so `now() - t`
  would mark every historical contact stale and would be a lie about a deployment that has
  never claimed live tracking. Freshness is measured against the *analysis reference time*
  (scan acquisition, or the timeline cursor). A future live feed changes the reference, not
  the rule.
- **An interpolation interval must stay below the correlation window.** Interpolating across a
  gap larger than 900 s would animate a contact through water that correlation deliberately
  excludes. The limit is set below 900 s and above the 4-minute cadence.
- **`sog < 0.1 kn` already means "do not propagate"** in the backend. The display layer reuses
  that threshold rather than inventing a second one.

## Defects found during the trace

Recorded before implementation because each one changes what DF-X9 can assume. Two of them are
in the analytical path and are runtime-confirmed, not inferred.

1. **CONFIRMED crash: absent SOG/COG raises in correlation.** `correlate` reads `ob["sog"]`
   and `ob["cog"]` with no `None` guard (`match.py:170,172,184`); `propagate` does
   `sog_knots < 0.1` (`geodesy.py:29`). `pipeline.py:369` passes raw archive rows straight in.
   Executed: `propagate(1.0, 103.0, None, 90.0, 120.0)` -> `TypeError: '<' not supported
   between instances of 'NoneType' and 'float'`. Any archive row that omits SOG — which the
   model explicitly permits — crashes the CORRELATING stage.

2. **GFW writes `sog=0.0, cog=0.0, heading=0.0`** (`gfw.py:68-70`). GFW publishes none of
   these. This contradicts `models.py`'s documented rule that absent is `None`, and it is
   exactly the "0 degrees means unknown" substitution DF-X9 §11 forbids. It also defeats the
   `sog < 0.1` no-propagation guard by presenting a stationary vessel as a measured one.

3. **The correlation size term is dead in production.** `correlate` reads
   `ob.get("length", 0)` and `ob.get("shipName")` (`match.py:186,295,329`), but the archive
   stores `length_m` and `name`. On real archive rows both are absent, so `size` is pinned at
   its 0.8 default and the vessel name never reaches `vesselName`.

4. **`loadScanAis` throws the observations away** (`client.ts:360`). Only coverage is stored,
   so the globe's AIS contacts actually come from `payload.ais_only` inside the scan-targets
   response — a different source with a narrower field set.

5. **Orientation data is destroyed at the projection boundary.** `client.ts:293-294` forces
   `sog: null, cog: null` on every `AisContact`. The types exist; the values do not.

6. **Two of four AIS routes have no runtime contract validation.** `SCANAISRESPONSE_FIELDS` is
   generated and exported and referenced nowhere.

7. **`AIS_PREDICTED` is an inert toggle that reads as enabled.** `defaultVisibility: true`
   (`layerRegistry.ts:215`) while the only caller passes `predicted = null`
   (`TacticalWorld.tsx:111`). The DF-X8 defect class, reintroduced.

8. **AIS entities are not clickable.** `#installPicking` matches `name.startsWith('target:')`
   only (`engine.ts:501-520`).

9. **`followingMmsi` is written and never read** (`store.ts:416`, cleared at
   `useGlobalKeys.ts:77`). No camera follow exists.
