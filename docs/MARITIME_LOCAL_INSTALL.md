# DF-X14 — Install locally obtained maritime reference GeoJSON

This command imports **only files already obtained by the operator**. It does not
download data, register with a publisher, authenticate, determine usage rights, or
confirm that a local file came from its claimed publisher. No reference data ships
with DarkFleet. Until imported, the respective reference dataset remains
`NOT_INSTALLED`.

The installer uses the existing `darkfleet.maritime.store.install` canonical
serializer, checks its recorded prepared checksum, then atomically publishes that
staged version to `<data-dir>/reference/<dataset>/<version>/`. Neither an untrusted
source checksum nor an archive digest is passed as the publisher checksum of the
**prepared** JSON. The resulting `CHECKSUM_UNRECORDED` state is expected: the local
data can be read and local corruption is detectable, but publisher origin is still
**unverified**. An `ingestion.json` receipt separately describes the observed raw
file SHA-256, operator-provided expected raw hash (if any), declared publisher URL,
retrieval time, feature count, prepared hash and source/usage limitations.

## Supported inputs and provenance

| Dataset id | Source | Version/identity | Input |
|---|---|---|---|
| `natural_earth_coastline` | [Natural Earth physical vectors](https://www.naturalearthdata.com/downloads/10m-physical-vectors/) | Registry version `4.1.0` | GeoJSON `FeatureCollection` of `LineString`/`MultiLineString` |
| `marine_regions_eez_wfs` | [Marine Regions WFS](https://geo.vliz.be/geoserver/MarineRegions/wfs), layer `MarineRegions:eez` | **Service release version not established**; require real retrieval timestamp and independently observed feature count | GeoJSON `FeatureCollection` of `Polygon`/`MultiPolygon` with source `mrgid`, `pol_type` including `200NM`, claimant attributes |
| `marine_regions_eez` | [Marine Regions World EEZ bulk product](https://www.marineregions.org/downloads/) | Registry `12`; bulk identity must be confirmed by operator from its actual obtained file | Same raw EEZ GeoJSON schema |

For `.zip` files, the archive must contain **exactly one** `.geojson` or `.json`
payload and no unsafe paths, symlinks or encrypted members. Archives containing only
Shapefile (`.shp`/`.dbf`) or GeoPackage are **not directly supported**. Obtain them
lawfully and convert **locally** to RFC 7946 GeoJSON using a separate trusted GIS
utility such as GDAL/OGR, selecting EPSG:4326 / longitude-latitude coordinates,
preserving feature properties and all polygon interior rings. Confirm that the
conversion has not omitted features or generated geometries. The ZIP adapter never
extracts any archive member onto the filesystem.

The importer limits source size to 256 MiB, ZIP entries to 32, ZIP expansion ratio to
500, features to 50,000, and vertices to 2,000,000. It accepts WGS84 lon/lat in
`[-180, 180]`, `[-90, 90]` and preserves antimeridian crossings; the Pacific-centred
0–360° format must be converted consciously rather than silently normalized. It
rejects unexpected geometry types, empty datasets, unsupported CRS, unclosed rings,
3D positions, duplicate feature IDs, and partial WFS feature counts. It does not validate that the
geographic shapes are legally correct or that operator-declared provenance is true.

## Commands (Windows PowerShell)

Run from the repository's `backend` directory with its Python 3.12 environment:

```powershell
.venv\Scripts\python.exe tools/install_maritime_reference.py --help
```

Natural Earth coastline, after locally converting the authorised publisher file to
GeoJSON (path names below are examples, **no file is bundled**):

```powershell
.venv\Scripts\python.exe tools/install_maritime_reference.py `
  --dataset natural_earth_coastline `
  --input 'C:\reference-input\ne_10m_coastline.geojson' `
  --data-dir '..\data' `
  --source-url 'https://www.naturalearthdata.com/downloads/10m-physical-vectors/' `
  --source-version '4.1.0' `
  --terms-confirmed
```

Marine Regions **WFS** GeoJSON snapshot previously fetched in full using authorised
means (the retrieval time and publisher reported count below must be replaced by
**the actual evidence for your file**):

```powershell
.venv\Scripts\python.exe tools/install_maritime_reference.py `
  --dataset marine_regions_eez_wfs `
  --input 'C:\reference-input\marine_regions_eez.geojson' `
  --data-dir '..\data' `
  --source-url 'https://geo.vliz.be/geoserver/MarineRegions/wfs' `
  --retrieved-at '<ACTUAL-ISO8601-UTC-TIMESTAMP>' `
  --source-feature-count <ACTUAL-SERVICE-REPORTED-COUNT> `
  --terms-confirmed
```

`<...>` tokens in that second command are **required operator-provided values**;
do not run it as-is. This tool never fetches WFS features or counts for you.
If the publisher provides a checksum for the **original input file**, add
`--expected-source-sha256 <64-character-hex-digest>`; the input bytes must match.
That checksum verifies equality to a user-supplied expectation, **not that the
publisher authored those bytes**. The receipt preserves that distinction.

The separate *bulk v12* registration source can instead use
`--dataset marine_regions_eez --source-version 12` with the appropriate Marine
Regions source URL; this installs a historical/alternative bulk slot. It does
**not** replace the live application's `marine_regions_eez_wfs` authority for
zone classification or the layer console.

## Recovery and verification

The importer refuses an existing dataset/version unless `--replace` is supplied.
It uses an exclusive `.dfx14-install.lock`, a temporary staged directory and a
temporary backup for explicit replacement. If publication raises before completion,
the previous version is restored. If a process dies after moving the previous
version to backup but before publishing, the **next invocation** restores the
sole backup. Multiple backups require manual review. Preserve any backup and staged
directories when diagnosing unexpected failures; do not delete unknown files.
Never remove `.dfx14-install.lock` unless you first verify that no install process
is running; an abandoned lock requires operator inspection.

After import, inspect `data/reference/<dataset>/<version>/manifest.json` and
`ingestion.json`, then query `GET /api/maritime/datasets` or use
`darkfleet.maritime.store.status_of(data_dir, dataset_id)` to confirm the state.
Repeat `status_of` after a process restart. Replacing one version can invalidate
historical reproducibility for reports referring to that version; archive the old
installation appropriately before `--replace`.

**Unavailable sources:** Licensed/restricted ports, global anchorages and bathymetry
have no installer in DF-X14. Natural Earth and Marine Regions input payloads were
not provided or verified during development. Tests use synthetic, isolated unit
fixtures only; green tests do not establish operational dataset coverage, licence
rights, source authenticity, or source-feature completeness.
