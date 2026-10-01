# DarkFleet Master Requirements (201 IDs, frozen CP0)

> One line per ID. Tests cite these IDs. Status lives in MASTER_FEATURE_PARITY.md.

## RES research (8)

- RES-001 PC `sentinel-1-rtc` capability verified (anon search, SAS reads, affine COG)
- RES-002 PC `sentinel-1-grd` capability assessed (anon search; read untested)
- RES-003 CDSE STAC Sentinel-1 absence proven (10 collections; 400 was wrong ID)
- RES-004 EarthSearch GRD GCP-referenced proven (210 GCPs EPSG:4326)
- RES-005 AIS sources assessed (AISStream/AISHub/GFW keyed; MarineCadastre keyless history; pyais)
- RES-006 Auxiliary datasets assessed (WorldCover/WPI/EEZ/lanes/GEBCO/orbits + licenses)
- RES-007 SAR/CV assessed (datasets; no maintained open S1-GRD weights; deterministic path)
- RES-008 `docs/RESEARCH_REGISTRY.md` maintained with probe evidence

## SAR-100s raster + georeferencing (12)

- SAR-101 AOI + time range → STAC scene search
- SAR-102 Product capability check before asset use
- SAR-103 Asset selection (polarization/product aware)
- SAR-104 Windowed remote raster read (no full-scene download)
- SAR-105 Affine chain: AOI → source CRS → window → pixel → source → WGS84
- SAR-106 GCP warp path for GCP-referenced assets
- SAR-107 UNREFERENCED assets fail loudly (never guessed)
- SAR-108 GRD branch: DN → σ⁰ → thermal-noise removal → terrain correction → dB
- SAR-109 RTC branch: linear γ⁰ → log/dB (never conflated with GRD)
- SAR-110 Raster metadata persisted (provider/collection/item/platform/orbit/time/product/pol/CRS/transform/spacing)
- SAR-111 Non-WGS84 rasters handled (never assumed)
- SAR-112 Local fixture COGs (EPSG:4326 + EPSG:32648, Sentinel-shaped)

## SAR-200s preprocessing + land mask (10)

- SAR-201 Valid-data mask first
- SAR-202 Product-specific calibration/normalization
- SAR-203 Log/dB representation
- SAR-204 Real land/water mask (WorldCover 10 m water class, per-tile COG)
- SAR-205 Configurable coastline exclusion buffer
- SAR-206 Port/coastal exceptions
- SAR-207 Mask version + provenance recorded per scan
- SAR-208 Mask debug visualization
- SAR-209 Natural Earth coarse-viz only (never detection data)
- SAR-210 Mask/raster alignment tested

## SAR-300s filtering + detection (15)

- SAR-301 Speckle mode none
- SAR-302 Speckle median 3×3
- SAR-303 Speckle Lee
- SAR-304 Refined-Lee / Frost architecture (no small-vessel erasure)
- SAR-305 Filter effects measured (retention/centroid displacement/area change/FP change/background SNR; no sub-resolution promises)
- SAR-306 CA-CFAR guard + training rings, adaptive threshold
- SAR-307 Power-domain / local-noise model
- SAR-308 Morphology on detection mask
- SAR-309 Connected components (8-connectivity)
- SAR-310 Per-candidate extraction (centroid/geo/bbox/area/axes/orientation/mean+max backscatter/footprint/confidence)
- SAR-311 Apparent footprint + uncertainty (never exact `pixels × spacing` length)
- SAR-312 Golden-vector parity with legacy TS engine before its retirement
- SAR-313 Detector interface (CFAR baseline; ML/ensemble slots) — CP15
- SAR-314 Polarimetric channels VV/VH/ratio where supported — CP15
- SAR-315 Small-vessel preservation through filtering

## AIS (16)

- AIS-001 AISStream live adapter (free key)
- AIS-002 AISHub live adapter (free username)
- AIS-003 Global Fishing Watch adapter where configured
- AIS-004 MarineCadastre historical import (keyless, US waters)
- AIS-005 Local file import (CSV/JSON/NMEA/Parquet)
- AIS-006 NMEA decode via pyais (MIT)
- AIS-007 Canonical fields (timestamp/mmsi/lat/lon/sog/cog/heading/nav_status/name/callsign/imo/ship_type/dimensions/source)
- AIS-008 Normalization across providers
- AIS-009 Deduplication
- AIS-010 Parquet archive `data/ais/YYYY/MM/DD/*.parquet`
- AIS-011 DuckDB queries (AOI/time/MMSI/source)
- AIS-012 Freshness + coverage reporting
- AIS-013 Restart persistence (no in-memory authority)
- AIS-014 Live collector persists into the same archive
- AIS-015 Live feed ≠ historical store (separate states)
- AIS-016 Source metadata on every observation

## COR correlation (16)

