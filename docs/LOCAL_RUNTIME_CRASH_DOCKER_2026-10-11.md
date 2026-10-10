# DarkFleet — genuine owner-process crash and Docker acceptance

**Execution:** 2026-10-11 Asia/Kolkata (2026-10-10 UTC).
**Inspected HEAD:** b5bdc675480ad7cc6ff78b3c81fcb0534065bad7.
**Data scope:** An independent Python child and pytest temporary root only. No user data/, service ports, master documents, real sensor observations or remote endpoints were used.

## Verdict table

| Gate | Verdict | Evidence |
| --- | --- | --- |
| Docker CLI | PASS | Docker 29.5.3, build d1c06ef |
| Docker Compose CLI | PASS | Compose v5.1.4 |
| Compose configuration | PASS | docker compose -f docker-compose.yml config --quiet: exit 0; default API and web published only on host loopback |
| Docker engine | EXTERNAL_BLOCKER | docker version and docker info: named pipe npipe:////./pipe/dockerDesktopLinuxEngine missing |
| Docker isolated start and health | NOT_RUN / EXTERNAL_BLOCKER | Engine inaccessible; no images built, containers started, ports bound or volumes written |
| Live kernel job owner | PASS | Independent ScanRunner sees ACTIVE_ELSEWHERE and leaves original in-flight state bytes unmodified while child holds actual lock |
| Abrupt owned-process termination | PASS | Child PID 21636 verified against own Popen PID, then child.kill() on that handle only; Windows child return code 1 |
| Same-root interruption recovery | PASS | Fresh FastAPI TestClient on original directory persisted FAILED at READING_SAR and read-only SSE replay reached terminal |
| Second restart and exact history | PASS | Identical recovered API and durable JSON; QUEUED -> SEARCHING_SCENE -> FAILED, no duplicate history |
| Local-only and no external egress | PASS (exercised child only) | Child DNS/TCP guards recorded 0 outside attempts; no source scan, no live listener, no user data writes |
| Prior MCP SDK read-only offline | PRIOR PASS, NOT_RERUN | docs/LOCAL_RUNTIME_MCP_ACCEPTANCE_2026-10-11.md, commit 53e10de; no new MCP failure or linkage issue observed |
| Genuine SAR/AIS provider source and Docker deployment | NOT_RUN / EXTERNAL | Test job generator is not a real scan; Docker daemon unavailable |

## Method and production code mapping

The new backend/tests/test_real_job_process_crash_acceptance.py launches a separate Python interpreter using subprocess.Popen. Inside it, ScanRunner(root/state) submits a **pure test-only generator** that yields the searching-scene stage and blocks, holding the genuine OS byte lock on root/state/jobs/DF-0001.lock. The owned child creates root/owner-ready.json with os.getpid(), stage and ready timestamp. The parent asserts that identifier matches its Popen.pid and that the child is still alive. No copied job JSON or artificial lock marker is used.

Before termination, an independent ScanRunner on the **same path** must report ACTIVE_ELSEWHERE, decline subscription and preserve source JSON unchanged. Only after that proof does the parent terminate its specific spawned child with Popen.kill(), wait for its exit, and confirm there was no graceful terminal write.

Fresh FastAPI startup via create_app(Settings(data_dir=<pytest-temp-root>)) releases no fake source data: instead it acquires the kernel-released lock, records an InterruptedError terminal event with stage FAILED and failed_at READING_SAR, and returns it from /api/scans/DF-0001 and /api/scans/DF-0001/events. A second independent lifespan returns the same API JSON, same three events and identical persisted JSON. The harness has bounded readiness/wait timeouts and a finally cleanup that can kill **only its own Popen child**.

The subprocess installs explicit socket hooks for getaddrinfo, connect, connect_ex and create_connection. Each non-local attempt would be written into child-egress-attempts.txt and refused. No such file existed after execution: **0 observed child external attempts**.

**Scientific provenance warning:** The job-state machine labels its record runtime_mode REAL and synthetic=false by default. Those are **runner metadata only**, NOT evidence of a verified REAL Sentinel-1 acquisition. The submitted generator explicitly records the detail “test-only stage, no source acquired”; no provider was called, imagery generated, AIS archived or scan result persisted. This is an acceptance of recovery mechanics, not satellite science.

## Timestamped measured receipt (UTC)

| Event | Observed timestamp |
| --- | --- |
| Parent before child creation | 2026-10-10T23:29:44.313052+00:00 |
| Child wrote QUEUED | 2026-10-10T23:29:44.682108+00:00 |
| Child wrote SEARCHING_SCENE | 2026-10-10T23:29:44.685445+00:00 |
| Child ready with owner lock | 2026-10-10T23:29:44.687217+00:00 |
| Test killed its child | 2026-10-10T23:29:44.722332+00:00 |
| Fresh app persisted FAILED | 2026-10-10T23:29:44.872437+00:00 |

The receipt reports PID **21636**, scan ID DF-0001, expected forcibly terminated child exit code **1**, preserved lock-marker file, three historical stages, no recorded external egress and no scan source file. All six timestamp orderings are asserted by the test. The child exit code is **not** the pytest result, and elapsed time is observational, not a performance guarantee.

## Test commands and outcome

- python -m pytest backend/tests/test_real_job_process_crash_acceptance.py backend/tests/test_job_interrupted_restart.py -q — **5 passed in 5.07 seconds** (new actual terminated-owner test plus existing simulated-copy/ownership coverage).
- python -m pytest backend/tests/test_real_job_process_crash_acceptance.py -s -q — **1 passed in 4.98 seconds**, prints REAL_JOB_CRASH_RECEIPT.
- python -m ruff check backend/tests/test_real_job_process_crash_acceptance.py — **All checks passed**.
- docker --version, docker version, docker info, docker compose version, docker compose -f docker-compose.yml config --quiet — Compose syntax passes, Docker engine externally blocked.

An initial attempted pytest collection failed because another worker's concurrently changing backend/tests/test_watch_alert_local_acceptance.py disappeared during collection. That was a shared-tree test-discovery race, **not** a test assertion failure. Later targeted runs passed. No files owned by another worker were edited.

## Residuals

Docker container startup, service health, volume restart and real provider-backed crash recovery remain **NOT_RUN** pending an available engine and genuine source access. The previously passing real MCP SDK offline test was deliberately **not rerun**, per task instructions. No production runner defect was reproduced and no existing runner code was changed. No user ports (including 8000 and 5174), external services, or master verification docs were touched. No push.
