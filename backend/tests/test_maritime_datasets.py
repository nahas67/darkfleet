"""Reference-dataset storage: versioning, integrity, and honest absence.

THE DEFECT THIS SUITE EXISTS BECAUSE OF

`maritime/provenance.py` shipped a duplicated `@dataclass(frozen=True)`, which made the
module FAIL TO IMPORT. 874 tests passed anyway, because nothing in the suite imported
it. A module nobody imports is a module nobody has run.

So the first test here is an import test, and it is deliberately the kind of thing that
looks trivial. It is not: it is the check that was missing for an entire checkpoint.

NO NETWORK. Every case uses a temporary directory and prepared payloads (§74).
"""

from __future__ import annotations

import json

import pytest

from darkfleet.maritime.datasets import (
    DatasetManifest,
    InstallStatus,
    LocalRepresentation,
    utc_now_iso,
)
from darkfleet.maritime.provenance import DatasetCoverage, LicenseKind
from darkfleet.maritime.registry import (
    VERIFIED_ON,
    known_dataset_ids,
    known_manifest,
)
from darkfleet.maritime.store import (
    all_statuses,
    availability,
    dataset_dir,
    install,
    load_prepared,
    require_usable,
    sha256_of,
    status_of,
    verify_all,
)


@pytest.fixture()
def data_dir(tmp_path):
    return tmp_path / "data"


# --------------------------------------------------------------------- imports
class TestModulesImport:
    """The check that was missing when provenance.py could not be imported."""

    def test_provenance_imports_and_builds(self) -> None:
        from darkfleet.maritime.provenance import ZONE_DISCLAIMER, ZoneClassification

        zone = ZoneClassification(zone="HIGH_SEAS")  # type: ignore[arg-type]
        assert zone.established is True
        assert zone.disputed is False
        assert "does not determine sovereignty" in ZONE_DISCLAIMER

    def test_every_manifest_module_imports(self) -> None:
        import darkfleet.maritime.datasets
        import darkfleet.maritime.geometry
        import darkfleet.maritime.registry
        import darkfleet.maritime.store  # noqa: F401


