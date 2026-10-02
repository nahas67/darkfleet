# Plan — Remove DEMO, adopt verified assets from `gods-eye-view-0.1.1`

Prepared after inspecting the archive. Every claim below is read out of the zip,
not assumed.

## 1. What the archive actually is

`gods-eye-view-0.1.1.zip` — 77,011,857 bytes, sha256
`C36D7E57BD98955BAF556CEC2ECAC8B5BE42F0F4D9117915FEB766BF505067A7`,
488 entries. A vanilla-JS + Cesium situational-awareness globe (NOT a Python
project, NOT a fork of DarkFleet).

## 2. Licensing — the governing constraint

Its `LICENSE` is explicit that the MIT grant covers **source code only**:

> "THE MIT LICENSE ABOVE COVERS THE SOURCE CODE ONLY. The datasets bundled under
> `src/data/local_data/` … are owned by their respective sources and are NOT
> licensed under MIT."

DarkFleet is **Apache-2.0** (`backend/pyproject.toml`). So:

| Asset | License | Verdict for an Apache-2.0 project |
|---|---|---|
| `src/data/*.js` | MIT | **Usable** with attribution; a policy port to Python is safest |
| `natural_earth/marine.json` | **Public domain** | **Usable**, no obligation |
| `telegeography_submarine_cables/` | **CC BY-NC-SA 3.0** | **Rejected** — NonCommercial + ShareAlike are incompatible with Apache-2.0 and with any commercial use |
| `dams/`, `datacenters/` | **ODbL 1.0** | **Rejected** — share-alike on the derived database; also not maritime |
| `public/models/*.glb` | third-party, per-file | **Rejected** — not MIT, and irrelevant to SAR |
| OpenSky (live) | non-commercial | **Rejected** — and aircraft, not maritime |

Rejected assets are recorded here rather than silently skipped.

## 3. The two picks, and why

### Pick A — Natural Earth named marine regions (public domain)

`marine.json`, 633,342 bytes, **292 named marine polygons** (oceans, seas,
gulfs, straits, bays). Verified contents: `Strait of Malacca` present,
`South China Sea` present, `Bay of Bengal` present. `Luzon Strait` is **absent**
— its own README records that two features (Drake Passage, Luzon Strait) are
sliver-only in the upstream source and were dropped. That limitation is carried
forward rather than hidden.

Shape is bespoke, not GeoJSON:
`{meta, features:[{name, featurecla, polygons:[[[lon,lat],…],…]}]}` — outer
rings only, stored open, coords rounded to 3 decimals (~110 m).

Provenance is embedded in `meta`: commit
`ca96624a56bd078437bca8184e78163e5039ad19`, fetched `2026-07-28T01:36:39Z`,
licence text, and the curation parameters.

**Why it earns its place:** DarkFleet currently reports a detection as
coordinates only. This lets evidence state the named water body — the current
test AOI (103.80 E, 1.25 N) resolves inside the Strait of Malacca, which is real
geographic context rather than a guess.

### Pick B — AISStream failure-classification and backoff policy (MIT)

`aisStreamAdapter.js` + `aisWatchdog.js`. DarkFleet's `AistreamCollector.run()`
opens **one** socket and never reconnects, and has no failure classification at
all. The archive's policy is the part worth having:

> "Only 'transport' may walk the fast backoff ladder. An auth rejection cannot be
> fixed by retrying, and a rate limit must honour the server's own pacing —
> treating either as a generic error is how a watchdog turns into a hammer."

Ported as **policy to Python**, not copied as a file. DarkFleet's Python
collector stays the single authority; no JS is vendored, so the port is a
documented reimplementation rather than a code import.

## 4. DEMO removal — assumption stated up front

DEMO is referenced 82× in backend source, 95× in backend tests, 76× in the
frontend. Removing it is not a find-and-delete: **DEMO is currently the test
harness.** The test suite generates scans through it.

Assumption being applied: **remove DEMO from the product and the public API;
replace its use in tests with explicit fixture scans that are labelled test-only
and unreachable from the HTTP surface.** A user-facing mode that fabricates
observations goes away; the ability to test without provider credentials stays,
because deleting that instead would leave the engine untestable. If the intent
was to delete synthetic *test* generation as well, say so and I will widen it.

## 5. Execution order

1. Adopt Pick A — marine regions module, tests, wire into evidence.
2. Adopt Pick B — AIS failure classification + backoff, tests.
3. Remove DEMO — backend, then frontend, tests last.
4. Record licensing decisions and provenance in `docs/`.
5. Full gate: pytest, ruff, strict mypy, tsc, vitest, vite build.

Each step is verified before the next starts.