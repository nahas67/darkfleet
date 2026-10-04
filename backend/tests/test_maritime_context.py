"""Maritime context: the four channels, their provenance, and their honesty.

DF-X8.4 §9 and §89. The invariant under test throughout is that CONTEXT IS NOT
ANALYTICAL CLASSIFICATION: adding coastline, zones, ports and bathymetry must not move
a single analytical value. The tests here cover the maritime side of that; the
end-to-end delta over real scans is in ``test_maritime_analytical_delta.py``.

The second theme is ABSENCE. Four datasets, four ways to be missing, and none of them
may produce a confident-looking number.

NO NETWORK. Payloads are prepared fixtures.
"""

from __future__ import annotations

import pytest

from darkfleet.maritime.context import (
    ContextStatus,
    classify_zone,
    coast_distance,
    nearest_port,
    sample_bathymetry,
)
from darkfleet.maritime.geometry import DistanceMethod, point_in_polygon
from darkfleet.maritime.provenance import MaritimeZone
from darkfleet.maritime.store import install

from . import maritime_fixtures as fx


@pytest.fixture()
def data_dir(tmp_path):
    return tmp_path / "data"


@pytest.fixture()
def all_installed(data_dir):
    install(data_dir, "natural_earth_coastline", fx.coastline_payload())
    install(data_dir, "marine_regions_eez", fx.eez_payload())
    install(data_dir, "nga_world_port_index", fx.ports_payload())
    install(data_dir, "gebco_2025", fx.grid_payload())
    return data_dir


# ===========================================================================
# Coastline
# ===========================================================================


class TestCoastDistance:
    def test_measures_a_real_distance(self, all_installed) -> None:
        # 100.5E is 1.5 degrees east of the 99E coastline, about 167 km at 6N.
        result = coast_distance(all_installed, lon=100.5, lat=6.0)
        assert result.status is ContextStatus.AVAILABLE
        assert result.meters is not None
        assert 150_000 < result.meters < 185_000, result.meters

    def test_distance_carries_provenance_with_version(self, all_installed) -> None:
        result = coast_distance(all_installed, lon=100.5, lat=6.0)
        assert result.provenance is not None
        assert result.provenance.version == "4.1.0"
        assert result.provenance.provider == "Natural Earth (NACIS)"

    def test_method_is_reported_not_hidden(self, all_installed) -> None:
        # A coastal distance is to the nearest SAMPLE, not an exact point-to-segment
        # measurement. Reporting a plain geodesic would overstate the precision.
        result = coast_distance(all_installed, lon=100.5, lat=6.0)
        assert result.method is DistanceMethod.DENSIFIED_POINT_METER
        assert result.sample_spacing_m is not None

    def test_densification_actually_changes_the_answer(self, all_installed) -> None:
        # The fixture's coast segment runs 20 degrees with NO intermediate vertices, and
        # the query point is at its midpoint. Measuring to vertices alone finds the two
        # endpoints ~1125 km away -- far outside the search radius -- so the coarse case
        # finds nothing at all. Densified sampling finds the true ~167 km.
        #
        # Asserting the coarse case is UNMEASURED rather than merely larger is the
        # stronger statement: it shows densification is load-bearing, not a refinement.
        coarse = coast_distance(all_installed, lon=100.5, lat=10.0,
                                sample_spacing_m=200_000_000)
        fine = coast_distance(all_installed, lon=100.5, lat=10.0, sample_spacing_m=2_000)
        assert coarse.status is ContextStatus.NO_COVERAGE
        assert coarse.meters is None
        assert fine.status is ContextStatus.AVAILABLE
        assert fine.meters is not None and 150_000 < fine.meters < 185_000, fine.meters

    def test_far_from_any_coast_is_no_coverage_not_a_huge_number(self, data_dir) -> None:
        install(data_dir, "natural_earth_coastline", fx.coastline_payload())
        result = coast_distance(data_dir, lon=0.0, lat=-40.0, max_radius_m=300_000)
        assert result.status is ContextStatus.NO_COVERAGE
        assert result.meters is None
        assert result.searched_radius_m == 300_000

    def test_absent_coastline_is_not_installed(self, data_dir) -> None:
        result = coast_distance(data_dir, lon=100.5, lat=6.0)
        assert result.status is ContextStatus.NOT_INSTALLED
        assert result.meters is None

    def test_corrupt_coastline_is_failed_not_merely_absent(self, data_dir) -> None:
        # One needs a download, the other needs attention. Collapsing them sends an
        # operator to re-download a file that is present and still broken.
        from darkfleet.maritime.store import dataset_dir

        install(data_dir, "natural_earth_coastline", fx.coastline_payload())
        target = dataset_dir(data_dir, "natural_earth_coastline", "4.1.0") / "coastline.json"
        target.write_text('{"tampered": true}', encoding="utf-8")
        assert coast_distance(data_dir, lon=100.5, lat=6.0).status is ContextStatus.FAILED


