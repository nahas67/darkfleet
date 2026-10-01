"""STAC provider implementations. Capability-based selection, no silent fallbacks."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx
import rasterio

from ..config.settings import settings
from . import Georeferencing, ProviderStatus, RealDataUnavailableError


@dataclass
class SarAsset:
    """One candidate SAR measurement asset with separately tracked capabilities."""

    provider: str
    collection: str
    item_id: str
    acquisition_time: str
    platform: str
    product: str
    polarization: str
    asset_href: str
    asset_roles: list[str] = field(default_factory=list)
    accessible: bool = False
    access_note: str = ""
    georeferencing: Georeferencing = Georeferencing.UNREFERENCED
    crs_wkt: str | None = None
    resolution_meters: float | None = None
    dtype: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def inspect_georeferencing(href: str) -> tuple[Georeferencing, dict[str, Any]]:
    """Classify an asset's georeferencing without reading pixel data.

    AFFINE: valid CRS + affine transform. GCP: usable ground control points.
    Anything else is UNREFERENCED and must fail loudly downstream.
    """
    try:
        with rasterio.open(href) as ds:
            info: dict[str, Any] = {
                "driver": ds.driver,
                "width": ds.width,
                "height": ds.height,
                "dtype": ds.dtypes[0] if ds.dtypes else None,
                "overviews": len(ds.overviews(1)) if ds.count >= 1 else 0,
                "gcp_count": len(ds.gcps[0]) if ds.gcps[0] else 0,
            }
            transform = ds.transform
            if ds.crs is not None and not transform.is_identity:
                info["crs"] = ds.crs.to_string()
                info["resolution"] = (abs(transform.a), abs(transform.e))
                return Georeferencing.AFFINE_GEOREFERENCED, info
            gcps, gcp_crs = ds.gcps
            if gcps:
                info["gcp_crs"] = gcp_crs.to_string() if gcp_crs else None
                return Georeferencing.GCP_GEOREFERENCED, info
            return Georeferencing.UNREFERENCED, info
    except OSError as exc:  # accessibility is a separate state; report, don't crash
        return Georeferencing.UNREFERENCED, {"access_error": str(exc)}


def stac_search(
    stac_url: str,
    collection: str,
    bbox: tuple[float, float, float, float],
    datetime_range: str,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Anonymous STAC search. Raises RealDataUnavailableError with the true cause."""
    try:
        resp = httpx.post(
            f"{stac_url.rstrip('/')}/search",
            json={
                "collections": [collection],
                "bbox": list(bbox),
                "datetime": datetime_range,
                "limit": limit,
                "sortby": [{"field": "properties.datetime", "direction": "desc"}],
            },
            timeout=40,
        )
    except httpx.HTTPError as exc:
        raise RealDataUnavailableError(
            f"STAC endpoint unreachable: {stac_url}",
            details={"provider": stac_url, "error": str(exc)},
        ) from exc
    if resp.status_code in (401, 403):
        raise RealDataUnavailableError(
            "STAC search requires authentication.",
            details={"provider": stac_url, "http": resp.status_code},
            suggestions=["Provide credentials for this STAC catalog."],
        )
    if resp.status_code == 400:
        # Wrong collection ID or bad query — not an auth problem. Say so precisely.
        raise RealDataUnavailableError(
            "STAC search rejected the query (unknown collection or bad parameters).",
            details={"provider": stac_url, "http": 400, "body": resp.text[:500]},
            suggestions=["Verify the collection ID against /collections."],
        )
    if resp.status_code == 429:
        raise RealDataUnavailableError(
            "STAC provider rate-limited this search.",
            details={"provider": stac_url, "http": 429},
            suggestions=["Retry with backoff."],
        )
    if resp.status_code != 200:
        raise RealDataUnavailableError(
            f"STAC search failed with HTTP {resp.status_code}.",
            details={"provider": stac_url, "http": resp.status_code},
        )
    data = resp.json()
    features: list[dict[str, Any]] = data.get("features", [])
    return features


def _pc_sign_href(href: str) -> str:
    """Append a Planetary Computer SAS token. The token endpoint is tried
    anonymously first; a 401/403 there means credentials are genuinely needed."""
    parsed = urlparse(href)
    host_parts = parsed.netloc.split(".blob.core.windows.net")
    if not host_parts or len(host_parts) < 2:
        return href  # not a PC blob URL; return unsigned
    account = host_parts[0]
    container = parsed.path.lstrip("/").split("/", 1)[0]
    token_url = f"{settings.pc.sas_token_url.rstrip('/')}/{account}/{container}"
    try:
        resp = httpx.get(token_url, timeout=20)
    except httpx.HTTPError as exc:
        raise RealDataUnavailableError(
            "Planetary Computer SAS token endpoint unreachable.",
            details={"token_url": token_url, "error": str(exc)},
        ) from exc
    if resp.status_code in (401, 403):
        raise RealDataUnavailableError(
            "Planetary Computer asset access now requires an account (SAS endpoint refused).",
            details={"token_url": token_url, "http": resp.status_code},
            suggestions=["Set PC credentials or use another provider."],
        )
    resp.raise_for_status()
    token = resp.json().get("token", "")
    sep = "&" if "?" in href else "?"
    return f"{href}{sep}{token}" if token else href


