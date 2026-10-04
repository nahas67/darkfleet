"""The single authoritative scan pipeline.

Yields real (ScanStage, detail) transitions as work completes: no timers, no
invented percentages. Every stage runs for every scan, because there is only one
kind of scan. A provider that cannot serve the request raises
:class:`~darkfleet.providers.RealDataUnavailableError` rather than yielding
substitute pixels.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final

import numpy as np

from .ais.archive import AisArchive
from .correlation.match import correlate
from .evidence import build_provenance
from .geolocation import (
    assert_window_consistency,
    geolocate_components,
    geolocation_uncertainty_m,
)
from .observability import stage as log_stage
from .polarization import NOT_AVAILABLE
from .providers import Georeferencing, RealDataUnavailableError
from .providers.stac import (
    SarAsset,
    inspect_georeferencing,
    search_earthsearch_grd,
    search_planetary_computer,
    sign_planetary_computer_asset,
)
from .sar import landmask as landmask_mod
from .sar.cfar import run_ca_cfar
from .sar.components import extract_components
from .sar.georef import read_window
from .sar.polarization_channel import domain_for, for_scene_polarization
from .sar.preprocess import grd_branch, rtc_branch
from .sar.speckle import apply_speckle

StageCallback = Callable[[str, str], None]

#: Reads a georeferenced raster window. Swappable so a test can exercise the
#: PRODUCTION pipeline against a checked-in fixture, rather than a parallel
#: implementation of it. Defaults to the real reader, so a shipped deployment
#: cannot inject a substitute.
WindowSource = Callable[[str, tuple[float, float, float, float]], dict[str, Any]]

_KNOWN_PROVIDERS = frozenset({"planetary-computer", "earthsearch"})

#: How many candidates to consider when the operator pinned a specific scene.
#: A pinned scene is routinely not the first result of the unpinned query, so the
#: window is widened rather than taking whatever came back.
_PINNED_SCENE_SEARCH_LIMIT: Final[int] = 25

DEFAULT_CFAR: dict[str, Any] = {
    "training_cells": 16,
    "guard_cells": 4,
    "threshold_factor": 3.5,
    "coastline_buffer_meters": 150,
    "speckle_filter": "median",
    "kernel_size": 3,
    "min_pixels": 3,
    "max_pixels": 1000,
}


def merge_cfar_config(overrides: Mapping[str, Any] | None) -> dict[str, Any]:
    """Layer caller overrides over :data:`DEFAULT_CFAR`.

    This used to be ``dict(cfar_config or DEFAULT_CFAR)``, which *replaces* the
    defaults instead of merging them. Any partial payload therefore removed every
    key it did not mention, and the pipeline -- which subscripts these values
    directly rather than with ``.get`` -- then died on the first missing one::

        no cfar_config          -> COMPLETE  train=16 guard=4 alpha=3.5
        {"training_cells": 8}   -> FAILED    KeyError: 'coastline_buffer_meters'
        camelCase UI payload    -> FAILED    KeyError: 'coastline_buffer_meters'
        full snake_case         -> COMPLETE  train=32 guard=8 alpha=5.5

    That contradicted ``ScanCreateRequest.cfar_config``, which documents "unset
    keys keep pipeline defaults", and it made every CFAR control in the interface
    capable of destroying a run rather than configuring one.

    Merging is what that sentence always meant. Unknown keys are still carried
    through rather than dropped, so a typo is visible in the persisted config and
    its hash instead of being silently discarded; the request model is where an
    unknown key is now rejected outright.
    """
    return {**DEFAULT_CFAR, **dict(overrides or {})}


def config_hash(config: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:16]


def _class_counts(targets: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for t in targets:
        counts[t["cls"]] = counts.get(t["cls"], 0) + 1
    return counts



def _component_mask(
    comp: dict[str, Any], db: np.ndarray
) -> np.ndarray | None:
    """This component's own bright pixels, as a boolean mask over the window grid.

    The polarization statistics must describe the SAME component whose dossier is
    open, so the mask comes from this component's own extent and never from a
    nearest-target inference.

    It is NOT the whole bounding box. A 3x3 box around a 5-pixel hull contains 4
    pixels of open water at roughly -40 dB, so a box mask reports a mean some 40 dB
    below the component's own `meanDb` -- a statistic about a rectangle, presented
    as a statistic about a vessel. It also makes `p95_db` collapse onto `max_db`,
    because the 95th percentile of nine samples is the brightest of them.

    The selection is therefore thresholded at the midpoint between the component's
    own measured clutter floor and its own peak, both read from the component
    itself. The midpoint is used rather than the peak because a hull is not
    uniformly bright: its deck, its sides and its superstructure differ by several
    dB, and a peak threshold would select only the brightest sliver of the vessel.

    Returns None when the component has no usable extent, so the channel can report
    EMPTY_MASK explicitly rather than scoring an empty selection.
    """
    bbox = comp.get("bbox") or {}
    try:
        row0 = int(bbox["minY"])
        row1 = int(bbox["maxY"])
        col0 = int(bbox["minX"])
        col1 = int(bbox["maxX"])
    except (KeyError, TypeError, ValueError):
        return None

    height, width = db.shape[:2]
    rows = slice(max(0, row0), min(height, row1 + 1))
    cols = slice(max(0, col0), min(width, col1 + 1))
    if rows.start >= rows.stop or cols.start >= cols.stop:
        return None

    patch = np.asarray(db[rows, cols], dtype=np.float64)
    if patch.size == 0:
        return None

    mask = np.zeros(db.shape[:2], dtype=bool)
    try:
        clutter = float(comp["clutterMeanDb"])
        peak = float(comp["maxDb"])
    except (KeyError, TypeError, ValueError):
        # Without the component's own levels there is no defensible threshold, and
        # guessing one would put a tuned constant between the measurement and the
        # number it produces. Fall back to the bounding box and say so.
        mask[rows, cols] = True
        return mask

    cut = clutter + 0.5 * (peak - clutter)
    selected = np.isfinite(patch) & (patch >= cut)
    if not selected.any():
        # The component's peak is not present in the window we were handed, which
        # means this array is not the one the component was measured on. Selecting
        # the whole box would report numbers from the wrong array as though they
        # were this target's, so decline instead.
        return None
    mask[rows, cols] = selected
    return mask


def run_scan(
    *,
    bbox: list[float],
    data_dir: str | Path,
    cfar_config: dict[str, Any] | None = None,
    datetime_range: str | None = None,
    scene_id: str | None = None,
    provider: str = "planetary-computer",
    product: str = "rtc",
    on_stage: StageCallback | None = None,
    scan_id: str = "DF-0000",
    window_source: WindowSource | None = None,
) -> dict[str, Any]:
    """Execute one scan end to end and return the full evidence document.

    Every stage calls `on_stage(ScanStage, detail)` with MEASURED detail at the
    moment the work actually completes. No timers, no percentages, no invented
    numbers.

    There is no synthetic mode and no degraded path: a provider that cannot serve
    the request raises :class:`RealDataUnavailableError` rather than yielding
    fabricated pixels.

    ``window_source`` exists for the test suite. It is the ONLY injection point
    into the real path, so a test exercises the production code rather than a
    parallel implementation of it. It defaults to the real reader, so a shipped
    deployment cannot accidentally supply synthetic data through it.
    """
    cfar_config = merge_cfar_config(cfar_config)

    def emit(stage: str, detail: str) -> None:
        if on_stage is not None:
            on_stage(stage, detail)

    started = time.time()
    aoi: tuple[float, float, float, float] = (
        float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]),
    )
    if provider not in _KNOWN_PROVIDERS:
        raise RealDataUnavailableError(
            f"Unknown SAR provider {provider!r}.",
            details={"provider": provider, "known": sorted(_KNOWN_PROVIDERS)},
            suggestions=["Use planetary-computer or earthsearch."],
        )

    emit("QUEUED", f"scan {scan_id} queued")
    log_stage("SCAN", f"scan {scan_id} created")

    chash = config_hash(cfar_config)

    # ---- SCENE / ASSET -----------------------------------------------------
    emit("SEARCHING_SCENE", f"searching {provider} {product}")
    signed_href = ""

    asset: SarAsset = _resolve_asset(provider, product, aoi, datetime_range, scene_id)
    if provider == "planetary-computer":
        sign_planetary_computer_asset(asset)
    signed_href = str(asset.extra.get("signed_href", asset.asset_href))
    state, geo_info = inspect_georeferencing(signed_href)
    if state == Georeferencing.UNREFERENCED:
        raise RealDataUnavailableError(
            "Selected asset has no usable georeferencing.",
            details={"item_id": asset.item_id, "state": state.value},
        )
    # Persist the measured raster geometry; never leave it null when known.
    res = geo_info.get("resolution")
    asset.resolution_meters = float(res[0]) if res else None
    asset.crs_wkt = str(geo_info.get("crs") or "") or None
    emit("SEARCHING_SCENE", f"scene selected {asset.item_id}")
    log_stage("STAC", f"selected scene {asset.item_id}")

    #: Measured geometry of the window actually read, carried into provenance.
    #: Every value is measured, never defaulted.
    raster_meta: dict[str, Any]

    # ---- READ -------------------------------------------------------------
    emit("READING_SAR", "reading raster window")
    window_data = (window_source or read_window)(signed_href, aoi)
    assert window_data is not None and asset is not None
    arr = window_data["array"].astype(np.float64)
    valid = np.isfinite(arr)
    land = None
    raster_meta = {
        "provider": asset.provider, "collection": asset.collection, "item_id": asset.item_id,
        "platform": asset.platform, "acquisition_time": asset.acquisition_time,
        "product": asset.product, "polarization": asset.polarization,
        "asset_href": asset.asset_href, "crs": str(window_data["crs"]),
        "transform": list(window_data["window_transform"])[:6],
        "resolution_m": asset.resolution_meters, "raster_window": list(window_data["window"]),
    }
    log_stage("SAR", f"read {arr.shape[1]}x{arr.shape[0]} {asset.product} window")


    # ---- PREPROCESS -------------------------------------------------------
    emit("PREPROCESSING", f"calibration branch {raster_meta['product']}")
    if raster_meta["product"] == "RTC":
        out = rtc_branch(window_data["array"].astype(np.float64), window_data["nodata"])
        db, valid, branch = out["db"], out["valid"], "RTC"
    else:
        assert window_data is not None
        out = grd_branch(window_data["array"].astype(np.float64), window_data["nodata"], None)
        db, valid, branch = out["db"], out["valid"], "GRD"
    log_stage("SAR", f"preprocessed via {branch} branch")

    # ---- MASK -------------------------------------------------------------
    emit("MASKING", f"land mask buffer={cfar_config['coastline_buffer_meters']}m")
    land_mask_result = _real_land_mask(db, valid, window_data, cfar_config, data_dir, aoi)
    land = land_mask_result["excluded"]
    land_prov: dict[str, Any] = land_mask_result["provenance"]
    log_stage("MASK", f"excluded {100.0 * float(land_mask_result['land_fraction']):.1f}% pixels")

    # ---- FILTER -----------------------------------------------------------
    emit("FILTERING", f"speckle={cfar_config['speckle_filter']}")
    filtered = apply_speckle(db, valid, cfar_config["speckle_filter"], cfar_config["kernel_size"])
    log_stage("FILTER", f"speckle {cfar_config['speckle_filter']} applied")

    # ---- DETECT -----------------------------------------------------------
    emit(
        "DETECTING",
        f"CA-CFAR train={cfar_config['training_cells']} "
        f"guard={cfar_config['guard_cells']} "
        f"alpha={cfar_config['threshold_factor']}",
    )
    det = run_ca_cfar(
        filtered, np.isfinite(filtered), land,
        training_cells=cfar_config["training_cells"],
        guard_cells=cfar_config["guard_cells"],
        threshold_factor=cfar_config["threshold_factor"],
    )
    log_stage("CFAR", f"detected {int(det['mask'].sum())} pixels")

    # ---- EXTRACT ----------------------------------------------------------
    emit("EXTRACTING", f"components min={cfar_config['min_pixels']}px")
    comps = extract_components(
        det["mask"], filtered,
        min_pixels=cfar_config["min_pixels"], max_pixels=cfar_config["max_pixels"],
        # Wake apparent lengths are reported in METRES, so the detector needs the
        # ground sample distance. The default of 1.0 would silently report pixels.
        pixel_spacing_m=float(raster_meta["resolution_m"] or 1.0),
    )
    _an = sum(1 for c in comps if (c.get("wakeAnalysis") or {}).get("detected"))
    log_stage(
        "CFAR",
        f"{len(comps)} components"
        + (f"; wake measured on all, {_an} with an arm pair" if comps else ""),
    )

    # ---- GEOLOCATE --------------------------------------------------------
    # GEO-CORR: components carry PIXEL centroids here. They must be turned into
    # geographic positions from the transform of the window that was ACTUALLY
    # read, before correlation sees them. Interpolating across the requested AOI
    # -- which correlation used to do -- places a detection wherever the AOI
    # happens to fall rather than where the pixel is, and the error then
    # propagates into the spatial score, the dynamic match radius and the
    # association itself.
    emit("GEOLOCATING", "pixel centroids to WGS84 from the window transform")
    # The reader hands back ONLY the window transform, which is the one that must
    # be used. `assert_window_consistency` is the guard for a caller that has both
    # and might pass the wrong one; with only the window transform available there
    # is nothing to cross-check, so what is asserted here is that it is present
    # and complete. An absent transform raises inside geolocate_components.
    window_transform = list(window_data["window_transform"])[:6]
    assert_window_consistency(
        scene_transform=None,
        window=window_data["window"],
        window_transform=window_transform,
    )
    comps = geolocate_components(
        comps,
        crs=str(window_data["crs"]),
        transform=list(window_data["window_transform"])[:6],
    )
    geo_unc_m = geolocation_uncertainty_m(
        resolution_m=raster_meta["resolution_m"],
        georeferencing=Georeferencing.AFFINE_GEOREFERENCED.value,
    )
    log_stage(
        "GEO",
        f"geolocated {len(comps)} components"
        + (f"; geolocation uncertainty {geo_unc_m:.1f} m" if geo_unc_m is not None else ""),
    )

    # ---- AIS --------------------------------------------------------------
    emit("LOADING_AIS", "loading AIS observations")
    acq = raster_meta["acquisition_time"]
    window_seconds = 900
    a0 = _as_utc(acq) - timedelta(seconds=window_seconds)
    a1 = _as_utc(acq) + timedelta(seconds=window_seconds)
    archive = AisArchive(data_dir)
    ais_rows = archive.query(a0, a1, bbox=aoi)
    sources: list[str] = archive.coverage()["sources"] or ["local-archive"]
    ais_provider = "+".join(sources)
    log_stage("AIS", f"loaded {len(ais_rows)} observations")

    # ---- ALIGN ------------------------------------------------------------
    emit("ALIGNING", "propagating AIS to acquisition time")
    emit("CORRELATING", "building candidates")
    # GEO-CORR: `comps` already carry measured lat/lon from the window
    # transform. No width/height/bbox is passed, so correlation cannot reintroduce
    # AOI interpolation. `grid_w`/`grid_h`/`grid_bbox` are gone for that reason.
    out = correlate(
        comps, ais_rows, acq, float(raster_meta["resolution_m"] or 10.0), "PENDING",
    )
    targets = out["targets"]
    matched = sum(1 for t in targets if t["cls"] == "SAR_MATCHED_AIS")
    log_stage("MATCH", f"associated {matched} targets")

    # ---- POLARIZATION -----------------------------------------------------
    # Runs on every component, and today almost always reports NOT_AVAILABLE,
    # which is the correct answer rather than a gap.
    #
    # Traced rather than assumed: SarAsset carries ONE polarization and ONE
    # asset_href, and read_window does ds.read(1). A production scan therefore
    # reads exactly ONE polarization, so there are no co-registered arrays and
    # no VH/VV ratio can be computed without synthesising a channel.
    # Synthesising one yields a number that looks like a measurement of this
    # vessel and is actually a ratio of unrelated things, so it is not done.
    #
    # Statistics for the polarization that WAS read are still reported, which
    # is genuinely useful. Evidence only: it touches no score and no class.
    _pol_read = str(raster_meta.get("polarization") or "") or None
    _pol_measured = 0
    for _i, _comp in enumerate(comps):
        # Section 39: this channel is secondary evidence, so nothing it can do may
        # abort the scan. The guard is here rather than inside the channel because a
        # channel that raises has still not produced evidence, and an unguarded
        # attribute access on its return value would take the whole SAR detection,
        # the AIS correlation and the classification down with it -- the exact
        # failure mode this section forbids.
        try:
            _result = for_scene_polarization(
                _pol_read,
                product=raster_meta.get("product"),
                db=filtered,
                mask=_component_mask(_comp, filtered),
            )
            _payload = _result.to_dict() if _result is not None else None
            _measured = bool(_result is not None and _result.measured)
        except Exception as _exc:  # noqa: BLE001 - deliberate: never fatal
            _payload = {
                "status": "FAILED",
                "available": [],
                "requested": ["VV", "VH"],
                "single_pol": True,
                "per_pol": {},
                "vh_over_vv_db": None,
                "dual_pol_flags": {"vh_over_vv": NOT_AVAILABLE},
                "calibration_domain": domain_for(raster_meta.get("product")),
                "reason": (
                    "polarization extraction failed; the SAR detection is unaffected "
                    f"({type(_exc).__name__}: {_exc})"
                ),
                "notes": [],
            }
            _measured = False
        if _i < len(targets) and _payload is not None:
            targets[_i]["polarizationEvidence"] = _payload
        _pol_measured += int(_measured)
    log_stage(
        "POLAR",
        f"polarization read={_pol_read or 'none'}; {_pol_measured}/{len(comps)} "
        "measured; dual-pol NOT_AVAILABLE on a single-pol acquisition",
    )

    # ---- SCORE / PERSIST --------------------------------------------------
    emit("SCORING", "assembling score decomposition and confidence")
    emit("PERSISTING", "building evidence record")
    prov = build_provenance(
        runtime_mode="REAL", synthetic=False,
        provider=raster_meta["provider"], collection=raster_meta["collection"],
        item_id=raster_meta["item_id"], platform=raster_meta["platform"],
        acquisition_time=acq, product=raster_meta["product"],
        polarization=raster_meta["polarization"], asset_href=raster_meta["asset_href"],
        crs=raster_meta["crs"], transform=raster_meta["transform"],
        resolution_m=raster_meta["resolution_m"], raster_window=raster_meta["raster_window"],
        bbox=list(aoi), config_hash=chash,
        land_mask=land_prov,
        speckle={"mode": cfar_config["speckle_filter"], "kernel": cfar_config["kernel_size"]},
        cfar={k: cfar_config[k] for k in ("training_cells", "guard_cells", "threshold_factor", "min_pixels", "max_pixels")},
        ais_provider=ais_provider,
        matching={"weights": [0.45, 0.25, 0.15, 0.15], "min_score": 0.40, "window_s": window_seconds},
    )
    result = {
        # Both isolation fields are INVARIANTS, not labels. There is no synthetic
        # path in this pipeline, so they are stamped rather than derived -- and
        # the store asserts them on write, so a record cannot drift from them.
        "runtime_mode": "REAL",
        "synthetic": False,
        "scene": raster_meta, "aoi": list(aoi), "acquisition_time": acq,
        "config": {**cfar_config, "config_hash": chash},
        "targets": targets, "ais_only": out["ais_only"],
        "counts": {**_class_counts(targets), "ais_only": len(out["ais_only"])},
        "provenance": prov,
        "artifacts": {
            "raw_db": db, "filtered_db": filtered, "land": land,
            "cfar_mask": det["mask"], "threshold_db": det["threshold_db"],
        },
        "processing_time_ms": int((time.time() - started) * 1000),
        "created_at": datetime.now(UTC).isoformat(),
        "scan_id": scan_id,
    }
    log_stage("DONE", f"scan completed in {result['processing_time_ms']} ms")
    emit("COMPLETE", f"scan completed in {result['processing_time_ms']} ms")
    return result


def _as_utc(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _resolve_asset(
    provider: str,
    product: str,
    bbox: tuple[float, float, float, float],
    dr: str | None,
    scene_id: str | None = None,
) -> SarAsset:
    """Pick the asset to read.

    With ``scene_id`` the match is EXACT or the scan fails. Falling back to
    "the first scene that happens to intersect the AOI" would process a different
    acquisition while the interface, the evidence record and the operator's
    selection all named the requested one -- a substituted scene presented as the
    chosen scene, which is the worst kind of wrong for an evidence product.

    The candidate window is widened when pinning, because a pinned scene is
    routinely not the first result of the unpinned query.
    """
    # A blank range means "no time filter"; the STAC helper omits the key.
    window = dr.strip() if dr and dr.strip() else ""
    limit = _PINNED_SCENE_SEARCH_LIMIT if scene_id else 2

    if provider == "planetary-computer":
        assets = search_planetary_computer(bbox, window, product=product, limit=limit)
    elif provider == "earthsearch":
        assets = search_earthsearch_grd(bbox, window, limit=limit)
    else:
        raise RealDataUnavailableError(
            f"unknown provider {provider}", details={"provider": provider}
        )

    if scene_id:
        wanted = scene_id.strip()
        for asset in assets:
            if asset.item_id == wanted:
                return asset
        # A polarisation-specific asset carries a suffixed id in some catalogues,
        # so a prefix match is allowed -- but only to a candidate that was really
        # returned for this AOI, never to something synthesised.
        prefixed = [a for a in assets if a.item_id.startswith(wanted)]
        if len(prefixed) == 1:
            return prefixed[0]
        raise RealDataUnavailableError(
            f"Scene {scene_id!r} does not intersect this area in the requested window.",
            details={
                "requested_scene_id": scene_id,
                "provider": provider,
                "candidates_considered": [a.item_id for a in assets],
            },
            suggestions=[
                "Re-run the scene search for this area and pick a listed acquisition.",
            ],
        )

    vv = [a for a in assets if a.polarization == "VV"]
    return (vv or assets)[0]


def _real_land_mask(
    db: np.ndarray,
    valid: np.ndarray,
    window_data: dict[str, Any],
    cfar_config: dict[str, Any],
    data_dir: str | Path,
    aoi: tuple[float, float, float, float],
) -> dict[str, Any]:
    """WorldCover-backed mask aligned to the SAR window, cached under data_dir."""
    cache_dir = Path(data_dir) / "boundaries" / "worldcover"
    min_lon, min_lat, max_lon, max_lat = aoi
    clip = cache_dir / f"{min_lon:.3f}_{min_lat:.3f}_{max_lon:.3f}_{max_lat:.3f}.tif"
    if not clip.exists():
        href = landmask_mod.tile_url((min_lon + max_lon) / 2, (min_lat + max_lat) / 2)
        landmask_mod.fetch_tile_clip(href, aoi, str(clip))
    win = window_data["window"]
    return landmask_mod.build_land_mask(
        str(clip),
        window_data["window_transform"],
        (int(win[2]), int(win[3])),
        window_data["crs"],
        coastline_buffer_m=int(cfar_config["coastline_buffer_meters"]),
        pixel_spacing_m=rasterio_res(window_data),
    )


def rasterio_res(window_data: dict[str, Any]) -> float:
    t = window_data["window_transform"]
    return float(max(abs(t.a), abs(t.e)))