# ===========================================================================
# Maritime zones
# ===========================================================================


class TestZoneClassification:
    def test_inside_an_eez(self, all_installed) -> None:
        result = classify_zone(all_installed, lon=101.0, lat=6.0)
        assert result.zone is MaritimeZone.EXCLUSIVE_ECONOMIC_ZONE
        assert result.feature_id == "EEZ-fixture-alpha"
        assert result.sovereign_names == ("FIXTURE ALPHA",)

    def test_zone_carries_dataset_provenance(self, all_installed) -> None:
        result = classify_zone(all_installed, lon=101.0, lat=6.0)
        assert result.provenance is not None
        assert result.provenance.version == "12"
        assert result.provenance.license.value == "CC_BY"

    def test_high_seas_only_from_an_explicit_polygon(self, all_installed) -> None:
        # 0E, 0N is inside the fixture HIGH_SEAS polygon and outside both EEZs.
        result = classify_zone(all_installed, lon=0.0, lat=0.0)
        assert result.zone is MaritimeZone.HIGH_SEAS
        assert result.established is True

    def test_absence_of_an_eez_is_never_high_seas(self, data_dir) -> None:
        """
        The single most important rule in this module (§20).

        A point outside every zone polygon is NOT high seas. Without an explicit
        HIGH_SEAS feature to test against, "inside no EEZ" is an inference about
        absence, and inferring HIGH_SEAS from a missing polygon is how an unintegrated
        dataset silently becomes a legal claim.
        """
        install(data_dir, "marine_regions_eez", fx.wrap_eez_payload())
        result = classify_zone(data_dir, lon=50.0, lat=20.0)
        assert result.zone is MaritimeZone.AMBIGUOUS
        assert result.established is False
        assert "not evidence of high seas" in (result.reason or "")

    def test_overlap_is_disputed_and_keeps_every_claimant(self, data_dir) -> None:
        install(data_dir, "marine_regions_eez", fx.eez_payload(include_overlap=True))
        # 101.5E, 6N is inside both EEZ squares.
        result = classify_zone(data_dir, lon=101.5, lat=6.0)
        assert result.zone is MaritimeZone.DISPUTED
        assert result.disputed is True
        # Three names, because the source names three. Reducing to one would be
        # DarkFleet asserting a sovereignty position.
        assert set(result.sovereign_names) == {"FIXTURE ALPHA", "FIXTURE BETA", "FIXTURE GAMMA"}

    def test_absent_zones_are_not_established(self, data_dir) -> None:
        result = classify_zone(data_dir, lon=101.0, lat=6.0)
        assert result.zone is MaritimeZone.NOT_ESTABLISHED
        assert result.established is False

    def test_an_empty_dataset_is_not_established_not_ambiguous(self, all_installed) -> None:
        # A payload that parsed but carries nothing is an ingestion failure, distinct
        # from a geometry that could not decide.
        install(all_installed, "marine_regions_eez", {"features": []})
        result = classify_zone(all_installed, lon=101.0, lat=6.0)
        assert result.zone is MaritimeZone.NOT_ESTABLISHED
        assert "no features" in (result.reason or "")

    def test_a_schema_violation_is_ambiguous_with_a_reason(self, all_installed) -> None:
        install(all_installed, "marine_regions_eez", {"features": [{"nope": 1}]})
        result = classify_zone(all_installed, lon=101.0, lat=6.0)
        assert result.zone is MaritimeZone.AMBIGUOUS
        assert "schema validation" in (result.reason or "")

    def test_a_hole_excludes_the_point(self, all_installed) -> None:
        # A polygon with an interior ring: the hole is not the zone.
        payload = {
            "features": [
                {
                    "id": "EEZ-holed",
                    "zone": "EXCLUSIVE_ECONOMIC_ZONE",
                    "ring": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]],
                    "holes": [[[4.0, 4.0], [6.0, 4.0], [6.0, 6.0], [4.0, 6.0], [4.0, 4.0]]],
                }
            ]
        }
        install(all_installed, "marine_regions_eez", payload)
        assert classify_zone(all_installed, lon=1.0, lat=1.0).zone is (
            MaritimeZone.EXCLUSIVE_ECONOMIC_ZONE
        )
        assert classify_zone(all_installed, lon=5.0, lat=5.0).zone is not (
            MaritimeZone.EXCLUSIVE_ECONOMIC_ZONE
        )


