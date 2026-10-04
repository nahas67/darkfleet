"""THE FORMAL ANALYTICAL DELTA. DF-X8 §10 and §89.

DF-X8.3 reported that maritime context "cannot alter sarConf" and argued it from the
diff. This measures it instead, which is what the brief asked for and what the earlier
checkpoint did not do.

WHAT IS COMPARED

Every analytical field, over REAL stored scans, through the real HTTP API:

    target count and ids
    latitude, longitude
    classification, analytical classification, is_ghost_vessel
    sar_conf
    AIS association, MMSI, AIS confidence, candidate count, correlation composite
    wake evidence
    polarization evidence
    scene id

HOW

Fingerprint the API response for every target of several real scans BEFORE any maritime
dataset is installed, then install all four and fingerprint again. Any difference is a
correctness failure and stops the checkpoint.

The comparison is deliberately end-to-end rather than a unit-level inspection: an
argument from the diff can be wrong, and a fingerprint over the actual served responses
cannot be.

THE CLAIM BEING TESTED

    Changing only coastline, EEZ, high-seas state, port proximity and depth must NOT
    alter any analytical value.

An earlier, weaker version of this test would have passed trivially because nothing
imported the maritime package. So the test also asserts that maritime context is
actually REACHABLE from the same code path afterwards -- otherwise "no change" would be
vacuous, and vacuous is what a green tick on an unexercised branch looks like.

NO NETWORK. Reads a local fixture archive through TestClient, loopback only.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.maritime.context import (
    ContextStatus,
    classify_zone,
    nearest_port,
    sample_bathymetry,
)
from darkfleet.maritime.store import install

from . import maritime_fixtures as fx

#: The live fixture archive from DF-X7's browser runs. Present in this environment; the
#: test SKIPS rather than inventing data if it is not, because a delta measured against
#: synthetic scans would prove less than it appears to.
ARCHIVE = Path(
    os.environ.get("DF_SERVE_DATA_DIR", r"C:\Users\nahas\AppData\Local\Temp\df-serve-56jd6e55")
)

#: Analytical fields, using the ACTUAL response names.
#:
#: Written against the served contract rather than a hoped-for one. A first draft used
#: `latitude`/`sar_conf`/`mmsi` from the brief's vocabulary, and every comparison then
#: compared two MISSING sentinels -- the delta was zero because it was comparing nothing.
#: The names below are `lat`, `lon`, `sarConf`, `aisConf`, `corr` and friends exactly as
#: `/api/scans/{id}/targets` serves them.
ANALYTICAL_FIELDS = (
    "id",
    "lat",
    "lon",
    "classification",
    "sarConf",
    "aisConf",
    "maxDb",
    "meanDb",
    "lenM",
    "widM",
    "lenUncM",
    "hdg",
    "geoCentreOffset",
    "geoPixelCentroid",
    "tags",
    "corr",
    "wake",
    "wakeAnalysis",
    "polarizationEvidence",
    "assessment",
    "area",
)

#: Nested objects compared as whole JSON: a change anywhere inside, including a key that
#: appeared or vanished, is a difference. Wake and polarization are the two most
#: tempting places for context to leak in -- both are "extra evidence" channels where a
#: maritime value would look entirely plausible.
WHOLE_SUBTREES = ("wake", "wakeAnalysis", "polarizationEvidence", "corr", "assessment")

MISSING = "<absent>"


def _client(data_dir: Path) -> TestClient:
    settings = Settings(data_dir=str(data_dir))
    return TestClient(create_app(settings))


def _scan_ids(data_dir: Path, limit: int = 6) -> list[str]:
    """Scan ids that actually SERVE targets.

    Not every stored scan.json is a completed run: a queued, failed or partial scan is on
    disk but its targets route returns 503. Fingerprinting those would assert a 503 is
    the "before" state, and comparing two 503s is not a measurement.
    """
    scans_dir = data_dir / "scans"
    if not scans_dir.is_dir():
        return []
    # Entered so the lifespan runs; otherwise every probe is a 503.
    probe = _client(data_dir)
    with probe:
        usable: list[str] = []
        for path in sorted(scans_dir.glob("*.json")):
            if probe.get(f"/api/scans/{path.stem}/targets").status_code == 200:
                usable.append(path.stem)
            if len(usable) >= limit:
                break
    return usable


def _fingerprint(client: TestClient, scan_id: str) -> dict[str, Any]:
    """Every analytical value the API serves for one scan's targets."""
    response = client.get(f"/api/scans/{scan_id}/targets")
    assert response.status_code == 200, f"{scan_id}: {response.status_code}"
    body = response.json()
    out: dict[str, Any] = {}

    targets = body.get("targets") if isinstance(body, dict) else body
    for target in targets or []:
        tid = str(target.get("id") or "?")
        record: dict[str, Any] = {}
        for field in ANALYTICAL_FIELDS:
            value = target.get(field, MISSING)
            # Dicts and lists are canonicalised so key ORDER cannot register as a
            # difference -- that would be a false positive that trains a reader to
            # ignore the test.
            record[field] = (
                json.dumps(value, sort_keys=True, default=str)
                if isinstance(value, (dict, list))
                else value
            )
        out[tid] = record
    return out


