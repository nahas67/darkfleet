"""Deterministic reference-dataset fixtures, and the tests that read them.

THE FIXTURES ARE TEST DATA, NOT A RUNTIME FALLBACK

Every payload here is TINY and SYNTHETIC. There is no code path that falls back to a
fixture when a real dataset is absent -- absence returns
:attr:`ContextStatus.NOT_INSTALLED` and says so. A fake fallback would make the product
look like it has maritime context on a machine with no maritime data, which is the
opposite of the point.

SHAPE MATCHES THE REAL PREPARER

These use the same field names and the same MULTI-PART structure that
``tools/snapshot_services.py`` emits from the live WFS: ``parts`` rather than a single
``ring``, plus ``mrgid_eez``. A fixture with a different shape than production is a
fixture that passes while the real payload is broken -- which is exactly what happened
when the first ZoneFeature model was missing ``mrgid_eez`` and 285 real features were
rejected by ``extra="forbid"``.

WHAT EACH FIXTURE PROVES

  EEZ square straddling the antimeridian   -- containment across the +-180 seam
  a second overlapping square               -- DISPUTED, with every claimant preserved
  a SEPARATE high-seas dataset              -- high seas measured, not inferred
  a coastline 1 degree away                 -- a MEASURED distance, not "near"
  a grid with a genuine no-data cell         -- missing depth is not 0 m

NO NETWORK. Nothing here reads a publisher.
"""

from __future__ import annotations

from typing import Any

#: A 2-degree square from 100E to 102E, 5N to 7N.
EEZ_SQUARE = [(100.0, 5.0), (102.0, 5.0), (102.0, 7.0), (100.0, 7.0), (100.0, 5.0)]

#: Straddling the antimeridian: 179E to 181E expressed as -179.
EEZ_WRAP_SQUARE = [
    (179.0, -1.0),
    (-179.0, -1.0),
    (-179.0, 1.0),
    (179.0, 1.0),
    (179.0, -1.0),
]

#: Overlaps EEZ_SQUARE on its eastern half.
EEZ_OVERLAP_SQUARE = [
    (101.0, 5.5), (103.0, 5.5), (103.0, 6.5), (101.0, 6.5), (101.0, 5.5)
]

#: A large explicit high-seas polygon. The live service ships ONE feature with 21 parts;
#: two parts here is enough to prove multi-part high-seas geometry is handled.
HIGH_SEAS_POLYGONS = [
    [(-30.0, -10.0), (20.0, -10.0), (20.0, 10.0), (-30.0, 10.0), (-30.0, -10.0)],
    [(100.0, -10.0), (130.0, -10.0), (130.0, 10.0), (100.0, 10.0), (100.0, -10.0)],
]

#: The dataset ids the context service actually reads. The bulk EEZ product is NOT
#: installed -- it sits behind a registration form -- so the WFS snapshot ids are the
#: live ones, and the fixtures must target those or the tests prove nothing.
EEZ_ID = "marine_regions_eez_wfs"
HIGH_SEAS_ID = "marine_regions_high_seas_wfs"
COAST_ID = "natural_earth_coastline"
PORTS_ID = "nga_world_port_index"
BATHY_ID = "gebco_2025"


def _feature(
    feature_id: str,
    zone: str,
    ring: list[tuple[float, float]],
    **extra: Any,
) -> dict[str, Any]:
    """One prepared ZoneFeature, in the exact shape the live preparer emits."""
    return {
        "id": feature_id,
        "zone": zone,
        "sovereign_names": extra.get("sovereign_names", ()),
        "territory_names": extra.get("territory_names", ()),
        "pol_type": extra.get("pol_type"),
        "geoname": extra.get("geoname"),
        "area_km2": extra.get("area_km2"),
        "mrgid_eez": extra.get("mrgid_eez"),
        "source": extra.get("source"),
        "dispute_note": extra.get("dispute_note"),
        # MULTI-PART, matching the live product. A single `ring` would not exercise the
        # path that detached island blocks actually take.
        "parts": [[list(point) for point in ring]],
        "holes": (),
    }


def coastline_payload() -> dict[str, Any]:
    """A coastline running north-south at about 99E, plus one far away.

    The far line exists so an OUT_OF_RANGE case is reachable: a fixture with only the
    near line could not distinguish "measured" from "found nothing".
    """
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"id": "fixture-coast-a"},
                "geometry": {
                    "type": "LineString",
                    # Long segments on purpose: densification is what makes the distance
                    # correct, and a fixture of tiny segments would pass even if
                    # densification were removed.
                    "coordinates": [[99.0, 0.0], [99.0, 20.0]],
                },
            },
            {
                "type": "Feature",
                "properties": {"id": "fixture-coast-b"},
                "geometry": {
                    "type": "MultiLineString",
                    "coordinates": [[[-70.0, 40.0], [-68.0, 42.0]]],
                },
            },
        ],
    }


