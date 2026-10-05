"""DF-X9.3A -- the corrected AIS correlation FIXTURE: 6 vessels, 27 observations.

=============================== THIS IS A TEST FIXTURE, NOT OPERATIONAL DATA ===============================

It is written to a pytest ``tmp_path``. It is never installed into a deployment data directory,
never served by a route, and never reachable from the product. Where it appears in reports it is
labelled ``CORRECTNESS FIXTURE``. Any code that reads it into an operational path is a defect.

WHY IT EXISTS AT ALL
====================

The real deployment's AIS archive is EMPTY (``GET /api/ais/coverage`` -> ``NOT_CONFIGURED``,
``observations: 0``). That made the formal analytical delta -- 87 targets, 1,827 comparisons,
0 differences -- **vacuous for every AIS scoring path**: the five DF-X9.1 fixes could not have acted
on a row that does not exist, so the 0 proved nothing about them.

This fixture closes that gap. It exercises the real read path end to end:

    real ``AisObservation`` objects
      -> real ``AisArchive.append()``
      -> real Parquet partitions on disk
      -> real DuckDB query with the session pinned to UTC
      -> real ``correlate()``

Nothing here is a mock or a hand-shaped dict standing in for an archive row. That matters because
two of the five defects were **column-name mismatches** between the archive and the scorer -- a
synthetic dict with the right keys would have hidden the very bugs under test.

THE CADENCE IS THE PRODUCT'S OWN
================================

``08:00, 08:04, 08:08, 08:12, 08:16`` -- five observations at 4-minute steps, matching
``test_ais_delivery.py``'s ``for minute in (0, 4, 8, 12, 16)``. This is the fastest cadence the
product models, and DF-X9's display thresholds are derived from it.

WHAT EACH VESSEL IS FOR
=======================

===========  =======  ==============================================================
MMSI        rows     the defect it isolates
===========  =======  ==============================================================
257000001   5        DEFECT 1 -- no kinematics reported at all. ``propagate()`` raised
                      ``TypeError`` on ``sog_knots < 0.1``.
257000002   5        DEFECTS 3+4 -- canonical archive spellings ``length_m`` / ``name``. A real
                      240 m hull against a 120 m apparent length, so the size term is 0.5 and
                      not its pinned 0.8 default.
257000003   5        PURE CONTROL -- ``cog = 0.0`` is a REAL course due north. If this changes,
                      a measured zero has been confused with absence, which is the single most
                      important thing in this whole fixture to keep separate.
257000004   2        WINDOWING -- one observation 3120 s from acquisition (outside
                      ``WINDOW_S = 900``) and one exactly on it. Proves the window is unchanged.
257000005   5        DEFECT 2 -- a GFW fishing vessel. GFW publishes no SOG, COG or heading, and
                      wrote three fabricated zeros. ``cog = 0.0`` is a real course, so the zeros
                      earned a free 0.15-weighted heading match.
257000006   5        DEFECT 2b -- a reported SPEED with an ABSENT COURSE. The second, distinct
                      crash mechanism, found by measurement rather than by reading.
===========  =======  ==============================================================

Total: 5 + 5 + 5 + 2 + 5 + 5 = **27 rows**.
"""

from __future__ import annotations

import math
from datetime import datetime
from pathlib import Path
from typing import Any

from darkfleet.ais.archive import AisArchive
from darkfleet.ais.gfw import normalize_gfw_event
from darkfleet.ais.models import AisObservation
from darkfleet.correlation.match import correlate

#: Acquisition instant for the fixture. 08:12 is also the 4th cadence step, so the observation at
#: ``dt = 0`` is one of the rows -- which is what makes the temporal term exactly 1.0 and lets the
#: size and heading terms be read without the temporal term varying underneath them.
ACQUISITION = "2026-05-12T08:12:00+00:00"

RESOLUTION_M = 10.0
BASE_RADIUS_M = 1200.0
MAX_RADIUS_M = 2800.0

