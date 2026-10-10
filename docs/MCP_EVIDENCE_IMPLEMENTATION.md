# DarkFleet Local MCP Evidence Server

**Checkpoint:** 2026-10-10. **Transport:** official Model Context Protocol SDK,
stdio JSON-RPC. **Scope:** read-only access to already persisted REAL scan records,
SAR target correlation, local AIS archive and versioned maritime datasets.

## Local start

From `backend/`, with a Python environment containing DarkFleet's project
dependencies and the official Python MCP SDK:

```powershell
python -m pip install "mcp==1.30.0"
python -m tools.mcp_evidence --data-dir ../data
```

The server will be silent because stdout is the MCP JSON-RPC channel. It
accepts no remote transport by default, has no mandatory provider login or
AI model, and makes no cloud requests. The `--data-dir` must already exist.
The installed SDK version used for verification was `mcp==1.30.0`; DarkFleet's
core `pyproject.toml` was left unchanged because this is an optional operator
integration. Run using a compatible Python environment with the package installed.

For a local MCP host that spawns processes (adjust command and directories to
absolute paths on your machine):

```json
{
  "mcpServers": {
    "darkfleet-evidence": {
      "command": "C:/path/to/python.exe",
      "args": [
        "-m", "tools.mcp_evidence",
        "--data-dir", "C:/path/to/darkfleet/data"
      ],
      "env": {
        "PYTHONPATH": "C:/path/to/darkfleet/backend"
      }
    }
  }
}
```

An MCP client should call `tools/list` and `tools/call` through its normal SDK.
The configuration contains no private tokens. Any MCP client has the **same local
read access as the user running that process**; install only in trusted local
agent configurations, with filesystem access controlled by the operating system.

## Exposed tool contracts

| Tool | Parameters | Result contract |
| --- | --- | --- |
| `list_real_scans` | `limit=30` (1–100), `offset=0` (0–10000) | Available persisted REAL scan references, count and provenance; empty state `NO_PERSISTED_REAL_SCANS` |
| `get_real_scan` | `scan_id` | Original persisted AOI, counts, acquisition metadata, safe provenance; explicit missing scan |
| `list_real_scan_targets` | `scan_id`, `limit=30`, `offset=0` | Bounded SAR target summaries and stored AIS correlation decomposition, including nullable measurements |
| `get_real_target_evidence` | `scan_id`, `target_id` | Exact scan-scoped target/correlation and any recorded matched AIS observation; missing target is explicit |
| `query_persisted_ais` | `scan_id`, `start_utc`, `end_utc`, `mmsi=null`, `limit=100` (1–200), `offset=0` | Archive observation rows, `has_more`, interval, source; 7-day maximum UTC-aware window |
| `get_real_target_maritime_context` | `scan_id`, `target_id` | Local reference-dataset context from the persisted WGS84 target position, with per-channel status and provenance |

Identifiers are 1–100 ASCII alphanumeric/underscore/hyphen/dot characters,
starting with an alphanumeric character. MMSI filters require exactly nine
digits; date inputs must include a timezone. Invalid identifiers, limits and
time intervals return MCP tool errors instead of silently coercing values.

All tools retain `scan_id` identity; target identity is the **(scan_id,
target_id)** pair. Outputs never infer cross-scan identity from a coincidentally
identical target label. `get_real_target_maritime_context` does not accept
client-supplied coordinates. If a saved target has no valid latitude/longitude,
the result says `TARGET_POSITION_UNAVAILABLE`.

## Evidence semantics

Every scan tool verifies `runtime_mode == REAL`, `synthetic is False`,
and the stored record ID matches the requested ID. Missing scans and targets
return `status=MISSING_EVIDENCE` with an explicit reason; a corrupted or
improperly labelled legacy scan cannot be presented as a verified result.
Safe provenance includes the relative saved-record path, source scene identity,
acquisition metadata, and allowlisted processing identifiers. Source HTTP/SAS
asset links, credentials and unknown/unreviewed metadata are excluded.

AIS data comes from existing `data/ais/YYYY/MM/DD/part-*.parquet` files, read
via bounded DuckDB SQL with bound parameters and a requested explicit interval.
Missing archive is `AIS_ARCHIVE_NOT_PRESENT`; a valid query with zero matching
observations is `NO_OBSERVATIONS_IN_WINDOW`; I/O errors are
`AIS_ARCHIVE_READ_FAILED`. An offset beyond the last row is `PAGE_EMPTY`
rather than claiming no observations existed in the interval. Zero reported
observations do not establish zero
vessels. The archive query does **not** infer that a vessel matched the SAR
target: its results are independent historic observations. For an association,
use the correlation evidence on the persisted target.

Maritime context reuses the existing local
`darkfleet.maritime.service.build_context` (zone, coastline, port,
bathymetry), reading only the snapshot files already installed under
`reference/`. Each context channel preserves its own source provenance and
missing-dataset status. No provider or remote registry is consulted.

## Code boundary and verification

Implementation files:

- `backend/darkfleet/mcp_server.py` — reader and official FastMCP tool registration.
- `backend/tools/mcp_evidence.py` — locally runnable stdio entry point.
- `backend/tests/test_mcp_server.py` — persisted fixture records, AIS Parquet,
  missing data, validation, read-only file inventory and a real spawned SDK
  `ClientSession` stdio initialization + `tools/list` + `tools/call`.

Verification commands, from `backend/`:

```powershell
python -m pytest tests/test_mcp_server.py -q
python -m ruff check darkfleet/mcp_server.py tools/mcp_evidence.py tests/test_mcp_server.py
python -m mypy --follow-imports=skip darkfleet/mcp_server.py tools/mcp_evidence.py
```

Tests create actual persisted but explicitly **test-only** fixture records
and actual local AIS Parquet partitions in the pytest temporary directory;
the product server never synthesizes operational observations. A read-only
file-inventory assertion detects writes to the fixture source directory.
The final targeted run passed 4/4 pytest tests (including real stdio), scoped
Ruff, and scoped mypy on the two added implementation modules. Verification ran
under the local Windows Python 3.14.4 runtime; the project's declared support
target remains Python 3.12 and was not separately exercised in this checkpoint.
The `--follow-imports=skip` option bounds type checking to this MCP slice;
it does not assert that all other concurrently edited backend modules typecheck.

## Limitations

- Stdio is local process-to-process, and the protocol has no per-user
  authentication: the caller inherits the local user's OS file permissions.
- Missing source data never triggers provider fetch, scan scheduling or model
  reasoning. No repair or ingestion endpoint is exposed.
- These tools expose only allowlisted fields from the saved record, not raw SAR
  raster pixels or complete evidence export documents. Other API functionality
  remains in its existing endpoints.
- `list_real_scans` and target pagination bound **response size**; listing
  scan files still scans the local directory. AIS queries are capped to 7 days,
  at most 200 rows per request, 10,000 offsets and 10,000 Parquet partitions,
  but very large partition sets can incur substantial local scanning time.
- The reference-reader implementation may re-hash installed snapshot files to
  verify integrity. It does not install or download missing datasets.
- This checkpoint verifies the protocol with a real local MCP subprocess.
  It does not establish an external SaaS host, live provider coverage, or a
  production multi-tenant authorization model.