# ===========================================================================
# Antimeridian
# ===========================================================================


class TestAntimeridianZones:
    @pytest.fixture()
    def wrap_dir(self, data_dir):
        install(data_dir, "marine_regions_eez", fx.wrap_eez_payload())
        return data_dir

    def test_point_east_of_the_seam_is_inside(self, wrap_dir) -> None:
        # 179.5E is inside a polygon drawn 179E..181E.
        result = classify_zone(wrap_dir, lon=179.5, lat=0.0)
        assert result.zone is MaritimeZone.EXCLUSIVE_ECONOMIC_ZONE
        assert result.feature_id == "EEZ-fixture-wrap"

    def test_point_west_of_the_seam_is_inside(self, wrap_dir) -> None:
        # -179.5E is the same polygon, 1.5 degrees away across the seam.
        result = classify_zone(wrap_dir, lon=-179.5, lat=0.0)
        assert result.zone is MaritimeZone.EXCLUSIVE_ECONOMIC_ZONE

    def test_the_far_side_of_the_world_is_outside(self, wrap_dir) -> None:
        # A naive west<east span test would accept this, which is why containment is
        # tested in continuous unwrapped space instead.
        assert classify_zone(wrap_dir, lon=0.0, lat=0.0).zone is not (
            MaritimeZone.EXCLUSIVE_ECONOMIC_ZONE
        )

    def test_containment_is_antisymmetric_across_the_seam(self, wrap_dir) -> None:
        east = classify_zone(wrap_dir, lon=179.5, lat=0.0)
        west = classify_zone(wrap_dir, lon=-179.5, lat=0.0)
        assert east.feature_id == west.feature_id == "EEZ-fixture-wrap"


# ===========================================================================
# Ports
# ===========================================================================