#: Identical geometry for every component. Chosen so the MATCHED branch is reachable:
#: ``snr = 6 - (-8) = 14`` -> ``_sar_conf`` 0.63 (above ``CLUTTER_CONF`` 0.45); aspect
#: ``12 / 5 = 2.4`` (not ``< 1.4``, so not stationary); ``area`` 9 (not ``<= 4``, so no clutter
#: multiplier). Every key ``correlate`` reads is present -- building the component from the
#: reader's own subscript list rather than from a guess, because an incomplete component fails
#: with a ``KeyError`` that looks like a product defect and is not one.
COMPONENT_BASE: dict[str, Any] = {
    "area": 9,
    "major": 12.0,
    "minor": 5.0,
    "maxDb": 6.0,
    "meanDb": 1.0,
    "clutterMeanDb": -8.0,
    "wake": False,
    "wakeAnalysis": None,
    "cx": 40.0,
    "cy": 30.0,
}

CADENCE = ("08:00", "08:04", "08:08", "08:12", "08:16")

KNOTS_TO_MPS = 0.514444444
STEP_SECONDS = 240


def _stamp(hhmm: str) -> str:
    return f"2026-05-12T{hhmm}:00+00:00"


def offset_m(lat: float, lon: float, north_m: float, east_m: float = 0.0) -> tuple[float, float]:
    """Flat-earth offset in metres -> (lat, lon).

    DESIGN-TIME HELPER ONLY. Every number the baseline report quotes is measured by running the
    real code, never read back from this function. A fixture that asserts its own expected values
    would be asserting its own arithmetic.
    """
    metres_per_deg_lon = 111319.49 * math.cos(math.radians(lat))
    return (
        round(lat + north_m / 110574.0, 6),
        round(lon + east_m / metres_per_deg_lon, 6),
    )


def _drift(knots: float, index: int) -> float:
    """Metres travelled by `index` cadence steps at `knots`, centred on the acquisition step."""
    return knots * KNOTS_TO_MPS * STEP_SECONDS * (index - 3)


def _plain(
    mmsi: str,
    hhmm: str,
    lat: float,
    lon: float,
    *,
    sog: float | None,
    cog: float | None,
    heading: float | None,
    length_m: float | None,
    name: str | None,
    ship_type: str = "Cargo",
) -> AisObservation:
    return AisObservation(
        timestamp=_stamp(hhmm),
        mmsi=mmsi,
        lat=lat,
        lon=lon,
        sog=sog,
        cog=cog,
        heading=heading,
        length_m=length_m,
        name=name,
        ship_type=ship_type,
        source="aistream",
    )


def fixture_observations() -> list[AisObservation]:
    """All 27 rows, in archive order, built through the real model."""
    rows: list[AisObservation] = []

    # V1 -- DEFECT 1. Positions still drift, because an AIS track can move without the row
    # carrying a speed. That is the point: absence of a speed is not evidence of a stationary
    # vessel, and this vessel proves it.
    for i, hhmm in enumerate(CADENCE):
        lat, _ = offset_m(1.30000, 103.80000, _drift(2.0, i))
        rows.append(
            _plain(
                "257000001", hhmm, lat, 103.80000,
                sog=None, cog=None, heading=None,
                length_m=120.0, name="MV BARE KINEMATICS",
            )
        )

    # V2 -- DEFECTS 3+4. 12 kn due east; a real 240 m hull against a 120 m apparent length.
    for i, hhmm in enumerate(CADENCE):
        _, lon = offset_m(1.35000, 103.85000, 0.0, _drift(12.0, i))
        rows.append(
            _plain(
                "257000002", hhmm, 1.35000, lon,
                sog=12.0, cog=90.0, heading=90.0,
                length_m=240.0, name="MV NORTHWIND",
            )
        )

    # V3 -- PURE CONTROL for the heading term. `cog = 0.0` is a real course. No length and no
    # name, so the size and naming terms are identical in both revisions and the heading term is
    # the only thing under test.
    for i, hhmm in enumerate(CADENCE):
        lat, _ = offset_m(1.40000, 103.90000, _drift(9.0, i))
        rows.append(
            _plain(
                "257000003", hhmm, lat, 103.90000,
                sog=9.0, cog=0.0, heading=0.0,
                length_m=None, name=None,
            )
        )

    # V4 -- windowing. 07:20 is 3120 s before acquisition, outside WINDOW_S = 900. 08:12 is on it.
    rows.append(
        _plain(
            "257000004", "07:20", 1.45000, 103.95000,
            sog=8.0, cog=45.0, heading=45.0,
            length_m=60.0, name="MV OUT OF WINDOW",
        )
    )
    rows.append(
        _plain(
            "257000004", "08:12", 1.46000, 103.96000,
            sog=8.0, cog=45.0, heading=45.0,
            length_m=60.0, name="MV OUT OF WINDOW",
        )
    )

    # V5 -- DEFECT 2, a GFW fishing vessel. Built through the product's OWN normaliser, so the
    # stored kinematics are whatever that code decides rather than whatever this fixture asserts.
    # Positions drift 4 kn with no reported speed: the positions move and the kinematics are
    # simply not in the dataset.
    for i, hhmm in enumerate(CADENCE):
        lat, _ = offset_m(1.50000, 104.00000, _drift(4.0, i))
        observation = normalize_gfw_event(
            {
                "start": _stamp(hhmm),
                "type": "fishing",
                "position": {"lat": lat, "lon": 104.00000},
                "vessel": {
                    "mmsi": "257000005",
                    "name": "MV GFW FISHING",
                    "type": "fishing",
                },
            }
        )
        assert observation is not None, "GFW normaliser rejected a fixture event with a position"
        rows.append(observation)

    # V6 -- DEFECT 2b. A reported speed with an absent course.
    for i, hhmm in enumerate(CADENCE):
        lat, _ = offset_m(1.55000, 105.00000, _drift(10.0, i))
        rows.append(
            _plain(
                "257000006", hhmm, lat, 105.00000,
                sog=10.0, cog=None, heading=None,
                length_m=100.0, name="MV COURSE BLIND",
            )
        )

    return rows


