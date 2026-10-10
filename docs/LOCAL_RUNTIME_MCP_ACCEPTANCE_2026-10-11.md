# DarkFleet local runtime, MCP, and offline AI acceptance — 2026-10-11

## Scope and provenance

Read-only source inspection and independent local runtime acceptance began at
**Git HEAD `5ddc0c5eed0443ce3d1027b3ddce41aa22f110af`**, initially clean.
The source of requested unrun gates was
`docs/MASTER_VERIFICATION_CHECKPOINT.md`, especially AI-01, LOC-01, REL-01,
SEC-01 and external/deferred acceptance. That file was **read only**.

All new runtime state was written inside pytest-managed temporary directories.
No persistent `data/` assets, existing user scans, AIS archives, credentials,
Docker volume, live provider, or external model endpoint were accessed.
There were no successful external network requests. The MCP acceptance uses
**actual SDK stdio JSON-RPC and an independent child Python process**, rather
than calling an in-process `EvidenceReader` and calling that a stdio test.

## Docker operational probe

| Gate | Actual command / observation | Verdict |
| --- | --- | --- |
| Docker CLI installed | `docker --version` → **29.5.3**, build `d1c06ef` | **PASS** |
| Docker Compose installed | `docker compose version` → **v5.1.4** | **PASS** |
| Compose structure | `docker compose -f docker-compose.yml config --quiet` → exit 0 | **PASS** |
| Isolated Compose port scope | Parsed JSON config; API host `127.0.0.1:8000`, web host `127.0.0.1:8080` by default, with web dependent on healthy API | **PASS (configuration)** |
| Docker daemon | `docker version` client responds; daemon connection to `npipe:////./pipe/dockerDesktopLinuxEngine` fails because named pipe does not exist | **EXTERNAL_BLOCKER** |
| Docker info | `docker info --format '{{json .ServerVersion}}'` yields no server version; same missing engine pipe | **EXTERNAL_BLOCKER** |
| `docker compose up`, image build, container health, service restart | **NOT_RUN: EXTERNAL_BLOCKER**. Would require Docker Desktop Linux engine. No volume or potentially live-provider-backed container was started | **NOT_RUN / EXTERNAL_BLOCKER**, not a failed product healthcheck |

The container API correctly binds `0.0.0.0` *inside* the Compose network, but
the host-published API and web ports remain loopback-bound. This confirms
configuration only; it is not evidence of a running container.

## Actual MCP stdio acceptance

New isolated regression:
`backend/tests/test_local_runtime_mcp_acceptance.py`. Its first test:

1. Creates an **empty** temporary operator evidence directory.
2. Starts `python -m tools.mcp_evidence --data-dir <temp>` as a **real
   subprocess** through the official MCP Python client's `stdio_client`
   and `ClientSession`; negotiates a protocol handshake.
3. Injects a temporary `sitecustomize.py` into the *child's* Python import
   path so that socket DNS, `connect`, `connect_ex` and
   `create_connection` cannot reach non-loopback addresses. The child writes
   a guard-loaded marker outside the evidence directory. Attempts would be
   recorded and blocked; actual run recorded **zero attempts**.
4. Confirms the exact six tools and their
   `readOnlyHint=true`, `destructiveHint=false`,
   `openWorldHint=false` annotations:
   `list_real_scans`, `get_real_scan`, `list_real_scan_targets`,
   `get_real_target_evidence`, `query_persisted_ais`,
   `get_real_target_maritime_context`.
5. Calls **every one** against a genuinely absent scan. Empty inventory is
   `NO_PERSISTED_REAL_SCANS`; absent evidence is explicit
   `MISSING_EVIDENCE`, not invented detections, zero measured targets,
   synthetic AIS or a fabricated maritime context.
6. Sends malformed traversal-style scan/target IDs and invalid pagination,
   observes SDK error responses, then confirms **no files created in the
   temporary evidence directory**.

Verdict: **PASS**, read-only stdio, missing-data semantics, actual child
network guard and malformed input. Existing
`backend/tests/test_mcp_server.py::test_actual_sdk_stdio_integration`
independently exercises all six tools against **clearly test-fixture** scan
and Parquet data, including citation fields, limit validation and output
properties. Those fixtures are not authenticated live SAR/AIS acquisitions.

