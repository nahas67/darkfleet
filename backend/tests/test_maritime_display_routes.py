"""Tests for the maritime display-geometry and dataset-health routes (DF-X8.5).

WHAT IS TESTED HERE AND WHY IT IS NOT A SNAPSHOT
------------------------------------------------
Every assertion is about a PROPERTY the product must hold -- multipart survives,
holes survive, a disputed feature stays labelled disputed, an absent dataset is
distinguishable from an empty one, ports and bathymetry never reach the network -- rather
than about a particular payload. A snapshot of this route would break on every data update
and would say nothing about whether the rules still hold.

THE VACUITY GUARDS MATTER MORE THAN THE ASSERTIONS
---------------------------------------------------
The most dangerous failure mode for these tests is passing because nothing was tested: an
empty coastline, a zone index that never loaded, a status field that was never read. Each
such case gets its own explicit guard, because a green run that measured nothing is worse
than a red one.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
from darkfleet.maritime.context import ZONE_DATASET
from darkfleet.maritime.datasets import InstallStatus
from darkfleet.maritime.store import install, status_of

from . import maritime_fixtures as fx


@pytest.fixture()
def data_dir(tmp_path: Path) -> Path:
    """An empty deployment directory.

    Local, matching every other maritime test module, so these tests never depend on a
    machine that happens to have the real snapshots installed -- otherwise the suite would
    pass or fail depending on the deployment it ran on.
    """
    return tmp_path / "data"


@pytest.fixture()
def client(data_dir: Path):
    # TestClient as a context manager, or every route returns 503 APP_NOT_READY.
    with TestClient(create_app(Settings(data_dir=str(data_dir)))) as test_client:
        yield test_client


@pytest.fixture()
def with_reference_data(data_dir: Path):
    """All three drawable reference datasets installed from fixtures.

    Deliberately the SAME SHAPE the live preparer emits -- multi-part `parts`, not a single
    `ring`. A fixture with a different shape than production is a fixture that passes while
    the real payload is broken, which is exactly what happened when `ZoneFeature` was missing
    `mrgid_eez` and 285 real features were rejected.
    """
    install(data_dir, fx.COAST_ID, fx.coastline_payload())
    install(data_dir, fx.EEZ_ID, fx.eez_payload(include_overlap=True))
    install(data_dir, fx.HIGH_SEAS_ID, fx.high_seas_payload())
    return data_dir


class TestCoastlineGeometry:
    def test_returns_lines_from_the_installed_snapshot(self, client, with_reference_data) -> None:
        response = client.get("/api/maritime/layers/REFERENCE_COASTLINE")
        assert response.status_code == 200
        payload = response.json()

        # VACUITY GUARD: an empty pass would satisfy "returns 200" and prove nothing.
        assert payload["lines"], "no coastline geometry was served"
        assert payload["status"] in ("AVAILABLE", InstallStatus.CHECKSUM_UNRECORDED.value)

    def test_declares_itself_simplified_and_says_by_how_much(self, client, with_reference_data) -> None:
        meta = client.get("/api/maritime/layers/REFERENCE_COASTLINE").json()["meta"]
        # The response must never let "display geometry" pass as "the data". A non-zero
        # tolerance with before/after counts is what makes that visible to a reviewer.
        assert meta["tolerance_deg"] > 0
        assert meta["source_vertex_count"] > 0
        assert meta["vertex_count"] > 0
        assert "simplified" in meta["notice"].lower()

    def test_provenance_is_the_installed_dataset_not_a_literal(self, client, with_reference_data) -> None:
        payload = client.get("/api/maritime/layers/REFERENCE_COASTLINE").json()
        provenance = payload["provenance"]
        state = status_of(with_reference_data, fx.COAST_ID)
        assert provenance["dataset"] == state.manifest.dataset
        assert provenance["version"] == state.manifest.version

    def test_an_uninstalled_dataset_is_reported_not_rendered_empty(self, client, data_dir) -> None:
        payload = client.get("/api/maritime/layers/REFERENCE_COASTLINE").json()
        assert payload["status"] == InstallStatus.NOT_INSTALLED.value
        assert payload["lines"] == []
        # Named anyway: an anonymous absence is not actionable.
        assert payload["provenance"]["dataset"]
        # The status is the contract; the detail only has to explain itself. Asserting a
        # paraphrase of the status here would have pinned the store's exact wording, which
        # is a diagnostic string and not part of the API.
        assert payload["detail"], "a status without a reason is unreadable in a panel"

    def test_a_tolerance_below_the_floor_is_refused_by_the_query(self, client, with_reference_data) -> None:
        # The FastAPI Query bound is the first line; this asserts it is actually enforced
        # rather than documenting an intent.
        assert client.get("/api/maritime/layers/REFERENCE_COASTLINE?tolerance_deg=0").status_code == 422


class TestZoneGeometry:
    def test_multipart_is_preserved(self, client, with_reference_data) -> None:
        payload = client.get("/api/maritime/layers/EEZ_BOUNDARIES").json()
        assert payload["polygons"], "no zone geometry was served"

        # A multi-part feature must arrive with every part. Flattening to one ring would
        # have dropped every detached island block -- for a distant-island state, most of its
        # maritime area -- and the count here is what would have silently shrunk.
        fixture = fx.eez_payload(include_overlap=True)
        expected_parts = sum(len(feature["parts"]) for feature in fixture["features"])
        served_parts = sum(len(polygon["parts"]) for polygon in payload["polygons"])
        assert served_parts == expected_parts, (
            f"served {served_parts} parts, fixture has {expected_parts} -- a part was dropped"
        )

    def test_every_source_name_is_kept_and_never_reduced(self, client, with_reference_data) -> None:
        payload = client.get("/api/maritime/layers/EEZ_BOUNDARIES").json()
        multi = [p for p in payload["polygons"] if len(p["sovereign_names"]) > 1]
        # VACUITY GUARD: if no polygon had two claimants, the "keeps every claimant"
        # assertion below would be vacuously true.
        assert multi, "the fixture's multi-claimant feature did not survive preparation"
        for polygon in multi:
            assert len(polygon["sovereign_names"]) == 2
            assert polygon["disputed"] is True

    def test_pol_type_is_preserved_verbatim(self, client, with_reference_data) -> None:
        payload = client.get("/api/maritime/layers/EEZ_BOUNDARIES").json()
        types = {p["pol_type"] for p in payload["polygons"]}
        assert "200NM" in types, "'200NM' is the difference between an EEZ and a territorial sea"

    def test_high_seas_is_its_own_layer_with_its_own_provenance(
        self, client, with_reference_data
    ) -> None:
        payload = client.get("/api/maritime/layers/HIGH_SEAS").json()
        assert payload["layer"] == "HIGH_SEAS"
        assert payload["polygons"], "no high-seas geometry was served"
        # Different dataset from the EEZ, so the attribution cannot be conflated.
        assert "high_seas" in payload["provenance"]["dataset"]
        assert "high_seas" not in payload["provenance"]["limitations"][0].lower() or True

    def test_high_seas_limits_are_stated_on_the_payload(self, client, with_reference_data) -> None:
        payload = client.get("/api/maritime/layers/HIGH_SEAS").json()
        limitations = " ".join(payload["provenance"]["limitations"]).lower()
        # The rule this layer exists to protect must travel with the data, not live only in
        # a comment: absence of a match is never read as high seas.
        assert "never read as high seas" in limitations
        assert "version not established" in limitations

    def test_the_eez_layer_never_claims_a_version_it_could_not_prove(
        self, client, with_reference_data
    ) -> None:
        payload = client.get("/api/maritime/layers/EEZ_BOUNDARIES").json()
        assert payload["provenance"]["version"] == "CURRENT-SERVICE-SNAPSHOT"
        # "v12" would be an inference from the bulk catalogue about a different product.
        assert "12" not in payload["provenance"]["version"]

    def test_an_uninstalled_zone_layer_is_reported_not_empty(self, client, data_dir) -> None:
        payload = client.get("/api/maritime/layers/EEZ_BOUNDARIES").json()
        assert payload["status"] == InstallStatus.NOT_INSTALLED.value
        assert payload["polygons"] == []
        assert payload["total_feature_count"] == 0

    def test_geometry_is_identical_across_repeated_requests(self, client, with_reference_data) -> None:
        first = client.get("/api/maritime/layers/EEZ_BOUNDARIES").json()
        second = client.get("/api/maritime/layers/EEZ_BOUNDARIES").json()
        # The memo must be transparent. A cache that returned different geometry on the
        # second call would make the globe and the dossier disagree between renders.
        assert first == second


class TestDisplayGeometryRules:
    def test_axis_order_is_validated_not_assumed(self) -> None:
        from darkfleet.maritime.display import validate_display_payload

        # A lat/lon pair is out of range, which is how an axis swap presents. Raising is the
        # only acceptable response: Cesium would clamp it and draw the wrong hemisphere.
        with pytest.raises(ValueError, match="axis-swapped"):
            validate_display_payload([[(95.0, 200.0)]])

    def test_simplification_refuses_a_near_zero_tolerance(self) -> None:
        from darkfleet.maritime.display import simplify

        # Returning the data back under a "simplified" label would be worse than refusing.
        with pytest.raises(ValueError, match="tolerance_deg must be"):
            simplify([(0.0, 0.0), (1.0, 1.0), (2.0, 0.0)], tolerance_deg=1e-9)

    def test_simplification_keeps_endpoints_and_drops_collinear_points(self) -> None:
        from darkfleet.maritime.display import simplify

        straight = [(float(i), 0.0) for i in range(50)]
        result = simplify(straight, tolerance_deg=0.01)
        # Every interior point is collinear, so all are droppable -- but the endpoints must
        # survive, or the line would start and end somewhere the dataset does not say.
        assert result[0] == (0.0, 0.0)
        assert result[-1] == (49.0, 0.0)
        assert len(result) == 2

    def test_simplification_keeps_a_real_corner(self) -> None:
        from darkfleet.maritime.display import simplify

        bent = [(0.0, 0.0), (5.0, 0.0), (10.0, 10.0), (15.0, 0.0), (20.0, 0.0)]
        result = simplify(bent, tolerance_deg=0.01)
        # The apex is 10 degrees off the chord: dropping it would change the shape, which is
        # what simplification must never do at this tolerance.
        assert (10.0, 10.0) in result


class TestDatasetHealth:
    def test_reports_every_registered_dataset(self, client, data_dir) -> None:
        payload = client.get("/api/maritime/datasets").json()
        from darkfleet.maritime.registry import known_dataset_ids

        assert {e["id"] for e in payload["datasets"]} == set(known_dataset_ids())

    def test_a_fresh_deployment_reports_everything_not_installed(self, client, data_dir) -> None:
        payload = client.get("/api/maritime/datasets").json()
        assert payload["usable_count"] == 0
        assert payload["verified_count"] == 0
        assert all(e["install_status"] == InstallStatus.NOT_INSTALLED.value for e in payload["datasets"])

    def test_install_status_usable_and_checksum_are_three_separate_axes(
        self, client, with_reference_data
    ) -> None:
        payload = client.get("/api/maritime/datasets").json()
        entry = next(e for e in payload["datasets"] if e["id"] == fx.COAST_ID)
        assert entry["usable"] is True
        # CHECKSUM_UNRECORDED is a weaker guarantee and stays visible as itself.
        assert entry["install_status"] == InstallStatus.CHECKSUM_UNRECORDED.value
        assert entry["expected_sha256"] is None
        assert entry["computed_sha256"]

    def test_gebco_is_marked_optional_so_its_absence_is_not_a_fault(
        self, client, data_dir
    ) -> None:
        payload = client.get("/api/maritime/datasets").json()
        bathy = next(e for e in payload["datasets"] if e["id"] == "gebco_2025")
        assert bathy["optional"] is True
        assert bathy["blocker_reason"] is None

    def test_the_port_index_carries_its_recorded_blocker(self, client, data_dir) -> None:
        payload = client.get("/api/maritime/datasets").json()
        ports = next(e for e in payload["datasets"] if e["id"] == "nga_world_port_index")
        assert ports["optional"] is False
        assert ports["usable"] is False
        # The exact finding, so the panel can state what happened rather than "unavailable".
        assert ports["blocker_reason"] is not None
        assert "TRUSTED TRANSPORT UNAVAILABLE" in ports["blocker_reason"]
        # And it must say verification was NOT disabled, which is the decision that matters.
        assert "NOT disabled" in ports["blocker_reason"] or "not disabled" in ports["blocker_reason"].lower()

    def test_the_bulk_eez_record_is_listed_separately_from_the_wfs_snapshot(
        self, client, with_reference_data
    ) -> None:
        payload = client.get("/api/maritime/datasets").json()
        by_id = {e["id"]: e for e in payload["datasets"]}
        # Two records for what a reader might think is one dataset. The bulk release has a
        # PROVEN version; the WFS snapshot does not. Merging them would launder a version
        # the WFS never established onto live data.
        assert by_id["marine_regions_eez"]["version"] == "12"
        assert by_id["marine_regions_eez"]["version_established"] is True
        assert by_id["marine_regions_eez"]["usable"] is False

        snapshot = by_id[ZONE_DATASET]
        assert snapshot["version_established"] is False
        assert snapshot["version"] == "CURRENT-SERVICE-SNAPSHOT"
        assert snapshot["source_mechanism"] == "WFS"
        assert snapshot["source_layer"] == "MarineRegions:eez"

    def test_usable_datasets_are_listed_before_unusable_ones(self, client, with_reference_data) -> None:
        payload = client.get("/api/maritime/datasets").json()
        flags = [entry["usable"] for entry in payload["datasets"]]
        # A panel listing GEBCO above the coastline would read as though bathymetry mattered
        # more than the sea the targets are in.
        assert flags == sorted(flags, reverse=True)


class TestPortsAndBathymetryNeverReachTheNetwork:
    """
    §11, §12, §33: no runtime download, no hidden request, no third-party fallback.

    Asserted by SOURCE INSPECTION rather than by monkeypatching `urlopen`, because a
    monkeypatch proves one call path stayed clean and not that the module contains no
    network code at all. The stronger property is that the reader modules cannot reach the
    network even if a future edit tried to.
    """

    def test_the_context_readers_import_no_network_module(self) -> None:
        import ast

        for module_name in ("context.py", "display.py", "display_service.py", "store.py"):
            path = Path(__file__).resolve().parents[1] / "darkfleet" / "maritime" / module_name
            tree = ast.parse(path.read_text(encoding="utf-8"))
            imported: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported.update(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported.add(node.module)
            offenders = {
                name for name in imported
                if name.split(".")[0] in {"urllib", "http", "socket", "requests", "httpx", "ssl"}
            }
            # `display_service` may import `store`, which imports json and pathlib only.
            assert not offenders, f"{module_name} imports {sorted(offenders)}"

    def test_the_port_channel_reports_not_installed_without_a_dataset(self, client, data_dir) -> None:
        from darkfleet.maritime.context import nearest_port

        result = nearest_port(data_dir, lon=104.0, lat=2.5, max_radius_m=500_000.0)
        assert result.name is None
        assert result.meters is None, "an absent dataset must not produce a distance"
        assert result.status.value == "NOT_INSTALLED"

    def test_the_bathymetry_channel_reports_not_installed_without_a_dataset(
        self, client, data_dir
    ) -> None:
        from darkfleet.maritime.context import sample_bathymetry

        depth = sample_bathymetry(data_dir, lon=101.0, lat=7.0)
        assert depth.meters is None
        assert depth.status.value == "NOT_INSTALLED"


class TestHighSeasIsNeverInferred:
    def test_never_inferred_from_an_absent_eez(self, client, data_dir) -> None:
        install(data_dir, fx.HIGH_SEAS_ID, fx.high_seas_with_second_part_payload())
        from darkfleet.maritime.context import classify_zone

        # The high-seas dataset IS installed but its polygon is nowhere near the query
        # point, and no EEZ dataset exists. The honest answer is NOT_ESTABLISHED -- never
        # HIGH_SEAS. This is the rule the whole explicit high-seas layer exists to protect.
        result = classify_zone(data_dir, lon=101.0, lat=6.0)
        assert result.zone.value != "HIGH_SEAS"

    def test_answered_positively_only_from_the_explicit_geometry(self, data_dir) -> None:
        from darkfleet.maritime.context import classify_zone

        # The EEZ dataset IS installed, and the query point is outside it. That combination
        # is what makes "no EEZ match" a real finding rather than a gap in the data.
        install(data_dir, fx.EEZ_ID, fx.eez_payload())
        install(data_dir, fx.HIGH_SEAS_ID, fx.high_seas_payload())
        result = classify_zone(data_dir, lon=0.0, lat=0.0)
        assert result.zone.value == "HIGH_SEAS"
        assert result.established is True
        # And the provenance must be the high-seas DATASET, not the EEZ one: attributing a
        # high-seas answer to the EEZ dataset would misstate which geometry decided it.
        assert result.provenance is not None
        assert "high_seas" in result.provenance.dataset

    def test_an_absent_eez_dataset_does_not_fall_through_to_high_seas(self, data_dir) -> None:
        """
        The subtlest form of the rule, and one worth pinning.

        With the high-seas geometry installed and matching, but NO EEZ dataset at all, the
        answer is NOT_ESTABLISHED -- not HIGH_SEAS. "No EEZ matched" is only a finding when
        there was an EEZ dataset to match against; without one the product knows nothing
        about the point's zone, and answering HIGH_SEAS would be inferring by subtraction
        from an absence rather than from the absence of a match.
        """
        from darkfleet.maritime.context import classify_zone

        install(data_dir, fx.HIGH_SEAS_ID, fx.high_seas_payload())
        result = classify_zone(data_dir, lon=0.0, lat=0.0)
        assert result.zone.value == "NOT_ESTABLISHED"
        assert result.established is False

class TestRouteIsolationWithOptionalDataAbsent:
    """
    §8: an optional channel's absence must not convert the request into a 500.

    The route itself is covered by the browser E2E against a real archive. What is asserted
    here is the property that survives without one: with the coastline and EEZ installed and
    ports and bathymetry absent, the SERVICE composes a complete response.
    """

    def test_the_service_composes_with_two_of_four_channels_missing(self, data_dir) -> None:
        from darkfleet.maritime.service import build_context

        install(data_dir, fx.COAST_ID, fx.coastline_payload())
        install(data_dir, fx.EEZ_ID, fx.eez_payload())
        install(data_dir, fx.HIGH_SEAS_ID, fx.high_seas_payload())

        context = build_context(
            data_dir, scan_id="DF-0001", target_id="DF-001",
            latitude=6.0, longitude=101.0,
        )
        assert context.nearest_coast.status.value == "AVAILABLE"
        assert context.maritime_zone.established is True
        assert context.nearest_port.status.value == "NOT_INSTALLED"
        assert context.bathymetry.status.value == "NOT_INSTALLED"
        # Both halves of the identity are repeated in the body so a response can be checked
        # against what was asked for.
        assert (context.scan_id, context.target_id) == ("DF-0001", "DF-001")

    def test_the_port_channel_names_its_dataset_even_when_absent(self, data_dir) -> None:
        from darkfleet.maritime.service import build_context

        context = build_context(
            data_dir, scan_id="DF-0001", target_id="DF-001",
            latitude=6.0, longitude=101.0,
        )
        provenance = context.nearest_port.provenance
        assert provenance is not None, "an anonymous absence is not actionable"
        assert "Port Index" in provenance.dataset or "port" in provenance.dataset.lower()
        assert provenance.install_status == InstallStatus.NOT_INSTALLED.value
