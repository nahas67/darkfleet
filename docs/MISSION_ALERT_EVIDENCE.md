# DF-X18 — Durable Missions and Evidence-Grounded Alerts

**Implementation:** local, read-only against historical source observations.
Alert statements are operator-configured numeric threshold matches, **not**
determinations of vessel identity, illicit activity or fresh AIS/SAR events.

## 1. Baseline and storage boundaries

Before DF-X18, ScanWorkflow supplied real scan tasking and the Investigation
notebook held saved cases, watched SAR target IDs and WGS84 operator
annotations. Neither persisted mission management or alert acknowledgement.
The authoritative REAL scan store remains under data/scans/scan_id.json.
The mission system never writes, replaces, schedules or deletes those files.

Five new SQLite tables are created idempotently in data/missions.sqlite3:

| Table | Durable role |
| --- | --- |
| missions | User-provided title, WGS84 AOI, status and timestamps |
| mission_scans | Unique link from mission to an existing REAL completed scan |
| mission_rules | Operator's investigation, watched target, original scan, SAR threshold |
| mission_alerts | Unique rule/scan/target alert and immutable evidence snapshot, SHA-256, acknowledgement |
| mission_evaluations | Last status and reason for each rule/scan/target, including NOT_EVALUATED |

SQLite foreign keys cascade on **mission deletion**, but never alter saved
investigation notes/watchlist, operator WGS84 geometries, or source scan
evidence. Removing a rule does not erase historical alerts and evaluation
outcomes. Mission status: PLANNED, ACTIVE, PAUSED, CLOSED; only ACTIVE may
evaluate historical evidence. CLOSED refuses new scans and rules. Evaluation
never runs automatically or in the background.

Mission AOI is required as [west, south, east, north] in strictly ordered
WGS84 degrees. Antimeridian-spanning AOIs must be split into non-wrapping
rectangles. A mission scan link requires a persisted scan with matching ID,
REAL, synthetic=false, stage=COMPLETE, and a validated WGS84 scan AOI that
overlaps the mission AOI with positive intersection. Unknown scan AOI and
nonoverlap are explicit 409 errors; changing the mission AOI rechecks every
linked scan. Bounding-box overlap is a coarse sanity check, not proof that
all mission coordinates were imaged.

## 2. HTTP API

All endpoints are under /api/missions.

| Method | Path | Contract |
| --- | --- | --- |
| GET / POST | / | List or create durable missions |
| GET / PUT / DELETE | /{mission_id} | Detail, replace title/AOI/status or remove |
| POST | /{mission_id}/scans | Link existing completed REAL scan |
| DELETE | /{mission_id}/scans/{scan_id} | Unlink; blocked while active rules depend on the scan |
| POST | /{mission_id}/rules | Create operator watchlist confidence rule |
| DELETE | /{mission_id}/rules/{rule_id} | Remove future evaluation rule, preserve alert history |
| POST | /{mission_id}/evaluate | One explicit deterministic evaluation run |
| POST | /{mission_id}/alerts/{alert_id}/ack | Idempotently acknowledge a saved alert |

MissionOut includes scan_ids, rules, alerts, evaluations, AOI, status and
timestamps. Pydantic request models forbid extra attributes. Common
structured errors include UNKNOWN_MISSION, UNKNOWN_SCAN, UNKNOWN_TARGET,
TARGET_NOT_WATCHED, SCAN_NOT_LINKED, AOI_NOT_OVERLAPPING,
SCAN_AOI_NOT_ESTABLISHED, DUPLICATE_RULE, MISSION_NOT_ACTIVE,
SCAN_HAS_RULES and UNKNOWN_ALERT.

Rule creation body:

~~~json
{
  "investigation_id": "existing-case-id",
  "target_id": "DF-001",
  "minimum_sar_confidence": 0.8
}
~~~

The investigation must still contain this target in its saved watchlist;
its associated scan must also be explicitly linked to the mission.
Threshold must be finite in [0,1]. The one supported kind is
WATCHED_TARGET_SAR_CONFIDENCE. Rules do not assert anything about
intent, deceptive reporting, suspicious ships or legal violations.

## 3. Evidence evaluation and missingness

The pure mission_alerts.evaluate_sar_watch function reads only stored REAL
source records. It verifies source scan identity/runtime mode/synthetic flag,
COMPLETE stage, exactly one target ID, and finite numeric sarConf in [0,1].
The route also rechecks that the original operator investigation watchlist
entry still exists before evaluating.

The result is TRIGGERED if saved sarConf >= operator threshold, or
BELOW_THRESHOLD otherwise. Missing or corrupt source scan, incomplete scan,
absent target, unrecorded SAR confidence and revoked watchlists return
NOT_EVALUATED with a reason. NOT_EVALUATED is not zero detections and cannot
produce a new alert. The evaluator does not contact live providers, invoke
LLMs, or simulate detections.