## Offline/local analyst

The new second test invokes the **actual FastAPI** `/api/analyst` and
`/api/investigations` routes through a temporary-data-dir `TestClient`,
creates an unlinked case and an adversarial instruction-like annotation,
then exercises `SUMMARY`, `WATCHLIST`, `SAR_AIS` and `GAPS`.

- Every response reports `NO_MODEL_DETERMINISTIC_OFFLINE` and
  `NO_SCAN_LINKED`; no sensor claim or fake scan hash is emitted.
- Operator annotations remain data. The injected instructions and URL do
  not enter generated analyst claims.
- Unsupported intent, injected prompt field, traversal target and malformed
  case identifier are rejected with HTTP 422.
- A fresh application lifespan reopens the same temporary SQLite case
  and reports its genuine persisted annotation count.
- No external model, agent tool execution, provider request or authorization
  to write analysis conclusions was used.

Verdict: **PASS** for deterministic local no-model analysis and fail-closed
source semantics; **NOT_RUN / EXTERNAL** for external or paid cloud models
(not configured, not part of this local analyst contract).

## Offline and declared fallback

Ran
`npx vitest run src/globe/mapSources.test.ts src/globe/MapSourceController.test.ts`:
**34 passed** in two files. The production basemap registry retains
keyless **OSM** (`tile.openstreetmap.org`) and **Esri World Imagery**
(`server.arcgisonline.com`), with optional token-dependent Cesium ion.
These are **declared frontend imagery egress**, not evidence of SAR or AIS
coverage. No real tile was downloaded in this acceptance run; browser live
tile/failover testing is **NOT_RUN**, not marked PASS.

Also ran the established isolated backend
`backend/tests/test_restart_workflows_reverify.py`. Its provider-health
instrumentation exercises actual backend health-route attempts to Planetary
Computer, Earth Search and CDSE, blocks all three **before transport**,
records zero undeclared normal workflow egress, and deliberately probes the
DNS guard to prove it fires. These are *attempted declared provider calls*,
not successful provider checks or independent provider availability claims.
In the MCP subprocess, the child-local network guard separately proves
that **zero** external calls were attempted by the exercised read tools.

## Executed verification and results

```powershell
python -m pytest backend/tests/test_local_runtime_mcp_acceptance.py backend/tests/test_mcp_server.py backend/tests/test_analyst.py backend/tests/test_restart_workflows_reverify.py -q
python -m ruff check backend/tests/test_local_runtime_mcp_acceptance.py
npx vitest run src/globe/mapSources.test.ts src/globe/MapSourceController.test.ts
```

| Gate | Result |
| --- | --- |
| New two acceptance regressions | **2 passed**, including real stdio / analyst HTTP |
| Focused combined backend | **24 passed, 1 skipped, 0 failed**, 18.52 s |
| Frontend source/fallback controller | **34 passed, 0 failed** |
| Ruff targeted new file | **All checks passed!** |
| Windows symlink boundary test | **SKIPPED**, Windows WinError 1314 lacks symbolic-link privilege; other MCP input protections executed |
| Public network egress | **0 successful calls**. Child stdio guard marker present and zero attempts; health-route declared attempts stopped before transport |

An initial exploratory test assertion falsely flagged the analyst's standard
disclaimer phrase `illicit conduct` as if it were leaked prompt text. The
expectation was corrected to check the distinctive injected instructions;
the full final run passed. **No application defect was reproduced**, so no
production code was changed.

## External blockers and residuals

**EXTERNAL_BLOCKER:** Docker Desktop Linux engine is not running or its named
pipe is unavailable. A genuinely successful Compose startup, API/web
container health, restart and volume persistence test remains required on
an operational Docker host. A config-only PASS must never be promoted to a
container runtime PASS.

**NOT_RUN:** a real sensor acquisition, independently authenticated
provenance, real AIS archive under operational ownership, live provider
authorization, actual OSM/Esri tile-network failover, external model
integration and multi-process adversarial filesystem swapping. Local saved
`REAL` flags in separately created fixture tests are *not* independent
scientific verification. This lane made no global checkpoint/master-doc
edits, no user-data writes and no remote egress.