def _fingerprint_all(client: TestClient, scan_ids: list[str]) -> dict[str, Any]:
    return {scan_id: _fingerprint(client, scan_id) for scan_id in scan_ids}


def _diff(
    before: dict[str, Any], after: dict[str, Any]
) -> list[str]:
    """Every difference, named. An empty list is the pass condition."""
    problems: list[str] = []
    for scan_id in sorted(set(before) | set(after)):
        if scan_id not in after:
            problems.append(f"{scan_id}: present before, absent after")
            continue
        if scan_id not in before:
            problems.append(f"{scan_id}: appeared after")
            continue
        b, a = before[scan_id], after[scan_id]
        if len(b) != len(a):
            problems.append(f"{scan_id}: target count {len(b)} -> {len(a)}")
        for tid in sorted(set(b) | set(a)):
            if tid not in a:
                problems.append(f"{scan_id}/{tid}: target disappeared")
                continue
            if tid not in b:
                problems.append(f"{scan_id}/{tid}: target appeared")
                continue
            for field in ANALYTICAL_FIELDS:
                if b[tid][field] != a[tid][field]:
                    problems.append(
                        f"{scan_id}/{tid}: {field} {b[tid][field]!r} -> {a[tid][field]!r}"
                    )
    return problems


@pytest.fixture()
def archive_client(tmp_path) -> Any:
    """A copy of the real archive, so installing datasets cannot mutate shared state."""
    if not ARCHIVE.is_dir():
        pytest.skip(f"no fixture archive at {ARCHIVE}")
    import shutil

    data_dir = tmp_path / "archive"
    shutil.copytree(ARCHIVE, data_dir)
    scan_ids = _scan_ids(data_dir)
    if not scan_ids:
        pytest.skip("fixture archive has no scans")
    # Entered as a CONTEXT MANAGER so the app's lifespan runs and builds ApiState.
    # Without it every route returns 503 APP_NOT_READY, and fingerprinting two 503s
    # would have "proved" a zero delta while measuring nothing at all -- a vacuous pass
    # wearing the costume of a strong one.
    client = _client(data_dir)
    client.__enter__()
    try:
        yield data_dir, scan_ids, client
    finally:
        client.__exit__(None, None, None)


