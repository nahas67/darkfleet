"""Vertical datum safety: never conflate geoid and ellipsoidal height (GEO-003).

Two different numbers are both called "altitude", and mixing them produces errors
of tens of metres that read as authoritative. This module exists so DarkFleet
cannot conflate them, and so every height it reports carries its datum.

The distinction
---------------
* **Ellipsoidal height** is measured from the WGS84 ellipsoid. GNSS and most
  satellite metadata report this.
* **Orthometric / geoid height** is measured from the geoid, the equipotential
  surface approximating mean sea level. A tide gauge measures this, and it is
  what "height above the sea" means to a mariner.
* They differ by the **geoid undulation** N, typically 30-60 m, and N is
  *negative* over much of the northern hemisphere, so the error's sign flips
  across the world. A conversion that ignores the sign is worse than none.

Why a SAR engine needs this
---------------------------
SAR measures a two-dimensional backscatter image. It does NOT measure height.
So DarkFleet must be explicit that it reports no vessel altitude at all, rather
than emitting a number that looks like one. The real hazard is a downstream
consumer pairing a detected footprint with a chart-datum height and reading the
difference as a measurement.

Undulation source
-----------------
Converting between datums needs the EGM2008 undulation grid, which this project
does **not** ship. Rather than depend on an ambiguous package (``geoid`` on PyPI
is a US Census geocoder, not the geoid library) or substitute zero, the undulation
is a pluggable provider that is absent by default:

* absent  -> the value is returned on its ORIGINAL datum, clearly labelled, and
  the caller is told no conversion happened;
* supplied -> the conversion is real.

An assumed zero is exactly the error this module exists to prevent, so it is never
substituted. ``from_undulation_provider`` lets a deployment that genuinely ships
a grid opt in without this module taking a dependency.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

#: Undulation provider: (lat, lon) -> N in metres, or None when unknown.
UndulationProvider = Callable[[float, float], float | None]

ELLIPSOID = "WGS84"
GEOID_MODEL = "EGM2008"

_provider: UndulationProvider | None = None


def set_undulation_provider(provider: UndulationProvider | None) -> None:
    """Install (or clear) the undulation source. None disables conversion."""
    # A single process-wide source is intended: one grid per deployment.
    global _provider
    _provider = provider


def has_undulation_provider() -> bool:
    return _provider is not None


def geoid_undulation_m(lat: float, lon: float) -> float | None:
    """Geoid undulation N in metres, or None when no source is installed.

    Positive N means the geoid sits ABOVE the ellipsoid, so for the same point
    the ellipsoidal height is the SMALLER of the two.
    """
    if _provider is None:
        return None
    try:
        value = _provider(float(lat), float(lon))
    except Exception:  # noqa: BLE001 - a broken grid must not become a height
        # A corrupt or unreadable grid is an unknown undulation, not an error the
        # caller can act on, and certainly not a value to invent.
        return None
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


@dataclass(frozen=True)
class VerticalDatum:
    """A height with the datum it is measured from. Never unlabelled."""

    value_m: float
    #: "EGM2008" for height above the geoid, "WGS84" for ellipsoidal.
    datum: str
    #: True when the value is on the geoid-referenced datum.
    geoid_referenced: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "value_m": self.value_m,
            "datum": self.datum,
            "geoid_referenced": self.geoid_referenced,
        }


def to_geoid_height(ellipsoidal_m: float, lat: float, lon: float) -> VerticalDatum:
    """Convert an ellipsoidal height to height above the geoid. H = h - N.

    With no undulation source the value is returned UNCHANGED and labelled
    ``WGS84``. It is never relabelled as a geoid height, and zero is never
    assumed for N.
    """
    n = geoid_undulation_m(lat, lon)
    if n is None:
        return VerticalDatum(float(ellipsoidal_m), ELLIPSOID, geoid_referenced=False)
    return VerticalDatum(float(ellipsoidal_m) - n, GEOID_MODEL, geoid_referenced=True)


def to_ellipsoidal_height(geoid_m: float, lat: float, lon: float) -> VerticalDatum:
    """Convert a height above the geoid to an ellipsoidal height. h = H + N."""
    n = geoid_undulation_m(lat, lon)
    if n is None:
        return VerticalDatum(float(geoid_m), GEOID_MODEL, geoid_referenced=True)
    return VerticalDatum(float(geoid_m) + n, ELLIPSOID, geoid_referenced=False)


def from_undulation_provider(
    provider: UndulationProvider,
    lat: float,
    lon: float,
) -> VerticalDatum:
    """Build a datum-tagged value using a caller-supplied undulation source."""
    set_undulation_provider(provider)
    try:
        return to_geoid_height(0.0, lat, lon)
    finally:
        set_undulation_provider(None)


def datum_note(lat: float, lon: float) -> str:
    """One line for a report caption, stating what this module cannot do here."""
    n = geoid_undulation_m(lat, lon)
    if n is None:
        return (
            "No geoid undulation source is installed, so heights are reported on the "
            f"{ELLIPSOID} ellipsoid and are NOT height above sea level. DarkFleet "
            "does not measure vessel altitude: SAR is a two-dimensional sensor."
        )
    return (
        f"Geoid undulation N = {n:.1f} m at this position; geoid and ellipsoidal "
        f"heights differ by {abs(n):.1f} m here."
    )


def describe_datum(lat: float, lon: float) -> dict[str, Any]:
    """Machine-readable datum context for an evidence record.

    ``altitude_measured: False`` is the load-bearing field. A consumer must not be
    able to read a detection's apparent size and infer a height from it.
    """
    n = geoid_undulation_m(lat, lon)
    return {
        "geoid_model": GEOID_MODEL,
        "ellipsoid": ELLIPSOID,
        "undulation_m": None if n is None else round(n, 2),
        "undulation_available": n is not None,
        # SAR does not measure height. Stated so no consumer infers one.
        "altitude_measured": False,
        "note": datum_note(lat, lon),
    }