def _item_datetime(props: dict[str, Any]) -> str:
    return str(props.get("datetime") or props.get("start_datetime") or "")


def search_planetary_computer(
    bbox: tuple[float, float, float, float],
    datetime_range: str,
    product: str = "rtc",
    limit: int = 5,
) -> list[SarAsset]:
    """Search PC sentinel-1-rtc (analysis-ready, affine) or sentinel-1-grd."""
    collection = settings.pc.rtc_collection if product == "rtc" else settings.pc.grd_collection
    features = stac_search(settings.pc.stac_url, collection, bbox, datetime_range, limit)
    assets: list[SarAsset] = []
    for feat in features:
        props = feat.get("properties", {})
        for name in ("vv", "vh"):
            info = (feat.get("assets", {}) or {}).get(name)
            if not info or not info.get("href"):
                continue
            assets.append(
                SarAsset(
                    provider="planetary-computer",
                    collection=collection,
                    item_id=feat.get("id", ""),
                    acquisition_time=_item_datetime(props),
                    platform=str(props.get("platform", "sentinel-1")),
                    product="RTC" if product == "rtc" else "GRD",
                    polarization=name.upper(),
                    asset_href=info["href"],
                    asset_roles=list(info.get("roles", [])),
                )
            )
    return assets


def sign_planetary_computer_asset(asset: SarAsset) -> SarAsset:
    """Resolve SAS access for a PC asset; marks accessibility explicitly."""
    try:
        signed = _pc_sign_href(asset.asset_href)
        asset.extra["signed_href"] = signed
        asset.accessible = True
        asset.access_note = "SAS token appended"
    except RealDataUnavailableError as exc:
        asset.accessible = False
        asset.access_note = str(exc)
        raise
    return asset


def search_earthsearch_grd(
    bbox: tuple[float, float, float, float],
    datetime_range: str,
    limit: int = 5,
) -> list[SarAsset]:
    """Search EarthSearch sentinel-1-grd. Assets are public S3 but GCP-referenced:
    usable only through the GCP warp path, never as affine rasters."""
    features = stac_search(
        settings.earthsearch.stac_url, settings.earthsearch.grd_collection, bbox, datetime_range, limit
    )
    assets: list[SarAsset] = []
    for feat in features:
        props = feat.get("properties", {})
        for name in ("vv", "vh"):
            info = (feat.get("assets", {}) or {}).get(name)
            if not info or not info.get("href"):
                continue
            assets.append(
                SarAsset(
                    provider="earthsearch",
                    collection=settings.earthsearch.grd_collection,
                    item_id=feat.get("id", ""),
                    acquisition_time=_item_datetime(props),
                    platform=str(props.get("platform", "sentinel-1")),
                    product="GRD",
                    polarization=name.upper(),
                    asset_href=info["href"],
                    asset_roles=list(info.get("roles", [])),
                    accessible=True,  # public S3 bucket
                    access_note="public S3, unsigned reads allowed",
                )
            )
    return assets


def cdse_sentinel1_status() -> tuple[ProviderStatus, str]:
    """CDSE STAC carries no Sentinel-1 collections (verified: 10 IDs, ccm-*/clms_*
    only). Discovery is anonymous; S-1 is absent — that is BLOCKED, not auth."""
    try:
        resp = httpx.get(f"{settings.cdse.stac_url.rstrip('/')}/collections", timeout=30)
        resp.raise_for_status()
        ids = [c.get("id", "") for c in resp.json().get("collections", [])]
    except httpx.HTTPError as exc:
        return ProviderStatus.UNAVAILABLE, f"CDSE STAC unreachable: {exc}"
    s1 = [i for i in ids if "sentinel-1" in i.lower()]
    if not s1:
        return (
            ProviderStatus.UNAVAILABLE,
            (
                "CDSE STAC publishes no Sentinel-1 collections "
                f"({len(ids)} collections: {', '.join(ids[:10])})."
            ),
        )
    return ProviderStatus.AVAILABLE, f"Sentinel-1 collections present: {', '.join(s1)}"
