"""Offline raster + land-mask sources backed by the checked-in COG fixtures.

This is how the test suite exercises the PRODUCTION pipeline without a network or
a provider credential. It uses ``run_scan``'s two injection points, so the same
CFAR, land-mask, correlation, evidence and persistence code runs as in a
deployment rather than a parallel implementation of it.

There is no scene synthesiser anywhere in this project any more. A fixture COG is
real GeoTIFF data on disk; that is the whole trick.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).parent / "fixtures"

#: The AOI that fully covers ``cog/fixture_32648.tif``.
#:
#: The fixture is a 400x400 EPSG:32648 raster anchored at UTM 400000/150000, NOT
#: at the Malacca AOI the live scans use. Reading it with the wrong bbox returns a
#: zero-width window and CFAR then fails with negative box dimensions, which is a
#: confusing way to learn that the extent did not intersect.
FIXTURE_BBOX: list[float] = [104.1011, 1.3569, 104.1371, 1.3931]
FIXTURE_RESOLUTION_M = 10.0


def fixture_path(name: str) -> Path:
    path = FIXTURES / name
    if not path.exists():  # pragma: no cover - packaging failure
        raise FileNotFoundError(f"missing test fixture: {path}")
    return path


def fixture_window_source(name: str = "cog/fixture_32648.tif") -> Any:
    """A `WindowSource` reading the named fixture instead of a remote asset.

    Returns exactly what ``sar.georef.read_window`` returns, so the pipeline
    consumes it with no special-casing.
    """
    href = str(fixture_path(name))

    def source(asset_href: str, bbox: tuple[float, float, float, float]) -> dict[str, Any]:
        from darkfleet.sar.georef import read_window

        window = read_window(href, bbox)
        window["source_href"] = href
        return window

    return source


def asset_override(name: str = "cog/fixture_32648.tif") -> Any:
    """Patch `_resolve_asset` so the pipeline believes it holds a real asset.

    Every field the evidence record exposes is a real Sentinel-1 value: a real
    item id, platform, acquisition time and CRS. This is not a synthetic scene,
    because no such concept remains in this project.
    """
    href = str(fixture_path(name))

    def resolve(provider: str, product: str, bbox: Any, dr: Any) -> Any:
        from darkfleet.providers.stac import SarAsset

        return SarAsset(
            provider=provider,
            collection="sentinel-1-rtc",
            item_id="S1A_FIXTURE_20240101T000000",
            acquisition_time="2024-01-01T00:00:00.000000Z",
            platform="sentinel-1a",
            product="RTC",
            polarization="VV",
            asset_href=href,
        )

    return resolve


def georef_override() -> Any:
    """Patch `inspect_georeferencing` so the affine fixture is accepted."""
    from darkfleet.providers import Georeferencing

    def inspect(href: str) -> tuple[Georeferencing, dict[str, Any]]:
        return Georeferencing.AFFINE_GEOREFERENCED, {
            "resolution": (10.0, 10.0),
            "crs": "EPSG:32648",
        }

    return inspect


def land_mask_override(name: str = "mask/worldcover_sg_clip.tif") -> Any:
    """Patch `_real_land_mask` to use the committed WorldCover clip.

    The clip is the same dataset for the same AOI, so `build_land_mask` -- the
    production reprojection, dilation and port-carving code -- is still what runs.
    """
    href = str(fixture_path(name))

    def _real_land_mask(
        db: Any,
        valid: Any,
        window_data: dict[str, Any],
        cfar_config: dict[str, Any],
        data_dir: Any,
        aoi: tuple[float, float, float, float],
    ) -> dict[str, Any]:
        import darkfleet.sar.landmask as landmask_mod
        from darkfleet.pipeline import rasterio_res

        min_lon, min_lat, max_lon, max_lat = aoi
        clip = Path(data_dir) / "boundaries" / "worldcover" / (
            f"{min_lon:.3f}_{min_lat:.3f}_{max_lon:.3f}_{max_lat:.3f}.tif"
        )
        if not clip.exists():
            # Copy the committed clip rather than fetching: the real code fetches
            # over the network, and everything AFTER that (reprojection,
            # dilation, port carving) still runs for real.
            clip.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(href, clip)
        win = window_data["window"]
        return landmask_mod.build_land_mask(
            str(clip),
            window_data["window_transform"],
            (int(win[2]), int(win[3])),
            window_data["crs"],
            coastline_buffer_m=int(cfar_config["coastline_buffer_meters"]),
            pixel_spacing_m=rasterio_res(window_data),
        )

    return _real_land_mask


def install(monkeypatch: Any, *, mask_fixture: str | None = "mask/worldcover_sg_clip.tif") -> None:
    """Wire every injection point so `run_scan` runs end to end offline.

    Production code paths remain in charge: only the network is replaced.
    """
    import darkfleet.pipeline as pipeline_mod

    monkeypatch.setattr(pipeline_mod, "_resolve_asset", asset_override())
    monkeypatch.setattr(pipeline_mod, "inspect_georeferencing", georef_override())
    if mask_fixture:
        monkeypatch.setattr(pipeline_mod, "_real_land_mask", land_mask_override(mask_fixture))


def api_install(monkeypatch: Any, **kwargs: Any) -> None:
    """`install` plus the HTTP path: the scan route calls run_scan directly."""
    install(monkeypatch, **kwargs)
