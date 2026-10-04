"""The evidence document is a contract, not a bag of keys.

Three routes serve an evidence document and every one of them used to hand the
browser a ``dict[str, Any]``: ``/targets/{id}``, ``/targets/{id}/summary`` and the
scan record on ``/evidence/{id}``. A UI is about to render this document as the
authoritative analytical record, and an untyped dict cannot be validated -- so a
renamed field or a dropped block would have been invisible in exactly the way the
``cls``/``classification`` drift was invisible.

These tests pin the three things that make the declared model real:

1. both builder branches -- Ghost Vessel and matched -- validate;
2. an UNEXPECTED key is rejected at every level, which is the entire point of
   ``extra="forbid"``;
3. every key the builder actually emits is declared by some model, checked
   against REAL pipeline output rather than a hand-written sample.

Test 3 is the anti-regression gate for the risk this change introduces. Forbidding
extras is only safe while the model is complete; if :func:`target_evidence` grows
a key and no model declares it, the route 500s. That failure has to arrive in CI,
not in production, so it is asserted here against a scan the PRODUCTION pipeline
produced over the checked-in fixture COG.

They also pin the epistemics the types exist to enforce: a null association field
is not a zero, the product designation never replaces the analytical class, and
the Ghost Vessel observation block is not the top-level observation block.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from darkfleet import pipeline
from darkfleet.api.evidence_models import (
    AssociationEvidence,
    EvidenceBullet,
    EvidenceDocument,
    GhostVesselDossier,
    GhostVesselNotApplicable,
    ObservedEvidence,
    ScanRecordDocument,
)
from darkfleet.api.models import jsonable
from darkfleet.api.targets import ScanScene, ScoreDecomposition
from darkfleet.evidence import target_evidence
from darkfleet.geoid import GEOID_MODEL
from darkfleet.ghost_vessel import GHOST_CLASSIFICATION, GHOST_LABEL
from tests import fixture_source

#: A full association decomposition, in the camelCase the record stores.
DECOMPOSITION: dict[str, float] = {
    "spatialScore": 0.9,
    "temporalScore": 0.85,
    "headingScore": 0.72,
    "sizeScore": 0.8,
    "compositeScore": 0.84,
    "matchRadiusMeters": 400.0,
    "distanceOffsetMeters": 14.2,
    "timeDeltaSeconds": 3.1,
}

#: The candidate that was considered and not accepted. Its presence is what makes
#: "no association was found" arithmetic rather than an assertion.
REJECTED: dict[str, Any] = {
    "mmsi": "565123456",
    "vesselName": "STRAIT VOYAGER",
    "score": 0.31,
    "distanceMeters": 900.0,
    "timeDeltaSeconds": 30.0,
    "shortfall": 0.09,
}

#: The evidence document's own top-level keys. Asserted literally so a block that
#: appears or disappears in the builder is a failing test rather than a silently
#: wider schema.
DOCUMENT_KEYS = {
    "target_id",
    "classification",
    "designation",
    "ghost_vessel",
    "observed",
    "uncertainty",
    "association",
    "summary",
    "tags",
    "hypotheses",
    "unknowns",
    "sar_chip",
    "provenance",
}

#: `ScanScene` is declared `extra="allow"` (pre-existing, in a module this lane
#: does not own) and does not declare these two. The record's scene carries them,
#: so the coverage gate below names them explicitly: a THIRD undeclared key is a
#: failure, and these two are the documented concession rather than a silently
#: widened one.
SCENE_KEYS_OPEN_BY_DESIGN = {"transform", "raster_window"}


# ------------------------------------------------------------- real scan data


@pytest.fixture(scope="module")
def record(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """One REAL, PERSISTED record from the production pipeline over the fixture COG.

    Module-scoped and built once: it is the input every coverage assertion reads,
    and a hand-written sample would only prove the models agree with the author of
    the models. Only the network is replaced -- the detection, correlation,
    evidence and persistence code all run for real.

    It is persisted through :func:`darkfleet.api.routes._persist_scan` rather than
    taken from ``run_scan``'s return value, and that is not incidental. The stored
    document is not the pipeline's return value: ``_persist_scan`` strips
    ``artifacts`` into the artifact cache and adds ``debug`` and ``schema_version``.
    Reading the wrong one of the two is how a model gets declared against a shape
    nothing ever serves -- which is exactly what this lane had to fix.
    """
    from darkfleet.api.routes import ScanSpec, _persist_scan
    from darkfleet.storage.runs import RunStore

    data_dir = tmp_path_factory.mktemp("evidence-contract")
    with pytest.MonkeyPatch.context() as monkeypatch:
        fixture_source.install(monkeypatch)
        result = pipeline.run_scan(
            bbox=fixture_source.FIXTURE_BBOX,
            data_dir=str(data_dir),
            window_source=fixture_source.fixture_window_source(),
            scan_id="DF-0001",
        )
        store = RunStore(data_dir / "scans")
        spec = ScanSpec(
            runtime_mode="REAL",
            bbox=tuple(fixture_source.FIXTURE_BBOX),
            scene=result["scene"],
            provider="planetary-computer",
            product="rtc",
            datetime_range=None,
            scene_id=None,
            cfar_config=None,
            data_dir=data_dir,
            store=store,
        )
        # `ScanSpec` receives its id from the runner's one-shot binding; this test
        # is not going through the runner, so it binds it the way the runner does.
        spec.bind("DF-0001")
        _persist_scan(spec, result)
        stored = store.get("DF-0001")
    assert stored is not None, "the scan did not persist"
    return stored


@pytest.fixture(scope="module")
def base_target(record: dict[str, Any]) -> dict[str, Any]:
    """A real detected target, deep-copied so each test may mutate it freely."""
    return copy.deepcopy(record["targets"][0])


def _ghost_target(base: dict[str, Any]) -> dict[str, Any]:
    """A real target carrying the association a Ghost Vessel actually has.

    Built from a real detection rather than written from scratch, so the coverage
    assertions run against every measurement the detector produced and not just
    the ones this branch happens to read.
    """
    return {
        **copy.deepcopy(base),
        "cls": "SAR_UNMATCHED",
        "aisConf": 0.0,
        "corr": {
            **copy.deepcopy(base["corr"]),
            "matched": False,
            "mmsi": None,
            "vesselName": None,
            "distanceOffsetMeters": None,
            "timeDeltaSeconds": None,
            "predictedLat": None,
            "predictedLon": None,
            "aisAssociationConfidence": 0.0,
            "scoreDecomposition": None,
            "candidatesConsidered": 4,
            "acceptanceThreshold": 0.4,
            "closestRejected": copy.deepcopy(REJECTED),
        },
    }


def _matched_target(base: dict[str, Any]) -> dict[str, Any]:
    """A real target carrying a full, accepted association."""
    return {
        **copy.deepcopy(base),
        "cls": "SAR_MATCHED_AIS",
        "aisConf": 0.88,
        "corr": {
            **copy.deepcopy(base["corr"]),
            "matched": True,
            "mmsi": "565123456",
            "vesselName": "STRAIT VOYAGER",
            "distanceOffsetMeters": 14.2,
            "timeDeltaSeconds": 3.1,
            "predictedLat": 1.267511,
            "predictedLon": 103.855401,
            "aisAssociationConfidence": 0.88,
            "scoreDecomposition": copy.deepcopy(DECOMPOSITION),
            "candidatesConsidered": 1,
            "acceptanceThreshold": 0.4,
            "closestRejected": None,
        },
    }


@pytest.fixture(scope="module")
def docs(
    record: dict[str, Any], base_target: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """Every builder branch, as the raw dicts the builder actually returns."""
    provenance = record.get("provenance") or None
    return {
        "fixture": jsonable(target_evidence(base_target, provenance, None)),
        "ghost": jsonable(
            target_evidence(
                _ghost_target(base_target),
                provenance,
                None,
                ais_coverage={"state": "NO_COVERAGE"},
            )
        ),
        "matched": jsonable(target_evidence(_matched_target(base_target), provenance, None)),
    }


# ------------------------------------------------------- both branches accept


def test_the_fixture_branch_validates(docs: dict[str, dict[str, Any]]) -> None:
    """What the real fixture actually produces must validate."""
    document = EvidenceDocument.model_validate(docs["fixture"])
    assert document.target_id
    assert document.observed.position.marine_region.kind
    assert document.observed.position.vertical_datum.altitude_measured is False


def test_the_ghost_vessel_branch_validates(docs: dict[str, dict[str, Any]]) -> None:
    document = EvidenceDocument.model_validate(docs["ghost"])
    assert isinstance(document.ghost_vessel, GhostVesselDossier)
    assert document.ghost_vessel.decision.closest_rejected_candidate is not None
    assert document.ghost_vessel.decision.reason_no_association
    assert document.ghost_vessel.observed.wake_detected is False


def test_the_matched_branch_validates(docs: dict[str, dict[str, Any]]) -> None:
    document = EvidenceDocument.model_validate(docs["matched"])
    assert document.ghost_vessel.is_ghost_vessel is False
    assert document.association.mmsi == "565123456"
    assert document.association.predicted_position is not None
    assert document.association.predicted_position.lat == pytest.approx(1.267511)
    assert document.uncertainty.match_radius_m == pytest.approx(400.0)


def test_a_non_ghost_target_is_not_a_dossier(docs: dict[str, dict[str, Any]]) -> None:
    """The stub is a statement, not a hole: it still names the real class."""
    document = EvidenceDocument.model_validate(docs["matched"])
    assert isinstance(document.ghost_vessel, GhostVesselNotApplicable)
    assert document.ghost_vessel.designation is None
    assert document.ghost_vessel.analytical_classification == "SAR_MATCHED_AIS"


def test_the_score_decomposition_is_the_existing_df_x6c_model(
    docs: dict[str, dict[str, Any]]
) -> None:
    """Reused, not restated. Two models for one shape would be two truths."""
    document = EvidenceDocument.model_validate(docs["matched"])
    decomposition = document.association.score_decomposition
    assert isinstance(decomposition, ScoreDecomposition)
    assert decomposition is not None
    assert decomposition.composite_score == pytest.approx(0.84)
    ghost = EvidenceDocument.model_validate(docs["ghost"])
    assert isinstance(ghost.ghost_vessel, GhostVesselDossier)
    assert ghost.ghost_vessel.decision.score_decomposition is None


def test_bullets_are_typed_objects_not_bare_strings(docs: dict[str, dict[str, Any]]) -> None:
    """`{"text": ...}` keeps hypotheses and unknowns separable when rendered."""
    document = EvidenceDocument.model_validate(docs["ghost"])
    assert all(isinstance(b, EvidenceBullet) for b in document.hypotheses)
    assert all(b.text for b in document.unknowns)


def test_the_blocks_state_not_applicable_rather_than_being_empty(
    docs: dict[str, dict[str, Any]]
) -> None:
    """"Nothing found" must never render as "not examined"."""
    document = EvidenceDocument.model_validate(docs["fixture"])
    assert document.hypotheses, "an empty list would read as an unexamined block"
    assert document.unknowns


def test_absent_provenance_stays_absent(base_target: dict[str, Any]) -> None:
    """A record with no provenance block renders as null, not as an empty block.

    Substituting ``{}`` would assert that the acquisition was recorded and carried
    no detail -- a different, unsupported claim.
    """
    document = target_evidence(base_target, None, None)
    assert document["provenance"] is None
    assert EvidenceDocument.model_validate(document).provenance is None


# ------------------------------------------- an unexpected key is REJECTED


def test_an_unexpected_top_level_key_is_rejected(docs: dict[str, dict[str, Any]]) -> None:
    tampered = copy.deepcopy(docs["fixture"])
    tampered["intent"] = "smuggling"
    with pytest.raises(ValidationError, match="intent"):
        EvidenceDocument.model_validate(tampered)


def test_a_renamed_block_is_rejected(docs: dict[str, dict[str, Any]]) -> None:
    """The drift that shipped twice, stated as a test: `cls` -> `classification`.

    A rename is additive-plus-lossy, and an untyped document absorbs both halves
    silently. Here it has to fail.
    """
    tampered = copy.deepcopy(docs["fixture"])
    tampered["classification_v2"] = tampered.pop("classification")
    with pytest.raises(ValidationError, match="classification_v2"):
        EvidenceDocument.model_validate(tampered)


def test_a_missing_observation_block_is_rejected(docs: dict[str, dict[str, Any]]) -> None:
    """Dropping a block is as invisible as renaming one, and equally wrong."""
    tampered = copy.deepcopy(docs["fixture"])
    del tampered["observed"]
    with pytest.raises(ValidationError, match="observed"):
        EvidenceDocument.model_validate(tampered)


def test_an_unexpected_nested_key_is_rejected(docs: dict[str, dict[str, Any]]) -> None:
    """Forbidding only at the envelope would have caught nothing that matters."""
    tampered = copy.deepcopy(docs["fixture"])
    tampered["observed"]["altitude_m"] = 12.0
    with pytest.raises(ValidationError, match="altitude_m"):
        EvidenceDocument.model_validate(tampered)


def test_an_unexpected_association_key_is_rejected(docs: dict[str, dict[str, Any]]) -> None:
    tampered = copy.deepcopy(docs["fixture"])
    tampered["association"]["distanceOffsetMeters"] = 0
    with pytest.raises(ValidationError, match="distanceOffsetMeters"):
        EvidenceDocument.model_validate(tampered)


def test_an_unexpected_ghost_decision_key_is_rejected(docs: dict[str, dict[str, Any]]) -> None:
    tampered = copy.deepcopy(docs["ghost"])
    tampered["ghost_vessel"]["decision"]["recommended_action"] = "intercept"
    with pytest.raises(ValidationError, match="recommended_action"):
        EvidenceDocument.model_validate(tampered)


def test_an_unexpected_provenance_key_is_rejected(docs: dict[str, dict[str, Any]]) -> None:
    tampered = copy.deepcopy(docs["fixture"])
    tampered["provenance"]["sar"]["downloaded_by"] = "operator"
    with pytest.raises(ValidationError, match="downloaded_by"):
        EvidenceDocument.model_validate(tampered)


# ------------------------------------------- builder keys are all declared


def _undeclared(model: type[BaseModel], payload: Any) -> list[str]:
    """Every path in ``payload`` the model does not accept, however deep.

    Driven by validation rather than by reflecting over annotations, because a
    reflected walk cannot resolve a multi-member union (``ghost_vessel`` is one)
    and would silently skip it. ``forbid`` already makes validation the authority
    on what is declared; this only attributes the failure to a path so the message
    names the offending key instead of dumping a tree of locs.
    """
    try:
        model.model_validate(payload)
    except ValidationError as exc:
        return [
            f"{'.'.join(str(part) for part in error['loc']) or '<root>'} "
            f"[{error['type']}]"
            for error in exc.errors()
        ]
    return []


@pytest.mark.parametrize("branch", ["fixture", "ghost", "matched"])
def test_every_key_the_builder_emits_is_declared(
    docs: dict[str, dict[str, Any]], branch: str
) -> None:
    """The anti-regression gate for ``extra="forbid"``.

    ``forbid`` is only safe while the model is complete. A builder key with no
    declaration turns a legitimate response into a 500, so this validates the
    builder's REAL output at every depth.
    """
    undeclared = _undeclared(EvidenceDocument, docs[branch])
    assert not undeclared, (
        f"the {branch} branch emits keys the model does not declare, or the model "
        f"declares keys the branch no longer emits; either would fail in "
        f"production: {undeclared}"
    )


def test_every_target_in_the_real_scan_is_covered(
    record: dict[str, Any], docs: dict[str, dict[str, Any]]
) -> None:
    """Every target the pipeline actually produced, not just one of them.

    One sample can satisfy a coverage gate by luck; three cannot.
    """
    assert len(record["targets"]) >= 2
    provenance = record.get("provenance") or None
    for target in record["targets"]:
        payload = jsonable(target_evidence(target, provenance, None))
        assert not _undeclared(EvidenceDocument, payload)


def test_every_record_key_is_declared(record: dict[str, Any]) -> None:
    """Same gate for the scan record ``/evidence/{id}`` serves."""
    undeclared = _undeclared(ScanRecordDocument, jsonable(record))
    assert not undeclared, (
        f"the stored record emits keys the model does not declare, or the model "
        f"declares keys the record no longer carries; either would fail in "
        f"production: {undeclared}"
    )


def test_the_only_open_record_keys_are_the_two_scan_scene_does_not_declare(
    record: dict[str, Any]
) -> None:
    """The concession is named, so a third open key cannot appear unnoticed.

    ``ScanScene`` is declared ``extra="allow"`` in :mod:`darkfleet.api.targets`,
    which this lane does not own, and it does not declare the window affine or the
    raster window the record carries. Declaring a second, stricter scene model
    here would create exactly the two-sources-of-truth problem this change exists
    to remove, so the gap is asserted instead of duplicated.
    """
    scene = jsonable(record["scene"])
    assert not _undeclared(ScanRecordDocument, jsonable(record))
    assert set(scene) - set(ScanScene.model_fields) == SCENE_KEYS_OPEN_BY_DESIGN


def test_the_record_is_not_the_evidence_document(record: dict[str, Any]) -> None:
    """Two documents, two names. Neither type may stand in for the other.

    ``/evidence/{id}`` serves the stored record that owns the target;
    ``/targets/{id}`` serves the per-target slice. Typing one as the other would
    have been a functional regression disguised as a stricter contract.
    """
    document = jsonable(target_evidence(record["targets"][0], record["provenance"], None))
    assert not _undeclared(ScanRecordDocument, jsonable(record))
    with pytest.raises(ValidationError):
        EvidenceDocument.model_validate(jsonable(record))
    with pytest.raises(ValidationError):
        ScanRecordDocument.model_validate(document)


def test_the_stored_record_is_not_the_pipeline_return_value(
    record: dict[str, Any], tmp_path_factory: pytest.TempPathFactory
) -> None:
    """The gap the coverage gate exists to find, stated as its own test.

    ``run_scan`` returns five rasters under ``artifacts``; the stored record has no
    ``artifacts`` at all, and carries ``debug`` and ``schema_version`` instead.
    A model declared against the wrong one of those two looks perfectly correct in
    review and 400s on the first real request.
    """
    data_dir = tmp_path_factory.mktemp("evidence-contract-raw")
    with pytest.MonkeyPatch.context() as monkeypatch:
        fixture_source.install(monkeypatch)
        raw = pipeline.run_scan(
            bbox=fixture_source.FIXTURE_BBOX,
            data_dir=str(data_dir),
            window_source=fixture_source.fixture_window_source(),
            scan_id="DF-0002",
        )
    assert "artifacts" in raw
    assert "artifacts" not in record
    assert set(record) - set(raw) == {"debug", "schema_version"}


# ------------------------------------------------ the wire does not move


@pytest.mark.parametrize("branch", ["fixture", "ghost", "matched"])
def test_validating_does_not_rename_or_drop_anything(
    docs: dict[str, dict[str, Any]], branch: str
) -> None:
    """A contract that changes the payload is not a contract; it is a migration.

    Round-tripping the model must reproduce the builder's dict exactly, which is
    what lets the typed document be adopted without a coordinated frontend release.
    """
    document = EvidenceDocument.model_validate(docs[branch])
    assert jsonable(document.model_dump(by_alias=True)) == docs[branch]


def test_the_record_round_trips_without_renaming(record: dict[str, Any]) -> None:
    """The payload of ``/evidence/{id}`` is unchanged by typing it."""
    original = jsonable(record)
    dumped = jsonable(ScanRecordDocument.model_validate(original).model_dump(by_alias=True))
    assert set(dumped) == set(original)
    assert set(dumped["targets"][0]) == set(original["targets"][0])
    assert dumped["config"] == original["config"]
    assert dumped["provenance"] == original["provenance"]
    assert dumped["counts"] == original["counts"]
    assert dumped["debug"] == original["debug"]


# -------------------------------------------------------------- epistemics


def test_null_association_fields_stay_null_and_are_never_zero(
    docs: dict[str, dict[str, Any]]
) -> None:
    """The core honesty property of the association block.

    A zero offset is a measurement of zero separation, and 0 degrees true is north.
    Coercing an absent field to 0 would state that the vessel was exactly on the
    reported position -- a real, specific, and wrong claim.
    """
    association = EvidenceDocument.model_validate(docs["ghost"]).association
    for name in (
        "mmsi",
        "vessel_name",
        "distance_offset_m",
        "time_delta_s",
        "predicted_position",
        "score_decomposition",
    ):
        value = getattr(association, name)
        assert value is None, f"{name} must stay null, got {value!r}"
        assert value != 0, f"{name} must not be coerced to 0"
    # The key is still present, so a consumer can tell "reported as absent" from
    # "not reported on".
    wire = association.model_dump(by_alias=True)
    for name in ("mmsi", "distance_offset_m", "time_delta_s", "predicted_position"):
        assert name in wire, f"{name} must be present on the wire even when null"


def test_the_association_is_required_but_nullable() -> None:
    """A null association must not be expressible as a missing key.

    ``extra="forbid"`` alone accepts both, and a defaulted field is marked
    OPTIONAL in the generated TypeScript -- which is how a consumer ends up
    writing ``?? 0`` and rendering a fabricated zero offset.
    """
    for name in ("mmsi", "distance_offset_m", "time_delta_s", "predicted_position"):
        field = AssociationEvidence.model_fields[name]
        assert field.is_required(), f"{name} must be required, not defaulted"
        assert type(None) in getattr(field.annotation, "__args__", ()), (
            f"{name} must stay nullable"
        )


def test_the_designation_never_replaces_the_analytical_classification(
    docs: dict[str, dict[str, Any]]
) -> None:
    """GHOST VESSEL is the label; SAR_UNMATCHED is all the evidence supports.

    Collapsing the two turns a correlation outcome into a statement about intent,
    which is the inference :mod:`darkfleet.ghost_vessel` exists to forbid.
    """
    document = EvidenceDocument.model_validate(docs["ghost"])
    assert isinstance(document.ghost_vessel, GhostVesselDossier)
    assert document.ghost_vessel.designation == GHOST_LABEL
    assert document.ghost_vessel.analytical_classification == GHOST_CLASSIFICATION
    assert document.ghost_vessel.designation != document.ghost_vessel.analytical_classification
    # The same two facts, side by side, at the top level too.
    assert document.designation == GHOST_LABEL
    assert document.classification == GHOST_CLASSIFICATION
    assert document.classification != document.designation


def test_a_collapsed_ghost_payload_is_rejected(docs: dict[str, dict[str, Any]]) -> None:
    """If the label has replaced the class, the document is not renderable."""
    tampered = copy.deepcopy(docs["ghost"])
    tampered["ghost_vessel"]["analytical_classification"] = GHOST_LABEL
    with pytest.raises(ValidationError, match="analytical_classification"):
        EvidenceDocument.model_validate(tampered)


def test_a_dossier_cannot_claim_a_non_ghost_class(docs: dict[str, dict[str, Any]]) -> None:
    tampered = copy.deepcopy(docs["ghost"])
    tampered["ghost_vessel"]["analytical_classification"] = "SAR_MATCHED_AIS"
    with pytest.raises(ValidationError, match=GHOST_CLASSIFICATION):
        EvidenceDocument.model_validate(tampered)


def test_a_non_ghost_target_cannot_acquire_the_designation() -> None:
    """``designation`` is ``None`` on the stub, not ``str | None``.

    A non-Ghost target that could hold the label would acquire the designation by
    accident, which is precisely what ``display_label`` exists to prevent.
    """
    field = GhostVesselNotApplicable.model_fields["designation"]
    assert field.annotation is type(None)
    assert field.is_required()
    with pytest.raises(ValidationError, match="designation"):
        GhostVesselNotApplicable.model_validate(
            {
                "is_ghost_vessel": False,
                "designation": GHOST_LABEL,
                "analytical_classification": GHOST_CLASSIFICATION,
            }
        )


def test_sar_is_declared_as_measuring_no_altitude(docs: dict[str, dict[str, Any]]) -> None:
    """``altitude_measured`` is ``Literal[False]``, not ``bool``.

    A consumer that learned to read this as False must not have to re-derive it,
    and a future altimetry source has to change the schema rather than widen a
    boolean in place.
    """
    datum = EvidenceDocument.model_validate(docs["fixture"]).observed.position.vertical_datum
    assert datum.altitude_measured is False
    assert datum.geoid_model == GEOID_MODEL
    tampered = copy.deepcopy(docs["fixture"])
    tampered["observed"]["position"]["vertical_datum"]["altitude_measured"] = True
    with pytest.raises(ValidationError, match="altitude_measured"):
        EvidenceDocument.model_validate(tampered)


def test_the_ghost_observation_block_is_not_the_top_level_one(
    docs: dict[str, dict[str, Any]]
) -> None:
    """``wake_detected`` and ``wake_evident`` are two measurements.

    One is the 360-degree ray sweep, the other the legacy threshold flag. A merged
    type would let one detector's silence render as the other's finding, and would
    let the Ghost dossier's readable ``marine_region`` phrase be read as the
    structured region block that answers a different question.
    """
    document = EvidenceDocument.model_validate(docs["ghost"])
    assert isinstance(document.ghost_vessel, GhostVesselDossier)
    ghost_fields = type(document.ghost_vessel.observed).model_fields
    assert "wake_detected" in ghost_fields
    assert "wake_evident" not in ghost_fields
    assert "wake_evident" in ObservedEvidence.model_fields
    assert "wake_detected" not in ObservedEvidence.model_fields
    # A readable phrase here, a structured block there. Not interchangeable.
    assert ghost_fields["marine_region"].annotation == (str | None)
    assert not isinstance(ghost_fields["marine_region"].annotation, type(ObservedEvidence))


def test_the_document_declares_exactly_the_builder_keys() -> None:
    """Guards against a field declared under a name the builder never emits.

    Such a field would make the model permanently un-satisfiable, and the error
    message would name nothing recognisable.
    """
    assert set(EvidenceDocument.model_fields) == DOCUMENT_KEYS


def test_the_generated_contract_describes_the_evidence_document() -> None:
    """The browser is typed from the schema, so the schema has to be the real one.

    A regression here would mean the generated TypeScript fell back to an untyped
    object while the backend believed it was strict -- the same split-brain the
    ``cls``/``classification`` drift lived in.
    """
    from darkfleet.api.app import create_app
    from darkfleet.config.settings import Settings

    settings = Settings()
    settings.log_level = "WARNING"
    schemas = create_app(settings).openapi()["components"]["schemas"]

    for name in ("EvidenceDocument", "ScanRecordDocument"):
        assert schemas[name]["additionalProperties"] is False, (
            f"{name} must forbid extras in the served schema"
        )
    evidence_ref = schemas["TargetEvidenceResponse"]["properties"]["evidence"].get("$ref", "")
    assert evidence_ref.endswith("/EvidenceDocument"), json.dumps(evidence_ref)
    summary_ref = schemas["TargetSummaryResponse"]["properties"]["evidence"].get("$ref", "")
    assert summary_ref.endswith("/EvidenceDocument"), json.dumps(summary_ref)
    record_ref = schemas["EvidenceDocumentResponse"]["properties"]["evidence"].get("$ref", "")
    assert record_ref.endswith("/ScanRecordDocument"), json.dumps(record_ref)