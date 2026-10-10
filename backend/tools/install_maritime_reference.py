"""Offline installer for operator-obtained maritime GeoJSON reference datasets.

No network operations, implicit licence grants, or fabricated source verification.
The existing maritime store owns the canonical prepared payload and its manifest.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from darkfleet.maritime.context import ZoneIndex
from darkfleet.maritime.datasets import InstallStatus
from darkfleet.maritime.registry import known_manifest
from darkfleet.maritime.store import dataset_dir, install, reference_root, sha256_of, status_of

MAX_INPUT_BYTES = 256 * 1024 * 1024
MAX_ZIP_MEMBERS = 32
MAX_ZIP_RATIO = 500
MAX_FEATURES = 50_000
MAX_VERTICES = 2_000_000
DATASETS = ("natural_earth_coastline", "marine_regions_eez", "marine_regions_eez_wfs")
TRUSTED_HOSTS = {
    "natural_earth_coastline": ("naturalearthdata.com", "naciscdn.org"),
    "marine_regions_eez": ("marineregions.org",),
    "marine_regions_eez_wfs": ("geo.vliz.be",),
}


class InputError(ValueError):
    """Operator input cannot safely be installed."""


def _require_sha256(value: str) -> str:
    value = value.lower()
    if len(value) != 64 or any(ch not in "0123456789abcdef" for ch in value):
        raise InputError("expected source SHA-256 must contain exactly 64 hexadecimal characters")
    return value


def _source_url(value: str, dataset_id: str) -> str:
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port or
            parsed.query or parsed.fragment):
        raise InputError("source URL must be an HTTPS publisher URL without credentials, port or query")
    if not any(host == h or host.endswith("." + h) for h in TRUSTED_HOSTS[dataset_id]):
        raise InputError(f"source URL is not on the registered publisher host list: {host}")
    return value


def _utc_timestamp(value: str) -> str:
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as exc:
        raise InputError("retrieved-at requires an ISO 8601 timestamp with timezone") from exc
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise InputError("retrieved-at requires an ISO 8601 timestamp with timezone")
    if dt > datetime.now(dt.tzinfo):
        raise InputError("retrieved-at cannot be in the future")
    return dt.isoformat()


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise InputError(f"duplicate JSON property {key!r}")
        obj[key] = value
    return obj


def _reject_constant(value: str) -> None:
    raise InputError(f"non-JSON numeric literal: {value}")


def _read_geojson(source: Path) -> tuple[dict[str, Any], str, int]:
    """Read bounded JSON or one GeoJSON member; never extract archive paths to disk."""
    source_size = source.stat().st_size
    if source_size <= 0 or source_size > MAX_INPUT_BYTES:
        raise InputError("source file is empty or exceeds the 256 MiB input limit")
    if source.suffix.lower() == ".zip":
        try:
            with zipfile.ZipFile(source) as archive:
                members = archive.infolist()
                if not 1 <= len(members) <= MAX_ZIP_MEMBERS:
                    raise InputError("ZIP has no members or exceeds the 32-member limit")
                geojson_members: list[zipfile.ZipInfo] = []
                seen: set[str] = set()
                for info in members:
                    name = info.filename.replace("\\", "/")
                    parts = PurePosixPath(name).parts
                    if (not name or name.startswith(("/", "//")) or ".." in parts or
                            ":" in name or "\x00" in name):
                        raise InputError("unsafe ZIP member path")
                    lowered = name.lower()
                    if lowered in seen:
                        raise InputError("duplicate ZIP member path")
                    seen.add(lowered)
                    if (info.external_attr >> 16) & 0o170000 == 0o120000:
                        raise InputError("ZIP symlink members are prohibited")
                    if info.flag_bits & 1:
                        raise InputError("encrypted ZIP members are prohibited")
                    if info.file_size > MAX_INPUT_BYTES or (
                        info.file_size > MAX_ZIP_RATIO * max(info.compress_size, 1)
                    ):
                        raise InputError("ZIP member exceeds size or decompression ratio bound")
                    if not info.is_dir() and lowered.endswith((".geojson", ".json")):
                        geojson_members.append(info)
                if len(geojson_members) != 1:
                    raise InputError("ZIP must contain exactly one GeoJSON/JSON payload")
                chosen = geojson_members[0]
                if chosen.file_size == 0:
                    raise InputError("empty ZIP GeoJSON member")
                with archive.open(chosen) as stream:
                    raw = stream.read(MAX_INPUT_BYTES + 1)
                if len(raw) != chosen.file_size or len(raw) > MAX_INPUT_BYTES:
                    raise InputError("ZIP member size mismatch or input too large")
                format_name = "ZIP/GeoJSON"
        except (zipfile.BadZipFile, RuntimeError, EOFError, OSError) as exc:
            raise InputError(f"invalid ZIP payload: {type(exc).__name__}") from exc
    elif source.suffix.lower() in (".geojson", ".json"):
        raw = source.read_bytes()
        format_name = "GeoJSON"
    else:
        raise InputError("supported sources: .geojson, .json, or .zip containing one GeoJSON")
    try:
        parsed = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_reject_duplicate_keys,
                            parse_constant=_reject_constant)
    except (UnicodeError, ValueError) as exc:
        raise InputError(f"invalid GeoJSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise InputError("GeoJSON document must be a JSON object")
    return parsed, format_name, source_size


def _coordinate(point: Any, counts: list[int]) -> list[float]:
    if not isinstance(point, list) or len(point) != 2:
        raise InputError("position must contain exactly lon/lat; no 3D data is discarded")
    lon, lat = point[0], point[1]
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
           for v in (lon, lat)):
        raise InputError("coordinates must be finite numbers")
    if not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise InputError("coordinates must be WGS84 longitude/latitude (not 0–360 or projected)")
    counts[0] += 1
    if counts[0] > MAX_VERTICES:
        raise InputError("GeoJSON exceeds vertex limit")
    return [float(lon), float(lat)]


def _geometry(geometry: Any, *, coast: bool, counts: list[int]) -> dict[str, Any]:
    if not isinstance(geometry, dict):
        raise InputError("each feature requires geometry")
    kind = geometry.get("type")
    acceptable = ("LineString", "MultiLineString") if coast else ("Polygon", "MultiPolygon")
    if kind not in acceptable:
        raise InputError(f"unsupported geometry type {kind!r} for this dataset")
    coords = geometry.get("coordinates")
    if not isinstance(coords, list) or not coords:
        raise InputError("empty geometry coordinates")

    def line(points: Any, closed: bool) -> list[list[float]]:
        if not isinstance(points, list) or len(points) < (4 if closed else 2):
            raise InputError("line/ring has insufficient positions")
        result = [_coordinate(point, counts) for point in points]
        if closed and result[0] != result[-1]:
            raise InputError("polygon rings must be closed")
        if closed and len({tuple(p) for p in result[:-1]}) < 3:
            raise InputError("degenerate polygon ring")
        return result

    validated: Any
    if kind == "LineString":
        validated = line(coords, False)
    elif kind == "MultiLineString":
        validated = [line(part, False) for part in coords]
    elif kind == "Polygon":
        validated = [[*line(ring, True)] for ring in coords]
    else:
        validated = [[line(ring, True) for ring in poly] for poly in coords if poly]
        if len(validated) != len(coords):
            raise InputError("empty multipolygon part")
    return {"type": kind, "coordinates": validated}


def _crs(payload: dict[str, Any]) -> None:
    crs = payload.get("crs")
    if crs is None:
        return  # RFC 7946 GeoJSON longitude,latitude WGS84 convention
    if not isinstance(crs, dict) or crs.get("type") != "name":
        raise InputError("CRS must be WGS84/CRS84; unsupported CRS metadata")
    properties = crs.get("properties") or {}
    name = properties.get("name") if isinstance(properties, dict) else None
    if name not in ("EPSG:4326", "urn:ogc:def:crs:OGC:1.3:CRS84", "OGC:CRS84"):
        raise InputError("CRS is not declared as WGS84/CRS84")


def _features(payload: dict[str, Any], *, coast: bool) -> tuple[list[dict[str, Any]], int]:
    if payload.get("type") != "FeatureCollection":
        raise InputError("source GeoJSON must be a FeatureCollection")
    _crs(payload)
    features = payload.get("features")
    if not isinstance(features, list) or not 1 <= len(features) <= MAX_FEATURES:
        raise InputError("FeatureCollection must contain 1–50,000 features")
    counts = [0]
    checked: list[dict[str, Any]] = []
    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise InputError("every entry must be a GeoJSON Feature")
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            raise InputError("feature properties must be an object")
        geometry = _geometry(feature.get("geometry"), coast=coast, counts=counts)
        checked.append({"type": "Feature", "id": feature.get("id"),
                        "properties": properties, "geometry": geometry})
    return checked, counts[0]


def _prepared_coast(features: list[dict[str, Any]]) -> dict[str, Any]:
    prepared: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for index, feature in enumerate(features):
        props = dict(feature["properties"])
        claimed_id = feature.get("id") if feature.get("id") is not None else props.get("id")
        if claimed_id is not None and (not isinstance(claimed_id, (str, int)) or
                                       isinstance(claimed_id, bool)):
            raise InputError("coastline source feature identifier must be string/integer")
        identifier = str(claimed_id) if claimed_id is not None else f"local-index-{index}"
        if identifier in identifiers:
            raise InputError(f"duplicate feature id: {identifier}")
        identifiers.add(identifier)
        props["id"] = identifier
        prepared.append({"type": "Feature", "properties": props,
                         "geometry": feature["geometry"]})
    return {"type": "FeatureCollection", "features": prepared,
            "preprocessing_notes": ["Source coordinate order preserved (lon, lat)",
                                    "local-index-* ids are ordinal, not publisher identifiers"]}


def _prepared_eez(features: list[dict[str, Any]]) -> dict[str, Any]:
    prepared: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for feature in features:
        props = feature["properties"]
        mrgid = props.get("mrgid", feature.get("id"))
        if not isinstance(mrgid, (str, int)) or isinstance(mrgid, bool) or not str(mrgid):
            raise InputError("Marine Regions features require a source mrgid/id")
        identifier = str(mrgid)
        if identifier in identifiers:
            raise InputError(f"duplicate Marine Regions feature id: {identifier}")
        identifiers.add(identifier)
        pol_type = props.get("pol_type")
        if not isinstance(pol_type, str) or "200NM" not in pol_type.upper():
            raise InputError("World EEZ feature pol_type must explicitly establish 200NM")
        raw = feature["geometry"]
        polygons = [raw["coordinates"]] if raw["type"] == "Polygon" else raw["coordinates"]
        parts = [poly[0] for poly in polygons]
        holes = [hole for poly in polygons for hole in poly[1:]]
        sovereigns = [props.get(f"sovereign{i}") for i in (1, 2, 3)]
        territories = [props.get(f"territory{i}") for i in (1, 2, 3)]
        if any(value is not None and not isinstance(value, str)
               for value in (*sovereigns, *territories)):
            raise InputError("source sovereign/territory labels must be strings")
        prepared.append({
            "id": identifier, "zone": "EXCLUSIVE_ECONOMIC_ZONE",
            "sovereign_names": [s for s in sovereigns if s],
            "territory_names": [t for t in territories if t],
            "pol_type": pol_type, "geoname": props.get("geoname"),
            "area_km2": props.get("area_km2"),
            "mrgid_eez": props.get("mrgid_eez"),
            "source": props.get("source"),
            "dispute_note": props.get("dispute_note") or (
                f"mrgid_sov2={props['mrgid_sov2']} (additional sovereign reference)"
                if props.get("mrgid_sov2") else None
            ),
            "parts": parts, "holes": holes,
        })
    return {"features": prepared, "preprocessing_notes": [
        "World EEZ polygons: all exterior/interior rings retained; no geometry simplified",
        "Only features with explicit 200NM pol_type accepted",
    ]}


def _prepared(payload: dict[str, Any], dataset_id: str) -> tuple[dict[str, Any], int, int]:
    coast = dataset_id == "natural_earth_coastline"
    features, vertices = _features(payload, coast=coast)
    prepared = _prepared_coast(features) if coast else _prepared_eez(features)
    if not coast:
        try:
            ZoneIndex.model_validate(prepared)
        except ValueError as exc:
            raise InputError(f"prepared zone schema invalid: {exc}") from exc
    return prepared, len(features), vertices


def _guard_destination(data_dir: Path, source: Path, dataset_id: str, version: str) -> Path:
    root = reference_root(data_dir)
    target = dataset_dir(data_dir, dataset_id, version)
    for candidate in (data_dir, root, root / dataset_id, target):
        if candidate.is_symlink():
            raise InputError(f"symlink destination component rejected: {candidate}")
    if source.resolve().is_relative_to(root.resolve()):
        raise InputError("source input must be outside the reference installation tree")
    return target


def _recover(parent: Path, target: Path) -> str | None:
    """Restore the sole interrupted replacement backup when target is missing."""
    backups = sorted(parent.glob(f".dfx14-backup-{target.name}-*"))
    if any(path.is_symlink() for path in backups):
        raise InputError("replacement backup is a symlink: manual recovery required")
    if not target.exists() and len(backups) == 1 and backups[0].is_dir():
        backups[0].rename(target)
        return f"restored interrupted replacement from {backups[0].name}"
    if not target.exists() and len(backups) > 1:
        raise InputError("multiple replacement backups: manual recovery required")
    return None


def _publish(staged: Path, target: Path, *, replace: bool) -> str | None:
    if target.exists() and not replace:
        raise InputError(f"installation exists: {target}; use --replace to replace it")
    backup = target.parent / f".dfx14-backup-{target.name}-{os.getpid()}"
    if backup.exists():
        raise InputError(f"previous replacement backup exists: {backup}")
    moved_old = False
    try:
        if target.exists():
            target.rename(backup)
            moved_old = True
        staged.rename(target)
    except OSError:
        if moved_old and not target.exists():
            backup.rename(target)
        raise
    if moved_old:
        try:
            shutil.rmtree(backup)
        except OSError:
            # The new version is already published. A Windows reader may hold an old
            # file open: report the retained backup instead of claiming install failed.
            return str(backup)
    return None


def install_local(
    *, data_dir: Path, source: Path, dataset_id: str, source_url: str,
    source_version: str | None, retrieved_at: str | None, source_feature_count: int | None,
    expected_source_sha256: str | None, terms_confirmed: bool, replace: bool = False,
) -> dict[str, Any]:
    """Validate full source first, then publish a staged store install under a local lock."""
    manifest = known_manifest(dataset_id)
    if dataset_id not in DATASETS or manifest is None:
        raise InputError(f"dataset not supported by this installer: {dataset_id}")
    if not terms_confirmed:
        raise InputError("--terms-confirmed is required; operator must confirm source rights")
    url = _source_url(source_url, dataset_id)
    if dataset_id == "marine_regions_eez_wfs":
        if source_version not in (None, "CURRENT-SERVICE-SNAPSHOT"):
            raise InputError("WFS source version is unestablished; do not label it bulk v12")
        if retrieved_at is None or source_feature_count is None:
            raise InputError("WFS import requires --retrieved-at and --source-feature-count")
    elif source_version != manifest.version:
        raise InputError(f"registered version is {manifest.version}; require --source-version")
    retrieved = _utc_timestamp(retrieved_at) if retrieved_at else None
    if source_feature_count is not None and not 1 <= source_feature_count <= MAX_FEATURES:
        raise InputError("source-feature-count must be between 1 and 50,000")
    source = source.expanduser()
    if source.is_symlink():
        raise InputError("source must not be a symlink")
    source = source.resolve(strict=True)
    if not source.is_file():
        raise InputError("source must be a regular local file")
    if not 0 < source.stat().st_size <= MAX_INPUT_BYTES:
        raise InputError("source file is empty or exceeds the 256 MiB input limit")
    target = _guard_destination(data_dir, source, dataset_id, manifest.version)
    digest = sha256_of(source)
    if expected_source_sha256 and digest != _require_sha256(expected_source_sha256):
        raise InputError("source SHA-256 mismatch; input bytes differ from expected source")
    payload, format_name, source_size = _read_geojson(source)
    prepared, feature_count, vertices = _prepared(payload, dataset_id)
    if source_feature_count is not None and feature_count != source_feature_count:
        raise InputError(f"feature count mismatch: expected {source_feature_count}, got {feature_count}")

    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    lock = parent / ".dfx14-install.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise InputError(f"install lock already exists: {lock}; inspect before removal") from exc
    try:
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            handle.write(str(os.getpid()))
        _recover(parent, target)
        if target.exists() and not replace:
            raise InputError(f"installation exists: {target}; use --replace")
        with tempfile.TemporaryDirectory(prefix=".dfx14-stage-", dir=parent) as staging:
            staged_root = Path(staging)
            # The shared store serialises and records the canonical PREPARED digest.
            # A raw-source digest is NEVER passed as the prepared publisher digest.
            candidate = install(staged_root, dataset_id, prepared, retrieved_at=retrieved)
            if candidate.status is not InstallStatus.CHECKSUM_UNRECORDED:
                raise InputError(f"unexpected staged install status: {candidate.status.value}")
            staged = dataset_dir(staged_root, dataset_id, manifest.version)
            receipt = {
                "dataset_id": dataset_id,
                "source_url_declared": url,
                "source_version_declared": source_version,
                "source_retrieved_at_declared": retrieved,
                "terms_confirmed_by_operator": True,
                "license_from_registered_manifest": manifest.license.value,
                "source_sha256_observed": digest,
                "expected_source_sha256_operator_supplied": expected_source_sha256.lower()
                if expected_source_sha256 else None,
                "source_format": format_name,
                "source_file_size": source_size,
                "source_feature_count_declared": source_feature_count,
                "prepared_feature_count": feature_count,
                "prepared_vertices": vertices,
                "prepared_sha256_observed": candidate.computed_sha256,
                "publisher_source_verified": False,
                "publisher_prepared_checksum_verified": False,
                "note": "Local source integrity does not prove publisher origin or source version.",
            }
            (staged / "ingestion.json").write_text(
                json.dumps(receipt, indent=2, sort_keys=True), encoding="utf-8"
            )
            retained_backup = _publish(staged, target, replace=replace)
        installed = status_of(data_dir, dataset_id)
        if installed.status is not InstallStatus.CHECKSUM_UNRECORDED:
            raise InputError(f"published installation verification failed: {installed.status.value}")
        return {"status": installed.status.value, "dataset_id": dataset_id,
                "version": manifest.version, "installed_path": str(target),
                "features": feature_count, "vertices": vertices,
                "source_sha256": digest, "prepared_sha256": installed.computed_sha256,
                "publisher_verified": False, "retained_backup": retained_backup}
    finally:
        lock.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(
        "Offline, locally sourced GeoJSON installer. No downloads or publisher verification. "
        "The installed status remains CHECKSUM_UNRECORDED without an authenticated "
        "publisher checksum of the prepared payload."
    ))
    parser.add_argument("--dataset", required=True, choices=DATASETS)
    parser.add_argument("--input", required=True, type=Path, help="Local GeoJSON or ZIP/GeoJSON")
    parser.add_argument("--data-dir", required=True, type=Path, help="DarkFleet persistent data directory")
    parser.add_argument("--source-url", required=True, help="Declared HTTPS publisher source URL")
    parser.add_argument("--source-version", help="Declared static release; must match registry")
    parser.add_argument("--retrieved-at", help="Actual source retrieval ISO 8601 timestamp")
    parser.add_argument("--source-feature-count", type=int, help="Publisher-reported expected count")
    parser.add_argument("--expected-source-sha256", help="Externally obtained checksum of INPUT bytes")
    parser.add_argument("--terms-confirmed", action="store_true",
                        help="Confirm that you obtained the payload lawfully and reviewed its terms")
    parser.add_argument("--replace", action="store_true", help="Explicitly replace this version")
    args = parser.parse_args(argv)
    try:
        outcome = install_local(
            data_dir=args.data_dir, source=args.input, dataset_id=args.dataset,
            source_url=args.source_url, source_version=args.source_version,
            retrieved_at=args.retrieved_at, source_feature_count=args.source_feature_count,
            expected_source_sha256=args.expected_source_sha256,
            terms_confirmed=args.terms_confirmed, replace=args.replace,
        )
    except (InputError, OSError, ValueError) as exc:
        print(f"INSTALL REJECTED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(outcome, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
