"""Guard the recorded orphan classification (DF-X8.5B Â§40).

WHY THESE TESTS EXIST
---------------------
`/api/scans/{scan_id}` and `/api/scans/{scan_id}/raster` had been described as INTERNAL and
REDUNDANT in prose across several checkpoints. Prose is not a classification: the tool still
counted them as plain orphans, `--strict` exited 1 for a reason no reader could see off the
output, and a FOURTH orphan would have looked identical to those two.

The classification now lives in `INTENTIONAL_ORPHANS`, next to the measurement. These tests
assert the property that makes it worth having -- 100% reachability remains the default
expectation, and an unexplained orphan is still a failure.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from tools import route_reachability as rr

ROOT = Path(__file__).resolve().parents[2]


class TestIntentionalOrphansAreRecorded:
    def test_exactly_the_two_documented_routes_are_classified(self) -> None:
        # An explicit set, not a count. A count would be satisfied by any two routes, which
        # is how a real orphan could be quietly reclassified as intentional.
        assert set(rr.INTENTIONAL_ORPHANS) == {
            "/api/scans/{scan_id}",
            "/api/scans/{scan_id}/raster",
        }

    def test_every_classification_states_a_reason(self) -> None:
        # A label with no reasoning is a shrug. "INTERNAL" alone does not survive a reader
        # who has forgotten why.
        for path, reason in rr.INTENTIONAL_ORPHANS.items():
            assert len(reason) > 60, f"{path} is labelled but not explained"

    def test_the_scan_record_route_is_explained_as_a_persistence_detail(self) -> None:
        # The reason has to survive a reader disagreeing with it, so it says WHY the frontend
        # does not call it rather than only naming the label.
        assert "persistence" in rr.INTENTIONAL_ORPHANS["/api/scans/{scan_id}"]

    def test_the_raster_route_is_explained_as_superseded(self) -> None:
        assert "REDUNDANT" in rr.INTENTIONAL_ORPHANS["/api/scans/{scan_id}/raster"]
        assert "/raster/{layer}" in rr.INTENTIONAL_ORPHANS["/api/scans/{scan_id}/raster"]


class TestStrictModeStillMeansSomething:
    def test_no_discovered_route_is_missing_from_the_registry_of_classifications(self) -> None:
        """
        The table must not name a route that no longer exists.

        A stale entry is worse than none: it would read as "we decided this", for a route that
        has since been deleted or renamed, and a reader checking the orphan list would find
        the decision and no route.
        """
        discovered = {route.path for route in rr.declared_routes()}
        assert discovered, "no routes discovered -- the regex is stale"
        stale = set(rr.INTENTIONAL_ORPHANS) - discovered
        # The earlier assertion read `assert stale == {}, msg` -- an empty DICT and an empty
        # SET are not equal in Python (`{} == set()` is False), so the failure message showed
        # `[]` while the real content was there. Comparing to `set()` states the intent.
        assert not stale, f"INTENTIONAL_ORPHANS names routes that do not exist: {sorted(stale)}"

    def test_the_helper_keeps_exactly_the_unclassified_ones(self) -> None:
        """
        The property that makes the tolerance safe.

        `--strict` tolerating orphans wholesale would be worthless. It tolerates exactly the
        recorded ones and fails on anything else -- which is a property of the HELPER, so it
        is asserted here with a mixed set rather than against the live route list.

        (The first version of this test passed EVERY discovered route in as an orphan and got
        24 unexplained entries, which says nothing useful -- the real repository state is
        checked end-to-end by the subprocess tests below.)
        """
        classified = rr.Route("GET", "/api/scans/{scan_id}")
        fabricated = rr.Route("GET", "/api/scans/{scan_id}/imaginary")
        assert rr.unexplained_orphans([], [classified, fabricated]) == [fabricated]

    def test_a_fabricated_orphan_is_reported_unexplained(self) -> None:
        # A route NOT in the table. `orphan_reason` returns None, which is exactly what both
        # the strict exit code and the console marker key on.
        fabricated = rr.Route("GET", "/api/scans/{scan_id}/imaginary")
        assert rr.orphan_reason(fabricated) is None
        assert rr.unexplained_orphans([], [fabricated]) == [fabricated]

    def test_a_classified_route_is_not_reported_unexplained(self) -> None:
        classified = rr.Route("GET", "/api/scans/{scan_id}")
        assert rr.unexplained_orphans([], [classified]) == []


class TestJsonCarriesTheClassification:
    def test_the_json_output_names_why_each_orphan_is_tolerated(self) -> None:
        """
        So a CI check can assert on the REASONING, not on a count.

        A count assertion passes while the reasoning has been replaced by something wrong,
        which is precisely how a gate quietly stops meaning anything.
        """
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "backend" / "tools" / "route_reachability.py"),
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=ROOT,
            timeout=180,
            # check=False on purpose: a non-zero exit IS the signal these tests read,
            # so raising here would replace an inspectable return code with a traceback.
            check=False,
        )
        assert result.returncode == 0, result.stderr[:400]
        payload = json.loads(result.stdout)

        assert payload["unexplained_orphans"] == []
        classified = {
            orphan["path"]: orphan["classification"]
            for orphan in payload["caller_orphans"]
        }
        assert set(classified) == set(rr.INTENTIONAL_ORPHANS)
        # Every one carries a reason. A null here would mean an orphan slipped through
        # unclassified while the assertion above still passed.
        assert all(reason for reason in classified.values()), classified

    def test_strict_exits_zero_only_while_every_orphan_is_classified(self) -> None:
        # With only classified orphans present, `--strict` passes. This is what lets CI run
        # it without an allow-list maintained somewhere else.
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "backend" / "tools" / "route_reachability.py"),
                "--strict",
            ],
            capture_output=True,
            text=True,
            cwd=ROOT,
            timeout=180,
            # check=False on purpose: a non-zero exit IS the signal these tests read,
            # so raising here would replace an inspectable return code with a traceback.
            check=False,
        )
        assert result.returncode == 0, result.stdout[-400:] + result.stderr[-400:]

    def test_the_console_marks_an_unexplained_orphan(self) -> None:
        # The console output is what a human reads. An unexplained orphan has to be visible
        # as such, not merely listed -- a bare list is what made this invisible before.
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "backend" / "tools" / "route_reachability.py"),
            ],
            capture_output=True,
            text=True,
            cwd=ROOT,
            timeout=180,
            # check=False on purpose: a non-zero exit IS the signal these tests read,
            # so raising here would replace an inspectable return code with a traceback.
            check=False,
        )
        assert result.returncode == 0
        assert "UNEXPLAINED, not tolerated" not in result.stdout, (
            "an orphan has no recorded classification"
        )
        # And the two that are classified show their reasoning.
        assert "INTERNAL" in result.stdout
        assert "REDUNDANT" in result.stdout

