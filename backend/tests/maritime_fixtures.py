"""Deterministic reference-dataset fixtures, and the tests that read them.

THE FIXTURES ARE TEST DATA, NOT A RUNTIME FALLBACK

Every payload here is TINY and SYNTHETIC. There is no code path that falls back to a
fixture when a real dataset is absent -- absence returns
:attr:`ContextStatus.NOT_INSTALLED` and says so. A fake fallback would make the product
look like it has maritime context on a machine with no maritime data, which is the
opposite of the point (§75).

WHAT EACH FIXTURE PROVES

  EEZ square straddling the antimeridian   -- containment across the +-180 seam
  a second overlapping square               -- DISPUTED, with both names preserved
  an explicit HIGH_SEAS polygon             -- the high-seas rule needs it, not absence
  a coastline 1 degree away                 -- a MEASURED distance, not "near"
  ports either side of the seam              -- nearest-port across the wrap
  a grid with a genuine no-data cell         -- missing depth is not 0 m

NO NETWORK. Nothing here reads a publisher.
"""

from __future__ import annotations

from typing import Any

# A 2-degree square from 100E to 102E, 5N to 7N.
EEZ_SQUARE = [(100.0, 5.0), (102.0, 5.0), (102.0, 7.0), (100.0, 7.0), (100.0, 5.0)]

# Straddling the antimeridian: 179E to 181E expressed as -179.
EEZ_WRAP_SQUARE = [
    (179.0, -1.0),
    (-179.0, -1.0),
    (-179.0, 1.0),
    (179.0, 1.0),
    (179.0, -1.0),
]

# Overlaps EEZ_SQUARE on its eastern half.
EEZ_OVERLAP_SQUARE = [(101.0, 5.5), (103.0, 5.5), (103.0, 6.5), (101.0, 6.5), (101.0, 5.5)]

# A large explicit high-seas polygon, as Marine Regions ships separately.
HIGH_SEAS_POLYGON = [
    (-30.0, -10.0),
    (20.0, -10.0),
    (20.0, 10.0),
    (-30.0, 10.0),
    (-30.0, -10.0),
]


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
                    # Long segments on purpose: densification is what makes the
                    # distance correct, and a fixture of tiny segments would pass even
                    # if densification were removed.
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


def eez_payload(*, include_high_seas: bool = True, include_overlap: bool = False) -> dict[str, Any]:
    features: list[dict[str, Any]] = [
        {
            "id": "EEZ-fixture-alpha",
            "zone": "EXCLUSIVE_ECONOMIC_ZONE",
            "sovereign_names": ["FIXTURE ALPHA"],
            "ring": [list(p) for p in EEZ_SQUARE],
        }
    ]
    if include_high_seas:
        features.append(
            {
                "id": "HS-fixture",
                "zone": "HIGH_SEAS",
                "sovereign_names": [],
                "ring": [list(p) for p in HIGH_SEAS_POLYGON],
            }
        )
    if include_overlap:
        features.append(
            {
                "id": "EEZ-fixture-beta",
                "zone": "EXCLUSIVE_ECONOMIC_ZONE",
                # Two claimants, as a real disputed dataset records. Choosing one would
                # be DarkFleet asserting a sovereignty position it has no standing to
                # take.
                "sovereign_names": ["FIXTURE BETA", "FIXTURE GAMMA"],
                "dispute_note": "fixture overlap",
                "ring": [list(p) for p in EEZ_OVERLAP_SQUARE],
            }
        )
    return {"features": features, "preprocessing_notes": []}


def wrap_eez_payload() -> dict[str, Any]:
    """Only the antimeridian-straddling polygon, and NO high-seas polygon.

    So a query near +179/-179 has a zone to find while a query elsewhere must NOT be
    able to infer HIGH_SEAS from the absence of an EEZ.
    """
    return {
        "features": [
            {
                "id": "EEZ-fixture-wrap",
                "zone": "EXCLUSIVE_ECONOMIC_ZONE",
                "sovereign_names": ["FIXTURE WRAP"],
                "ring": [list(p) for p in EEZ_WRAP_SQUARE],
            }
        ],
        "preprocessing_notes": ["fixture: deliberately omits any HIGH_SEAS polygon"],
    }


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