def eez_payload(*, include_overlap: bool = False) -> dict[str, Any]:
    """EEZ features ONLY.

    High seas is a SEPARATE dataset, matching the real service: Marine Regions publishes
    ``MarineRegions:eez`` and ``MarineRegions:high_seas`` as distinct layers. Folding them
    together would hide the whole point -- that high seas is answered by its own explicit
    geometry rather than by the absence of an EEZ.
    """
    features = [
        _feature(
            "EEZ-fixture-alpha", "EXCLUSIVE_ECONOMIC_ZONE", EEZ_SQUARE,
            sovereign_names=("FIXTURE ALPHA",), territory_names=(),
            pol_type="200NM", geoname="FIXTURE ALPHA EEZ", area_km2=1000.0,
            mrgid_eez=1,
        )
    ]
    if include_overlap:
        features.append(
            _feature(
                "EEZ-fixture-beta", "EXCLUSIVE_ECONOMIC_ZONE", EEZ_OVERLAP_SQUARE,
                # Two claimants, as a real disputed dataset records. Choosing one would
                # be DarkFleet asserting a sovereignty position it has no standing to
                # take.
                sovereign_names=("FIXTURE BETA", "FIXTURE GAMMA"),
                territory_names=(),
                pol_type="200NM", geoname="FIXTURE BETA EEZ", area_km2=800.0,
                mrgid_eez=2, dispute_note="fixture overlap",
            )
        )
    return {"features": features, "preprocessing_notes": []}


def wrap_eez_payload() -> dict[str, Any]:
    """Only the antimeridian-straddling polygon.

    No high-seas feature here, and the high-seas dataset is NOT installed alongside it, so
    a query elsewhere must NOT be able to infer HIGH_SEAS from the absence of an EEZ.
    """
    return {
        "features": [
            _feature(
                "EEZ-fixture-wrap", "EXCLUSIVE_ECONOMIC_ZONE", EEZ_WRAP_SQUARE,
                sovereign_names=("FIXTURE WRAP",), pol_type="200NM",
                geoname="FIXTURE WRAP EEZ", mrgid_eez=3,
            )
        ],
        "preprocessing_notes": ["fixture: the high-seas dataset is deliberately absent"],
    }


def high_seas_payload() -> dict[str, Any]:
    """The explicit high-seas geometry, as its own dataset.

    Mirrors the live shape: one feature, multiple parts, carrying the publisher's own
    methodology pointer.
    """
    feature = _feature(
        "HS-fixture", "HIGH_SEAS", HIGH_SEAS_POLYGONS[0],
        geoname="High Seas", area_km2=222496418.0, mrgid_eez=63203,
        source="https://marineregions.org/eezmethodology.php",
    )
    feature["parts"] = [[list(point) for point in ring] for ring in HIGH_SEAS_POLYGONS]
    return {"features": [feature], "preprocessing_notes": []}


def high_seas_with_second_part_payload() -> dict[str, Any]:
    """High seas whose geometry does NOT contain the query point.

    Needed to prove that HIGH_SEAS is refused when the explicit geometry misses, rather
    than being granted because no EEZ matched.
    """
    payload = high_seas_payload()
    # Move the polygon far from the region under test.
    payload["features"][0]["parts"] = [
        [[list(p) for p in ring] for ring in [[(-170.0, -60.0), (-160.0, -60.0),
                                              (-160.0, -55.0), (-170.0, -55.0),
                                              (-170.0, -60.0)]]]
    ]
    return payload


def ports_payload() -> dict[str, Any]:
    return {
        "ports": [
            {
                "id": "WPI-FIX-0001",
                "name": "FIXTURE PORT ALPHA",
                "country": "FIXTURELAND",
                "lon": 100.5,
                "lat": 6.0,
                "harbor_type": "Harbor of refuge",
                "harbor_size": "Small",
                "facilities": "Cargo, fuel",
            },
            {
                "id": "WPI-FIX-0002",
                "name": "FIXTURE PORT BETA",
                "country": "FIXTURELAND",
                "lon": 103.0,
                "lat": 1.0,
            },
            {
                # Across the antimeridian from its neighbour at -179.5E.
                "id": "WPI-FIX-0003",
                "name": "FIXTURE PORT WRAP EAST",
                "country": "FIXTURELAND",
                "lon": 179.5,
                "lat": 0.5,
            },
            {
                "id": "WPI-FIX-0004",
                "name": "FIXTURE PORT WRAP WEST",
                "country": "FIXTURELAND",
                "lon": -179.5,
                "lat": 0.5,
            },
        ],
        "preprocessing_notes": [],
    }


def grid_payload(*, with_no_data: bool = True) -> dict[str, Any]:
    """A 3x3 grid, north to south, centred on cell centres.

    Row order is north-to-south because ``step_lat`` is negative; getting that backwards
    silently mirrors the map about the equator, which is why the origin and step signs
    are recorded explicitly rather than inferred.
    """
    values: list[float | None] = [-100.0, -200.0, -300.0]
    if with_no_data:
        # Middle cell of the second row: a genuine no-data cell, i.e. land.
        values += [-150.0, None, -250.0]
    else:
        values += [-150.0, -150.0, -250.0]
    values += [-400.0, -500.0, -600.0]
    return {
        "origin_lon": 100.0,
        "origin_lat": 7.0,
        "step_lon": 1.0,
        "step_lat": -1.0,
        "n_cols": 3,
        "n_rows": 3,
        "values": values,
        "source_types": ["measured", "measured", "measured",
                         "measured", None, "measured",
                         "interpolated", "interpolated", "predicted"],
        "preprocessing_notes": [],
    }