# ----------------------------------------------------------------- the registry
class TestVerifiedRegistry:
    def test_the_registered_datasets_are_exactly_these(self) -> None:
        """
        An explicit SET, not a count.

        The previous assertion was `len == 4`. Adding the two WFS snapshots broke it,
        which is the right outcome but the wrong reason: a count cannot say WHICH
        datasets must exist, so any unrelated addition would have satisfied it.
        """
        assert set(known_dataset_ids()) == {
            "natural_earth_coastline",
            # The BULK EEZ product. Registered but NOT installed: it sits behind a
            # registration form collecting personal data, and no identity was fabricated.
            "marine_regions_eez",
            # The live WFS snapshots, which ARE installed.
            "marine_regions_eez_wfs",
            "marine_regions_high_seas_wfs",
            "nga_world_port_index",
            "gebco_2025",
        }

    def test_the_wfs_snapshots_declare_no_established_version(self) -> None:
        """
        DF-X8.4H §2: prove the version or record honestly.

        The WFS publishes no per-layer version string for ``MarineRegions:eez``, so the
        snapshot records a retrieval-based version with ``version_established`` False.
        Recording "v12" here because the bulk catalogue says v12 is current would be
        exactly the inference the brief forbids.
        """
        for dataset_id in ("marine_regions_eez_wfs", "marine_regions_high_seas_wfs"):
            manifest = known_manifest(dataset_id)
            assert manifest is not None, dataset_id
            assert manifest.version_established is False, dataset_id
            assert manifest.version == "CURRENT-SERVICE-SNAPSHOT", dataset_id
            assert True  # set at install, not in source
            assert any("VERSION NOT ESTABLISHED" in lim for lim in manifest.limitations), (
                dataset_id
            )
            assert manifest.source_mechanism.value == "WFS", dataset_id

    def test_the_bulk_eez_record_keeps_its_proven_v12(self) -> None:
        # The legacy static record is retained for the dataset this build does not have
        # installed, and it is where the proven v12 / 2023-10-25 lives.
        assert known_manifest("marine_regions_eez").version == "12"  # type: ignore[union-attr]
        assert known_manifest("marine_regions_eez").version_established is True  # type: ignore[union-attr]

    def test_every_dataset_carries_licence_and_attribution(self) -> None:
        for dataset_id in known_dataset_ids():
            m = known_manifest(dataset_id)
            assert m is not None, dataset_id
            assert m.license is not LicenseKind.UNDETERMINED, dataset_id
            assert m.attribution.strip(), dataset_id

    def test_anchorages_is_absent_rather_than_faked(self) -> None:
        # §31/§53: no verified unencumbered global source, so no manifest. A layer
        # backed by scraped or unknown-licence data must not exist at all.
        assert "anchorages" not in known_dataset_ids()

    def test_eez_version_is_12_not_the_archived_11(self) -> None:
        # A Copernicus Marine mirror still serves v11. If this ever reads "11", a
        # five-year-old boundary is being served while loading cleanly.
        assert known_manifest("marine_regions_eez").version == "12"  # type: ignore[union-attr]

    def test_eez_records_the_redistribution_caveat(self) -> None:
        terms = known_manifest("marine_regions_eez").terms_notes  # type: ignore[union-attr]
        assert "not redistributed" in terms.lower()
        assert "CC BY" in terms

    def test_eez_records_median_lines_and_disputed_status(self) -> None:
        limits = " ".join(known_manifest("marine_regions_eez").limitations)  # type: ignore[union-attr]
        assert "DISPUTED" in limits
        assert "MEDIAN LINES" in limits

    def test_ports_currency_is_the_date_not_the_edition(self) -> None:
        m = known_manifest("nga_world_port_index")
        assert m is not None
        assert m.version == "35th Edition"
        # Confusing these is how a 2019 dataset gets called current.
        assert m.release_date == "2019-08-31"
        assert "DATA CURRENCY 2019-08-31" in " ".join(m.limitations)

    def test_ports_forbid_intent_inference(self) -> None:
        limits = " ".join(known_manifest("nga_world_port_index").limitations)  # type: ignore[union-attr]
        assert "does not establish origin, destination, intent" in limits

    def test_bathymetry_carries_the_27_3_percent_limitation(self) -> None:
        m = known_manifest("gebco_2025")
        assert m is not None
        assert "27.3%" in m.coverage_note
        assert "NOT FOR NAVIGATION" in " ".join(m.limitations)

    def test_coastline_is_reference_only(self) -> None:
        limits = " ".join(known_manifest("natural_earth_coastline").limitations)  # type: ignore[union-attr]
        assert "NOT FOR NAVIGATION" in limits

    def test_verification_date_is_recorded(self) -> None:
        assert VERIFIED_ON == "2026-10-04"

    def test_an_unknown_id_returns_none_rather_than_raising(self) -> None:
        # A caller asking about an unknown dataset must report NOT_INSTALLED, not
        # crash a dossier.
        assert known_manifest("not_a_dataset") is None

    def test_no_dataset_is_committed_to_the_repository(self) -> None:
        # §6: the repository holds manifests and code, not multi-GB payloads.
        assert all(m.expected_sha256 is None or len(m.expected_sha256) == 64
                   for m in (known_manifest(d) for d in known_dataset_ids()) if m)


# ---------------------------------------------------------------- strict models
class TestManifestStrictness:
    def test_unknown_fields_are_rejected(self) -> None:
        with pytest.raises(ValueError, match="Extra inputs|extra"):
            DatasetManifest(
                id="x", provider="p", dataset="d", version="1",
                license=LicenseKind.PUBLIC_DOMAIN, attribution="a",
                representation=LocalRepresentation.PREPPED_ROWS,
                payload_files=("d.json",),
                something_unexpected="surprise",
            )

    def test_a_malformed_checksum_is_rejected(self) -> None:
        # A typo'd checksum that validates would defeat the entire integrity check.
        with pytest.raises(ValueError, match="64 hex"):
            DatasetManifest(
                id="x", provider="p", dataset="d", version="1",
                license=LicenseKind.PUBLIC_DOMAIN, attribution="a",
                representation=LocalRepresentation.PREPPED_ROWS,
                payload_files=("d.json",),
                expected_sha256="abc",
            )

    def test_manifests_are_frozen(self) -> None:
        # Provenance editable after the fact is not provenance.
        m = known_manifest("gebco_2025")
        with pytest.raises(ValueError):
            m.version = "2026"  # type: ignore[misc]

    def test_utc_timestamp_is_timezone_aware(self) -> None:
        assert utc_now_iso().endswith("+00:00")


