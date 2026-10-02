"""Vertical datum safety (GEO-003).

The assertions that matter are the refusals: without an undulation source, a
conversion must NOT happen and must NOT silently assume zero.
"""

from __future__ import annotations

import math

import pytest

from darkfleet.geoid import (
    ELLIPSOID,
    GEOID_MODEL,
    VerticalDatum,
    describe_datum,
    from_undulation_provider,
    geoid_undulation_m,
    has_undulation_provider,
    set_undulation_provider,
    to_ellipsoidal_height,
    to_geoid_height,
)

# Real EGM2008 undulations, approximate, at recognisable places.
SINGAPORE_N = -3.0  # geoid BELOW the ellipsoid here
NORTH_ATLANTIC_N = 47.0  # geoid ABOVE the ellipsoid here
ATLANTIC = (30.0, -40.0)
EQUATOR = (0.0, 0.0)


@pytest.fixture(autouse=True)
def _reset_provider() -> None:
    set_undulation_provider(None)
    yield
    set_undulation_provider(None)


# --------------------------------------------------------- no source present


def test_no_provider_means_no_undulation() -> None:
    assert has_undulation_provider() is False
    assert geoid_undulation_m(1.29, 103.85) is None


def test_conversion_is_refused_rather_than_assuming_zero() -> None:
    """The zero-substitution bug this module exists to prevent."""
    result = to_geoid_height(100.0, *ATLANTIC)
    assert result.value_m == 100.0, "the value must not move when N is unknown"
    assert result.datum == ELLIPSOID, "and must not be relabelled as a geoid height"
    assert result.geoid_referenced is False


def test_the_opposite_conversion_is_also_refused() -> None:
    result = to_ellipsoidal_height(100.0, *ATLANTIC)
    assert result.value_m == 100.0
    assert result.datum == GEOID_MODEL


def test_absence_is_stated_rather_than_left_implicit() -> None:
    note = describe_datum(1.29, 103.85)["note"]
    assert "NOT height above sea level" in note


# -------------------------------------------------------------- with a source


def test_negative_undulation_subtracts_the_right_way_round() -> None:
    """Over Singapore the geoid sits BELOW the ellipsoid, so H = h - N > h."""
    set_undulation_provider(lambda lat, lon: SINGAPORE_N)
    result = to_geoid_height(100.0, 1.29, 103.85)
    assert result.value_m == pytest.approx(103.0)
    assert result.datum == GEOID_MODEL
    assert result.geoid_referenced is True


def test_positive_undulation_subtracts_the_other_way_round() -> None:
    """Over the North Atlantic the geoid sits ABOVE the ellipsoid, so H < h."""
    set_undulation_provider(lambda lat, lon: NORTH_ATLANTIC_N)
    result = to_geoid_height(100.0, *ATLANTIC)
    assert result.value_m == pytest.approx(53.0)
    assert result.datum == GEOID_MODEL


def test_round_trip_is_exact_in_both_directions() -> None:
    set_undulation_provider(lambda lat, lon: SINGAPORE_N)
    to_sea = to_geoid_height(250.0, 1.29, 103.85)
    back = to_ellipsoidal_height(to_sea.value_m, 1.29, 103.85)
    assert back.value_m == pytest.approx(250.0)
    assert back.datum == ELLIPSOID


def test_undulation_sign_is_reported_not_just_its_magnitude() -> None:
    set_undulation_provider(lambda lat, lon: SINGAPORE_N)
    body = describe_datum(1.29, 103.85)
    assert body["undulation_m"] == pytest.approx(-3.0)
    assert body["undulation_available"] is True
    # -3.0 differs from 3.0; the note must not hide which side it is on.
    assert "-3.0 m" in body["note"]


# ---------------------------------------------------------------- robustness


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_non_finite_undulation_degrades_to_unknown(bad: float) -> None:
    set_undulation_provider(lambda lat, lon: bad)
    assert geoid_undulation_m(0.0, 0.0) is None
    assert to_geoid_height(100.0, *EQUATOR).datum == ELLIPSOID


def test_a_raising_provider_does_not_escape() -> None:
    def broken(lat: float, lon: float) -> float:
        raise RuntimeError("grid corrupt")

    set_undulation_provider(broken)
    # A provider failure must not become a fabricated height.
    assert to_geoid_height(100.0, *EQUATOR).value_m == 100.0


def test_from_undulation_provider_does_not_leak_state() -> None:
    """A one-shot provider must not stay installed."""
    value = from_undulation_provider(lambda lat, lon: SINGAPORE_N, 1.29, 103.85)
    assert value.value_m == pytest.approx(-SINGAPORE_N)
    assert has_undulation_provider() is False


def test_set_undulation_provider_clears() -> None:
    set_undulation_provider(lambda lat, lon: 10.0)
    assert has_undulation_provider() is True
    set_undulation_provider(None)
    assert has_undulation_provider() is False


# --------------------------------------------------------- the key statement


def test_sar_does_not_measure_altitude_and_says_so() -> None:
    """A consumer must not infer a height from an apparent footprint."""
    body = describe_datum(1.29, 103.85)
    assert body["altitude_measured"] is False
    assert "does not measure vessel altitude" in body["note"]


def test_datum_serialises() -> None:
    body = VerticalDatum(100.0, ELLIPSOID, geoid_referenced=False).to_dict()
    assert body == {"value_m": 100.0, "datum": ELLIPSOID, "geoid_referenced": False}