def write_fixture_archive(data_dir: Path) -> AisArchive:
    """Write the 27 rows through the real archive, and read them back the real way.

    Returns the archive. Reading back rather than reusing the in-memory objects is deliberate: it
    proves the values survive Parquet, which is where a nullable column can silently become a
    zero and where the column NAMES the size-term defect turned on.
    """
    archive = AisArchive(data_dir)
    written = archive.append(fixture_observations())
    assert written["written"] == 27, f"expected 27 rows on disk, wrote {written['written']}"

    coverage = archive.coverage()
    assert coverage["observations"] == 27, f"expected 27 rows on disk, found {coverage}"

    start = datetime.fromisoformat("2026-05-12T07:00:00+00:00")
    end = datetime.fromisoformat("2026-05-12T09:00:00+00:00")
    rows = archive.query(start, end)
    assert len(rows) == 27, f"expected 27 rows on the DuckDB read path, got {len(rows)}"
    return archive


def read_fixture_rows(data_dir: Path) -> list[dict[str, Any]]:
    """The 27 rows exactly as the correlation path would receive them."""
    archive = AisArchive(data_dir)
    return list(
        archive.query(
            datetime.fromisoformat("2026-05-12T07:00:00+00:00"),
            datetime.fromisoformat("2026-05-12T09:00:00+00:00"),
        )
    )


def rows_for(mmsi: str, hhmm: str | None = None, data_dir: Path | None = None) -> list[dict[str, Any]]:
    """Rows for one MMSI, optionally restricted to one cadence stamp.

    Scenarios pin WHICH observation they test. Restricting by stamp is what lets a scenario
    isolate a single `dt`, and therefore isolate one score term, rather than averaging over five.

    MATCHED ON THE TIME OF DAY, NOT THE STRING. The DuckDB read path returns a tz-aware
    `datetime`, so the fixture's ISO stamp is not a substring of anything -- matching on the string
    silently selected zero rows, and a scenario that selects nothing is worse than no scenario at
    all because it looks like it passed.
    """
    rows = read_fixture_rows(data_dir) if data_dir is not None else _rows_direct()
    selected = [r for r in rows if str(r["mmsi"]) == mmsi]
    if hhmm is not None:
        hour, minute = (int(part) for part in hhmm.split(":"))
        selected = [r for r in selected if _at_cadence(r["timestamp"], hour, minute)]
    assert selected, f"fixture selected no rows for mmsi={mmsi} hhmm={hhmm}"
    return selected


