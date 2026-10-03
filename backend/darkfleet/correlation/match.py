"""Spatio-temporal correlation. Legacy-equivalent association + all 7 states.

New-state bands (SEA_CLUTTER / LOW_CONFIDENCE / UNRESOLVED) were calibrated so
the golden run is stable: they fire only in the weak/ambiguous zone the legacy
lumped into SAR_UNMATCHED. Golden deltas are recorded in the CP5 ledger entry.
"""

from __future__ import annotations

import math
from typing import Any, TypedDict

from ..ais.normalize import _as_utc
from .geodesy import dynamic_radius, geodesic_meters, orient_diff, propagate

WINDOW_S = 900
MIN_SCORE = 0.40
LOW_BAND = 0.30  # [LOW_BAND, MIN_SCORE) with a candidate -> LOW_CONFIDENCE
CONFLICT_GAP = 0.05  # two candidates >= MIN_SCORE within this -> UNRESOLVED
CLUTTER_CONF = 0.45
CLUTTER_AREA = 6
CLUTTER_DB = 0.0


class Candidate(TypedDict):
    idx: int
    ais: dict[str, Any]
    score: float
    dist: float
    pred: dict[str, float]
    dt: int
    spatial: float
    temporal: float
    heading: float
    size: float
    radius: float


class DetectionNotGeolocatedError(TypeError):
    """A component reached correlation without a measured geographic position.

    A distinct type so a caller can catch exactly this and route it to
    "geolocation failed" rather than to a generic bad-input path: it means the
    SAR stage handed correlation a pixel it never converted, which is a pipeline
    defect rather than user error.
    """

    def __init__(self, message: str, **detail: Any) -> None:
        super().__init__(message)
        self.detail: dict[str, Any] = detail


def component_position(comp: dict[str, Any]) -> tuple[float, float]:
    """The measured geographic position of one detection, as ``(lat, lon)``.

    GEO-CORR: this used to interpolate linearly across the REQUESTED AOI::

        lon = min_lon + (x / width) * (max_lon - min_lon)
        lat = max_lat - (y / height) * (max_lat - min_lat)

    which is only right when the window read exactly fills the AOI. On the
    committed fixture the raster covered latitude 1.32075..1.35693 while the
    requested AOI covered 1.35690..1.39310, so every detection was placed about
    4 km north of where it was. Because the spatial score and the dynamic match
    radius are both computed from this position, that displaced every
    association while still producing plausible-looking scores.

    Correlation now CONSUMES a position measured by
    :mod:`darkfleet.geolocation` from the window transform that was actually
    read. It does not receive a bbox, a width or a height, and it never inspects
    a raster: mapping pixels to the Earth is not this module's concern.

    A component with no measured position is an error, not something to estimate.
    """
    lat = comp.get("lat")
    lon = comp.get("lon")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        raise DetectionNotGeolocatedError(
            "component carries no measured lat/lon; detections must be geolocated "
            "from the window transform before correlation "
            "(see darkfleet.geolocation.geolocate_components)",
            component_keys=sorted(str(k) for k in comp),
        )
    if not (math.isfinite(float(lat)) and math.isfinite(float(lon))):
        raise ValueError(
            f"component position is not finite (lat={lat}, lon={lon}); refusing to score it"
        )
    return float(lat), float(lon)


def _sar_confidence(comp: dict[str, Any], wake: bool) -> float:
    snr: float = float(comp["maxDb"]) - float(comp["clutterMeanDb"])
    conf: float = min(0.98, max(0.35, 0.45 + (snr / 35) * 0.45))
    if comp["area"] < 4:
        conf *= 0.8
    if wake:
        conf = min(0.99, conf + 0.08)
    return round(conf, 2)


