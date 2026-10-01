# Plan Changes

> Every scope change after the CP0 freeze requires an entry here.
> Format: date · CP · change · rationale · parity rows affected.

| Date | CP | Change | Rationale | Rows affected |
|---|---|---|---|---|
| 2026-10-01 | CP0 | Plan frozen at v1. No changes yet. | — | — |
| 2026-10-01 | CP5 | Geodesy upgraded spherical→WGS84 ellipsoidal. | Mandated by COR-003 ("never compare raw WGS84 as planar metres"). Legacy haversine was mislabelled WGS-84. Measured cost recorded (≤1.11% on sub-km baselines). | COR-003 |
| 2026-10-01 | CP5 | New classification bands added (SEA_CLUTTER / LOW_CONFIDENCE / UNRESOLVED). | Mandated by COR-011; legacy emitted only 3 of 7 states. Bands calibrated so the golden run stays stable; deltas documented. | COR-011, COR-012 |
| 2026-10-01 | CP6 | Pipeline uses a stage CALLBACK, not a generator. | A generator cannot both yield live stages and return the result document the API needs. Callback streams events in real time and returns the evidence dict. No requirement change. | OPS-002, EVD-001 |
| 2026-10-01 | CP15 | Wake detection: Radon arm-pair → polar-ray arm-pair. | The Radon variant was measured to be **insensitive to wake strength** (identical z across a 14 dB sweep) because summed projections are dominated by per-row background and per-angle normalisation cancelled the signal. Switched to direct ray sampling, which measures arm contrast where it physically is. Recorded rather than silently rewritten. | ADV-004, ADV-005 |
| 2026-10-01 | CP15 | Wake confidence semantics clarified. | Confidence is bounded evidence strength, not a probability; it saturates because a brighter arm does not make the geometry more certain. Angular recovery tolerance documented at ±10 deg. | ADV-005 |