class TestNearestPort:
    def test_finds_the_nearest_and_its_distance(self, all_installed) -> None:
        result = nearest_port(all_installed, lon=100.6, lat=6.0)
        assert result.status is ContextStatus.AVAILABLE
        assert result.port_id == "WPI-FIX-0001"
        assert result.name == "FIXTURE PORT ALPHA"
        assert result.meters is not None and result.meters < 20_000, result.meters

    def test_uses_geodesic_distance(self, all_installed) -> None:
        assert nearest_port(all_installed, lon=100.6, lat=6.0).method is (
            DistanceMethod.GEODESIC_METER
        )

    def test_provenance_records_the_real_data_currency(self, all_installed) -> None:
        """
        §29: the currency must be visible.

        WPI is the 35th EDITION with a DATA CURRENCY of 2019-08-31. Confusing those two
        is how a 2019 dataset gets described as a current port database.
        """
        prov = nearest_port(all_installed, lon=100.6, lat=6.0).provenance
        assert prov is not None
        assert prov.version == "35th Edition"
        assert any("DATA CURRENCY 2019-08-31" in lim for lim in prov.limitations)

    def test_result_carries_an_explicit_no_intent_restriction(self, all_installed) -> None:
        """
        §32: proximity is not a destination.

        The restriction travels ON EVERY RESULT rather than living only in a
        limitation string, so it cannot be lost by a caller rendering the port name
        without its provenance.
        """
        result = nearest_port(all_installed, lon=100.6, lat=6.0)
        text = result.interpretation.lower()
        assert "not a destination" in text
        assert "intent" in text

    def test_no_field_suggests_destination_origin_or_intent(self, all_installed) -> None:
        result = nearest_port(all_installed, lon=100.6, lat=6.0)
        emitted = set(result.model_dump())
        for forbidden in ("destination", "origin", "intent", "heading_to", "port_call",
                          "arriving", "departing", "eta", "route"):
            assert forbidden not in emitted, forbidden

    def test_across_the_antimeridian(self, all_installed) -> None:
        # Two ports 1 degree apart straddling the seam; the nearer one must win by
        # actual distance rather than by longitude ordering.
        result = nearest_port(all_installed, lon=-179.7, lat=0.5)
        assert result.status is ContextStatus.AVAILABLE
        assert result.port_id in ("WPI-FIX-0003", "WPI-FIX-0004")
        assert result.meters is not None and result.meters < 100_000, result.meters

    def test_prefilter_does_not_discard_a_legitimate_candidate(self, all_installed) -> None:
        """
        §31: the earlier `_M_PER_DEG_LAT` defect dropped candidates SILENTLY.

        A candidate just inside the search radius must be found. That bug was a factor
        of ten, so a port 1.5 degrees away was excluded by a 500 km radius because
        1.5 > 0.45.
        """
        # 0.5 degrees from port BETA, searched with a radius that comfortably includes
        # it. Under the old constant this was the failing case.
        result = nearest_port(all_installed, lon=102.5, lat=1.0, max_radius_m=500_000)
        assert result.status is ContextStatus.AVAILABLE
        assert result.port_id == "WPI-FIX-0002"

    def test_high_latitude_prefilter_scales_with_latitude(self, data_dir) -> None:
        # At 80N one degree of longitude is ~19 km, so a degree-scale prefilter bound is
        # far too tight if it ignores latitude. A port 0.5 degrees east must be found.
        payload = {
            "ports": [{"id": "HIGH", "name": "HIGH LAT PORT", "lon": 10.5, "lat": 80.0}],
            "preprocessing_notes": [],
        }
        install(data_dir, "nga_world_port_index", payload)
        result = nearest_port(data_dir, lon=10.0, lat=80.0, max_radius_m=200_000)
        assert result.status is ContextStatus.AVAILABLE
        assert result.port_id == "HIGH"

    def test_beyond_the_radius_is_no_coverage_not_a_distant_port(self, all_installed) -> None:
        result = nearest_port(all_installed, lon=-60.0, lat=-30.0, max_radius_m=400_000)
        assert result.status is ContextStatus.NO_COVERAGE
        assert result.port_id is None
        assert result.meters is None
        assert result.searched_radius_m == 400_000

    def test_absent_ports_report_not_installed(self, data_dir) -> None:
        result = nearest_port(data_dir, lon=100.6, lat=6.0)
        assert result.status is ContextStatus.NOT_INSTALLED
        assert result.port_id is None


