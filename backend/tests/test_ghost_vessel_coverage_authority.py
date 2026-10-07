"""DF-X9.4R -- the ghost-vessel decision record carries the REAL AIS coverage state.

THE DEFECT THIS EXISTS TO PIN
=============================

`/targets/{target_id}` passed a hardcoded `None` as `ais_coverage` when building the evidence
document, so `ghost_vessel.assess()` computed::

    coverage_state = str((ais_coverage or {}).get("state") or "NOT_ESTABLISHED")

which is the constant ``"NOT_ESTABLISHED"`` for every target in the product, whatever the local
AIS archive actually held.

WHY THAT MATTERS
================

This is DF-X7's defect in a new place. Two materially different situations produced one
indistinguishable answer:

  * no AIS archive is installed at all, so no candidate could ever be considered, and
  * an archive is installed and healthy, but no vessel was near enough to this target to consider.

An operator reading the decision record could not tell those apart. The first is a deployment
problem; the second is a finding about this target. Rendering both as an uninformative absence
also meant the product could never state DF-X7's required distinction between "AIS source not
configured", "no coverage", "zero observations", "zero candidates" and "candidates rejected".

THE FIX
=======

`_ais_coverage_report` is now a single function with two consumers -- the `/ais/coverage` route
and the evidence builder -- so the coverage state in the decision record is by construction the
same fact the coverage route reports. Two implementations of that computation would be free to
disagree, and the disagreement would be invisible.

WHAT IS *NOT* CLAIMED HERE
==========================

`NO_COVERAGE` and `PARTIAL` remain unreachable from this route, because
`_ais_coverage_report` only ever produces `NOT_CONFIGURED` or `AVAILABLE`: it reports on the
presence and span of a LOCAL archive and cannot know whether that archive covers a particular
patch of ocean. Those states exist in the `AisCoverageState` union for callers that can establish
them, and the frontend renders them, but this route does not invent them. A test asserts they are
not fabricated, because a coverage state that is computed rather than measured is the exact error
this file is about.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from darkfleet.api.routes import _ais_coverage_report
from darkfleet.ghost_vessel import assess


class _Report:
    """The minimal `coverage()` shape `_ais_coverage_report` reads."""

    def __init__(self, **fields: Any) -> None:
        self._fields = fields

    def coverage(self) -> dict[str, Any]:
        return dict(self._fields)


class _Archive:
    def __init__(self, report: _Report) -> None:
        self._report = report

    def coverage(self) -> dict[str, Any]:
        return self._report.coverage()


class _State:
    """A state whose archive reports a fixed coverage."""

    def __init__(self, report: _Report) -> None:
        self._report = report

    # `_archive_for(state)` is the only thing `_ais_coverage_report` reaches for, so overriding it
    # here is enough -- and it means these tests exercise the REAL coverage computation rather
    # than a stand-in for it.
    def archive(self) -> _Archive:  # pragma: no cover - replaced by the fixture below
        raise AssertionError("unused")


@pytest.fixture()
def state_for(monkeypatch: pytest.MonkeyPatch):
    """Patch `_archive_for` so `_ais_coverage_report` reads a fixed archive report."""

    def _make(**fields: Any) -> Any:
        from darkfleet.api import routes

        archive = _Archive(_Report(**fields))
        monkeypatch.setattr(routes, "_archive_for", lambda _state: archive)
        return object()

    return _make


def _ghost_target(**corr_overrides: Any) -> dict[str, Any]:
    """A `SAR_UNMATCHED` target with a real decision record."""
    corr: dict[str, Any] = {
        "matched": False,
        "mmsi": None,
        "scoreDecomposition": None,
        "candidatesConsidered": 3,
        "acceptanceThreshold": 0.4,
        "closestRejected": {
            "mmsi": "123456789",
            "vesselName": "MV EXAMPLE",
            "score": 0.31,
            "distanceMeters": 1840.0,
            "timeDeltaSeconds": -240,
            "shortfall": 0.09,
        },
    }
    corr.update(corr_overrides)
    return {
        "id": "DF-001",
        "cls": "SAR_UNMATCHED",
        "lat": 1.3288,
        "lon": 104.1146,
        "sarConf": 0.94,
        "aisConf": 0.0,
        # `area` is required by `evidence.py` (`target["area"]`, a direct subscript, not a `.get`).
        # Its absence raises KeyError rather than producing an absent value, so a fixture that
        # omits it cannot reach the route at all. Included because the route needs it, and noted
        # because "an absent measurement becomes a 500" is itself the shape of bug this file is
        # downstream of.
        "area": 5,
        "lenM": 42.0,
        "widM": 8.0,
        "lenUncM": 9.2,
        "hdg": 271.0,
        "meanDb": -6.1,
        "maxDb": 3.8,
        "wake": True,
        "corr": corr,
    }


# ------------------------------------------------------------------ the coverage computation


def test_an_absent_archive_reports_NOT_CONFIGURED(state_for: Any) -> None:
    coverage = _ais_coverage_report(state_for(observations=0))
    assert str(coverage.state) == "NOT_CONFIGURED"


def test_a_populated_archive_reports_AVAILABLE(state_for: Any) -> None:
    coverage = _ais_coverage_report(
        state_for(observations=54, oldest="2026-05-12T07:20:00+00:00", newest="2026-05-12T08:16:00+00:00", sources=["aistream"])
    )
    assert str(coverage.state) == "AVAILABLE"
    assert coverage.observation_count == 54


def test_an_archive_with_observations_but_NO_SPAN_is_NOT_CONFIGURED(state_for: Any) -> None:
    """
    Observations without an oldest/newest span cannot describe a window, so the archive cannot say
    what it covers. Reporting AVAILABLE here would claim coverage on the strength of a count alone.
    """
    coverage = _ais_coverage_report(state_for(observations=54, oldest=None, newest=None))
    assert str(coverage.state) == "NOT_CONFIGURED"


def test_it_does_NOT_fabricate_NO_COVERAGE_or_PARTIAL(state_for: Any) -> None:
    """
    This route reports on the presence and span of a LOCAL archive. It cannot know whether that
    archive covers the patch of ocean a given target sits in, so it must never claim to.

    A coverage state that is computed rather than measured is the precise error DF-X7 is about, and
    the fix for `NOT_ESTABLISHED`-everywhere must not become "confidently assert something else".
    """
    for fields in (
        {"observations": 0},
        {"observations": 10, "oldest": "2026-01-01T00:00:00+00:00", "newest": "2026-01-02T00:00:00+00:00"},
        {"observations": 1, "oldest": None, "newest": None},
    ):
        state = str(_ais_coverage_report(state_for(**fields)).state)
        assert state in {"NOT_CONFIGURED", "AVAILABLE"}, f"fabricated coverage state {state}"


# ------------------------------------------------------------------ it reaches the decision


def test_the_decision_record_carries_AVAILABLE_when_an_archive_exists(state_for: Any) -> None:
    record = assess(
        _ghost_target(),
        ais_coverage={"state": str(_ais_coverage_report(state_for(
            observations=54,
            oldest="2026-05-12T07:20:00+00:00",
            newest="2026-05-12T08:16:00+00:00",
        )).state)},
    )
    decision = record["decision"]
    assert decision["ais_coverage_state"] == "AVAILABLE"
    assert decision["candidates_considered"] == 3


def test_the_decision_record_carries_NOT_CONFIGURED_when_there_is_no_archive(state_for: Any) -> None:
    record = assess(
        _ghost_target(candidatesConsidered=0, closestRejected=None),
        ais_coverage={"state": str(_ais_coverage_report(state_for(observations=0)).state)},
    )
    decision = record["decision"]
    assert decision["ais_coverage_state"] == "NOT_CONFIGURED"
    assert decision["candidates_considered"] == 0


def test_the_two_situations_are_now_DISTINGUISHABLE(state_for: Any) -> None:
    """
    The regression DF-X7 is about, asserted directly.

    Both records have `candidates_considered == 0`. Before the fix both reported
    `ais_coverage_state == "NOT_ESTABLISHED"` and were indistinguishable to an operator. One is a
    deployment problem; the other is a finding about this target.
    """
    no_archive = assess(
        _ghost_target(candidatesConsidered=0, closestRejected=None),
        ais_coverage={"state": "NOT_CONFIGURED"},
    )["decision"]
    healthy_archive = assess(
        _ghost_target(candidatesConsidered=0, closestRejected=None),
        ais_coverage={"state": "AVAILABLE"},
    )["decision"]

    assert no_archive["candidates_considered"] == healthy_archive["candidates_considered"] == 0
    assert no_archive["ais_coverage_state"] != healthy_archive["ais_coverage_state"]


def test_an_absent_coverage_argument_still_yields_NOT_ESTABLISHED() -> None:
    """
    The honest fallback, preserved deliberately.

    `assess()` is called from several places, and a caller that genuinely has no coverage to report
    must produce an absence rather than a guess. This test is why the route fix was made at the
    ROUTE rather than by defaulting inside `assess()`: defaulting there would have papered over
    every caller that had not been wired, including this one.
    """
    decision = assess(_ghost_target(), ais_coverage=None)["decision"]
    assert decision["ais_coverage_state"] == "NOT_ESTABLISHED"


# ------------------------------------------------------------------ THE ROUTE, not just assess()


def test_THE_ROUTE_carries_the_coverage_into_the_response(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """
    THE TEST THAT WAS MISSING, and whose absence let MUT-I survive.

    Every test above calls `assess()` directly. Reverting the route to its hardcoded `None` -- the
    original defect, verbatim -- passed all eight of them, because none of them went through the
    route. The unit under test was the function, not the WIRING, and the wiring was the defect.

    So this one drives `get_target` itself, against a real store holding a real `SAR_UNMATCHED`
    target, and reads the coverage state out of the HTTP response body.
    """
    from darkfleet.api import routes
    from darkfleet.api.routes import get_target

    # A store holding one scan with one unmatched target.
    class _Store:
        def get(self, scan_id: str) -> dict[str, Any] | None:
            if scan_id != "DF-9001":
                return None
            return {
                "scan_id": "DF-9001",
                "runtime_mode": "REAL",
                "synthetic": False,
                "targets": [_ghost_target()],
            }

        def scans(self) -> list[str]:  # pragma: no cover - only used on the scan_id-less path
            return ["DF-9001"]

    monkeypatch.setattr(routes, "_archive_for", lambda _state: _Archive(_Report(
        observations=54,
        oldest="2026-05-12T07:20:00+00:00",
        newest="2026-05-12T08:16:00+00:00",
    )))

    state = SimpleNamespace(store=_Store(), data_dir=tmp_path)
    response = get_target("DF-001", state, scan_id="DF-9001")

    decision = response.evidence.ghost_vessel.decision
    assert decision.ais_coverage_state == "AVAILABLE", (
        "the route must carry the real coverage state into the decision record"
    )
    assert decision.candidates_considered == 3
    assert decision.closest_rejected_candidate.mmsi == "123456789"


def test_THE_ROUTE_reports_NOT_CONFIGURED_when_there_is_no_archive(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deployment half of the distinction, through the same route."""
    from darkfleet.api import routes
    from darkfleet.api.routes import get_target

    class _Store:
        def get(self, scan_id: str) -> dict[str, Any] | None:
            if scan_id != "DF-9001":
                return None
            return {
                "scan_id": "DF-9001",
                "runtime_mode": "REAL",
                "synthetic": False,
                "targets": [_ghost_target(candidatesConsidered=0, closestRejected=None)],
            }

        def scans(self) -> list[str]:  # pragma: no cover
            return ["DF-9001"]

    monkeypatch.setattr(routes, "_archive_for", lambda _state: _Archive(_Report(observations=0)))

    state = SimpleNamespace(store=_Store(), data_dir=tmp_path)
    response = get_target("DF-001", state, scan_id="DF-9001")

    decision = response.evidence.ghost_vessel.decision
    assert decision.ais_coverage_state == "NOT_CONFIGURED"
    assert decision.candidates_considered == 0
