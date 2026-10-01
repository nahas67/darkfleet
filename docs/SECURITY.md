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
`.`, `..`, separators, and NUL bytes (`storage/runs.py:130`). Scan identifiers
are allocated by the runner, not accepted from clients.

**Input validation.** Every request body is a Pydantic model. A malformed AOI is
rejected with 422 before any work begins (`api/models.py::BBox`).

**Secrets.** Provider credentials are read from environment variables only.
`redact()` in `api/routes.py` scrubs values before they enter any response or
log line. Provider health responses report status, latency, and error text —
never credentials.

**CORS.** An explicit origin allowlist, `allow_credentials=False`.

**Container privileges.** The Docker images run as non-root with no capability
additions and no privileged mounts.

**DEMO/REAL isolation.** `RunStore.save` rejects any record whose
`runtime_mode` and `synthetic` flag disagree. This prevents mislabelled evidence
being persisted even if a caller is wrong.

## Known limitations

- There is **no authentication or authorization layer**. DarkFleet is designed
  for local-first, single-operator use. Do not expose it to an untrusted
  network without putting an authenticating proxy in front of it.
- There is **no per-request rate limiting**. Local operation makes this
  acceptable; a shared deployment needs it.
- Raster windows are bounded by the configured AOI but there is no global
  maximum pixel budget. Very large AOIs will be slow and memory-hungry rather
  than rejected.

## Dependency policy

Backend dependencies are pinned in `backend/pyproject.toml`; frontend in
`package.json` with a committed lockfile. Both `npm audit` and the Python
ecosystem scanners are expected to run clean before release. Report any
vulnerability you find in a transitive dependency.