def correlate(
    components: list[dict[str, Any]],
    ais: list[dict[str, Any]],
    acquisition_iso: str,
    resolution_m: float,
    scan_id: str,
    weights: tuple[float, float, float, float] = (0.45, 0.25, 0.15, 0.15),
    base_radius_m: float = 1200.0,
    max_radius_m: float = 2800.0,
) -> dict[str, Any]:
    """Associate SAR detections with AIS observations.

    GEO-CORR: ``width``, ``height`` and ``bbox`` are GONE from this signature.
    They were only ever used to interpolate a pixel position across the
    requested AOI, which is not the same thing as the window that was read. Each
    ``component`` must now carry a measured ``lat``/``lon`` produced by
    :mod:`darkfleet.geolocation` from the window transform.

    Removing them from the signature rather than ignoring them is deliberate: a
    parameter that exists invites a caller to pass a bbox and trust the result,
    and that is precisely the defect being closed.
    """
    acq = _as_utc(acquisition_iso).timestamp()
    w_sp, w_tm, w_hd, w_sz = weights

    cands: list[Candidate] = []
    for idx, comp in enumerate(components):
        lat, lon = component_position(comp)
        apparent_len = round(comp["major"] * resolution_m)
        for ob in ais:
            ob_ts = _as_utc(str(ob["timestamp"])).timestamp()
            dt = acq - ob_ts
            if abs(dt) > WINDOW_S:
                continue
            pred = propagate(ob["lat"], ob["lon"], ob["sog"], ob["cog"], dt)
            dist = geodesic_meters(lat, lon, pred["lat"], pred["lon"])
            radius = dynamic_radius(base_radius_m, dt, ob["sog"], max_radius_m)
            if dist > radius:
                continue
            spatial = max(0.0, 1 - dist / radius)
            temporal = max(0.0, 1 - abs(dt) / WINDOW_S)
            eff_hdg = comp["wakeHdg"] if comp["wake"] and comp["wakeHdg"] is not None else comp["orient"]
            hdg = max(0.0, 1 - orient_diff(eff_hdg, ob["cog"], comp["wake"]) / 90)
            size = 0.8
            if ob.get("length", 0) > 0:
                size = max(0.0, 1 - abs(apparent_len - ob["length"]) / max(ob["length"], 50))
            composite = w_sp * spatial + w_tm * temporal + w_hd * hdg + w_sz * size
            cands.append(
                {
                    "idx": idx,
                    "ais": ob,
                    "score": composite,
                    "dist": dist,
                    "pred": pred,
                    "dt": round(dt),
                    "spatial": spatial,
                    "temporal": temporal,
                    "heading": hdg,
                    "size": size,
                    "radius": radius,
                }
            )

    # Greedy 1-to-1 on candidates >= MIN_SCORE; UNRESOLVED on close conflicts.
    strong = sorted([c for c in cands if c["score"] >= MIN_SCORE], key=lambda c: -c["score"])
    matched: dict[int, Candidate] = {}
    used_mmsi: set[str] = set()
    unresolved: set[int] = set()
    for c in strong:
        i, mmsi = c["idx"], str(c["ais"]["mmsi"])
        if i in matched or i in unresolved or mmsi in used_mmsi:
            continue
        rival = next(
            (r for r in strong if r["idx"] == i and str(r["ais"]["mmsi"]) != mmsi and abs(r["score"] - c["score"]) <= CONFLICT_GAP),
            None,
        )
        if rival is not None:
            # Two near-equal claimants: do not force a winner.
            unresolved.add(i)
            continue
        matched[i] = c
        used_mmsi.add(mmsi)

    weak_best: dict[int, float] = {}
    for c in cands:
        if LOW_BAND <= c["score"] < MIN_SCORE:
            weak_best[c["idx"]] = max(weak_best.get(c["idx"], 0.0), c["score"])

    # The best candidate considered and REJECTED, per target -- regardless of how
    # far below threshold it fell.
    #
    # Without this, "no association was accepted" is unfalsifiable: an analyst
    # cannot tell an empty search from a near miss, and those are completely
    # different findings. The closest rejected candidate is what makes the
    # decision inspectable, which is the whole point of a Ghost Vessel workflow.
    closest_rejected: dict[int, Candidate] = {}
    for c in cands:
        if c["idx"] in matched or c["idx"] in unresolved:
            continue
        incumbent = closest_rejected.get(c["idx"])
        if incumbent is None or c["score"] > incumbent["score"]:
            closest_rejected[c["idx"]] = c

    targets: list[dict[str, Any]] = []
    for idx, comp in enumerate(components):
        lat, lon = component_position(comp)
        apparent_len = round(comp["major"] * resolution_m)
        apparent_wid = round(comp["minor"] * resolution_m)
        len_unc = max(10, round(apparent_len * 0.22))
        sar_conf = _sar_confidence(comp, comp["wake"])
        aspect = comp["major"] / max(1.0, comp["minor"])
        stationary = comp["maxDb"] > 2.0 and aspect < 1.4 and not comp["wake"]
        m = matched.get(idx)
        best_ais = m["ais"] if m else None
        score = m["score"] if m else 0.0

        tags: list[str] = []
        if idx in unresolved:
            cls = "UNRESOLVED"
            assessment = (
                f"Radar return at {lat:.4f}N, {lon:.4f}E with two near-equal AIS "
                f"candidates; association withheld pending further evidence."
            )
            tags.append("ASSOCIATION_CONFLICT")
        elif stationary and (not best_ais or (m and m["dist"] > 1000)):
            cls = "STATIONARY_OR_INFRASTRUCTURE"
            assessment = (
                f"Stationary radar return at {lat:.4f}N, {lon:.4f}E. High "
                f"point-backscatter ({comp['maxDb']} dB), no wake; fixed infrastructure."
            )
            tags += ["STATIC_INFRASTRUCTURE", "HIGH_RCS"]
        elif (
            sar_conf < CLUTTER_CONF
            and comp["area"] <= CLUTTER_AREA
            and comp["maxDb"] < CLUTTER_DB
            and not best_ais
        ):
            cls = "SEA_CLUTTER"
            assessment = (
                f"Weak, small radar return consistent with sea clutter "
                f"(confidence {sar_conf}, {comp['area']} px, peak {comp['maxDb']} dB)."
            )
            tags.append("SEA_CLUTTER")
        elif m is not None and score >= MIN_SCORE:
            cls = "SAR_MATCHED_AIS"
            hit = m["ais"]
            assessment = (
                f"Correlated with AIS MMSI {hit['mmsi']} "
                f"({hit.get('shipName') or 'Unregistered'}). Spatial delta "
                f"{round(m['dist'])}m at dt {m['dt']}s."
            )
            tags += ["CORRELATED_AIS", str(hit.get("shipType", "")).upper().replace(" ", "_")]
        elif idx in weak_best:
            cls = "LOW_CONFIDENCE"
            assessment = (
                f"Surface radar return (~{apparent_len}m) with a sub-threshold AIS "
                f"candidate (score {weak_best[idx]:.2f}); association not established."
            )
            tags.append("SUB_THRESHOLD_CANDIDATE")
        else:
            cls = "SAR_UNMATCHED"
            assessment = (
                f"Unmatched surface radar return (~{apparent_len}m). No sufficiently "
                f"confident AIS association in the available observations."
            )
            tags += ["SAR_UNMATCHED", "AIS_UNASSOCIATED"]
            if comp["wake"]:
                tags.append("UNDERWAY")

        # Computed for EVERY target, not just the unmatched branch: the winning
        # candidate and the runner-up are both needed to explain a match, and an
        # analyst asking "why not?" needs the same fields on the other branch.
        rejected = closest_rejected.get(idx)
        candidates_considered = len([c for c in cands if c["idx"] == idx])

        corr: dict[str, Any] = {
            "matched": bool(best_ais and score >= MIN_SCORE),
            "mmsi": str(best_ais["mmsi"]) if best_ais else None,
            "vesselName": best_ais.get("shipName") if best_ais else None,
            "distanceOffsetMeters": round(m["dist"]) if m else None,
            "timeDeltaSeconds": m["dt"] if m else None,
            "predictedLat": m["pred"]["lat"] if m else None,
            "predictedLon": m["pred"]["lon"] if m else None,
            "scoreDecomposition": None,
        }
        # Association decision, made inspectable.
        #
        # `candidatesConsidered` and `closestRejected` let a reader answer "why was
        # this not matched?" with arithmetic instead of assertion. Both are null
        # when the search genuinely found nothing, which is a DIFFERENT finding
        # from "found something and rejected it" and is preserved as such.
        corr["candidatesConsidered"] = candidates_considered
        corr["acceptanceThreshold"] = MIN_SCORE
        corr["closestRejected"] = (
            {
                "mmsi": str(rejected["ais"]["mmsi"]),
                "vesselName": rejected["ais"].get("shipName"),
                "score": round(rejected["score"], 3),
                "distanceMeters": round(rejected["dist"]),
                "timeDeltaSeconds": rejected["dt"],
                "shortfall": round(MIN_SCORE - rejected["score"], 3),
            }
            if rejected is not None
            else None
        )
        if m:
            corr["scoreDecomposition"] = {
                "spatialScore": round(m["spatial"], 3),
                "temporalScore": round(m["temporal"], 3),
                "headingScore": round(m["heading"], 3),
                "sizeScore": round(m["size"], 3),
                "compositeScore": round(m["score"], 3),
                "matchRadiusMeters": round(m["radius"]),
                "distanceOffsetMeters": round(m["dist"]),
                "timeDeltaSeconds": m["dt"],
            }
        targets.append(
            {
                "id": f"DF-{idx + 1:03d}",
                "cls": cls,
                "lat": lat,
                "lon": lon,
                # GEO-CORR measured these and correlation was dropping them.
                #
                # `geolocate_components` computes the exact sub-pixel centroid
                # and the centre convention used, and keeps them on the component.
                # This target dict is built from an explicit field list, and those
                # keys were not on it -- so the sub-pixel position was discarded one
                # layer after being measured.
                #
                # The coordinate itself was never wrong: lat/lon were already
                # correct. What was lost is the REPRODUCIBILITY evidence -- the
                # ability to map this detection back to a pixel, to re-derive its
                # coordinate, or to prove a raster pixel and this target are the
                # same object. The analytics surface needs exactly that.
                "geo_pixel_centroid": comp.get("geo_pixel_centroid"),
                "geo_centre_offset": comp.get("geo_centre_offset"),
                "sarConf": sar_conf,
                "aisConf": round(score, 2),
                "lenM": apparent_len,
                "widM": apparent_wid,
                "lenUncM": len_unc,
                "hdg": comp["wakeHdg"] if comp["wake"] and comp["wakeHdg"] is not None else comp["orient"],
                "wake": comp["wake"],
                "meanDb": comp["meanDb"],
                "maxDb": comp["maxDb"],
                "area": comp["area"],
                "corr": corr,
                "assessment": assessment,
                "tags": tags,
            }
        )

    ais_only = []
    for ob in ais:
        if str(ob["mmsi"]) not in used_mmsi:
            ais_only.append(
                {
                    "cls": "AIS_ONLY",
                    "mmsi": str(ob["mmsi"]),
                    "vesselName": ob.get("shipName"),
                    "lat": ob["lat"],
                    "lon": ob["lon"],
                    "timestamp": str(ob["timestamp"]),
                }
            )
    return {"targets": targets, "ais_only": ais_only}
