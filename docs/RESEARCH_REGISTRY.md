# DarkFleet Research Registry

> Every significant external dependency. Freshness marked per row.
> `LAST VERIFIED 2026-10-01` unless noted. Anonymous probes only.

## RES-SAR — Providers (probed live, no credentials)

| NAME | PURPOSE | OFFICIAL SOURCE | LICENSE | AUTH | PROBE RESULT |
|---|---|---|---|---|---|
| Planetary Computer STAC + `sentinel-1-rtc` | Primary REAL SAR: analysis-ready RTC COGs | https://planetarycomputer.microsoft.com/api/stac/v1 | CC-BY-4.0 (RTC) | anon search; free SAS token endpoint for reads | search 200; SAS 200; 512² window 11.6 s, EPSG:32648 affine |
| Planetary Computer `sentinel-1-grd` | Secondary REAL SAR | same | proprietary | same SAS flow | search 200; read untested |
| CDSE STAC | NOT a Sentinel-1 source on public endpoint | https://stac.dataspace.copernicus.eu/v1 | n/a | anon discovery | 10 collections only (`ccm-*`, `clms_*`); S-1 absent; prior 400 = wrong ID |
| EarthSearch `sentinel-1-grd` | Backup GRD via GCP warp | https://earth-search.aws.element84.com/v1 | open data | anon search + public S3 | 70 scenes SG Strait; 210 GCPs EPSG:4326, no affine |
| AWS s1-orbits / STEP auxdata | Precise orbit metadata | registry.opendata.aws/s1-orbits ; https://step.esa.int/auxdata/orbits/ | open | anon | bucket + directory listings reachable |

## RES-AIS — AIS sources (probed live, no credentials)

| NAME | AUTH | LIVE? | HISTORICAL? | LOCAL STORAGE? | LICENSE | PROBE RESULT | DOCS |
|---|---|---|---|---|---|---|---|
| AISStream | free API key | yes `wss://stream.aisstream.io/v0/stream` | no (live-only) | yes per docs | proprietary service, free tier | 200 `/`, 200 `/documentation` | https://aisstream.io/documentation |
| AISHub | free username | yes, HTTP 1 req/min | no (snapshot) | members-only, redistribution restricted | proprietary | 200 `/`, 200 `/api` | https://www.aishub.net/api |
| Global Fishing Watch v3 | free account + Bearer key | derived events | yes (effort/events/presence) | yes with attribution | GFW ToU | 401 anon (expected) | https://globalfishingwatch.org/our-apis/documentation |
| US MarineCadastre AIS | none | no (delayed archive) | **yes, 2009+ ZIPs** | yes | US public domain | 200 hub pages | https://hub.marinecadastre.gov/pages/vesseltraffic |
| pyais (NMEA decode) | none (pip) | decoder | n/a | yes | MIT, v3.2.3 maintained 2026 | PyPI 200 | https://github.com/M0r13n/pyais |

Verdict: no free keyless *live global* feed; no free keyless *global historical* archive.
MarineCadastre = the keyless historical path (US waters, PD). libais rejected (stale 2018).

## RES-AUX — Reference data (probed live, no credentials)

| NAME | PURPOSE | SOURCE | LICENSE / REDIST | PROBE RESULT |
|---|---|---|---|---|
| ESA WorldCover v200 10 m | **Primary detection mask** (class 80 water) | esa-worldcover.org ; `s3://esa-worldcover/v200/2021/map` ; Zenodo 10.5281/zenodo.7254221 | CC-BY-4.0, attribution; fetch per-tile, don't vendor 124 GB | S3 listing 200; per-tile 2.5–20 MB; accuracy ~76.7% |
| OSM land polygons | Secondary mask/overlay | osmdata.openstreetmap.de | ODbL — **never vendor** (share-alike) | 928 MB zip, daily 2026-10-01 |
| Natural Earth 10 m | Coarse visualization only (bundle, 3 MB) | naturalearthdata.com | public domain | 200, `ne_10m_coastline.zip` 3 MB |
| GSHHG 2.3.7 | Visualization/small-scale only (2017 vintage) | soest.hawaii.edu/pwessel/gshhg | LGPL — never vendor | SOEST 200, 149 MB; NCEI mirror 404 (retired) |
| NGA World Port Index | Ports (~3,700) | msi.nga.mil/Publications/WPI | US PD — may vendor | CSV download 200 |
| MarineRegions EEZ v12 | EEZ boundaries | marineregions.org ; DOI 10.14284/632 | CC-BY-4.0 but **do not re-host**; WFS live + cite | WFS GetCapabilities 200 |
| NOAA shipping lanes | US TSS polygons | encdirect.noaa.gov/.../shippinglanes.zip | US PD — may vendor | 200, 2 MB, weekly refresh |
| World Bank traffic density | Global lane proxy raster | datacatalog.worldbank.org 0037580 | CC-BY-4.0 | listing confirmed; verify single-file GET before wiring |
| GEBCO_2026 | Bathymetry backdrop | gebco.net ; download.gebco.net | PD + attribution | 200; use subset API per AOI |

## RES-ML — Detection/CV (assessed 2026-10-01)

| NAME | SOURCE | LICENSE | DOMAIN/FIT | LIMITATION |
|---|---|---|---|---|
| SSDD / HRSID / OpenSARShip / LS-SSDD-v1.0 | linked GitHub/SJTU mirrors (see probe notes) | academic / request-gated | partial S1 | mixed sensors, small chips, gated downloads |
| xView3-SAR | https://iuu.xview.us/ | CC BY-SA IGO 3.0 | **S1 GRD 991 scenes + AIS** | ~1.4 TB, noisy near-shore labels — validation only |
| **No maintained open-weight S1-GRD vessel model exists** | allenai/sar_vessel_detect archived 2022–23 | Apache-2.0 code-only | comp snapshot | no weights/docs — train-your-own only |
| AssenSAR-Wake-Detector (sparse Radon) | github.com/oktaykarakus/AssenSAR-Wake-Detector | MIT | linear-wake Radon on SAR | linear arms only, needs denoised chips |
| skimage Radon Kelvin method | reimplement via `skimage.transform.radon` | n/a (our code) | arms + turbulent scar | implement deterministically |
| VH-first CFAR + VV confirm + VH/VV ratio | rs13061184 / DpolRAD literature | methods, not code | VH suppresses clutter; ratio boosts small vessels | needs calibrated dB pair |
| opencv-headless 5.0.0.93, scikit-image 0.26.0, scipy 1.18.1 | PyPI | BSD/Apache | cp312 wheels | pin numpy>=2 for scipy 1.18 |

Verdict: stay deterministic (CFAR on VH + VV-confirm + ratio channel + Radon
wake-confirm). ML interface stays an adapter; revisit only with labeled budget.

## Version pins adopted from research

`opencv-python-headless==5.0.0.93 scikit-image==0.26.0 scipy==1.18.1 pyais (MIT)
fpdf2 Pillow` — added to backend deps at CP1/CP4/CP12 as each lands.