# ===========================================================================
# Bathymetry
# ===========================================================================


class TestBathymetry:
    def test_samples_a_depth(self, all_installed) -> None:
        # Centre cell of the first row is -200 m.
        result = sample_bathymetry(all_installed, lon=101.0, lat=7.0)
        assert result.status is ContextStatus.AVAILABLE
        assert result.meters == -200

    def test_negative_sign_is_preserved(self, all_installed) -> None:
        # A sounding reported positive would invert the meaning of the sea.
        assert (sample_bathymetry(all_installed, lon=101.0, lat=7.0).meters or 0) < 0

    def test_no_data_is_never_zero_metres(self, all_installed) -> None:
        """
        §39. The middle cell of row two is genuinely no-data (land).

        Rendering it as `0 m` would fabricate a sounding, and 0 m is a real value
        elsewhere in the grid -- so it cannot even be distinguished from a measurement.
        """
        result = sample_bathymetry(all_installed, lon=101.0, lat=6.0)
        assert result.status is ContextStatus.NO_COVERAGE
        assert result.meters is None
        assert "no value" in result.detail

    def test_outside_the_grid_is_no_coverage(self, all_installed) -> None:
        result = sample_bathymetry(all_installed, lon=150.0, lat=0.0)
        assert result.status is ContextStatus.NO_COVERAGE
        assert "outside" in result.detail

    def test_precision_is_bounded_by_the_grid(self, all_installed) -> None:
        # A 1-degree fixture cell is far coarser than GEBCO's 15 arc-seconds, but the
        # rule is the same: whole metres, and the resolution travels with the value.
        result = sample_bathymetry(all_installed, lon=101.0, lat=7.0)
        assert result.resolution_deg == 1.0
        assert result.meters == int(result.meters)

    def test_resolution_and_version_are_reported(self, all_installed) -> None:
        result = sample_bathymetry(all_installed, lon=101.0, lat=7.0)
        assert result.provenance is not None
        assert result.provenance.version == "2025"
        assert "27.3%" in result.provenance.coverage_note
        assert any("NOT FOR NAVIGATION" in lim for lim in result.provenance.limitations)

    def test_source_type_is_reported_not_invented(self, all_installed) -> None:
        # The dataset's own code, passed through. Never synthesised.
        assert sample_bathymetry(all_installed, lon=101.0, lat=7.0).source_type == "measured"
        assert sample_bathymetry(all_installed, lon=102.0, lat=5.0).source_type == "predicted"

    def test_absent_grid_is_not_installed_and_never_zero(self, data_dir) -> None:
        result = sample_bathymetry(data_dir, lon=101.0, lat=7.0)
        assert result.status is ContextStatus.NOT_INSTALLED
        assert result.meters is None

    def test_a_cell_count_mismatch_is_failed(self, all_installed) -> None:
        # Declaring 3x3 while carrying nine values is fine; declaring a different size
        # is an ingestion fault and must not index into the wrong cell.
        install(
            all_installed,
            "gebco_2025",
            {
                "origin_lon": 0.0, "origin_lat": 0.0, "step_lon": 1.0, "step_lat": 1.0,
                "n_cols": 4, "n_rows": 4, "values": [-1.0] * 9, "preprocessing_notes": [],
            },
        )
        result = sample_bathymetry(all_installed, lon=0.5, lat=0.5)
        assert result.status is ContextStatus.FAILED
        assert "declares" in result.detail

    def test_row_order_north_to_south(self, all_installed) -> None:
        # A negative step_lat means north to south. Reading it backwards would mirror
        # the grid about the equator and return the wrong depth entirely.
        #
        # The fixture grid is row-major, north to south:
        #   row 0 (lat 7): -100  -200  -300
        #   row 1 (lat 6): -150   None  -250
        #   row 2 (lat 5): -400  -500  -600
        assert sample_bathymetry(all_installed, lon=101.0, lat=7.0).meters == -200
        assert sample_bathymetry(all_installed, lon=100.0, lat=5.0).meters == -400
        assert sample_bathymetry(all_installed, lon=102.0, lat=5.0).meters == -600

    def test_a_positive_step_lat_is_also_handled(self, data_dir) -> None:
        # Some prepared grids run south to north. The sampler must not assume the sign,
        # or half of all grids would return mirrored values.
        install(data_dir, "gebco_2025", {
            "origin_lon": 0.0, "origin_lat": 5.0, "step_lon": 1.0, "step_lat": 1.0,
            "n_cols": 1, "n_rows": 3, "values": [-100.0, -200.0, -300.0],
            "preprocessing_notes": [],
        })
        assert sample_bathymetry(data_dir, lon=0.0, lat=5.0).meters == -100
        assert sample_bathymetry(data_dir, lon=0.0, lat=7.0).meters == -300


