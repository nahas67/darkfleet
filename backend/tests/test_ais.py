"""CP4 gate: AIS subsystem (AIS-001..016 except live-network runs)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from darkfleet.ais.archive import AisArchive
from darkfleet.ais.collector import AishubPoller, AistreamCollector
from darkfleet.ais.gfw import GfwClient, normalize_gfw_event
from darkfleet.ais.importers import import_csv, import_nmea
from darkfleet.ais.models import AisObservation
from darkfleet.ais.normalize import (
    normalize_aishub,
    normalize_aistream,
    normalize_marinecadastre,
)
from darkfleet.providers import RealDataUnavailableError

T0 = datetime(2024, 12, 24, 22, 40, tzinfo=UTC)


def _obs(mmsi: str, minutes: int, lon: float, source: str = "file-import") -> AisObservation:
    from datetime import timedelta

    return AisObservation(
        timestamp=T0 + timedelta(minutes=minutes),
        mmsi=mmsi,
        lat=1.27,
        lon=lon,
        sog=12.0,
        cog=90.0,
        heading=90.0,
        nav_status="Under Way",
        name=f"VESSEL-{mmsi[-3:]}",
        source=source,
    )


def test_canonical_rejects_bad_mmsi() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        AisObservation(
            timestamp=T0, mmsi="123", lat=0.0, lon=0.0, source="test",
        )


def test_normalize_aistream() -> None:
    msg = {
        "MetaData": {"MMSI": "563189210", "time_utc": "2024-12-24 22:40:00"},
        "Message": {
            "PositionReport": {
                "Latitude": 1.27,
                "Longitude": 103.82,
                "Sog": 14.8,
                "Cog": 122.0,
                "TrueHeading": 122,
                "NavigationalStatus": 0,
            },
            "ShipStaticData": {"Name": "MAERSK TEST", "Callsign": "9VAB", "ImoNumber": 9619907},
        },
    }
    o = normalize_aistream(msg)
    assert o is not None and o.mmsi == "563189210" and o.source == "aistream"
    assert o.name == "MAERSK TEST" and o.sog == 14.8


def test_normalize_aishub_row() -> None:
    row = ["477421900", 1735078800, 103.85, 1.29, 304.0, 13.2, 304, "COSCO TEST", "Under Way"]
    o = normalize_aishub(row)
    assert o is not None and o.mmsi == "477421900" and o.lon == 103.85


def test_normalize_marinecadastre_row() -> None:
    row = {
        "MMSI": "366999000",
        "BaseDateTime": "2024-12-24T22:40:00",
        "LAT": "29.5",
        "LON": "-88.2",
        "SOG": "10.1",
        "COG": "45.0",
        "Heading": "46",
        "VesselName": "GULF TEST",
        "IMO": "1234567",
        "CallSign": "WXYZ",
        "VesselType": "Tanker",
        "Status": "Under Way",
        "Length": "200",
        "Width": "32",
    }
    o = normalize_marinecadastre(row)
    assert o is not None and o.length_m == 200.0 and o.source == "marinecadastre"


def test_pyais_decodes_real_sentence() -> None:
    from pyais import decode  # type: ignore[import-untyped]

    from darkfleet.ais.normalize import normalize_pyais

    msg = decode("!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C")
    d = dict(msg.asdict())
    assert -90 <= float(d["lat"]) <= 90 and -180 <= float(d["lon"]) <= 180
    o = normalize_pyais(msg)
    assert o is not None and len(o.mmsi) == 9


def test_archive_roundtrip_dedup_query_restart(tmp_path: Path) -> None:
    archive = AisArchive(tmp_path)
    rows = [_obs("563189210", 0, 103.82), _obs("563189210", 5, 103.83), _obs("477421900", 2, 103.85)]
    assert archive.append(rows) == {"written": 3, "duplicates": 0}
    assert archive.append(rows) == {"written": 0, "duplicates": 3}

    from datetime import timedelta

    got = archive.query(T0 - timedelta(hours=1), T0 + timedelta(hours=1))
    assert len(got) == 3
    assert [r["mmsi"] for r in got] == ["563189210", "477421900", "563189210"]  # time-ordered
    assert len(archive.query(T0 - timedelta(hours=1), T0 + timedelta(hours=1), mmsi="477421900")) == 1
    assert (
        len(archive.query(T0 - timedelta(hours=1), T0 + timedelta(hours=1), bbox=(103.84, 1.2, 103.9, 1.3)))
        == 1
    )
    cov = archive.coverage()
    assert cov["observations"] == 3 and cov["sources"] == ["file-import"]

    # Restart: new instance over the same directory keeps everything.
    archive2 = AisArchive(tmp_path)
    assert archive2.append(rows) == {"written": 0, "duplicates": 3}
    assert len(archive2.query(T0 - timedelta(hours=1), T0 + timedelta(hours=1))) == 3


def test_csv_import(tmp_path: Path) -> None:
    p = tmp_path / "mc.csv"
    p.write_text(
        "MMSI,BaseDateTime,LAT,LON,SOG,COG,Heading,VesselName,IMO,CallSign,VesselType,Status,Length,Width\n"
        "366999000,2024-12-24T22:40:00,29.5,-88.2,10.1,45.0,46,GULF TEST,1234567,WXYZ,Tanker,Under Way,200,32\n"
    )
    rows = import_csv(p)
    assert len(rows) == 1 and rows[0].name == "GULF TEST"


def test_nmea_import(tmp_path: Path) -> None:
    p = tmp_path / "feed.nmea"
    p.write_text("!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C\ngarbage line\n")
    rows = import_nmea(p)
    assert len(rows) == 1 and len(rows[0].mmsi) == 9


def test_collectors_require_keys(tmp_path: Path) -> None:
    archive = AisArchive(tmp_path)
    with pytest.raises(RealDataUnavailableError, match="AISStream"):
        AistreamCollector("", archive)
    with pytest.raises(RealDataUnavailableError, match="AISHub"):
        AishubPoller("", archive)
    with pytest.raises(RealDataUnavailableError, match="Global Fishing Watch"):
        GfwClient("", archive)


def test_normalize_gfw_event() -> None:
    entry = {
        "start": "2024-12-24T22:40:00.000Z",
        "type": "encounter",
        "position": {"lat": 1.28, "lon": 103.84},
        "vessel": {"mmsi": "636019882", "name": "PACIFIC TEST", "imo": "9428798"},
    }
    o = normalize_gfw_event(entry)
    assert o is not None and o.mmsi == "636019882" and o.source == "gfw"
    assert normalize_gfw_event({"start": "2024-12-24T22:40:00Z"}) is None
