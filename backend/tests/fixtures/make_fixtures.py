"""Deterministic Sentinel-shaped fixture COGs for offline verification (SAR-112).

Two rasters + one unreferenced + one GCP-tagged control. Seeded RNG.
Sidecar JSON records vessel PIXEL positions; tests hand-compute expectations.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import Affine

FIXTURE_DIR = Path(__file__).parent / "cog"
RNG = np.random.default_rng(20261001)

SIZE = 400
VESSELS_PX = [(120, 200), (250, 300), (310, 150)]  # (row, col) bright clusters
LAND_ROWS = 60


def _ocean(shape: tuple[int, int]) -> np.ndarray:
    return (-21.0 + RNG.normal(0.0, 1.5, shape)).astype(np.float32)


def _paint(arr: np.ndarray) -> np.ndarray:
    out = arr.copy()
    out[:LAND_ROWS, :] = -8.0 + RNG.normal(0.0, 0.8, (LAND_ROWS, out.shape[1]))
    for r, c in VESSELS_PX:
        out[r - 1 : r + 2, c - 1 : c + 2] = 2.0 + RNG.normal(0.0, 0.3, (3, 3))
    return out.astype(np.float32)


def _write_cog(path: Path, arr: np.ndarray, *, crs: CRS | None, transform: Affine) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "count": 1,
        "width": arr.shape[1],
        "height": arr.shape[0],
        "tiled": True,
        "blockxsize": 128,
        "blockysize": 128,
        "compress": "deflate",
    }
    if crs is not None:
        profile["crs"] = crs
        profile["transform"] = transform
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr, 1)
        dst.build_overviews([2, 4], Resampling.average)
        dst.update_tags(ns="rio_overview", resampling="average")


def main() -> None:
    arr = _paint(_ocean((SIZE, SIZE)))

    # EPSG:4326 fixture, 0.0001 deg/px, origin (lon 103.80, lat 1.30) at NW corner
    t4326 = Affine(0.0001, 0.0, 103.80, 0.0, -0.0001, 1.30)
    _write_cog(FIXTURE_DIR / "fixture_4326.tif", arr, crs=CRS.from_epsg(4326), transform=t4326)

    # EPSG:32648 fixture, 10 m/px, origin (400000 E, 150000 N) at NW corner
    t32648 = Affine(10.0, 0.0, 400000.0, 0.0, -10.0, 150000.0)
    _write_cog(FIXTURE_DIR / "fixture_32648.tif", arr, crs=CRS.from_epsg(32648), transform=t32648)

    # Unreferenced control: same pixels, no CRS, identity transform
    _write_cog(
        FIXTURE_DIR / "fixture_unreferenced.tif",
        arr,
        crs=None,
        transform=Affine.identity(),
    )

    # GCP control: identity affine, no CRS, 4 corner GCPs in EPSG:4326
    from rasterio.control import GroundControlPoint

    gcps = [
        GroundControlPoint(row=0, col=0, x=103.80, y=1.30),
        GroundControlPoint(row=0, col=SIZE, x=103.84, y=1.30),
        GroundControlPoint(row=SIZE, col=0, x=103.80, y=1.26),
        GroundControlPoint(row=SIZE, col=SIZE, x=103.84, y=1.26),
    ]
    path = FIXTURE_DIR / "fixture_gcp.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        dtype="float32",
        count=1,
        width=SIZE,
        height=SIZE,
        tiled=True,
        compress="deflate",
        gcps=gcps,
        crs=CRS.from_epsg(4326),
    ) as dst:
        dst.write(arr, 1)

    sidecar = {
        "size": SIZE,
        "vessels_px": [{"row": r, "col": c} for r, c in VESSELS_PX],
        "land_rows": LAND_ROWS,
        "t4326": {"lon0": 103.80, "lat0": 1.30, "res": 0.0001},
        "t32648": {"x0": 400000.0, "y0": 150000.0, "res": 10.0},
    }
    (FIXTURE_DIR / "sidecar.json").write_text(json.dumps(sidecar, indent=1))
    print(f"wrote fixtures to {FIXTURE_DIR}")


if __name__ == "__main__":
    main()