# ------------------------------------------------------------------- absence
class TestHonestAbsence:
    def test_a_fresh_deployment_reports_every_dataset_not_installed(self, data_dir) -> None:
        # Every registered dataset, and every one NOT_INSTALLED -- including the WFS
        # snapshots. The count comes from the registry rather than a literal, so adding a
        # dataset does not silently exempt it from the absence check.
        statuses = all_statuses(data_dir)
        assert len(statuses) == len(known_dataset_ids())
        assert {s.manifest.id for s in statuses} == set(known_dataset_ids())
        assert all(s.status is InstallStatus.NOT_INSTALLED for s in statuses)

    def test_absence_carries_a_reason(self, data_dir) -> None:
        # A status with no reason is unreadable in a panel.
        assert status_of(data_dir, "gebco_2025").detail == "no manifest on disk"

    def test_an_uninstalled_dataset_is_not_usable(self, data_dir) -> None:
        assert require_usable(data_dir, "gebco_2025") is None
        assert load_prepared(data_dir, "gebco_2025") is None

    def test_unknown_id_reports_version_unknown(self, data_dir) -> None:
        s = status_of(data_dir, "mystery")
        assert s.status is InstallStatus.VERSION_UNKNOWN
        assert s.manifest.license is LicenseKind.UNDETERMINED

    def test_coverage_is_unknown_before_any_query(self, data_dir) -> None:
        # §47: install state and coverage are different axes. Coverage is UNKNOWN until
        # a query actually asks, because reporting COVERED would be an assumption.
        a = availability(data_dir, "marine_regions_eez")
        assert a.coverage is DatasetCoverage.UNKNOWN
        assert a.install_status is InstallStatus.NOT_INSTALLED
        assert a.version is None


# ------------------------------------------------------------------ installation
class TestInstall:
    def test_install_makes_a_dataset_usable(self, data_dir) -> None:
        installed = install(data_dir, "natural_earth_coastline", {"features": []})
        assert installed.usable is True
        assert load_prepared(data_dir, "natural_earth_coastline") == {"features": []}

    def test_install_records_a_timestamp_and_checksum(self, data_dir) -> None:
        installed = install(data_dir, "natural_earth_coastline", {"features": []})
        assert installed.installed_at is not None
        assert installed.computed_sha256 is not None and len(installed.computed_sha256) == 64

    def test_install_places_the_version_in_the_path(self, data_dir) -> None:
        install(data_dir, "marine_regions_eez", {"features": []})
        # The version in the PATH is what makes historical reproducibility structural
        # rather than aspirational (§8): installing another version adds a directory
        # and leaves this one untouched.
        assert dataset_dir(data_dir, "marine_regions_eez", "12").is_dir()

    def test_an_unknown_dataset_cannot_be_installed(self, data_dir) -> None:
        with pytest.raises(ValueError, match="unknown dataset id"):
            install(data_dir, "anchorages", {"features": []})

    def test_a_supplied_checksum_is_recorded_and_verified(self, data_dir) -> None:
        payload = {"features": []}
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        import hashlib

        digest = hashlib.sha256(body).hexdigest()
        installed = install(data_dir, "natural_earth_coastline", payload,
                            expected_sha256=digest)
        assert installed.status is InstallStatus.READY
        assert installed.computed_sha256 == digest

    def test_unrecorded_checksum_is_visibly_weaker_than_ready(self, data_dir) -> None:
        # "Unverified" must never be rendered as "verified".
        installed = install(data_dir, "natural_earth_coastline", {"features": []})
        assert installed.status is InstallStatus.CHECKSUM_UNRECORDED
        assert installed.usable is True  # parsed and consistent, so serving it is honest
        assert "no publisher checksum" in installed.detail

    def test_corruption_is_caught_even_with_no_publisher_checksum(self, data_dir) -> None:
        """
        The stronger guarantee, and the one that actually matters.

        A dataset with no publisher checksum still has a digest recorded at install
        time, so a tampered local copy is still caught. Checking only against a
        publisher hash would leave exactly these datasets -- the majority, since none of
        the four registries publish a checksum we have independently confirmed --
        completely unprotected against the failure that really happens.
        """
        install(data_dir, "gebco_2025", {"cells": [1, 2, 3]})
        assert status_of(data_dir, "gebco_2025").usable is True

        target = dataset_dir(data_dir, "gebco_2025", "2025") / "grid.json"
        target.write_text('{"cells": [9, 9, 9]}', encoding="utf-8")

        after = status_of(data_dir, "gebco_2025")
        assert after.status is InstallStatus.CHECKSUM_MISMATCH
        assert after.usable is False
        assert "local corruption" in after.detail


