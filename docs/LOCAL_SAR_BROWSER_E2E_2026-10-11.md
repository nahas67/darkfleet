# Local GeoTIFF browser acceptance — 2026-10-11

## Reproduction and scope

Run `python build-tools/local_sar_browser_e2e.py` at the repository root (or by absolute script path). Requires Python with `playwright`, `psutil`, `numpy`, `rasterio` and `Pillow`; installed Google Chrome; Node with installed Vite dependencies. The test starts its own **headless** Chrome, FastAPI on **127.0.0.1:8010**, and Vite on **127.0.0.1:5175**, with Vite proxying `/api` to that FastAPI. It refuses to run if either port is already in use. It creates and removes a private OS temporary directory for FastAPI `Settings(data_dir=...)`, operator `local-sar-inbox`, and receipts. No operator `data/` directory or pre-existing server/process is opened for writes; no push or deployment is performed.

Browser interaction uses Playwright user-level navigation, fill, select and click (`ADVANCED` rail → `Local GeoTIFF` tab → intake form). There are no DOM-dispatched submit/click events. A temporary ASGI socket guard rejects external DNS lookups and nonloopback TCP connects, logging attempted destinations. Browser requests outside loopback are aborted. Local Vite HMR WebSocket notifications are suppressed during verification because concurrent worker edits otherwise reload the form mid-interaction; normal HTTP API/UI traffic remains real. Google Chrome uses its installed stable channel because the optional Playwright `chromium_headless_shell` executable was absent. The script records SHA-256 of the UI/API contract files at both ends and fails if they change. It collects its own process PIDs and terminates its descendants on exit. Generated screenshots and service logs live in the temporary directory and are removed by the test.

The only image source is the **committed deterministic test GeoTIFF** at `backend/tests/fixtures/cog/fixture_32648.tif`, copied byte-for-byte to the private inbox. It is **not** a Sentinel-1 acquisition or evidence of actual SAR, acquisition time, polarization, calibration, analysis, vessel detection, or live provider availability. GRD / VV / RAW_DN and `2026-10-11T00:15:00Z` are operator-provided test declarations; the backend correctly reports `calibration_verified=false` and `IMPORTED_NOT_ANALYZED`.

Final passing execution's Git HEAD changed from `c30dd84879279c86d5df9b4f89387d4f984c9d64` to `0948bf5f18510c9c6950423804b35ee797ebbe34` while other workers were committing; the **four relevant Local GeoTIFF contracts were SHA-256-stable throughout this browser run**. The isolated process IDs were **FastAPI 5192**, **Vite 7172**, and **restarted FastAPI 20672**. Both FastAPI processes and the owned Vite process were terminated after the test. Disposable operator-data root was `C:\Users\nahas\AppData\Local\Temp\darkfleet-local-sar-browser-akrqlozy\operator-data` and was removed after completion. System Chrome reported version `154.0.8037.98`. Test command exit code: **0**. An earlier full run also passed; one intermediate run was interrupted by Vite HMR from unrelated concurrent edits before the HMR isolation was added.

## Source and image identity

| Item | Observed |
|---|---|
| Committed fixture size | 703,707 bytes |
| Committed fixture SHA-256 | `c1b231e9b398a285eaa76637078fbcd73db7f18cf5c84e904ccabe75a872b3e4` |
| Measured GeoTIFF | 400 × 400 pixels, EPSG:32648, float32 |
| UI POST request | `{"relative_path":"fixture_32648.tif","product":"GRD","polarization":"VV","acquisition_time":"2026-10-11T00:15:00Z","calibration":"RAW_DN"}` |
| Successful POST response | HTTP 201, import ID `d7fb2207d304b5fb000581e509edf397`, `IMPORTED_NOT_ANALYZED` |
| Browser image | `complete=true`, natural size 400 × 400 |
| Immutable PNG SHA-256 | `04517ed811cdb2afe2d37ddc921dd54d8f952b698fd4f39348d33fbb55c00262` |
| PNG verification | Actual RGBA 400 × 400 array matched **every pixel** reconstructed from the fixture's measured values and the backend's 2nd/98th percentile stretch; nonconstant grayscale |
| UI screenshot SHA-256 | `89c9208335a85ae412d5717d128398640790b73a70bc8e6f6694ef13026315f7` (captured in private temporary folder, intentionally not retained) |

## Integrated checks

1. **PASS — real UI reachability and truthful provenance:** clicking Advanced and Local GeoTIFF exposed the configured server inbox, submitted the selected source, displayed the saved import and a real decoded PNG, and rendered an import-only state without a completed scan.
2. **PASS — import identity and persistence:** a second real UI submit of identical fields returned the same ID and left exactly one persisted JSON receipt.
3. **PASS — client and server request refusal:** a traversal basename `../secret.tif` was stopped by the UI without a POST; a direct POST returned 422 `INVALID_RELATIVE_TIFF_BASENAME`. Unsupported `calibration=FABRICATED`, `product=RAW`, and an acquisition timestamp lacking a timezone each returned HTTP 422. The committed `fixture_unreferenced.tif` was refused with HTTP 422 `GEOREFERENCE_AFFINE_INVALID`; its invalid affine transform is rejected before reaching the CRS check.
4. **PASS — changed source:** modifying a pixel in **only the temporary inbox copy** changed its SHA-256 to `32cb7e2c8abb09888570b2c413122a700eed02de97617a60b3a23f701f949e0d`. Clicking Refresh sources displayed `SOURCE CHANGED`. The immutable saved preview remained byte-identical to the earlier PNG.
5. **PASS — missing source:** deleting **only the temporary inbox copy**, then clicking Refresh sources, displayed `SOURCE MISSING`. Submitting its filename returned HTTP 404 with safe `SOURCE_NOT_FOUND` error text in the UI, with the verified saved preview preserved.
6. **PASS — actual restart:** stopping and restarting the isolated FastAPI process on port 8010, then reloading the browser and navigating to Local GeoTIFF again, recovered the same import ID, source-missing status, catalogue count of one, and checksum-identical saved PNG. The private `scans/` folder contained **zero** synthetic completed scan receipts.

This is a real integrated local fixture acceptance, including raster decoding and browser interaction. It does not prove live satellite-provider access, geospatial science beyond the file metadata, or any user-owned dataset's behavior. Source changes and deletions were limited to disposable fixture copies.

## Network observations and limitations

The app's map shell attempted **10** `tile.openstreetmap.org` and **10** `server.arcgisonline.com` requests during this run; the browser blocked all 20. The isolated FastAPI attempted **12** external provider DNS lookups: **four** each to `planetarycomputer.microsoft.com`, `earth-search.aws.element84.com`, and `stac.dataspace.copernicus.eu`. These were rejected in-process **before external name resolution**. The Python guard also rejects attempted external TCP connects. These are documented egress *attempts*, not successful remote calls; no external provider response was consumed as test data. The import workflow itself completed offline. The guard is scoped to the launched Python process and browser; it is not an OS-wide packet capture or proof of zero DNS activity by unrelated software or child programs. Vite itself is a local Node development server and is not covered by the Python socket guard.

The script's terminal JSON provides the raw import receipt, request payload, individual browser response status codes, attempted external hosts, ephemeral service PIDs, fixture/PNG hashes, and screenshot hash. The screenshot itself is discarded because the worker owns only this verifier and document, and keeping temporary browser images is outside scope.
