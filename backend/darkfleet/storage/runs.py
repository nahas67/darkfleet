"""Durable scan / evidence record store (OPS-013) with the OPS-014 guard.

Every scan becomes one JSON document under ``root/scans/<scan_id>.json``. State
lives on disk, never in memory: a new :class:`RunStore` over the same root sees
every previously saved record.

The isolation guard is the point of this module. Any record written here must
carry a ``runtime_mode`` of ``"DEMO"`` or ``"REAL"`` **and** a boolean
``synthetic`` flag, and the two must agree: ``REAL`` may never claim synthetic
data and ``DEMO`` may never claim real data. Violations raise
:class:`ValueError` at :meth:`RunStore.save` time, so a mislabelled artifact
never reaches disk.

``root`` is the run root; :func:`run_store_for_data_dir` maps the project-level
``settings.data_dir`` onto the ``data/scans/`` layout used by the CLI/API.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any, Final, Literal

__all__ = [
    "RUNTIME_MODES",
    "RunRecordError",
    "RunStore",
    "mark_synthetic",
    "run_store_for_data_dir",
]

RUNTIME_MODES: Final[tuple[str, ...]] = ("DEMO", "REAL")
RuntimeMode = Literal["DEMO", "REAL"]

RUNTIME_MODE_FIELD: Final[str] = "runtime_mode"
SYNTHETIC_FIELD: Final[str] = "synthetic"
SCAN_ID_FIELD: Final[str] = "scan_id"

SCHEMA_VERSION: Final[int] = 1

#: ``DEMO`` always means synthetic, ``REAL`` always means not synthetic. The map
#: is the single source of truth used by both the stamper and the validator.
_EXPECTED_SYNTHETIC: Final[dict[str, bool]] = {"DEMO": True, "REAL": False}

#: Module-level alias so that the ``list()`` method name cannot shadow the
#: builtin inside class-level annotations.
_RecordList = list[dict[str, Any]]
_PathList = list[Path]


class RunRecordError(ValueError):
    """Raised when a run record violates the DEMO/REAL isolation guard.

    Subclasses :class:`ValueError` so callers may catch either.
    """


def _validate_runtime_mode(value: object) -> str:
    if not isinstance(value, str):
        raise RunRecordError(f"{RUNTIME_MODE_FIELD} must be a string, got {type(value).__name__}")
    if value not in RUNTIME_MODES:
        raise RunRecordError(
            f"{RUNTIME_MODE_FIELD} must be one of {RUNTIME_MODES}, got {value!r}"
        )
    return value


def _assert_consistent(record: Mapping[str, Any]) -> None:
    """Enforce the OPS-014 guard: mode present, flag present, flag agrees."""
    if RUNTIME_MODE_FIELD not in record:
        raise RunRecordError(f"record must carry {RUNTIME_MODE_FIELD!r} ('DEMO' or 'REAL')")
    mode = _validate_runtime_mode(record[RUNTIME_MODE_FIELD])

    if SYNTHETIC_FIELD not in record:
        raise RunRecordError(f"record must carry a {SYNTHETIC_FIELD!r} boolean flag")
    synthetic = record[SYNTHETIC_FIELD]
    if not isinstance(synthetic, bool):
        raise RunRecordError(
            f"{SYNTHETIC_FIELD} must be a bool, got {type(synthetic).__name__}"
        )

    expected = _EXPECTED_SYNTHETIC[mode]
    if synthetic is not expected:
        raise RunRecordError(
            f"isolation guard: runtime_mode={mode!r} requires {SYNTHETIC_FIELD}={expected}, "
            f"got {synthetic}"
        )


def mark_synthetic(
    record: Mapping[str, Any],
    synthetic: bool,
    runtime_mode: RuntimeMode | None = None,
) -> dict[str, Any]:
    """Return a copy of ``record`` with both isolation fields stamped correctly.

    ``synthetic=True`` implies ``runtime_mode="DEMO"`` and ``synthetic=False``
    implies ``runtime_mode="REAL"``. Passing an explicit ``runtime_mode`` that
    disagrees with ``synthetic`` raises :class:`RunRecordError`, so the helper
    cannot be used to launder a mislabelled record.
    """
    mode = "DEMO" if synthetic else "REAL"
    if runtime_mode is not None:
        requested = _validate_runtime_mode(runtime_mode)
        if requested != mode:
            raise RunRecordError(
                f"runtime_mode={requested!r} contradicts synthetic={synthetic}"
            )
    stamped = dict(record)
    stamped[RUNTIME_MODE_FIELD] = mode
    stamped[SYNTHETIC_FIELD] = synthetic
    return stamped


class RunStore:
    """Filesystem-backed store of scan/evidence documents.

    Layout::

        <root>/scans/<scan_id>.json

    Documents are written atomically (temp file + ``os.replace``) so a crash
    mid-write cannot leave a half-written record that later reads as truth.
    """

    def __init__(self, root: Path, *, scans_subdir: str = "scans") -> None:
        if not scans_subdir or scans_subdir in {".", ".."} or any(
            char in scans_subdir for char in ("/", "\\", "\x00")
        ):
            raise ValueError(f"scans_subdir must be a simple directory name, got {scans_subdir!r}")
        self._root = Path(root)
        self._scans_dir = self._root / scans_subdir
        self._counters = {"saves": 0, "loads": 0, "deletes": 0}

    # -- introspection ---------------------------------------------------

    @property
    def root(self) -> Path:
        return self._root

    @property
    def scans_dir(self) -> Path:
        """Directory holding one JSON document per scan."""
        return self._scans_dir

    def stats(self) -> dict[str, int]:
        """Real counters for actual store operations performed by this instance."""
        return dict(self._counters)

    # -- internals -------------------------------------------------------

    @staticmethod
    def _validate_scan_id(scan_id: str) -> str:
        if not isinstance(scan_id, str) or not scan_id.strip():
            raise RunRecordError("scan_id must be a non-empty string")
        if scan_id != scan_id.strip():
            raise RunRecordError(f"scan_id must not have surrounding whitespace: {scan_id!r}")
        if scan_id in {".", ".."} or any(char in scan_id for char in ("/", "\\", "\x00", ":")):
            raise RunRecordError(f"scan_id must not contain path separators: {scan_id!r}")
        if len(scan_id) > 200:
            raise RunRecordError("scan_id must be at most 200 characters")
        return scan_id

    def _path(self, scan_id: str) -> Path:
        return self._scans_dir / f"{scan_id}.json"

    def _atomic_write(self, path: Path, data: bytes) -> None:
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

    @staticmethod
    def _read_document(path: Path) -> dict[str, Any] | None:
        try:
            raw = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None
        try:
            document = json.loads(raw)
        except ValueError:
            return None
        return document if isinstance(document, dict) else None

    # -- public API ------------------------------------------------------

    def save(self, record: Mapping[str, Any]) -> Path:
        """Validate and persist one evidence document; return its path.

        Raises :class:`RunRecordError` (a ``ValueError``) if ``scan_id`` is
        missing/invalid or the DEMO/REAL isolation guard is violated.
        """
        if not isinstance(record, Mapping):
            raise RunRecordError(f"record must be a mapping, got {type(record).__name__}")
        if SCAN_ID_FIELD not in record:
            raise RunRecordError(f"record must carry {SCAN_ID_FIELD!r}")
        scan_id = self._validate_scan_id(record[SCAN_ID_FIELD])

        _assert_consistent(record)

        document = dict(record)
        document["schema_version"] = int(document.get("schema_version", SCHEMA_VERSION))
        path = self._path(scan_id)
        self._atomic_write(
            path,
            json.dumps(document, sort_keys=True, indent=2, default=str).encode("utf-8"),
        )
        self._counters["saves"] += 1
        return path

    def get(self, scan_id: str) -> dict[str, Any] | None:
        """Return the stored document, or ``None`` when absent/unreadable."""
        self._validate_scan_id(scan_id)
        document = self._read_document(self._path(scan_id))
        if document is not None:
            self._counters["loads"] += 1
        return document

    def exists(self, scan_id: str) -> bool:
        return self._path(self._validate_scan_id(scan_id)).is_file()

    def list_ids(self) -> list[str]:
        """Sorted scan ids currently on disk. An empty store yields ``[]``."""
        if not self._scans_dir.is_dir():
            return []
        return sorted(path.stem for path in self._scans_dir.glob("*.json"))

    def list(self) -> _RecordList:
        """Alias for :meth:`get_all` kept for call-site readability."""
        return self.get_all()

    def get_all(self) -> _RecordList:
        """Every readable document, ordered by scan id. Survives restarts."""
        documents: _RecordList = []
        for scan_id in self.list_ids():
            document = self._read_document(self._path(scan_id))
            if document is not None:
                documents.append(document)
        return documents

    def delete(self, scan_id: str) -> bool:
        """Delete one record. Returns True only when a file was removed."""
        path = self._path(self._validate_scan_id(scan_id))
        if not path.is_file():
            return False
        try:
            path.unlink()
        except OSError as exc:
            raise RunRecordError(f"could not delete {scan_id!r}: {exc}") from exc
        self._counters["deletes"] += 1
        return True

    def save_many(self, records: Iterable[Mapping[str, Any]]) -> _PathList:
        """Save several records, returning their paths in input order."""
        return [self.save(record) for record in records]

    def load_many(self, scan_ids: Iterable[str]) -> _RecordList:
        """Load several documents by id, skipping ids that are absent."""
        loaded: _RecordList = []
        for scan_id in scan_ids:
            document = self.get(scan_id)
            if document is not None:
                loaded.append(document)
        return loaded


def run_store_for_data_dir(data_dir: Path) -> RunStore:
    """Build a :class:`RunStore` over ``<data_dir>/scans``.

    Passing :attr:`darkfleet.config.settings.Settings.data_dir` yields the
    ``data/scans/<scan_id>.json`` layout the CLI and API expect, since the store
    itself already appends the ``scans/`` subdirectory.
    """
    return RunStore(Path(data_dir))