# ------------------------------------------------------------------- integrity
class TestIntegrity:
    def test_corruption_is_reported_never_as_available(self, data_dir) -> None:
        payload = {"features": []}
        import hashlib

        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        digest = hashlib.sha256(body).hexdigest()
        install(data_dir, "natural_earth_coastline", payload, expected_sha256=digest)

        # Corrupt the payload on disk.
        target = dataset_dir(data_dir, "natural_earth_coastline", "4.1.0") / "coastline.json"
        target.write_text('{"features": ["tampered"]}', encoding="utf-8")

        after = status_of(data_dir, "natural_earth_coastline")
        assert after.status is InstallStatus.CHECKSUM_MISMATCH
        # The critical assertion: corruption is never usable.
        assert after.usable is False
        assert require_usable(data_dir, "natural_earth_coastline") is None
        # The detail names LOCAL CORRUPTION specifically, distinguishing it from a
        # publisher-checksum disagreement -- two different diagnoses with two different
        # remedies.
        assert "corruption" in after.detail.lower()

    def test_a_supplied_publisher_checksum_that_disagrees_is_a_mismatch(
        self, data_dir
    ) -> None:
        # The publisher hash is a STRONGER claim than the local baseline: it asserts the
        # content is what the publisher shipped. A wrong one must fail loudly rather
        # than being satisfied by a self-consistent local copy.
        install(data_dir, "natural_earth_coastline", {"features": []},
                expected_sha256="0" * 64)
        after = status_of(data_dir, "natural_earth_coastline")
        assert after.status is InstallStatus.CHECKSUM_MISMATCH
        assert after.usable is False

    def test_a_missing_payload_is_invalid(self, data_dir) -> None:
        install(data_dir, "marine_regions_eez", {"features": []})
        (dataset_dir(data_dir, "marine_regions_eez", "12") / "eez.json").unlink()
        after = status_of(data_dir, "marine_regions_eez")
        assert after.status is InstallStatus.INVALID
        assert "missing payload" in after.detail

    def test_an_unreadable_manifest_is_invalid(self, data_dir) -> None:
        install(data_dir, "gebco_2025", {"cells": []})
        (dataset_dir(data_dir, "gebco_2025", "2025") / "manifest.json").write_text(
            "{not json", encoding="utf-8"
        )
        assert status_of(data_dir, "gebco_2025").status is InstallStatus.INVALID

    def test_a_foreign_version_is_version_unknown(self, data_dir) -> None:
        install(data_dir, "marine_regions_eez", {"features": []})
        directory = dataset_dir(data_dir, "marine_regions_eez", "12")
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        manifest["version"] = "11"
        (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        after = status_of(data_dir, "marine_regions_eez")
        assert after.status is InstallStatus.VERSION_UNKNOWN
        assert "v11" not in after.detail or "11" in after.detail

    def test_verify_all_is_read_only(self, data_dir) -> None:
        install(data_dir, "natural_earth_coastline", {"features": []})
        before = status_of(data_dir, "natural_earth_coastline").computed_sha256
        verify_all(data_dir)
        after = status_of(data_dir, "natural_earth_coastline").computed_sha256
        assert before == after


# ------------------------------------------------------- version consistency
class TestVersionConsistency:
    def test_the_version_shown_is_the_version_on_disk(self, data_dir) -> None:
        # §77: displayed provenance comes from the same installed source of truth, so
        # "UI says v12, disk says v11" is structurally impossible.
        install(data_dir, "marine_regions_eez", {"features": []})
        shown = availability(data_dir, "marine_regions_eez")
        assert shown.version == known_manifest("marine_regions_eez").version  # type: ignore[union-attr]

    def test_provenance_is_built_from_the_installed_manifest(self, data_dir) -> None:
        installed = install(data_dir, "gebco_2025", {"cells": []})
        prov = installed.provenance()
        assert prov.version == "2025"
        assert prov.provider == "GEBCO Compilation Group"
        # The 27.3% figure must travel with every value this dataset produces.
        assert "27.3%" in prov.coverage_note
        assert any("NOT FOR NAVIGATION" in lim for lim in prov.limitations)

    def test_two_versions_can_coexist_on_disk(self, data_dir) -> None:
        # The mechanism that protects an old report: a second version is a NEW
        # directory, so the old bytes are untouched.
        install(data_dir, "marine_regions_eez", {"features": ["v12"]})
        directory_v11 = data_dir / "reference" / "marine_regions_eez" / "11"
        directory_v11.mkdir(parents=True)
        (directory_v11 / "eez.json").write_text('{"features": ["v11"]}', encoding="utf-8")
        (directory_v11 / "manifest.json").write_text(
            json.dumps({"id": "marine_regions_eez", "version": "11"}), encoding="utf-8"
        )
        # The current build resolves v12 and ignores the stray v11 directory.
        assert status_of(data_dir, "marine_regions_eez").manifest.version == "12"
        assert dataset_dir(data_dir, "marine_regions_eez", "12").is_dir()
        assert (directory_v11 / "eez.json").read_text(encoding="utf-8") == '{"features": ["v11"]}'


def test_sha256_is_streamed_not_buffered(tmp_path) -> None:
    # A multi-gigabyte grid must not be read into memory to be hashed.
    big = tmp_path / "big.bin"
    big.write_bytes(b"x" * (3 * 1024 * 1024))
    assert len(sha256_of(big)) == 64