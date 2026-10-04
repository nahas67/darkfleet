# Verified maritime reference sources

**Purpose.** Every contextual answer DarkFleet gives about a vessel must be traceable
to a named dataset, a version, and a licence. This file records what was **verified
against the publisher**, not what a documentation page once said.

**None of these datasets is committed to this repository.** They are installed
locally and versioned; see §45 of the DF-X8 brief. A 122 MB EEZ geodatabase or a
3.7-billion-cell bathymetry grid has no business in git.

---

## 1. Marine Regions Maritime Boundaries — MARITIME BOUNDARIES

| field | value |
|---|---|
| provider | VLIZ / Marine Regions |
| dataset | Maritime Boundaries Geodatabase |
| **current version** | **v12, released 2023-10-25** |
| archived | v11 (2019-11-18) and earlier |
| licence | **CC BY 4.0** |
| DOI | `10.14284/386` (v11 record; confirm the v12 DOI at install) |
| products | World EEZ v12 (122 MB), Contiguous Zone v4 (46 MB), Territorial Seas v4, Internal Waters, Archipelagic Waters, High Seas v1 (`10.14284/418`) |
| variants | GeoPackage, Shapefile, **Low res**, **0–360°**, KML |
| contains | overlapping claims and joint regimes |

**Verified 2026-10-04.** v12 is the current release; v11 is archived.

### Two corrections that matter

1. **Do not use v11.** A Copernicus Marine mirror
   (`EXT_MR_EEZ-AND-TERRITORIAL-SEAS`) still serves **v11 EEZ and v4 Territorial
   Seas**. Taking the version from a mirror rather than the publisher is how a
   product silently reports a five-year-old boundary.
2. **CC BY is not "do whatever".** VLIZ adopted CC BY at v11 and permits commercial
   use, but asks users **not to redistribute the products elsewhere** and to refer to
   marineregions.org for the most current version. So: cite it, do not republish the
   geodatabase, and re-check the version at update time.

### Legal caution

Maritime boundaries in this dataset are **disputed, overlapping and provisional**.
They are a third party's representation derived from treaties — and, where treaties
are unavailable, from **median lines that were calculated**. DarkFleet reports a
*DATASET-REPRESENTED* zone and never determines sovereignty. Where the source
exposes a dispute or overlap note, that note is preserved and shown.

### The 0–360° variant exists

Relevant to the antimeridian: the publisher ships a Pacific-centred 0–360° product
specifically for regions near longitude 180. Recorded here as an option; DarkFleet's
own wrap-aware geometry means it is not required for correctness.

---

## 2. Natural Earth — COASTLINE

| field | value |
|---|---|
| provider | Natural Earth (NACIS) |
| dataset | `ne_*_coastline`, 10m Physical Vectors |
| **current version** | **4.1.0** |
| size | 2.93 MB |
| licence | **PUBLIC DOMAIN** |
| scales | 1:10m / 1:50m / 1:110m for LOD |
| content | "Includes major islands" |

**Verified 2026-10-04.**

Labelled **REFERENCE COASTLINE**, never navigational hydrography. It is a cartographic
generalisation suitable for global reference scale; it is **not** chart-grade and
carries no depth, hazard or drying information.

---

## 3. GEBCO — BATHYMETRY

| field | value |
|---|---|
| provider | GEBCO Compilation Group (Nippon Foundation–GEBCO Seabed 2030) |
| dataset | GEBCO_2025 Grid |
| **current version** | **2025, published August 2025** |
| resolution | 15 arc-second, 43200 × 86400 (3,732,480,000 cells) |
| registration | **pixel-centre** |
| DOI | `10.5285/37c52e96-24ea-67ce-e063-7086abc05f29` |
| licence | **PUBLIC DOMAIN** — "free to copy, publish, distribute and transmit … adapt" |
| companion | **GEBCO Type Identifier (TID) Grid** |
| modern-standard coverage | **27.3%** of the ocean floor (up from 26.1% in 2024) |

**Verified 2026-10-04.**

Two consequences, both load-bearing:

- The **27.3% figure is itself provenance.** Presenting this grid as uniform global
  bathymetry would overstate it; the TID grid exists precisely to say which cells are
  measurement-based and which are interpolated.
- Labelled **REFERENCE BATHYMETRY — NOT FOR NAVIGATION**. GEBCO merges heterogeneous
  sources at a 15 arc-second cell, so no local sounding accuracy is implied.

### Delivery

Never a multi-gigabyte global grid in the browser. GEBCO publishes **user-defined
area** downloads (netCDF, GeoTIFF, ESRI ASCII) as well as the global netCDF, so the
server can hold a subset. That is the architecture.

---

## 4. NGA World Port Index — PORTS

| field | value |
|---|---|
| provider | NGA Maritime Safety Information |
| dataset | World Port Index (Pub 150) |
| **current edition** | **35th Edition, currency 31 August 2019** |
| licence | **PUBLIC DOMAIN** ("All the ports data has been released into Public Domain") |
| fields | ~100 characteristics: position, facilities, services, harbour type, size |
| formats | csv, geopackage, json, shapefile, file geodatabase |

**Verified 2026-10-04.**

**The currency date is a real limitation and is carried as such.** The live structured
export sits behind the NGA WPI Viewing Application; the directly downloadable
shapefile/PDF/Access artefacts are labelled *Archived 2019 Edition*. So the honest
position is: the data is public domain and structured, the current edition is 2019,
and obtaining it programmatically requires the viewer application.

Ports are **CONTEXT ONLY**. Proximity establishes distance and identity. It does not
establish origin, destination or intent, and DF-X8 §54 forbids inferring "heading to
port" from proximity alone.

---

## 5. Anchorages — DEFERRED, WITH REASON

**Status: NOT CONFIGURED.** The layer contract is implemented; no dataset is
integrated.

Reason: no globally complete, licence-unencumbered anchorage dataset was verified.
The realistic candidates are OpenStreetMap (ODbL — share-alike obligations on derived
databases) or national hydrographic offices (no single global source, per-country
licences, no uniform coverage).

Per DF-X8 §31 the layer reports **NOT CONFIGURED** rather than shipping invented or
partially-licensed data. An incomplete anchorage layer presented as complete is worse
than an absent one, because an operator cannot tell which it is.

---

## Basemap providers

Handled by the `MapSourceController`, not here — these are *providers* with health
state, not reference *datasets* with provenance. See
`docs/SPATIAL_PLATFORM_ARCHITECTURE.md`.

The required posture: a **keyless** OSM-compatible source so DarkFleet starts with no
credentials, with stronger imagery and configured commercial sources strictly
optional and never load-bearing.