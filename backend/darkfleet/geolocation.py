"""Pixel -> WGS84 geolocation for SAR detections (GEO-CORR).

Why this module exists
----------------------
Detection coordinates used to be produced by interpolating linearly across the
REQUESTED AOI::

    lon = min_lon + (x / width) * (max_lon - min_lon)
    lat = max_lat - (y / height) * (max_lat - min_lat)

That is only correct when the window read exactly fills the AOI in the source
CRS. It generally does not: a window can be clamped to the raster's own extent,
or the AOI can extend past it. Measured on the committed fixture, the raster
covered latitude 1.32075..1.35693 while the requested AOI covered
1.35690..1.39310 -- so every detection was placed ~4 km north of where it
actually was, by a constant offset. Longitude happened to survive because the
longitude extents coincided, which is why the defect stayed invisible.

Because AIS correlation scores every candidate on distance offset, a constant
displacement of the SAR point invalidates the spatial score, the dynamic match
radius, the composite score and therefore the association itself, while still
producing plausible-looking numbers.

This module is the ONLY place that converts a pixel position to a coordinate.
:mod:`darkfleet.correlation.match` consumes the resulting geographic position and
never inspects a raster.

Pixel-centre semantics
----------------------
Sample ``i`` of an array is at index ``i``. Rasterio's
``transform.xy(t, row, col, offset="center")`` -- the authoritative definition of a
pixel centre -- evaluates ``t * (col + 0.5, row + 0.5)``. So a centroid expressed
in sample-index space maps to the ground as ``t * (cx + 0.5, cy + 0.5)``.

Verified empirically against rasterio itself in ``tests/test_geolocation.py``,
which asserts equality with ``ds.xy(...)`` rather than with a hand-copied copy
of rasterio's arithmetic. Getting this wrong by the half-pixel shifts every
detection by 5 m at 10 m spacing -- invisible on a chart, material in a match
radius.

Window transform, not scene transform
-------------------------------------
Callers MUST pass the transform of the window that was actually read. A full
scene transform places every detection outside the scene whenever the window has
a non-zero offset, which is the common case for an AOI that does not start at
the tile origin. :func:`assert_window_consistency` exists to make that mistake
loud.

Uncertainty
-----------
:func:`geolocation_uncertainty_m` states what the source actually supports. For an
affine-georeferenced product with a known pixel spacing the geolocation precision
is bounded by that spacing; the value returned is a documented fraction of it,
not a claim of sub-pixel accuracy. It is deliberately conservative because it
feeds a match radius, where understating uncertainty widens false associations.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any, Protocol, cast

#: Fraction of one pixel used as the geolocation uncertainty for an affine
#: product. 0.5 px is the classic half-pixel geolocation budget for a
#: well-registered product; it is an UPPER bound, not a measured error, and the
#: caller is told so.
DEFAULT_UNCERTAINTY_PIXELS = 0.5


class GeoreferenceError(Exception):
    """The pixel-to-ground mapping is unknown or unusable.

    Raised rather than falling back to an assumed extent. A detection placed
    without a real transform is a plausible-looking fiction, which is the one
    failure mode this module exists to prevent.

    ``detail`` carries the measured values that produced the refusal, so the
    error is self-explaining in an evidence record rather than needing a
    reproduction to interpret.
    """

    def __init__(self, message: str, **detail: Any) -> None:
        super().__init__(message)
        self.detail: dict[str, Any] = detail


class AffineLike(Protocol):
    """The subset of ``rasterio.Affine`` this module uses."""

    a: float
    b: float
    c: float
    d: float
    e: float
    f: float

    def __matmul__(self, other: tuple[float, float]) -> tuple[float, float]: ...


class TransformerLike(Protocol):
    def transform(self, x: float, y: float) -> tuple[float, float]: ...


def affine_from_sequence(values: Sequence[float]) -> AffineLike:
    """Build a transform from the 6-element form stored in the scan record.

    Uses rasterio's own Affine rather than reimplementing ``a*col + b*row + c``,
    so the arithmetic here is the same object the reader used to write the file.
    """
    if not values or len(values) != 6:
        raise GeoreferenceError(
            f"expected a 6-element affine transform, got {values!r}",
            transform=list(values) if values else None,
        )
    from rasterio.transform import Affine

    return cast("AffineLike", Affine(*(float(v) for v in values)))


def transform_wgs84(crs: str) -> TransformerLike:
    """A WGS84 transformer for a CRS string, with XY (lon/lat) axis order.

    ``always_xy=True`` is mandatory and not optional: without it, GDAL applies
    the authority's axis order, which for EPSG:4326 means latitude first. The
    result is a silent swap of the two coordinates -- a detection in the Gulf of
    Guinea and one in the Gulf of Guinea's true antipode are equally plausible,
    so nothing downstream would notice.
    """
    if not crs:
        raise GeoreferenceError("no CRS supplied; cannot reproject a pixel to lon/lat", crs=crs)
    from pyproj import CRS, Transformer

    try:
        src = CRS.from_user_input(crs)
    except Exception as exc:
        raise GeoreferenceError(f"unusable CRS {crs!r}", crs=crs) from exc
    return Transformer.from_crs(src, CRS.from_epsg(4326), always_xy=True)


def pixel_to_wgs84(
    col: float,
    row: float,
    *,
    transform: AffineLike,
    to_wgs84: TransformerLike,
    centre_offset: float = 0.5,
) -> tuple[float, float]:
    """One array-index position -> ``(lat, lon)``.

    ``centre_offset`` is the +0.5 that converts a sample index into the index of
    that sample's centre, matching ``rasterio.transform.xy(offset="center")``.
    """
    if not (math.isfinite(col) and math.isfinite(row)):
        raise GeoreferenceError(
            f"non-finite pixel position (col={col}, row={row}); refusing to place it",
            col=col,
            row=row,
        )
    x, y = transform @ (col + centre_offset, row + centre_offset)
    lon, lat = to_wgs84.transform(x, y)
    if not (math.isfinite(lon) and math.isfinite(lat)):
        raise GeoreferenceError(
            f"reprojecting pixel (col={col}, row={row}) produced a non-finite coordinate",
            col=col,
            row=row,
            x=x,
            y=y,
        )
    # Returned at FULL float precision, deliberately unrounded. An earlier draft
    # rounded to 7 dp (~1 cm); that is finer than any real geolocation, but it is
    # also coarser than this repository's own 1e-9 test tolerances, and rounding
    # would quietly discard the sub-pixel signal that GEO-CORR exists to preserve.
    # Presentation layers round; measurement layers do not.
    return float(lat), float(lon)


def geolocate_components(
    components: Sequence[dict[str, Any]],
    *,
    crs: str,
    transform: Sequence[float],
    centre_offset: float = 0.5,
    copy: bool = True,
) -> list[dict[str, Any]]:
    """Attach a measured geographic position to every component.

    Returns new dicts (unless ``copy`` is False) carrying, in addition to the
    original component fields:

    ``lat`` / ``lon``
        the measured position, at full float precision. The centroid is NOT
        rounded to a pixel index: sub-pixel positioning is real information the
        intensity-weighted centroid already computed.
    ``geo_source_transform``
        the 6-element transform used, so evidence can explain the coordinate.
    ``geo_crs``
        the CRS the transform is expressed in.
    ``geo_pixel_centroid``
        the exact sub-pixel position it came from.
    ``geo_centre_offset``
        the centre convention applied, so a reader can reproduce it.
    """
    affine = affine_from_sequence(transform)
    to_wgs84 = transform_wgs84(crs)
    out: list[dict[str, Any]] = []
    for comp in components:
        cx = comp.get("cx")
        cy = comp.get("cy")
        if cx is None or cy is None:
            raise GeoreferenceError(
                "component has no centroid (cx/cy); it cannot be geolocated",
                component_keys=sorted(str(k) for k in comp),
            )
        lat, lon = pixel_to_wgs84(
            float(cx), float(cy), transform=affine, to_wgs84=to_wgs84, centre_offset=centre_offset
        )
        record = dict(comp) if copy else comp
        record["lat"] = lat
        record["lon"] = lon
        record["geo_source_transform"] = [float(v) for v in transform]
        record["geo_crs"] = crs
        record["geo_pixel_centroid"] = [float(cx), float(cy)]
        record["geo_centre_offset"] = float(centre_offset)
        out.append(record)
    return out


def assert_window_consistency(
    *,
    scene_transform: Sequence[float] | None,
    window: Sequence[int] | None,
    window_transform: Sequence[float] | None,
    pixel_size: float | None = None,
) -> None:
    """Raise when a window transform does not match the scene transform + offset.

    The affine composition is exact::

        window_transform = scene_transform * Affine.translation(col_off, row_off)

    Checking it costs nothing and catches the failure that produces detections
    outside the scene by thousands of pixels: passing the SCENE transform where
    the WINDOW transform was required.
    """
    if scene_transform is None or window is None or window_transform is None:
        return
    scene = affine_from_sequence(scene_transform)
    col_off, row_off = float(window[0]), float(window[1])
    from rasterio.transform import Affine

    expected = scene @ Affine.translation(col_off, row_off)
    actual = affine_from_sequence(window_transform)
    if not (
        math.isclose(expected.a, actual.a, rel_tol=0, abs_tol=1e-6)
        and math.isclose(expected.e, actual.e, rel_tol=0, abs_tol=1e-6)
        and math.isclose(expected.c, actual.c, rel_tol=0, abs_tol=1e-3)
        and math.isclose(expected.f, actual.f, rel_tol=0, abs_tol=1e-3)
    ):
        raise GeoreferenceError(
            "window transform does not match scene transform composed with the "
            "window offset; geolocating with it would place detections outside "
            "the read window",
            scene_transform=list(scene_transform),
            window=list(window),
            expected_window_transform=[expected.a, expected.b, expected.c, expected.d, expected.e, expected.f],
            supplied_window_transform=list(window_transform),
        )


def geolocation_uncertainty_m(
    *,
    resolution_m: float | None,
    georeferencing: str,
    uncertainty_pixels: float = DEFAULT_UNCERTAINTY_PIXELS,
) -> float | None:
    """How precisely this product places a target on the ground, in metres.

    Returns ``None`` when the product does not support a statement, so the caller
    renders "not established" instead of a number. It never returns a value finer
    than the source can justify: for an affine product the floor is the pixel
    spacing, and for anything else there is no defensible figure.
    """
    if georeferencing != "AFFINE_GEOREFERENCED":
        # GCP or unreferenced: the reprojection adds error this module cannot
        # quantify, and inventing a figure would overstate the product.
        return None
    if resolution_m is None or not math.isfinite(resolution_m) or resolution_m <= 0:
        return None
    return float(resolution_m) * float(uncertainty_pixels)


__all__ = [
    "DEFAULT_UNCERTAINTY_PIXELS",
    "AffineLike",
    "GeoreferenceError",
    "TransformerLike",
    "affine_from_sequence",
    "assert_window_consistency",
    "geolocate_components",
    "geolocation_uncertainty_m",
    "pixel_to_wgs84",
    "transform_wgs84",
]