class TestAnalyticalDeltaIsZero:
    def test_installing_all_four_datasets_changes_no_analytical_value(
        self, archive_client
    ) -> None:
        """
        The invariant, measured rather than argued (§9, §89).

        A single field moving is a correctness failure and would invalidate every
        evidence record derived from these scans, so this is the test that decides
        whether DF-X8.4 may proceed.
        """
        data_dir, scan_ids, client = archive_client

        before = _fingerprint_all(client, scan_ids)

        # Context is genuinely absent at this point.
        assert classify_zone(data_dir, lon=101.0, lat=6.0).established is False
        assert sample_bathymetry(data_dir, lon=101.0, lat=7.0).meters is None

        install(data_dir, fx.COAST_ID, fx.coastline_payload())
        install(data_dir, fx.EEZ_ID, fx.eez_payload())
        install(data_dir, fx.HIGH_SEAS_ID, fx.high_seas_payload())
        install(data_dir, fx.PORTS_ID, fx.ports_payload())
        install(data_dir, fx.BATHY_ID, fx.grid_payload())

        # Context is genuinely present now. Without this the delta below would be
        # vacuous -- "nothing changed" is also what you get when nothing was ever read.
        assert classify_zone(data_dir, lon=101.0, lat=6.0).established is True
        assert sample_bathymetry(data_dir, lon=101.0, lat=7.0).meters == -200
        assert nearest_port(data_dir, lon=100.6, lat=6.0).status is ContextStatus.AVAILABLE

        after_client = _client(data_dir)
        with after_client:
            after = _fingerprint_all(after_client, scan_ids)

        problems = _diff(before, after)
        assert not problems, "analytical values moved:\n  " + "\n  ".join(problems[:25])

    def test_the_fingerprint_actually_contains_the_fields_it_claims(self, archive_client) -> None:
        """
        Guard against a vacuous pass.

        If the endpoint renamed a field, every comparison would compare two MISSING
        sentinels and report "no change" while checking nothing. So the fingerprint is
        asserted to hold real values for the fields that matter.
        """
        _data_dir, scan_ids, client = archive_client
        fingerprint = _fingerprint(client, scan_ids[0])
        assert fingerprint, "no targets fingerprinted"

        first = next(iter(fingerprint.values()))
        assert first["id"] != MISSING, "target id absent from the response"
        assert first["classification"] != MISSING, "classification absent from the response"
        # Coordinates must be real numbers. A sentinel here would mean the delta was
        # comparing the string "<absent>" to itself.
        assert isinstance(first["lat"], (int, float)), first["lat"]
        assert isinstance(first["lon"], (int, float)), first["lon"]
        assert isinstance(first["sarConf"], (int, float)), first["sarConf"]
        # And the nested evidence channels must be present, not silently missing.
        assert first["wakeAnalysis"] != MISSING
        assert first["corr"] != MISSING

    def test_comparing_the_fingerprint_to_itself_finds_nothing(self, archive_client) -> None:
        # The diff function must be capable of reporting a difference, or "no problems"
        # means nothing.
        _data_dir, scan_ids, client = archive_client
        a = _fingerprint_all(client, scan_ids)
        b = _fingerprint_all(client, scan_ids)
        assert _diff(a, b) == []

        # Perturb one analytical field and confirm the diff notices.
        mutated = json.loads(json.dumps(a))
        some_scan = next(iter(mutated))
        some_target = next(iter(mutated[some_scan]))
        mutated[some_scan][some_target]["sarConf"] = 0.123456
        assert _diff(a, mutated), "the diff failed to detect a changed sarConf"

        # And a change DEEP inside a nested evidence channel must also be caught, since
        # that is exactly where context would try to hide.
        deep = json.loads(json.dumps(a))
        target = deep[some_scan][some_target]
        target["wakeAnalysis"] = json.dumps({"state": "TAMPERED"})
        assert _diff(a, deep), "the diff failed to detect a changed wakeAnalysis"

    def test_context_channels_are_unreachable_from_the_analytical_path(self) -> None:
        """
        Structural half of the invariant.

        The maritime package must not be IMPORTED by the analytical modules. If it were,
        "no change" would depend on a runtime coincidence rather than on the dependency
        not existing -- and one later import would make every measurement above
        meaningless.

        Checked via the AST rather than a substring search, because a substring search is
        wrong in a way that looks like a finding: `polarization.py` contains the word
        "maritime" in a comment about "the maritime convention" for open-water
        brightness, which is not an import of anything. A grep would have reported a
        dependency that does not exist and invited someone to "fix" real science to
        satisfy a test.
        """
        import ast

        import darkfleet.ghost_vessel as ghost
        import darkfleet.polarization as pol
        from darkfleet import tracks

        for module in (ghost, pol, tracks):
            tree = ast.parse(Path(module.__file__ or "").read_text(encoding="utf-8"))
            imported: list[str] = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported += [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    # `from ..maritime import x` records module=".." and level=2, so
                    # the package name has to be read off the name, not the module.
                    imported.append(node.module or "")
                    imported += [f"{node.module or ''}.{a.name}" for a in node.names]
            offenders = [name for name in imported if "maritime" in name.split(".")]
            assert not offenders, (
                f"{module.__name__} imports maritime context via {offenders}; the "
                "analytical path must not depend on it"
            )


class TestContextDoesNotEnterEvidence:
    def test_installing_context_adds_no_field_to_the_evidence_document(
        self, archive_client
    ) -> None:
        """
        §51: context is not evidence.

        EEZ, nearest port and depth must NOT appear inside an evidence document, and the
        check is STRUCTURAL: the document's key set is compared before and after context
        is installed. Any added key is a leak.

        A substring search was the first attempt and it was wrong in a way that looked
        like a finding. The evidence document legitimately contains
        `land_mask.coastline_buffer_m` -- a pre-existing ESA WorldCover parameter from
        the SAR pipeline, where a "coastline buffer" means how far inland the mask
        reaches. Nothing to do with maritime reference data. A substring test flagged it
        as a leak and would have prompted someone to "fix" working science to satisfy a
        bad test.

        Comparing key sets has no such failure mode: a pre-existing analytical key is in
        both sets, and only a genuinely NEW key shows up as a difference.
        """
        data_dir, scan_ids, client = archive_client
        targets = client.get(f"/api/scans/{scan_ids[0]}/targets").json().get("targets") or []
        if not targets:
            pytest.skip("no targets in the first scan")
        target_id = targets[0]["id"]

        def flatten(value: Any, prefix: str = "") -> set[str]:
            if isinstance(value, dict):
                out: set[str] = set()
                for key, child in value.items():
                    out |= flatten(child, f"{prefix}{key}.")
                return out
            if isinstance(value, list):
                return {f"{prefix}[]"}
            return {prefix.rstrip(".")}

        def key_set() -> set[str]:
            return flatten(client.get(f"/api/targets/{target_id}").json())

        before = key_set()

        install(data_dir, fx.EEZ_ID, fx.eez_payload())
        install(data_dir, fx.HIGH_SEAS_ID, fx.high_seas_payload())
        install(data_dir, fx.PORTS_ID, fx.ports_payload())
        install(data_dir, fx.BATHY_ID, fx.grid_payload())
        install(data_dir, fx.COAST_ID, fx.coastline_payload())

        after = key_set()
        added = after - before
        assert not added, (
            "installing maritime context added field(s) to the evidence document: "
            f"{sorted(added)}"
        )
        # Nothing removed either: context must not restructure evidence either.
        assert not (before - after), (
            f"evidence document lost field(s): {sorted(before - after)}"
        )

    def test_the_pre_existing_coastline_buffer_is_not_a_context_leak(self, archive_client) -> None:
        """
        The false positive, pinned so it cannot be "rediscovered" later.

        `land_mask.coastline_buffer_m` is a land-mask parameter that predates DF-X8. A
        test that greps for the word "coastline" in evidence output will always flag it,
        and the natural response would be to delete or rename real science.
        """
        _data_dir, scan_ids, client = archive_client
        targets = client.get(f"/api/scans/{scan_ids[0]}/targets").json().get("targets") or []
        if not targets:
            pytest.skip("no targets in the first scan")
        document = client.get(f"/api/targets/{targets[0]['id']}").json()
        # Reached through the real document path:
        # evidence.provenance.processing.land_mask -- the pipeline's provenance block,
        # recording the parameters the scan actually ran with.
        mask = (
            document.get("evidence", {})
            .get("provenance", {})
            .get("processing", {})
            .get("land_mask", {})
        )
        assert isinstance(mask, dict) and mask, (
            f"land mask absent; document keys {sorted(document)}"
        )
        assert "coastline_buffer_m" in mask, (
            "expected the pre-existing land-mask coastline buffer parameter; if this now "
            f"fails the land mask was restructured, keys are {sorted(mask)}"
        )


class TestPortProximityInfersNothing:
    def test_the_evidence_route_makes_no_intent_claim_for_a_port_proximate_target(
        self, archive_client
    ) -> None:
        """
        §54 and §61: near a port must never produce intent language.

        Checked on the EMITTED PRODUCT, not the source, because an emitted word is what
        an operator reads.
        """
        data_dir, scan_ids, client = archive_client
        install(data_dir, fx.PORTS_ID, fx.ports_payload())

        for scan_id in scan_ids:
            targets = client.get(f"/api/scans/{scan_id}/targets").json().get("targets") or []
            for target in targets[:4]:
                target_id = target.get("id") or target.get("target_id")
                evidence = client.get(f"/api/targets/{target_id}").json()
                text = json.dumps(evidence, sort_keys=True, default=str).lower()
                for phrase in ("heading toward", "heading to port", "bound for",
                               "departed port", "arriving at", "port call",
                               "destination port", "likely destination"):
                    assert phrase not in text, (
                        f"evidence for {target_id} contains intent phrase {phrase!r}"
                    )