- COR-001 Dead-reckoning propagation to acquisition time
- COR-002 Recorded source ts / acquisition ts / Δt / predicted coord / propagation uncertainty
- COR-003 All distances geodesic metres (never raw degrees)
- COR-004 Dynamic radius from sensor + age + movement + processing uncertainty
- COR-005 Actual radius persisted per candidate
- COR-006 Scores spatial/temporal/heading/size/composite
- COR-007 Weights in configuration
- COR-008 Decomposition persisted backend-side
- COR-009 No invented values when inputs missing
- COR-010 Greedy 1-to-1 association
- COR-011 All 7 canonical classifications reachable
- COR-012 AIS_ONLY emitted as real targets
- COR-013 Neutral language only
- COR-014 No intent/illegality inference from missing AIS
- COR-015 Proximity-pair detection preserved
- COR-016 Size score uses reported dimensions with uncertainty

## EVD evidence (8)

- EVD-001 Full provenance per detection (scene/asset/acquisition/AOI/raster/preprocessing/mask/filter/detector/AIS/propagation/radius/scores/class/uncertainty/version)
- EVD-002 Reproducible (versioned algorithm + config hash)
- EVD-003 Persisted server-side, never React-state-only
- EVD-004 Per-target evidence API
- EVD-005 Debug trace per scan
- EVD-006 DEMO synthetic marking on every artifact
- EVD-007 Software version recorded
- EVD-008 Confidence decomposition + uncertainty in evidence

## API (12)

- API-001 POST /api/scans
- API-002 GET /api/scans/{id}
- API-003 GET /api/scans/{id}/targets
- API-004 GET /api/scans/{id}/events (SSE)
- API-005 GET /api/scenes
- API-006 GET /api/targets/{id}
- API-007 GET /api/providers/health (real probing)
- API-008 GET /api/evidence/{target_id}
- API-009 GET /api/debug/{scan_id}/...
- API-010 Export endpoints (all 5 formats)
- API-011 Typed Pydantic contracts; frontend mirrors, never reimplements logic
- API-012 REAL failures explicit (AUTH_REQUIRED/NO_COVERAGE/PROVIDER_UNAVAILABLE/RATE_LIMITED/SCENE_NOT_FOUND/AIS_HISTORY_UNAVAILABLE), zero synthetics

## UI (40)

- UI-001 Full-screen Cesium default viewport
- UI-002 Minimal top bar (brand + mode + sources + time + settings)
- UI-003 Compact left icon rail (Search/Layers/SAR/AIS/Correlate/Analytics/More)
- UI-004 Bottom-center floating command dock (Search/Scan/Time/Layers/View)
- UI-005 Floating layers surface (Imagery/Contacts/Analysis/Reference/Intelligence + opacity)
- UI-006 Registry-driven layers incl. uncertainty radii + selected target
- UI-007 Search: coords/sector/scene/target/MMSI/scan-ID → camera
- UI-008 Scene browser (Sentinel-1 pass discovery)
- UI-009 Scan on selected AOI/scene
- UI-010 View modes WORLD/SAR/SAR_CONTRAST/CORRELATION/ANALYSIS
- UI-011 Target ops: click/hover/next/prev/focus/release
- UI-012 Evidence inspector (Evidence/AIS/Imagery/Timeline tabs; OBSERVED/HYPOTHESES/UNKNOWNS separated)
- UI-013 Real acquisition-time timeline with useful scrubbing
- UI-014 Telemetry: merged surface, sorting, filters, bidirectional map sync
- UI-015 CFAR workbench preserved + extended (lee, kernel/min/max, recompute signaling, before/after)
- UI-016 Analysis workbench (raw/normalized/mask/filtered/CFAR/components/boxes + dB probe + box select + colormaps)
- UI-017 Debug workspace (13 layers) via `?debug=true` + toggle
- UI-018 Export tray (5 formats)
- UI-019 Settings / provider configuration
- UI-020 Source health display (real states)
- UI-021 DEMO/REAL unmistakable everywhere
- UI-022 Neutral copy (fix `NO TRANSPONDER`/`UNMATCHED (DARK)`/`CRITICAL`/hardcoded `SIMULATION`)
- UI-023 Keyboard shortcuts (Esc/search/next/prev/camera/layers) + documented
- UI-024 ARIA, focus states, reduced-motion, non-colour status, parallel target list
- UI-025 Readable at 1920×1080 / 1440×900 / 1280×720 / 1024×768
- UI-026 Camera suite (11 commands), easing, never overrides user nav
- UI-027 Correlation links + uncertainty geometry
- UI-028 Reference layers (EEZ/ports/lanes; PD sources vendored, EEZ via WFS)
- UI-029 Wake layer slot, `NOT_AVAILABLE`-hidden until CP15
- UI-030 Multipass layer slot, `NOT_AVAILABLE`-hidden until CP15
- UI-031 AIS positions + tracks + predicted positions
- UI-032 Registered SAR imagery overlay (real raster, not screenshot)
- UI-033 Sentinel footprint + AOI
- UI-034 Attribution always visible (Cesium + data sources)
- UI-035 Zero console-error spam
- UI-036 Frame-rate measured on capable hardware (target 60 FPS, reported as measured)
- UI-037 Legacy UI deleted only after parity verification
- UI-038 Exactly one product architecture at final state
- UI-039 Design identity: orbital ocean intelligence laboratory
- UI-040 Progressive disclosure over dashboard clutter

