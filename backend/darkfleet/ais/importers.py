"""File importers: CSV / JSON / NMEA (!AIVDM via pyais) / Parquet. (AIS-005)"""

from __future__ import annotations

import csv
import json
import logging
from pathlib import Path
from typing import Any

from .models import AisObservation
from .normalize import normalize_marinecadastre, normalize_pyais

logger = logging.getLogger(__name__)


def import_csv(path: str | Path, *, mapping: str = "marinecadastre") -> list[AisObservation]:
    out: list[AisObservation] = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            o = normalize_marinecadastre(row) if mapping == "marinecadastre" else None
            if o is not None:
                out.append(o)
    return out


def import_json(path: str | Path) -> list[AisObservation]:
    data = json.loads(Path(path).read_text())
    rows = data if isinstance(data, list) else data.get("observations", [])
    out: list[AisObservation] = []
    for r in rows:
        o = normalize_marinecadastre(r)
        if o is not None:
            out.append(o)
    return out


def import_nmea(path: str | Path, source: str = "nmea-import") -> list[AisObservation]:
    """Decode !AIVDM/!AIVDO sentences with pyais. Returns [] for garbage input."""
    from pyais import decode

    out: list[AisObservation] = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line.startswith("!"):
            continue
        try:
            msg = decode(line)
            o = normalize_pyais(msg, source)
            if o is not None:
                out.append(o)
        except Exception as exc:  # noqa: BLE001 — third-party decoder must never kill a bulk import
            logger.debug("skipping undecodable NMEA line: %s", exc)
            continue
    return out


def import_parquet(path: str | Path) -> list[dict[str, Any]]:
    import pyarrow.parquet as pq

    rows: list[dict[str, Any]] = pq.read_table(path).to_pylist()
    return rows
