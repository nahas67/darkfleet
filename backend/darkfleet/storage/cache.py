"""Deterministic content-addressed artifact cache (OPS-004, OPS-005, OPS-006).

The cache maps four inputs -- scene item id, bounding box, processing config and
algorithm version -- to a stable sha256 digest, and stores derived arrays on
disk beneath ``root/<digest[:2]>/<digest>/<artifact_name>.npz``.

Design rules that the tests pin down:

* **Deterministic keys.** Canonical JSON with sorted keys, fixed separators and
  no NaN/Infinity, so two equal configs built in a different insertion order
  produce the same digest.
* **Real counters.** ``hits``/``misses``/``writes``/``evictions`` are moved by
  actual calls, not by best-effort bookkeeping.
* **Restart safe.** Payloads live on disk; a fresh :class:`ArtifactCache` over
  the same root reads them back. Only the counters reset.
* **Corruption is a miss, never a silent success.** Every read verifies a
  recorded sha256 plus shape/dtype before handing an array back.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import tempfile
import zipfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

__all__ = [
    "ArtifactCache",
    "CacheKey",
    "CacheStats",
    "cache_key",
]

#: Bounding-box coordinates are rounded to this many decimal places so that
#: float noise below a pixel cannot fragment the cache.
BBOX_DECIMALS = 6

_META_SUFFIX = ".meta.json"

_STORAGE_VERSION = 1


def _canonical_bbox(bbox: Sequence[float]) -> tuple[float, float, float, float]:
    """Validate ``bbox`` and normalise it to four 6-dp, sign-stable floats."""
    if len(bbox) != 4:
        raise ValueError(f"bbox must have exactly 4 values, got {len(bbox)}")
    out: list[float] = []
    for value in bbox:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError(f"bbox values must be finite, got {value!r}")
        rounded = round(number, BBOX_DECIMALS)
        # Collapse -0.0 into 0.0 so the two never hash to different digests.
        out.append(0.0 if rounded == 0.0 else rounded)
    return (out[0], out[1], out[2], out[3])


def _canonical_json(value: object) -> str:
    """Serialise ``value`` so that equal values produce byte-equal output."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )


@dataclass(frozen=True, eq=False)
class CacheKey:
    """Content-addressed cache key with inspectable components.

    The digest folds in the four defining inputs; the same inputs stay available
    as fields so a caller can log exactly what produced an artifact.
    """

    scene_item_id: str
    bbox: tuple[float, float, float, float]
    processing_config: Mapping[str, Any] = field(default_factory=dict)
    algorithm_version: str = ""

    def __post_init__(self) -> None:
        if not self.scene_item_id or not self.scene_item_id.strip():
            raise ValueError("scene_item_id must be a non-empty string")
        if not self.algorithm_version or not self.algorithm_version.strip():
            raise ValueError("algorithm_version must be a non-empty string")
        # Normalise once so callers and the digest share a single view, and so
        # a later mutation of the caller's dict cannot change the key.
        frozen = json.loads(_canonical_json(dict(self.processing_config)))
        object.__setattr__(self, "processing_config", frozen)

    @property
    def canonical(self) -> str:
        """Canonical JSON string that is hashed into :attr:`digest`."""
        return _canonical_json(
            {
                "algorithm_version": self.algorithm_version,
                "bbox": list(self.bbox),
                "processing_config": dict(self.processing_config),
                "scene_item_id": self.scene_item_id,
            }
        )

    @property
    def digest(self) -> str:
        """Stable sha256 hex digest (64 lowercase hex chars)."""
        return hashlib.sha256(self.canonical.encode("utf-8")).hexdigest()

    @property
    def shard(self) -> str:
        """First two hex characters, used as the directory shard."""
        return self.digest[:2]

    @property
    def directory(self) -> str:
        """Full digest, used as the per-entry directory name."""
        return self.digest

    def __str__(self) -> str:
        return self.digest

    def __eq__(self, other: object) -> bool:
        return isinstance(other, CacheKey) and other.digest == self.digest

    def __hash__(self) -> int:
        return hash(self.digest)


