# Storage, alerting, analyst and MCP verification — 2026-10-11

## Scope and authority

Read and scoped fixes to `backend/darkfleet/storage/{runs,cache}.py`,
`backend/darkfleet/mission_alerts.py`, `backend/darkfleet/analyst.py`, and
`backend/darkfleet/mcp_server.py`, with their dedicated existing test modules.
Verification used the current Windows working copy and temporary local data
directories. Existing user data under `data/` was not touched. No live sensor,
provider, remote model, or broker was exercised. Test records tagged `REAL` are
controlled fixtures and are **not** proof of real satellite acquisition.

## Behavior verified and repaired

1. **RunStore directory and document boundaries.** All read, write, lookup,
   enumeration, and delete entry points now reject paths redirected through
   symlinks/junctions. Hardlinked records are rejected so another on-disk file
   cannot be exposed as a scan simply by linking it into `scans/`. Restart
   persistence and corrupted/missing evidence behavior remain covered by tests.
   The REAL/non-synthetic stamp is a metadata guard, not cryptographic sensor
   provenance verification.
2. **Cache file and archive boundaries.** Reject unsafe/overlong artifact names,
   path redirects through symlinked shards and hardlinked files. Reject `.npz`
   archives above 512 MiB and selected ZIP members with declared uncompressed
   size above 512 MiB before NumPy decompression. Compressed archive corruption
   and checksum mismatch remain cache misses; readers do not accept pickles.
   The bound is on declared archive member size, not a full hostile ZIP parser
   sandbox.
3. **MCP evidence disclosure controls.** Read-only tools now return bounded,
   selected scalars and validated AOIs/counts. Nested scan fields, URI and
   credential-bearing query parameter values, and unreviewed non-scalar data
   are excluded from tool outputs. AIS observation metadata is filtered too.
   Local AIS Parquet query refuses archive directory junctions and partition
   paths resolving outside the configured archive, while limiting partition
   enumeration to the configured cap. Missing targets are marked unknown and
   do not produce invented zero counts or claims of target absence.
4. **Deterministic mission alert and analyst.** Watch alert evidence excludes
   credential-bearing query values, URLs and Windows filesystem paths. Analyst
   SQLite opens in URI read-only mode and now rejects database hardlinks and
   redirects; saved operator prose is not used to generate sensor claims.
   Existing restart, deduplication, acknowledgment, source-replacement,
   unknown-evidence, and MCP SDK stdio handshake tests are preserved.

## Reproducible verification

From the repo root:

```powershell
python -m pytest backend/tests/test_cache_storage.py backend/tests/test_mcp_server.py backend/tests/test_analyst.py backend/tests/test_missions_alerts.py -q
python -m ruff check backend/darkfleet/storage backend/darkfleet/mission_alerts.py backend/darkfleet/analyst.py backend/darkfleet/mcp_server.py backend/tests/test_cache_storage.py backend/tests/test_mcp_server.py backend/tests/test_analyst.py backend/tests/test_missions_alerts.py
```

Baseline before edits: **63 passed**. Final scoped run: **78 passed, 2 skipped**
in 11.64 s. The lint command returned **All checks passed!** Windows file
symlink creation is denied to this
test account with WinError 1314, so two privilege-dependent symlink tests are
skipped; separate hardlink and ordinary Windows junction tests run in their
place and verify actual filesystem behavior. This does not establish complete
Windows concurrent reparse-point defense.

## Remaining boundaries and shared-owner observations

- **TOCTOU:** Another process with write authority over the data tree may
  exchange a directory or file after path validation and before actual I/O.
  A handle-based, Windows-specific reparse-point policy would be necessary for
  strong concurrent-adversary isolation; no such claim is made here.
- **Unsigned local observations:** A locally forged JSON record with
  `runtime_mode="REAL"` and `synthetic=false` may pass the metadata guard;
  cryptographic provenance/chain-of-custody is a separate product requirement.
- **AIS archive write path (shared owner):** During this parallel session,
  `backend/darkfleet/ais/archive.py::_part_path` was updated in another lane
  to normalize arbitrary source labels to deterministic safe filenames. A
  read-only traversal-name path probe stayed within the archive. This worker
  did not modify that code or verify the other lane's broader tests.
- **API route exposure (shared owner):** The local FastAPI API currently relies
  on local bind configuration and CORS rather than application authentication.
  Any external bind or proxy changes require independent access-control review.
- **Security model:** Whitelisting reduces disclosure of obvious credentials
  and metadata but cannot classify every secret embedded in an otherwise
  ordinary user-provided scalar. The MCP server is still a trusted-local-process
  interface: consumers and the filesystem owner must be permissioned.

No commit, push, release, or provider verification result is implied by this
evidence file alone; refer to the scoped worker handoff for exact status.
