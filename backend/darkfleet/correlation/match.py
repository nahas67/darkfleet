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


def _speed_knots(ob: dict[str, Any]) -> float:
    """Speed over ground in knots, treating "not reported" as ZERO MOTION.

    ``AisObservation.sog`` is nullable by design -- ``models.py`` is explicit that an absent
    measurement is ``None`` and not ``0.0``, precisely so a vessel at anchor stays
    distinguishable from one that never broadcast. ``correlate`` read ``ob["sog"]`` directly,
    so a single row that omitted SOG reached ``propagate``'s ``sog_knots < 0.1`` comparison and
    raised ``TypeError``. Confirmed by execution, not by inspection::

        propagate(1.0, 103.0, None, 90.0, 120.0)
        TypeError: '<' not supported between instances of 'NoneType' and 'float'

    That is the CORRELATING stage failing on an archive the model explicitly allows. The fix
    reads absence as zero MOTION rather than as zero SPEED: an un-reported speed licenses no
    dead reckoning, and the existing ``sog < 0.1`` guard in ``propagate`` then declines to
    project. The distinction matters, and it is preserved: ``_speed_knots`` returns the number
    used for kinematics, never a claim that the vessel measured zero.

    An UNREADABLE value is not absence, so it is raised rather than silently read as 0.0. A
    NaN that reached the score would propagate into every candidate.
    """
    value = ob.get("sog")
    if value is None:
        return 0.0
    speed = float(value)
    if not math.isfinite(speed):
        raise ValueError(f"observation has a non-finite sog: {value!r}")
    return max(0.0, speed)


def _course_deg(ob: dict[str, Any]) -> float | None:
    """Course over ground in degrees true, or ``None`` when it was not reported.

    Returning ``None`` rather than ``0.0`` is the whole point. COG 0 is a real course due
    north; substituting it for absence would assert a direction the vessel never reported, and
    would let a contact be scored as *agreeing* with a north-oriented hull for free.
    """
    value = ob.get("cog")
    if value is None:
        return None
    course = float(value)
    if not math.isfinite(course):
        return None
    return course % 360.0


def _has_cog(ob: dict[str, Any]) -> bool:
    """Whether the observation reported a course at all."""
    return _course_deg(ob) is not None


def _hull_length_m(ob: dict[str, Any]) -> float | None:
    """
    The vessel's overall length in metres, or ``None`` when it was not reported.

    READS BOTH SPELLINGS, CANONICAL FIRST.

    ``AisObservation`` and the Parquet schema name the field ``length_m``
    (``models.py:52``, ``archive.py:36``). The golden fixture and the correlation-input shape
    call it ``length``. ``correlate`` only ever read the second, so on real archive rows the
    size term was pinned to its 0.8 default and a 0.15-weighted contribution was a constant.

    Canonical-first rather than either-or, so that a row carrying both cannot pick the wrong
    one by dict ordering -- and so the golden run's parity is unchanged.
    """
    for key in ("length_m", "length"):
        raw = ob.get(key)
        if raw is None:
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if math.isfinite(value) and value > 0:
            return value
    return None


def _vessel_type(ob: dict[str, Any]) -> str | None:
    """
    The vessel's type, or ``None``.

    Same two-spelling problem as the name: the archive stores ``ship_type``
    (``models.py:50``) and the fixture uses ``shipType``. Read raw here rather than upper-cased,
    so the CALLER decides the presentation -- a tag that has already been transformed cannot be
    told apart from a source value.
    """
    for key in ("ship_type", "shipType"):
        value = ob.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _vessel_name(ob: dict[str, Any]) -> str | None:
    """
    The vessel's name, or ``None``.

    The same two-spelling problem as the hull length: ``AisObservation`` and the archive
    store ``name`` (``models.py:49``), while the correlation-input shape uses ``shipName``.
    Reading only ``shipName`` meant ``vesselName`` was always ``None`` on a real archive row,
    so the operator saw an unnamed vessel for every contact that had one.

    CANONICAL FIRST, matching ``_hull_length_m`` and ``_vessel_type``. An earlier revision read
    ``shipName`` first, so a row carrying both spellings resolved by a different rule from every
    other field -- and a test comparing the three helpers caught exactly that.
    """
    for key in ("name", "shipName"):
        value = ob.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
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


