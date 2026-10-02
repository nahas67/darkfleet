"""GREEN-3 gate: AIS observation and track delivery.

The archive already existed and was queryable; nothing exposed it over HTTP, so
a track could not be drawn and a vessel's history could not be shown. These tests
cover the delivery that was added, and they are mostly about what the API
REFUSES to claim:

* a measured zero is distinguishable from a never-reported value;
* "no observations" is distinguishable from "no coverage here";
* an unassociated target never borrows a nearby vessel's MMSI;
* a malformed MMSI is rejected rather than silently returning an empty track;
* archive reads are reproducible in UTC regardless of the host timezone.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from darkfleet.ais.archive import AisArchive
from darkfleet.ais.models import AisObservation
from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings

BASE = datetime(2026, 3, 1, 12, 0, 0, tzinfo=UTC)
MMSI_FULL = "123456789"
MMSI_BARE = "987654321"


def _obs(mmsi: str, minute: int, **kwargs: object) -> AisObservation:
    defaults: dict[str, object] = {
        "lat": 1.30 + minute * 0.001,
        "lon": 103.80 + minute * 0.001,
        "source": "aistream",
    }
    defaults.update(kwargs)
    return AisObservation(
        timestamp=BASE + timedelta(minutes=minute), mmsi=mmsi, **defaults  # type: ignore[arg-type]
    )


@pytest.fixture(scope="module")
def archive_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """An archive holding one fully-reported vessel and one bare vessel."""
    data_dir = tmp_path_factory.mktemp("ais-delivery")
    archive = AisArchive(data_dir)
    rows = [
        _obs(
            MMSI_FULL,
            minute,
            sog=12.5,
            cog=210.0,
            # heading deliberately NOT reported
            name="MV TEST",
            callsign="9V1234",
            imo="9123456",
            ship_type="Cargo",
            length_m=90.0,
            width_m=14.0,
        )
        for minute in (0, 4, 8, 12, 16)
    ]
    # A vessel that broadcast a position and nothing else.
    rows.append(_obs(MMSI_BARE, 20, sog=None, cog=None, name=None, source="aishub"))
    written = archive.append(rows)
    assert written["written"] == len(rows), written
    return data_dir


@pytest.fixture(scope="module")
def client(archive_dir: Path) -> Iterator[TestClient]:
    settings = Settings(data_dir=str(archive_dir))
    with TestClient(create_app(settings)) as test_client:
        yield test_client


# ------------------------------------------------------------------ coverage


def test_coverage_reports_what_the_archive_holds(client: TestClient) -> None:
    response = client.get("/api/ais/coverage")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["state"] == "AVAILABLE"
    assert body["observation_count"] == 6
    assert set(body["sources"]) == {"aistream", "aishub"}


def test_coverage_without_an_archive_is_not_configured_not_empty(
    tmp_path: Path,
) -> None:
    """An absent source must not read as an empty sea."""
    settings = Settings(data_dir=str(tmp_path / "empty"))
    with TestClient(create_app(settings)) as bare:
        body = bare.get("/api/ais/coverage").json()
    assert body["state"] == "NOT_CONFIGURED"
    assert body["observation_count"] is None
    assert "not the same as an empty sea" in body["detail"]


# --------------------------------------------------------------------- track


def test_track_returns_observed_positions_in_time_order(client: TestClient) -> None:
    body = client.get(f"/api/vessels/{MMSI_FULL}/track").json()
    assert body["mmsi"] == MMSI_FULL
    assert len(body["observations"]) == 5
    stamps = [o["timestamp"] for o in body["observations"]]
    assert stamps == sorted(stamps), "track must be time-ordered"


def test_track_resolves_identity_from_observed_data(client: TestClient) -> None:
    body = client.get(f"/api/vessels/{MMSI_FULL}/track").json()
    assert body["ship_name"] == "MV TEST"
    assert body["callsign"] == "9V1234"
    assert body["imo"] == "9123456"
    assert body["ship_type"] == "Cargo"
    assert body["length_m"] == 90.0


def test_unreported_measurements_stay_null(client: TestClient) -> None:
    """The headline truthfulness property.

    ``heading`` was never sent by this vessel. Delivering ``0`` would claim the
    vessel was pointing north, and would put a fabricated number into the heading
    score of any correlation that consumed it.
    """
    body = client.get(f"/api/vessels/{MMSI_FULL}/track").json()
    for observation in body["observations"]:
        assert observation["heading"] is None, observation
        assert observation["sog"] == 12.5
        assert observation["cog"] == 210.0


def test_a_bare_vessel_reports_nothing_rather_than_zeroes(client: TestClient) -> None:
    body = client.get(f"/api/vessels/{MMSI_BARE}/track").json()
    assert len(body["observations"]) == 1
    observation = body["observations"][0]
    for field in ("sog", "cog", "heading", "ship_name", "callsign", "imo", "ship_type"):
        assert observation[field] is None, f"{field} must be null, got {observation[field]!r}"
    # Identity is resolved only from what was reported.
    assert body["ship_name"] is None
    assert body["coverage"]["observation_count"] == 1


def test_track_timestamps_are_utc_not_host_local(client: TestClient) -> None:
    """Archive reads must not depend on the machine's timezone.

    DuckDB renders a TIMESTAMP WITH TIME ZONE in the SESSION timezone. Unpinned,
    the same row came back as 17:30+05:30 for an observation recorded at 12:00Z:
    the same instant, a different serialisation, and a range filter that can
    silently exclude rows at the window edge.
    """
    body = client.get(f"/api/vessels/{MMSI_FULL}/track").json()
    for observation in body["observations"]:
        stamp = observation["timestamp"]
        assert stamp.endswith("Z") or "+00:00" in stamp, stamp


def test_malformed_mmsi_is_rejected_not_returned_empty(client: TestClient) -> None:
    for bad in ("12345", "1234567890", "abcdefghi", ""):
        response = client.get(f"/api/vessels/{bad}/track")
        assert response.status_code in (400, 404), (bad, response.status_code)


def test_unknown_but_wellformed_mmsi_is_a_real_zero(client: TestClient) -> None:
    """A valid MMSI with no archive rows is a measured absence, not a gap."""
    body = client.get("/api/vessels/555555555/track").json()
    assert body["observations"] == []
    assert body["coverage"]["state"] == "AVAILABLE"
    assert body["coverage"]["observation_count"] == 0


# ------------------------------------------------------------- scan delivery


def test_scan_ais_without_a_scan_is_404(client: TestClient) -> None:
    assert client.get("/api/scans/DF-9999/ais").status_code == 404


def test_target_ais_without_a_target_is_404(client: TestClient) -> None:
    assert client.get("/api/targets/NOPE/ais-observations").status_code == 404


# ------------------------------------------------------------ model contract


def test_optional_measurements_are_nullable_on_the_model() -> None:
    """A missing measurement must be representable, not defaulted to zero."""
    bare = AisObservation(timestamp=BASE, mmsi=MMSI_BARE, lat=1.0, lon=2.0)
    assert bare.sog is None
    assert bare.heading is None
    assert bare.name is None


def test_ais_heading_sentinel_is_not_clamped_to_zero() -> None:
    """511 means 'heading not available'. Clamping it would invent a course."""
    from darkfleet.ais.normalize import normalize_aistream

    observation = normalize_aistream(
        {
            "MetaData": {"MMSI": MMSI_BARE, "time_utc": "2026-03-01T12:00:00Z"},
            "Message": {
                "PositionReport": {
                    "Latitude": 1.0,
                    "Longitude": 2.0,
                    "Sog": 0.0,
                    "Cog": 511.0,
                    "TrueHeading": 511,
                }
            },
        }
    )
    assert observation is not None
    assert observation.heading is None, observation.heading
    assert observation.cog is None, observation.cog
    # A genuine zero speed IS a measurement and survives.
    assert observation.sog == 0.0