# Watchlist / alert operator acceptance — 2026-10-11

## Scope and scientific source boundary

Reviewed `backend/darkfleet/mission_alerts.py`, `backend/darkfleet/api/missions.py`, investigation watchlist routes, `src/missions/MissionWorkspace.tsx`, `src/api/missions.ts`, the existing `test_missions_alerts.py` and restart-test coverage. The mission UI exposes manual **Evaluate watched target records now**, an alert ledger and an acknowledgement action. It explicitly does **not** poll sensors or run a background watch service.

The local repository provides a checked-in **400×400 EPSG:32648 TEST FIXTURE** raster and a deterministic offline processing path. The fixture is not an independently authenticated Sentinel-1 acquisition. Running the canonical scientific pipeline with fixture inputs may produce internal `runtime_mode=REAL` and `synthetic=False` values, but **those fields are not proof of an authenticated physical source**. This lane explicitly marks fixture output `runtime_mode=TEST_FIXTURE_UNVERIFIED`, `synthetic=True` when testing a storage boundary, and NEVER stores it as a validated REAL scan. Production `RunStore.save` rejects that incompatible provenance. A subsequent actual temp-root FastAPI mission link is denied `UNKNOWN_SCAN`, the investigation/alert workflow cannot create a source-backed watch, no alert is invented, and app restart preserves the empty alert ledger.

**Verdict:** Offline scientific fixture computation, source rejection, ordinary mission lifecycle, audit SQLite state and out-of-order negative events are **PASS** for their precise scope. **Source-triggered verified-REAL alert → browser acknowledgement is NOT_RUN / external source unavailable**, not a surrogate PASS. Browser wasn't driven against real operator data or a synthetic/forged verified scan. No externally sourced provider, calibrated independent sensor or background alert was exercised. No user `data/` was read or modified.

## Existing tested contract vs new acceptance

Prior `backend/tests/test_missions_alerts.py` contains controlled test-seeded objects labelled REAL to test the service's **contract**: watch-rule validation, single threshold trigger, acknowledgement idempotency, source-change fingerprint protection, revoked watch, wrong-mission 404 and SQLite/application restart. These deterministic mocks **do not authenticate a fresh Sentinel-1 sensor record** and cannot establish production source-triggered live availability. This worker did not use those doubles to seed production-looking alert rows in the new integration tests.

New `backend/tests/test_watch_alert_local_acceptance.py`:

1. Processes the checked-in UTM raster through the real offline CFAR/correlation pipeline using fixture-only network substitutions. The resulting source is explicitly marked unverified/synthetic for the storage gate. `evaluate_sar_watch` returns `NOT_EVALUATED/PERSISTED_REAL_SCAN_UNAVAILABLE`; `RunStore.save` fails closed. Actual mission and investigation endpoints refuse the nonexistent verified scan; no watch or alert is created. The real SQLite mission ledger remains empty across FastAPI re-instantiation.
2. Issues concurrent adversarial-order `evaluate`/unknown-alert `ack` requests to real FastAPI instances backed by the same isolated SQLite root. Every evaluation reports zero created/existing alerts; every early acknowledgement returns 404 `UNKNOWN_ALERT`, and no `mission_alerts` or `mission_evaluations` row appears. This tests *absence of source*, not positive trigger ordering.
3. At the **pure evaluator unit boundary only**, exercises an explicitly named `TEST_DOUBLE_ONLY` source to test repeatable fingerprints, threshold-vs-below-threshold and absent-target semantics, without persisting or presenting a fake scan/alert. It also reproduces credential contamination of a scene item ID.

## Confirmed privacy defect and narrow fix

Before correction the new canary test failed: a producer-supplied scene identifier `S1A_FIXTURE Authorization: Bearer WATCH_BEARER_SECRET_DO_NOT_EXPOSE` was accepted by `mission_alerts._safe_value` and echoed verbatim into a `TRIGGERED` finding's `scene_item_id` evidence. The old filter covered URLs, query-string tokens and native paths, but not bearer headers embedded in otherwise plausible scalar scene metadata.

The only production change in this lane is the additional case-insensitive `Authorization: Bearer/Basic …` pattern rejection in `mission_alerts._safe_value`. It sets the contaminated optional scalar to `None` instead of laundering a credential into alert evidence. It does **not** alter confidence thresholds, reject the whole scientific finding, fabricate alternative source identity, or change durable mission rows. The scientific target measurement, fingerprint mechanics, other safe provenance and ordinary scene IDs remain intact. This is pattern-based defense, not a guarantee against every possible novel secret format.

## Local validation and remaining gates

- First new-suite run (before correction): **2 passed, 1 failed**; the failure displayed the unredacted bearer canary in `scene_item_id`. Both source rejection and adverse-order negative workflow passed.
- After correction: `python -m pytest backend/tests/test_watch_alert_local_acceptance.py backend/tests/test_missions_alerts.py backend/tests/test_restart_workflows_reverify.py -q` → **15 passed**. This includes previously implemented positive mocked-alert contract tests, not a new authenticated-source run.
- Expanded final check including `backend/tests/test_investigations.py` → **18 passed**. This is backend TestClient/local filesystem and SQLite evidence, **not** browser action evidence or a live provider trigger.
- `python -m ruff check backend/darkfleet/mission_alerts.py backend/tests/test_watch_alert_local_acceptance.py` → **All checks passed**.
- Integration gaps remaining **NOT_RUN**: externally authenticated acquisition → persisted verified REAL scan → watchlist rule triggered from independently proven sensor evidence → operator browser acknowledgement/reopen. Background triggering is **not implemented**: the UI and API require explicit manual evaluation. Browser workflow UI execution would require a trustworthy source and controlled isolated browser/backend; it was not simulated by relabelling a fixture.

No other production API route, watchlist route, frontend UI, generated contract, user data or remote system was changed.