#: Identifies the scoring semantics in force, and is recorded on every evidence
#: export so a result can be traced to the model that produced it.
#:
#: ``sar-scoring/v1``
#:     Wake evidence carried scoring authority: `+0.08` to SAR confidence, a
#:     widened heading tolerance, and the ability to veto the stationary test.
#:     The wake flag came from `_kelvin_sampler`, a six-point hull-axis brightness
#:     threshold that could not detect a Kelvin wake and reported False for all 84
#:     stored targets.
#:
#: ``sar-scoring/v2``
#:     Wake is EVIDENCE ONLY. `sarConf` describes the SAR detection itself and
#:     nothing else. See `docs/WAKE_SCORING_DELTA.md` for the measured
#:     consequences of v1 and the reasoning behind this change.
SCORING_MODEL_VERSION = "sar-scoring/v2"


def _sar_confidence(comp: dict[str, Any]) -> float:
    """Confidence in the SAR DETECTION itself, 0..1.

    Derived only from what the radar measured: peak-to-clutter ratio and component
    area. Two things are deliberately absent.

    AIS is absent because this is the SAR detection's confidence; folding in an
    AIS association would make the number describe the match rather than the
    detection, and `aisConf` already exists for that.

    Wake is absent because its contribution was never validated. `+0.08` was a
    bare constant, and the measurement in `docs/WAKE_SCORING_DELTA.md` shows it was
    load-bearing enough to transfer MMSI 477421900 between two detections and move
    a vessel into Ghost Vessel state. A constant that can reassign a named vessel
    is not evidence until it is validated.

    Note also that absence of wake is not evidence of absence. A stationary or
    slow vessel may show no wake at all, and viewing geometry and sea state affect
    visibility, so there is deliberately NO penalty term either. Any future
    conditional model must be validated before it touches this function.
    """
    snr: float = float(comp["maxDb"]) - float(comp["clutterMeanDb"])
    conf: float = min(0.98, max(0.35, 0.45 + (snr / 35) * 0.45))
    if comp["area"] < 4:
        conf *= 0.8
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
            sog_knots = _speed_knots(ob)
            cog_deg = _course_deg(ob)
            pred = propagate(ob["lat"], ob["lon"], sog_knots, cog_deg, dt)
            dist = geodesic_meters(lat, lon, pred["lat"], pred["lon"])
            radius = dynamic_radius(base_radius_m, dt, sog_knots, max_radius_m)
            if dist > radius:
                continue
            spatial = max(0.0, 1 - dist / radius)
            temporal = max(0.0, 1 - abs(dt) / WINDOW_S)
            eff_hdg = comp["orient"]
            # `orient_diff` is called with the wake flag permanently False. The
            # flag used to switch between a directed 0..180 metric and an
            # undirected 0..90 one, so a wake detection silently changed how
            # heading agreement was measured. Hull orientation is the only
            # validated primary source, and it is a line, so the undirected metric
            # is the correct one unconditionally.
            #
            # AN UNREPORTED COURSE SCORES ZERO, AND THAT IS A DELIBERATE PENALTY.
            # The heading term carries weight 0.15, so an observation with no COG simply cannot
            # win on heading. Reading absence as "agrees with everything" would let a contact
            # that reported nothing directionally out-score one that did, and reading it as 0
            # degrees would assert a course north that the vessel never gave.
            hdg = max(0.0, 1 - orient_diff(eff_hdg, cog_deg) / 90) if cog_deg is not None else 0.0
            # THE SIZE TERM WAS DEAD IN PRODUCTION.
            #
            # It read `ob.get("length", 0)` and `ob["length"]`, but `AisArchive` stores the
            # column as `length_m` and `AisObservation` names the field `length_m`. On every
            # real archive row `ob.get("length", 0)` returned 0, the guard skipped, and `size`
            # stayed pinned at its 0.8 default -- so a 0.15-weighted term contributed a
            # constant and the vessel's actual dimensions never influenced correlation.
            #
            # The golden fixture uses `length`, which is why it looked exercised. Both spellings
            # are now read, canonical first, because the golden run's parity must not change:
            # a fixture that says `length` and an archive that says `length_m` are the same
            # vessel, and picking one arbitrarily would silently move the score for whichever
            # spelling was missed.
            hull_length = _hull_length_m(ob)
            size = 0.8
            if hull_length is not None and hull_length > 0:
                size = max(0.0, 1 - abs(apparent_len - hull_length) / max(hull_length, 50))
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
        sar_conf = _sar_confidence(comp)
        aspect = comp["major"] / max(1.0, comp["minor"])
        # No wake term. This used to be `... and not comp["wake"]`, which let an
        # unvalidated wake flag veto the stationary classification. Bright
        # point-target infrastructure with no visible wake is exactly the case
        # that must not be reclassified by an absent signal.
        stationary = comp["maxDb"] > 2.0 and aspect < 1.4
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
                f"point-backscatter ({comp['maxDb']} dB) and a near-circular "
                f"footprint; consistent with fixed infrastructure."
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
                f"({_vessel_name(hit) or 'Unregistered'}). Spatial delta "
                f"{round(m['dist'])}m at dt {m['dt']}s."
            )
            # Read through the spelling-agnostic helper: the archive column is `ship_type` and
            # only the golden fixture spells it `shipType`, so a direct read produced an empty
            # string that then `.upper()`-ed into a bare tag with no vessel type in it. Guarded
            # on truthiness so an untyped vessel contributes no CORRELATED_AIS tag at all,
            # rather than a meaningless one.
            vessel_type = _vessel_type(hit)
            if vessel_type:
                tags += ["CORRELATED_AIS", vessel_type.upper().replace(" ", "_")]
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
            # A wake detection is recorded as a TAG, never as a score adjustment.
            # "Wake-like linear evidence present" is an observation; it is not a
            # claim that the vessel is underway, because that would need a
            # validated conditional model. See SCORING_MODEL_VERSION.
            if (comp.get("wakeAnalysis") or {}).get("detected"):
                tags.append("WAKE_EVIDENCE_PRESENT")

        # Computed for EVERY target, not just the unmatched branch: the winning
        # candidate and the runner-up are both needed to explain a match, and an
        # analyst asking "why not?" needs the same fields on the other branch.
        rejected = closest_rejected.get(idx)
        candidates_considered = len([c for c in cands if c["idx"] == idx])

        corr: dict[str, Any] = {
            "matched": bool(best_ais and score >= MIN_SCORE),
            "mmsi": str(best_ais["mmsi"]) if best_ais else None,
            "vesselName": _vessel_name(best_ais) if best_ais else None,
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
                "vesselName": _vessel_name(rejected["ais"]),
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
                "hdg": comp["orient"],
                "wake": comp["wake"],
            # The MEASURED wake evidence, carried separately from the legacy
            # `wake` boolean above so that no correlation decision can change
            # because a readout was added. A detector result belongs on the
            # record: an investigator asking what the wake analysis found needs
            # the method, the contrast, the measured arm geometry and the
            # apparent length, not a bare False that meant "never ran".
            "wakeAnalysis": comp.get("wakeAnalysis"),
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
                    "vesselName": _vessel_name(ob),
                    "lat": ob["lat"],
                    "lon": ob["lon"],
                    "timestamp": str(ob["timestamp"]),
                }
            )
    return {"targets": targets, "ais_only": ais_only}