def cache_key(
    scene_item_id: str,
    bbox: Sequence[float],
    processing_config: Mapping[str, Any],
    algorithm_version: str,
) -> CacheKey:
    """Build a :class:`CacheKey` from the four cache-defining inputs."""
    return CacheKey(
        scene_item_id=scene_item_id,
        bbox=_canonical_bbox(bbox),
        processing_config=dict(processing_config),
        algorithm_version=algorithm_version,
    )


@dataclass(frozen=True)
class CacheStats:
    """Real, monotonically increasing counters for one cache instance."""

    hits: int = 0
    misses: int = 0
    writes: int = 0
    evictions: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "hits": self.hits,
            "misses": self.misses,
            "writes": self.writes,
            "evictions": self.evictions,
        }


class _Counters:
    """Mutable counter block; :meth:`ArtifactCache.stats` snapshots it."""

    __slots__ = ("evictions", "hits", "misses", "writes")

    def __init__(self) -> None:
        self.hits = 0
        self.misses = 0
        self.writes = 0
        self.evictions = 0


class ArtifactCache:
    """On-disk artifact cache rooted at ``root``.

    Parameters
    ----------
    root:
        Directory that receives ``<digest[:2]>/<digest>/`` shards. Created on
        first write.
    algorithm_version:
        Version string of the producing algorithm. Keys built with any other
        version are refused, so a stale processor cannot poison the cache.
    max_artifacts:
        Optional cap on stored ``.npz`` files. When exceeded, the oldest entries
        are evicted and ``evictions`` moves.
    """

    def __init__(
        self,
        root: Path,
        algorithm_version: str,
        *,
        max_artifacts: int | None = None,
    ) -> None:
        if not algorithm_version or not algorithm_version.strip():
            raise ValueError("algorithm_version must be a non-empty string")
        if max_artifacts is not None and max_artifacts < 1:
            raise ValueError("max_artifacts must be >= 1 when provided")
        self._root = Path(root)
        self._algorithm_version = algorithm_version
        self._max_artifacts = max_artifacts
        self._counters = _Counters()

    # -- introspection ---------------------------------------------------

    @property
    def root(self) -> Path:
        return self._root

    @property
    def algorithm_version(self) -> str:
        return self._algorithm_version

    def stats(self) -> dict[str, int]:
        """Return the real counter snapshot as a plain dict."""
        return {
            "hits": self._counters.hits,
            "misses": self._counters.misses,
            "writes": self._counters.writes,
            "evictions": self._counters.evictions,
        }

    def stats_snapshot(self) -> CacheStats:
        """Same counters as a frozen :class:`CacheStats` value object."""
        return CacheStats(
            hits=self._counters.hits,
            misses=self._counters.misses,
            writes=self._counters.writes,
            evictions=self._counters.evictions,
        )

    # -- internals -------------------------------------------------------

    def _entry_dir(self, key: CacheKey) -> Path:
        return self._root / key.shard / key.directory

    def _artifact_path(self, key: CacheKey, artifact_name: str) -> Path:
        return self._entry_dir(key) / f"{artifact_name}.npz"

    def _meta_path(self, key: CacheKey, artifact_name: str) -> Path:
        return self._entry_dir(key) / f"{artifact_name}{_META_SUFFIX}"

    def _check_version(self, key: CacheKey) -> None:
        if key.algorithm_version != self._algorithm_version:
            raise ValueError(
                f"cache key algorithm_version {key.algorithm_version!r} "
                f"does not match cache {self._algorithm_version!r}"
            )

    @staticmethod
    def _check_artifact_name(artifact_name: str) -> str:
        if not artifact_name or not artifact_name.strip():
            raise ValueError("artifact_name must be a non-empty string")
        if artifact_name != artifact_name.strip():
            raise ValueError(
                f"artifact_name must not have surrounding whitespace: {artifact_name!r}"
            )
        if artifact_name in {".", ".."} or any(
            char in artifact_name for char in ("/", "\\", "\x00")
        ):
            raise ValueError(f"artifact_name must not contain path separators: {artifact_name!r}")
        return artifact_name

    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
            os.replace(tmp_name, path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def _stored_artifacts(self) -> list[Path]:
        """All stored artifacts, oldest write first (mtime, then path)."""
        artifacts = self._root.glob("*/*/*.npz")
        ordered = [(path.stat().st_mtime_ns, path.name, path) for path in artifacts]
        ordered.sort(key=lambda item: (item[0], item[1]))
        return [item[2] for item in ordered]

    def _enforce_capacity(self) -> None:
        if self._max_artifacts is None:
            return
        artifacts = self._stored_artifacts()
        while len(artifacts) > self._max_artifacts:
            victim = artifacts.pop(0)
            try:
                victim.unlink()
            except FileNotFoundError:
                continue
            try:
                victim.with_suffix(_META_SUFFIX).unlink()
            except OSError:
                pass
            self._counters.evictions += 1

    # -- public API ------------------------------------------------------

    def get(self, key: CacheKey, artifact_name: str) -> np.ndarray | None:
        """Return the cached array, or ``None`` plus exactly one counted miss.

        Any of: unknown key, missing file, truncated/corrupt file, checksum
        mismatch, shape/dtype drift -- all count as one miss, never a silent
        success.
        """
        self._check_version(key)
        name = self._check_artifact_name(artifact_name)
        artifact = self._artifact_path(key, name)
        meta_path = self._meta_path(key, name)

        if not artifact.is_file() or not meta_path.is_file():
            self._counters.misses += 1
            return None

        try:
            raw = artifact.read_bytes()
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self._counters.misses += 1
            return None

        if not isinstance(meta, dict):
            self._counters.misses += 1
            return None

        expected_sha = meta.get("sha256")
        if not isinstance(expected_sha, str):
            self._counters.misses += 1
            return None
        if hashlib.sha256(raw).hexdigest() != expected_sha:
            # Truncated or tampered payload: refuse rather than return garbage.
            self._counters.misses += 1
            return None

        try:
            with np.load(io.BytesIO(raw), allow_pickle=False) as bundle:
                if name not in bundle.files:
                    self._counters.misses += 1
                    return None
                array = np.array(bundle[name])
        except (OSError, ValueError, KeyError, zipfile.BadZipFile):
            self._counters.misses += 1
            return None

        if list(array.shape) != list(meta.get("shape", [])):
            self._counters.misses += 1
            return None
        if array.dtype.str != meta.get("dtype"):
            self._counters.misses += 1
            return None

        self._counters.hits += 1
        return array

    def put(self, key: CacheKey, artifact_name: str, payload: np.ndarray) -> Path:
        """Store ``payload`` under ``key``/``artifact_name``; return its path."""
        self._check_version(key)
        name = self._check_artifact_name(artifact_name)
        array = np.asarray(payload)
        if array.dtype.hasobject:
            raise ValueError("payload dtype must not be object dtype")

        entry = self._entry_dir(key)
        entry.mkdir(parents=True, exist_ok=True)

        buffer = io.BytesIO()
        # Bind the payload to its artifact name; numpy's savez stub types the
        # **kwargs slot loosely, so go through a typed mapping.
        named: dict[str, Any] = {name: array}
        np.savez(buffer, **named)
        raw = buffer.getvalue()

        meta = {
            "algorithm_version": key.algorithm_version,
            "artifact_name": name,
            "digest": key.digest,
            "dtype": array.dtype.str,
            "scene_item_id": key.scene_item_id,
            "shape": list(array.shape),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "storage_version": _STORAGE_VERSION,
        }

        artifact = self._artifact_path(key, name)
        self._atomic_write(artifact, raw)
        self._atomic_write(
            self._meta_path(key, name),
            json.dumps(meta, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        )
        self._counters.writes += 1
        self._enforce_capacity()
        return artifact

    def contains(self, key: CacheKey, artifact_name: str) -> bool:
        """Cheap existence probe that does not move hit/miss counters."""
        self._check_version(key)
        name = self._check_artifact_name(artifact_name)
        return self._artifact_path(key, name).is_file()

    def delete(self, key: CacheKey, artifact_name: str) -> bool:
        """Remove one artifact. Returns True when a file was actually removed."""
        self._check_version(key)
        name = self._check_artifact_name(artifact_name)
        artifact = self._artifact_path(key, name)
        removed = False
        if artifact.is_file():
            artifact.unlink()
            removed = True
        try:
            self._meta_path(key, name).unlink()
        except OSError:
            pass
        return removed