When a rule triggers, one alert is stored with threshold, observed saved
confidence, scan and target IDs, classification (as source context only),
whitelisted scene and processing provenance, an SHA-256 fingerprint, and an
explicit rationale denying a determination of identity or intent.
Provider tokens, raw asset URLs and unreviewed metadata are excluded.
SQL UNIQUE(rule_id,scan_id,target_id) prevents duplicated alerts on
repeated manual evaluation and across application restarts. Status lifecycle:
OPEN to ACKNOWLEDGED with a saved UTC time. Repeated acknowledgement
returns the original time; reevaluation does not reopen acknowledged alerts.
If a source record is unexpectedly replaced after an alert, fingerprint
comparison instead returns NOT_EVALUATED with
SOURCE_EVIDENCE_CHANGED_AFTER_ALERT. The prior alert remains historical;
the changed record does not masquerade as the same observation.

## 4. Local UI workflow

The operation rail now includes Missions, separate from Tasking and Reports.
The panel supports mission creation/selection/delete; WGS84 AOI entry or
current selection; mission status; persisted scan linking/unlinking;
refreshing the Investigation watchlists; watchlisted-target rule configuration;
manual evaluation, persisted result categories and an alert ledger with
source context and acknowledgement.

1. Persist a REAL scan with the existing Tasking tool.
2. In Reports, create an Investigation linked to that scan and watch a SAR target.
3. In Missions, create a mission with an overlapping AOI, link the scan.
4. Refresh watchlists, select the investigation and target, set a confidence threshold.
5. Switch status to ACTIVE and explicitly evaluate historical evidence.
6. Review rationale, original source scan and fingerprint, then acknowledge.

There is no autonomous alert generation or continuous monitoring claim.

## 5. Verification and ownership

Backend verification from backend/:

~~~powershell
.venv/Scripts/python.exe -m pytest tests/test_missions_alerts.py -q
.venv/Scripts/python.exe -m ruff check darkfleet/api/missions.py darkfleet/mission_alerts.py tests/test_missions_alerts.py
.venv/Scripts/python.exe -m mypy --follow-imports=silent --disable-error-code=valid-type darkfleet/api/missions.py darkfleet/mission_alerts.py
.venv/Scripts/python.exe -m tools.export_contract --check
~~~

Frontend verification from repo root:

~~~powershell
npm test -- --run src/api/missions.test.ts src/missions/MissionWorkspace.test.tsx
npm run lint
npm run build
~~~

Tests cover SQLite restart durability, mission CRUD, REAL/false evidence
verification, scan-file immutability, AOI overlap guards, watchlist authority,
hit and miss thresholds, NOT_EVALUATED when inputs disappear, duplicate-free
reevaluation, acknowledgement timestamp survival, cross-mission isolation,
API errors, client shape validation and UI/rail discovery.

Final verified scope: Python 3.12 backend/.venv **27 passed / 1 existing
Starlette TestClient deprecation warning** (mission + predecessor
investigation/geometry tests); scoped Ruff passed; scoped mypy passed with
existing unrelated views.py valid-type warning suppressed; focused frontend
Vitest **13 passed** (mission plus predecessor investigation API coverage);
TypeScript lint passed; Vite production build passed with the routine
oversized bundle warning; generated contract check current at **3,574 lines**.

**Browser smoke:** In the existing local Chrome Vite tab, a real click opened
Missions, backend GET /api/missions returned 200, real inputs + Create made a
temporary mission via POST 201, and the UI's confirmed Delete sent DELETE 204.
A subsequent GET 200 showed zero test missions. No temporary alert or
fake scan was inserted into real runtime data.

Prime regenerated the shared TypeScript contract to include all new mission
schemas; the worker did not modify or stage contract.ts or export_contract.py.
Only the permitted app/router/rail mount points and new DF-X18 files changed.

## 6. Explicit unresolved limitations

- No background scans, event stream subscriptions, push notifications,
  real-time AIS or SAR alerts. Evaluation is manually triggered against
  already saved REAL scan records.
- No multi-user ownership/RBAC, author signature, mission edit revision
  audit log, or notification delivery.
- Alert types are limited to the operator-configured sarConf threshold on
  an existing watched SAR target; no multi-venue track geofencing or AIS
  non-reporting inference. Missing data cannot prove vessel absence.
- Mission AOI uses non-wrapping WGS84 bboxes, not polygons or dateline-
  crossing single AOIs; bbox intersection is not scene coverage fidelity.
- The existing top command strip's global mission label/timeline remain
  outside this slice's permitted ownership and are not rebound to durable
  mission records.
- Browser smoke tested creation/navigation/deletion, not a real-provider
  acquisition followed by human browser evaluation and acknowledgement.
  Scientific/evidence assertions are test-fixture and deterministic
  storage checks, not verified-world events.
