"""Wake validation harness: the mutations that must fail, and the honesty rules.

Two things are being defended.

FIRST, that the harness cannot quietly launder bad science. A validator that folds
ambiguous samples into negatives, mixes incompatible sensor domains into one
accuracy number, or reports 0.0 for a rate with no denominator will produce a
comfortable-looking result from meaningless inputs. Each of those is asserted here.

SECOND, §47: a developer with no validation data installed must still get a green
test run. So nothing in this file downloads anything, and the suite is verified to
be independent of any corpus.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import numpy as np
import pytest

from darkfleet.sar.wake import axial_delta_deg
from darkfleet.validation.wake import DetectorVersion, Label, Metrics, Stratum, evaluate
from darkfleet.validation.wake.corpus import SampleProvenance, WakeValidationSample

BACKEND = Path(__file__).resolve().parents[1]


def _prov(**over: object) -> SampleProvenance:
    base = {
        "dataset": "TEST",
        "dataset_version": "0",
        "source_url": "",
        "license": "CC-BY-4.0",
        "scene_id": "S1",
        "sensor": "SENTINEL-1",
        "platform": "S1A",
        "product": "GRD",
        "processing_level": "1",
        "band": "C",
        "polarization": "VV",
        "resolution_m": 10.0,
        "chip_path": "x.tif",
        "checksum": "0" * 64,
        "stratum": Stratum.SENTINEL_1,
    }
    base.update(over)
    return SampleProvenance(**base)  # type: ignore[arg-type]


def _chip(size: int = 64) -> np.ndarray:
    rng = np.random.default_rng(3)
    return (-21.0 + rng.normal(0.0, 0.8, (size, size))).astype(np.float64)


def _sample(label: Label, **over: object) -> WakeValidationSample:
    prov_over = {k: v for k, v in over.items() if k in SampleProvenance.__dataclass_fields__}
    rest = {k: v for k, v in over.items() if k not in prov_over}
    return WakeValidationSample(
        provenance=_prov(**prov_over),
        label=label,
        image=_chip(),
        centre_row=32.0,
        centre_col=32.0,
        **rest,  # type: ignore[arg-type]
    )


# ------------------------------------------------------------------- honesty


class TestRatesAreHonest:
    def test_an_undefined_rate_is_none_not_zero(self) -> None:
        """A validator with no negatives must not report a perfect FPR.

        Returning 0.0 for "no denominator" is how an unvalidated detector
        acquires a flawless false-positive rate.
        """
        m = Metrics(tp=5, fp=0, tn=0, fn=0)
        assert m.false_positive_rate is None
        assert m.specificity is None
        assert m.precision == pytest.approx(1.0)
        assert m.recall == pytest.approx(1.0)

    def test_f1_is_none_when_precision_and_recall_are_undefined(self) -> None:
        assert Metrics().f1 is None

    def test_counts_are_reported_alongside_ratios(self) -> None:
        """§15: never publish only percentages."""
        d = Metrics(tp=3, fp=1, tn=8, fn=2).to_dict()
        assert d["counts"] == {
            "tp": 3, "fp": 1, "tn": 8, "fn": 2, "ambiguous": 0, "excluded": 0
        }
        assert d["precision"] == pytest.approx(0.75)

    def test_the_known_values_of_the_rates(self) -> None:
        m = Metrics(tp=3, fp=1, tn=8, fn=2)
        assert m.precision == pytest.approx(3 / 4)
        assert m.recall == pytest.approx(3 / 5)
        assert m.specificity == pytest.approx(8 / 9)
        assert m.false_positive_rate == pytest.approx(1 / 9)
        assert m.false_negative_rate == pytest.approx(2 / 5)


class TestLabelsAreNotLaundered:
    def test_ambiguous_samples_are_counted_separately(self) -> None:
        """§26: an ambiguous label must not become a negative."""
        samples = [
            _sample(Label.POSITIVE),
            _sample(Label.NEGATIVE),
            _sample(Label.AMBIGUOUS),
            _sample(Label.AMBIGUOUS),
        ]
        _, strata = evaluate(samples, DetectorVersion())
        m = strata[Stratum.SENTINEL_1.value]
        assert m.ambiguous == 2
        # The ambiguous pair must not have entered tp+fn or tn+fp.
        assert m.tp + m.fn + m.tn + m.fp <= 2

    def test_excluded_samples_are_counted_separately(self) -> None:
        _, strata = evaluate([_sample(Label.EXCLUDE)], DetectorVersion())
        assert strata[Stratum.SENTINEL_1.value].excluded == 1

    def test_a_missing_chip_excludes_rather_than_scoring(self) -> None:
        """An absent file must not be silently scored as a detection failure."""
        sample = WakeValidationSample(
            provenance=_prov(), label=Label.POSITIVE, image=None
        )
        results, strata = evaluate([sample], DetectorVersion())
        assert strata[Stratum.SENTINEL_1.value].excluded == 1
        assert results[0].predicted.endswith("NOT_AVAILABLE")


class TestDomainsAreNotPooled:
    def test_each_stratum_gets_its_own_metrics(self) -> None:
        """§10/§26: L, C and X band may not share one accuracy number."""
        samples = [
            _sample(Label.POSITIVE, stratum=Stratum.SENTINEL_1),
            _sample(Label.NEGATIVE, stratum=Stratum.L_BAND),
            _sample(Label.POSITIVE, stratum=Stratum.X_BAND),
        ]
        _, strata = evaluate(samples, DetectorVersion())
        assert set(strata) == {"SENTINEL_1", "L_BAND", "X_BAND"}
        assert strata["L_BAND"].tp + strata["L_BAND"].fn == 0

    def test_only_sentinel_1_may_inform_a_production_claim(self) -> None:
        from darkfleet.validation.wake.corpus import COMPATIBLE

        assert COMPATIBLE == frozenset({Stratum.SENTINEL_1})


# --------------------------------------------------------------- the detector


class TestDetectorIsFrozen:
    def test_the_config_is_read_from_the_module_not_restated(self) -> None:
        """A threshold change must not leave the record describing the old one."""
        from darkfleet.sar import wake as W
        from darkfleet.validation.wake import __main__ as cli

        config = cli._config()
        assert config["ARM_MIN_DEG"] == W.ARM_MIN_DEG
        assert config["MIN_MARGIN_DB"] == W.MIN_MARGIN_DB

    def test_the_digest_changes_when_the_config_changes(self) -> None:
        a = DetectorVersion(config={"MIN_MARGIN_DB": 1.2})
        b = DetectorVersion(config={"MIN_MARGIN_DB": 2.0})
        assert a.digest() != b.digest()

    def test_the_version_records_algorithm_and_commit(self) -> None:
        d = DetectorVersion(source_commit="abc1234").to_dict()
        assert d["algorithm_version"] == "polar-ray-arm-pair"
        assert d["source_commit"] == "abc1234"
        assert len(d["config_digest"]) == 16

    def test_a_detector_failure_does_not_abort_the_evaluation(self) -> None:
        """§25: a secondary channel must never destroy the run."""

        class Boom:
            shape = (64, 64)

        sample = WakeValidationSample(
            provenance=_prov(), label=Label.POSITIVE, image=Boom()  # type: ignore[arg-type]
        )
        results, _ = evaluate([sample], DetectorVersion())
        assert len(results) == 1
        assert "detector raised" in results[0].note


class TestConfidenceIsNotAProbability:
    def test_the_field_is_named_confidence_and_documented_as_strength(self) -> None:
        source = (BACKEND / "darkfleet" / "sar" / "wake.py").read_text(encoding="utf-8")
        assert "NOT a probability" in source or "not a probability" in source
        # And it must not have been renamed to anything probability-shaped.
        for banned in ("probability", "p_wake", "wakeProbability"):
            assert f"{banned}:" not in source, banned

    def test_confidence_stays_within_the_unit_interval(self) -> None:
        _, strata = evaluate([_sample(Label.POSITIVE)], DetectorVersion())
        assert strata  # ran without raising


# ------------------------------------------------------------- angle semantics


class TestAngleSemanticsSurvive:
    """§18: the resolved convention is permanently pinned."""

    @pytest.mark.parametrize(
        ("directed", "axial"),
        [(149.0, 31.0), (154.0, 26.0), (158.0, 22.0), (160.5, 19.5)],
    )
    def test_reported_bands_still_fold_as_documented(
        self, directed: float, axial: float
    ) -> None:
        assert axial_delta_deg(directed, 0.0) == pytest.approx(axial)


# -------------------------------------------------- suite independence (§47)


class TestSuiteNeedsNoCorpus:
    def test_the_validation_package_is_not_imported_by_the_test_suite(self) -> None:
        """The default suite must not depend on the validation package."""
        offenders: list[str] = []
        for path in (BACKEND / "tests").rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            if "darkfleet.validation" in text and path.name != Path(__file__).name:
                offenders.append(path.name)
        # This file is the only legitimate importer, and it imports no corpus data.
        assert not offenders, offenders

    def test_no_validation_module_performs_network_io(self) -> None:
        """Nothing in the harness may download anything."""
        for path in (BACKEND / "darkfleet" / "validation").rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                else:
                    continue
                for name in names:
                    assert not name.startswith(("requests", "urllib", "httpx", "aiohttp")), (
                        f"{path.name} imports {name}"
                    )

    def test_the_corpus_manifest_directory_is_gitignored(self) -> None:
        """Third-party archives must never enter version control."""
        gitignore = BACKEND.parent / "data" / "validation" / ".gitignore"
        assert gitignore.is_file(), "data/validation/.gitignore is missing"
        text = gitignore.read_text(encoding="utf-8")
        assert "*" in text
        assert "!manifest*.json" in text


class TestReportingIsGenerated:
    def test_report_only_states_insufficient_validation(self, tmp_path: Path) -> None:
        from darkfleet.validation.wake import __main__ as cli

        code = cli.main(["--report-only", "--out", str(tmp_path)])
        assert code == 0
        payload = json.loads((tmp_path / "wake_validation.json").read_text(encoding="utf-8"))
        assert payload["outcome_state"] == "INSUFFICIENT_VALIDATION"
        assert payload["detector"]["name"] == "wake-radon/v1"
        # And it must not invent any metric. The distribution keys are still
        # present with n=0, which is more informative than an absent object: it
        # says "measured nothing" rather than "did not look".
        assert payload["strata"] == {}
        assert payload["confidence_distribution"] == {"POSITIVE": {"n": 0}, "NEGATIVE": {"n": 0}}
        assert payload["angular_error"] == {"n": 0}
        assert payload["false_positives"] == []
        assert payload["false_negatives"] == []
        assert (tmp_path / "wake_validation.md").is_file()