def _at_cadence(value: Any, hour: int, minute: int) -> bool:
    """Whether an archive timestamp falls on the given UTC hour and minute."""
    if isinstance(value, datetime):
        return value.hour == hour and value.minute == minute
    # `fromisoformat` accepts both the "T" separator and a space, so only a trailing "Z" needs
    # normalising. Written without a `.replace()` chain because `Z` is the only spelling that is
    # not already ISO 8601, and a general replacement invites silently mangling other offsets.
    text = str(value)
    parsed = datetime.fromisoformat(f"{text[:-1]}+00:00" if text.endswith("Z") else text)
    return parsed.hour == hour and parsed.minute == minute


def _rows_direct() -> list[dict[str, Any]]:
    """Archive rows built without touching disk, for pure-score arithmetic tests.

    Used only where the Parquet round trip is not what is being tested. Every scenario in
    ``test_ais_correlation_baseline.py`` goes through the on-disk path instead.
    """
    out: list[dict[str, Any]] = []
    for observation in fixture_observations():
        out.append(
            {
                "timestamp": observation.timestamp,
                "mmsi": observation.mmsi,
                "lat": observation.lat,
                "lon": observation.lon,
                "sog": observation.sog,
                "cog": observation.cog,
                "heading": observation.heading,
                "nav_status": observation.nav_status,
                "name": observation.name,
                "shipName": observation.name,
                "callsign": observation.callsign,
                "imo": observation.imo,
                "ship_type": observation.ship_type,
                "shipType": observation.ship_type,
                "length_m": observation.length_m,
                "width_m": observation.width_m,
                "source": observation.source,
            }
        )
    return out


def components() -> dict[str, dict[str, Any]]:
    """The eight detection components, each placed to isolate one scenario."""
    c1_lat, _ = offset_m(1.30000, 103.80000, 150.0)
    _, c2_lon = offset_m(1.35000, 103.85000, 0.0, 300.0)
    c3_lat, _ = offset_m(1.40000, 103.90000, 150.0)
    c4_lat, _ = offset_m(1.45000, 103.95000, 200.0)
    c5_lat, _ = offset_m(1.46000, 103.96000, 200.0)
    _, c6_lon = offset_m(1.50000, 104.00000, 0.0, 300.0)
    # 900 m from the GFW row at 08:00, where dt = 720 s and temporal = 0.2. The older GFW rows are
    # further away and fall outside the 1200 m radius, so this scenario has exactly ONE candidate
    # and the state decision is arithmetic rather than a two-candidate conflict.
    c7_lat, _ = offset_m(
        offset_m(1.50000, 104.00000, _drift(4.0, 0))[0], 104.00000, -900.0
    )
    c8_lat, _ = offset_m(1.55000, 105.00000, 200.0)

    return {
        # North-oriented hull, so an absent course cannot accidentally look like a match.
        "C1": {**COMPONENT_BASE, "lat": c1_lat, "lon": 103.80000, "orient": 0.0},
        "C2": {**COMPONENT_BASE, "lat": 1.35000, "lon": c2_lon, "orient": 0.0},
        "C3": {**COMPONENT_BASE, "lat": c3_lat, "lon": 103.90000, "orient": 0.0},
        "C4": {**COMPONENT_BASE, "lat": c4_lat, "lon": 103.95000, "orient": 45.0},
        "C5": {**COMPONENT_BASE, "lat": c5_lat, "lon": 103.96000, "orient": 45.0},
        "C6": {**COMPONENT_BASE, "lat": 1.50000, "lon": c6_lon, "orient": 0.0},
        "C7": {**COMPONENT_BASE, "lat": c7_lat, "lon": 104.00000, "orient": 0.0},
        # Hull axis 45 deg, so a REPORTED course would have scored 0.5 on heading. V6 reports
        # none, so the term can only be 0 or a crash.
        "C8": {**COMPONENT_BASE, "lat": c8_lat, "lon": 105.00000, "orient": 45.0},
    }


