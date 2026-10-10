# Security Policy

## Reporting a vulnerability

Report privately via the repository's security advisory form rather than a
public issue. Include reproduction steps, the affected version, and the impact
you observed. You should receive an acknowledgement within a few days.

## Threat model

DarkFleet ingests untrusted geospatial data from third-party STAC catalogues and
user-supplied AIS files, then serves analysis results to a browser. The
interesting risks are therefore:

1. **Server-side request forgery** — a hostile catalogue response redirecting the
   backend at internal services.
2. **Path traversal** — a crafted `scan_id` or import path escaping the data
   directory.
3. **Secret disclosure** — provider credentials reaching logs, exports, or the
   browser.
4. **Resource exhaustion** — unbounded reads of large rasters or archives.

## What is implemented

**Outbound requests.** The backend makes outbound calls only to provider URLs
that come from typed configuration (`config/settings.py`), never from request
bodies. The health probe has a single call site (`api/routes.py::_probe_json`)
so it can be stubbed in tests and audited in one place.

The Planetary Computer SAS signer (`providers/stac.py::_pc_sign_href`) derives a
token path from a catalogue-provided asset href. It only proceeds when the host
matches `*.blob.core.windows.net`, and the token base URL always comes from
configuration — a hostile response cannot redirect the token request to an
arbitrary host.

**Filesystem paths.** `RunStore` validates its subdirectory name and rejects
`.`, `..`, separators, and NUL bytes (`storage/runs.py:152-157`), and refuses a
`scan_id` containing a separator, NUL or colon (`storage/runs.py:184`). Scan
identifiers are allocated by the runner, not accepted from clients.

**Input validation.** Every request body is a Pydantic model. A malformed AOI is
rejected with 422 before any work begins (`api/models.py::BBox`).

**Secrets.** Provider credentials are read from environment variables only.
`redact()` in `api/routes.py` scrubs values before they enter any response or
log line. Provider health responses report status, latency, and error text —
never credentials.

**CORS.** An explicit origin allowlist, `allow_credentials=False`.

**Local API binding.** `Settings.api_host` defaults to `127.0.0.1`, and the
Compose published API/web ports default to host loopback. The API has no operator
authentication, so network publication requires explicit configuration and an
authenticating reverse proxy. The container process binds to `0.0.0.0` inside
its own network namespace so that the loopback-published host port can reach it.

**Offline GeoTIFF intake.** `/api/sar/local/*` is a separate **loopback-only**
operator interface. The route checks the actual ASGI peer address rather than
trusting `Host`, `Origin` or proxy-forwarded headers. It accepts inbox-relative
GeoTIFF basenames, not URLs or absolute paths, and is limited to a configured
local directory (default `<data_dir>/local-sar-inbox`). Intake enforces a file
size, raster pixel count and raster edge bound before decoding, checks affine
CRS and nonempty finite pixels, retains a SHA-256-verifiable private copy, and
revalidates source/snapshot integrity on later reads. No imported document
becomes a completed scan, calibrated observation or AIS association by being
readable. See `docs/LOCAL_SAR_IMPORT_EVIDENCE.md` for the current validation.

Loopback restrictions are **not user authentication**: any local process able
to reach the API may invoke the import endpoint, and an operating-system user
who can alter the local inbox or stored receipts may manipulate that filesystem
content. Deployments behind reverse proxies must retain the local-peer policy;
do not expose this endpoint as an anonymous upload/inspection service.

**Container privileges.** The Docker images run as non-root with no capability
additions and no privileged mounts.

**No synthetic path.** There is no DEMO mode, no scene synthesiser
(`backend/darkfleet/demo.py` is deleted) and no `allow_synthetic_scenes` setting.
Two guards back that up:

- `RunStore.save` rejects any record that is not `runtime_mode="REAL"` **and**
  `synthetic=False`, and requires both fields to be present — so a caller cannot
  persist a mislabelled artifact, or an artifact with the isolation fields
  stripped out.
- `mark_synthetic(record, synthetic=True)` raises at the call site rather than
  letting the store reject it downstream.

A provider failure is an error response and persists nothing; there is no second
world for the pipeline to degrade into. `POST /api/scans` rejects
`runtime_mode` and `scene_id` with 422 `extra_forbidden`, and the OpenAPI schema
advertises neither, so a caller cannot request a mode that does not exist.

## Known limitations

- There is **no authentication or authorization layer**. DarkFleet is designed
  for local-first, single-operator use. Do not expose it to an untrusted
  network without putting an authenticating proxy in front of it.
- There is **no per-request rate limiting**. Local operation makes this
  acceptable; a shared deployment needs it.
- Windows does not expose `os.O_NOFOLLOW` through Python's `os` interface.
  Local GeoTIFF intake rejects link paths using filesystem metadata and checks
  the opened source identity before accepting bytes, but the Windows link test
  was skipped where symlink privileges were unavailable. Resistance to a
  malicious, privileged actor concurrently swapping NTFS reparse points has
  **not** been independently demonstrated. Do not grant untrusted local users
  write access to the configured inbox or imported archive.
- Raster windows are bounded by the configured AOI but there is no global
  maximum pixel budget. Very large AOIs will be slow and memory-hungry rather
  than rejected.

## Dependency policy

Backend dependencies are pinned in `backend/pyproject.toml`; frontend in
`package.json` with a committed lockfile. Both `npm audit` and the Python
ecosystem scanners are expected to run clean before release. Report any
vulnerability you find in a transitive dependency.