## EXP exports (6)

- EXP-001 GeoJSON with provenance
- EXP-002 KML with provenance
- EXP-003 Analytical JSON with provenance
- EXP-004 PNG evidence snapshot with provenance
- EXP-005 PDF evidence report with provenance
- EXP-006 DEMO exports clearly synthetic; single-target blobs carry provenance too

## OPS platform (14)

- OPS-001 15-state persistent scan jobs
- OPS-002 Real job events (no fixed timers)
- OPS-003 No invented percentages
- OPS-004 Deterministic cache key (scene + AOI + config hash + algorithm version)
- OPS-005 Cached: raster window, mask, filtered, detection mask, components, targets, metadata
- OPS-006 Cache reuse proven by hit counter; correct invalidation
- OPS-007 Structured logs of measured events only
- OPS-008 Typed configuration for all domains
- OPS-009 Secrets via environment only
- OPS-010 `docker compose up` (api + web)
- OPS-011 Container healthchecks
- OPS-012 Persistent volumes for data
- OPS-013 Restart persistence (scans + archive + cache)
- OPS-014 Strict DEMO/REAL isolation (failure raises, never degrades)

## ADV advanced, CP15 only (12)

- ADV-001 Multi-pass track hypotheses with location history + gaps
- ADV-002 Track uncertainty carried, never dropped
- ADV-003 No identity claims from geometry alone
- ADV-004 Image-based wake candidate/direction/apparent length/heading relationship
- ADV-005 Wake confidence + provenance + debug overlay
- ADV-006 VV/VH/combined features where data permits, provenance preserved
- ADV-007 ML detector adapter; CFAR remains baseline
- ADV-008 No unvalidated weights presented as SAR detectors
- ADV-009 Temporal patterns (association loss/return; convergence; repeated unmatched)
- ADV-010 Patterns emitted as hypotheses with confidence + unknowns
- ADV-011 Optional AI: strict OBSERVED/HYPOTHESES/UNKNOWNS/CONFIDENCE/summary JSON
- ADV-012 AI failure never breaks deterministic analysis; model IDs validated

## SEC security (8)

- SEC-001 No provider keys exposed to the browser
- SEC-002 SSRF guard on provider/outbound URLs
- SEC-003 Path-traversal guard on file imports
- SEC-004 CORS policy explicit
- SEC-005 API input validation (Pydantic everywhere)
- SEC-006 No secrets in logs, commits, or exports
- SEC-007 Docker least privilege (non-root, no stray mounts)
- SEC-008 Dependency vulnerability scans (npm audit + uv/pip audit)

## DOC docs/OSS (8)

- DOC-001 README with truth table (VERIFIED/EXPERIMENTAL/REQUIRES PROVIDER/PLANNED)
- DOC-002 Methodology documented
- DOC-003 Limitations documented
- DOC-004 Real `.env.example`
- DOC-005 Makefile with canonical commands
- DOC-006 CONTRIBUTING.md
- DOC-007 SECURITY.md
- DOC-008 LICENSE + fixed metadata.json

## TST testing (16)

- TST-001 Backend unit: transforms/mask/CFAR/components/geodesy/propagation/radius/scores/classification
- TST-002 Golden-vector parity (Python vs legacy TS)
- TST-003 Integration: provider → scene → SAR → detection → AIS → correlation → evidence → API
- TST-004 DEMO/REAL isolation test (REAL failure ⇒ explicit error, zero synthetics)
- TST-005 Restart persistence test
- TST-006 Cache keying + reuse + invalidation test
- TST-007 Export generation + provenance tests (all 5)
- TST-008 Frontend typecheck under `strict` + `noUnusedLocals`
- TST-009 Frontend unit: registry/search/selection/evidence/timeline/telemetry/modes/errors/keyboard
- TST-010 E2E DEMO full workflow
- TST-011 E2E REAL when a provider is accessible
- TST-012 E2E REAL-failure (unavailable → explicit error → no synthetics → no fallback)
- TST-013 Rendered review at 4 resolutions with fixes
- TST-014 Performance measured (window/detector/correlation/UI), never invented
- TST-015 Drift audit: no weakened tests, no skipped verification
- TST-016 Final global regression before verdict