# ===========================================================================
# Containment cross-check
# ===========================================================================


class TestContainmentCrossCheck:
    """
    shapely is the production path; this pure-python implementation exists so the two
    can be compared. If they disagree, one of them is wrong and the tests say which.
    """

    def test_agrees_with_shapely_on_the_fixture_square(self) -> None:
        shapely = pytest.importorskip("shapely.geometry")
        from shapely.geometry import Polygon

        ring = fx.EEZ_SQUARE
        polygon = Polygon([(x, y) for x, y in ring[:-1]])
        # `covers`, not `contains`. Ray casting INCLUDES the boundary; shapely's
        # `contains` EXCLUDES it. Comparing against `contains` reported a disagreement
        # at a ring vertex -- and that disagreement is a difference in boundary
        # convention, not a bug in either implementation. `covers` is the matching
        # semantics, and the fixture deliberately probes the corner so the convention
        # stays visible rather than being discovered later.
        for lon, lat in [(101.0, 6.0), (100.0, 5.0), (103.0, 9.0), (99.0, 6.0)]:
            mine = point_in_polygon(lon, lat, [ring])
            theirs = polygon.covers(shapely.Point(lon, lat))
            assert mine == theirs, f"disagreement at {lon},{lat}: {mine} vs {theirs}"

    def test_boundary_convention_is_documented_by_being_probed(self, all_installed) -> None:
        # A point exactly on the boundary is INSIDE under our semantics. That is
        # recorded deliberately: a vessel exactly on an EEZ line is a real case, and
        # the choice must be stated rather than accidental.
        assert point_in_polygon(100.0, 5.0, [fx.EEZ_SQUARE]) is True
        assert classify_zone(all_installed, lon=100.0, lat=5.0).established is True

    def test_agrees_with_shapely_across_the_antimeridian(self) -> None:
        shapely = pytest.importorskip("shapely.geometry")
        from shapely.geometry import Polygon

        ring = fx.EEZ_WRAP_SQUARE
        # Shapely wants unwrapped coords for the polygon, exactly as our containment
        # does internally.
        polygon = Polygon([(x if x >= 0 else x + 360.0, y) for x, y in ring[:-1]])
        for lon, lat in [(179.5, 0.0), (-179.5, 0.0), (0.0, 0.0)]:
            mine = point_in_polygon(lon, lat, [ring])
            probe = lon if lon >= 0 else lon + 360.0
            theirs = polygon.covers(shapely.Point(probe, lat))
            assert mine == theirs, f"disagreement at {lon},{lat}: {mine} vs {theirs}"

    def test_degenerate_input_is_none_not_false(self) -> None:
        # "This polygon is malformed" and "this point is outside it" must not collapse:
        # the first is a data fault worth reporting, the second is an ordinary answer.
        assert point_in_polygon(0.0, 0.0, []) is None
        assert point_in_polygon(0.0, 0.0, [[(0.0, 0.0)]]) is None