#: Each scenario: one component, the rows it sees, and the defect it isolates.
SCENARIOS: dict[str, dict[str, Any]] = {
    "S1": {
        "comp": "C1", "mmsi": "257000001", "stamp": None,
        "defect": "1",
        "purpose": "sog absent -> propagate() raised TypeError under HEAD",
    },
    "S2": {
        "comp": "C2", "mmsi": "257000002", "stamp": None,
        "defect": "3,4",
        "purpose": "canonical archive spellings length_m / name reach the scorer",
    },
    "S3": {
        "comp": "C3", "mmsi": "257000003", "stamp": None,
        "defect": "control",
        "purpose": "cog = 0.0 is a REAL course; must be identical in both revisions",
    },
    "S4": {
        "comp": "C4", "mmsi": "257000004", "stamp": "07:20",
        "defect": "windowing",
        "purpose": "|dt| = 3120 s > WINDOW_S = 900 -> zero candidates",
    },
    "S5": {
        "comp": "C5", "mmsi": "257000004", "stamp": "08:12",
        "defect": "windowing",
        "purpose": "|dt| = 0 s and 200 m from a 1200 m radius -> one candidate",
    },
    "S6": {
        "comp": "C6", "mmsi": "257000005", "stamp": "08:12",
        "defect": "2",
        "purpose": "GFW kinematics fabricated as 0.0 earned a free north heading match",
    },
    "S7": {
        "comp": "C7", "mmsi": "257000005", "stamp": "08:00",
        "defect": "2",
        "purpose": "the same free match, decided against the acceptance threshold",
    },
    "S8": {
        "comp": "C8", "mmsi": "257000006", "stamp": "08:12",
        "defect": "2b",
        "purpose": "reported speed, ABSENT course -> orient_diff raised TypeError under HEAD",
    },
}


def run_scenario(scenario_id: str, data_dir: Path | None = None) -> dict[str, Any]:
    """Run one scenario through the real `correlate`, returning its full score decomposition."""
    scenario = SCENARIOS[scenario_id]
    comps = components()
    ais = rows_for(scenario["mmsi"], scenario["stamp"], data_dir)
    assert ais, f"{scenario_id} selected no rows, so it would prove nothing"
    out = correlate([comps[scenario["comp"]]], ais, ACQUISITION, RESOLUTION_M, "FIXTURE")
    return {"scenario": scenario_id, "output": out, "ais_rows": ais, "spec": scenario}


def run_combined(data_dir: Path | None = None) -> dict[str, Any]:
    """Every component against every row -- the production shape `pipeline.py:380` uses.

    This is the leg that matters most. Under HEAD, ONE row without a speed took the whole scene
    to zero targets; the per-scenario legs each isolate a single vessel and would not show that.
    """
    comps = list(components().values())
    ais = read_fixture_rows(data_dir) if data_dir is not None else _rows_direct()
    return correlate(comps, ais, ACQUISITION, RESOLUTION_M, "FIXTURE")


#: The score-decomposition field names as they ACTUALLY exist on `correlate`'s output.
#:
#: Read from the code rather than guessed. The internal target dict uses `cls` (the API route
#: renames it to `classification` on the way out) and `headingScore` / `sizeScore` /
#: `temporalScore` / `spatialScore` / `compositeScore`. A first draft of the baseline suite used
#: `classification` and `heading`, and every assertion failed with a KeyError that read like a
#: product defect.
SCORE_KEYS = (
    "spatialScore",
    "temporalScore",
    "headingScore",
    "sizeScore",
    "compositeScore",
    "distanceOffsetMeters",
    "matchRadiusMeters",
    "timeDeltaSeconds",
)


def decomposition(out: dict[str, Any], index: int = 0) -> dict[str, Any]:
    """Pull one target's score decomposition out of a `correlate` result.

    Returns an EMPTY dict when there is no decomposition -- which is the correct answer for an
    unmatched target, because no candidate was ever scored. Callers that need a decomposition must
    assert on it rather than assume one exists.
    """
    targets = out.get("targets") or []
    assert targets, "expected at least one target"
    corr = targets[index].get("corr") or {}
    return dict(corr.get("scoreDecomposition") or {})


def classify(out: dict[str, Any], index: int = 0) -> str:
    """The classification of one target.

    Accepts either key: `correlate` emits `cls` internally, and the API route renames it to
    `classification`. Reading only one of them would silently report every target as unmatched.
    """
    targets = out.get("targets") or []
    assert targets, "expected at least one target"
    value = targets[index].get("classification") or targets[index].get("cls") or ""
    return str(value)