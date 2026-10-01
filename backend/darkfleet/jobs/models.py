"""Canonical 15-state scan-job machine (OPS-001).

There is exactly ONE definition of a scan's lifecycle in this codebase: the
``ScanStage`` enum below, declared in pipeline order.  Anything that reports
scan progress -- the runner, the log lines, the future SSE endpoint -- reads
its states from here.  No other module may invent a stage name, a stage count,
or a progress percentage (OPS-003).

Order is load-bearing: ``PIPELINE`` is the forward order, ``NEXT_STAGE`` is the
single legal successor of each state, and ``LEGAL_TRANSITIONS`` is the machine.
A transition that is not in the table raises ``IllegalTransitionError`` rather
than being silently accepted, because a scan that jumps (or rewinds) is a bug
in the caller, not something to paper over.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final

__all__ = [
    "ALL_STAGES",
    "LEGAL_TRANSITIONS",
    "NEXT_STAGE",
    "PIPELINE",
    "STAGE_TAGS",
    "TERMINAL",
    "IllegalTransitionError",
    "RuntimeMode",
    "ScanStage",
    "is_terminal",
    "next_stage",
    "validate_transition",
]


class ScanStage(StrEnum):
    """The 15 states of a scan, declared in pipeline order."""

    QUEUED = "QUEUED"
    SEARCHING_SCENE = "SEARCHING_SCENE"
    READING_SAR = "READING_SAR"
    PREPROCESSING = "PREPROCESSING"
    MASKING = "MASKING"
    FILTERING = "FILTERING"
    DETECTING = "DETECTING"
    EXTRACTING = "EXTRACTING"
    LOADING_AIS = "LOADING_AIS"
    ALIGNING = "ALIGNING"
    CORRELATING = "CORRELATING"
    SCORING = "SCORING"
    PERSISTING = "PERSISTING"
    COMPLETE = "COMPLETE"
    FAILED = "FAILED"


class RuntimeMode(StrEnum):
    """Which world a scan ran against. Recorded as submitted, never inferred."""

    REAL = "REAL"
    DEMO = "DEMO"


#: Forward pipeline order, QUEUED through COMPLETE. FAILED is NOT here: it is an
#: exit from anywhere, not a step in the pipeline.
PIPELINE: Final[tuple[ScanStage, ...]] = (
    ScanStage.QUEUED,
    ScanStage.SEARCHING_SCENE,
    ScanStage.READING_SAR,
    ScanStage.PREPROCESSING,
    ScanStage.MASKING,
    ScanStage.FILTERING,
    ScanStage.DETECTING,
    ScanStage.EXTRACTING,
    ScanStage.LOADING_AIS,
    ScanStage.ALIGNING,
    ScanStage.CORRELATING,
    ScanStage.SCORING,
    ScanStage.PERSISTING,
    ScanStage.COMPLETE,
)

#: Every state, in pipeline order with FAILED appended last.
ALL_STAGES: Final[tuple[ScanStage, ...]] = (*PIPELINE, ScanStage.FAILED)

#: No transition leaves these.
TERMINAL: Final[frozenset[ScanStage]] = frozenset({ScanStage.COMPLETE, ScanStage.FAILED})

#: The single legal successor of each pipeline state (FAILED has none).
NEXT_STAGE: Final[dict[ScanStage, ScanStage]] = {
    PIPELINE[i]: PIPELINE[i + 1] for i in range(len(PIPELINE) - 1)
}


def _build_legal_transitions() -> dict[ScanStage, frozenset[ScanStage]]:
    """Strictly-next plus escape-to-FAILED. Terminal states are sinks."""
    table: dict[ScanStage, frozenset[ScanStage]] = {ScanStage.FAILED: frozenset()}
    for index, stage in enumerate(PIPELINE):
        allowed: set[ScanStage] = set()
        if index + 1 < len(PIPELINE):
            allowed.add(PIPELINE[index + 1])
        # Real jobs fail mid-stream: any non-terminal state may drop out.
        if stage is not ScanStage.COMPLETE:
            allowed.add(ScanStage.FAILED)
        table[stage] = frozenset(allowed)
    return table


#: The machine. Keys are every state; values are the states reachable from it.
LEGAL_TRANSITIONS: Final[dict[ScanStage, frozenset[ScanStage]]] = _build_legal_transitions()

#: Fixed-width subsystem tag per stage, used for the structured log prefix.
#: Labels only -- never counts. The detail string comes from the worker.
STAGE_TAGS: Final[dict[ScanStage, str]] = {
    ScanStage.QUEUED: "SCAN",
    ScanStage.SEARCHING_SCENE: "STAC",
    ScanStage.READING_SAR: "SAR",
    ScanStage.PREPROCESSING: "SAR",
    ScanStage.MASKING: "MASK",
    ScanStage.FILTERING: "FILTER",
    ScanStage.DETECTING: "CFAR",
    ScanStage.EXTRACTING: "COMP",
    ScanStage.LOADING_AIS: "AIS",
    ScanStage.ALIGNING: "ALIGN",
    ScanStage.CORRELATING: "CORR",
    ScanStage.SCORING: "SCORE",
    ScanStage.PERSISTING: "STORE",
    ScanStage.COMPLETE: "SCAN",
    ScanStage.FAILED: "FAIL",
}


class IllegalTransitionError(ValueError):
    """Raised when a caller asks for a transition the machine forbids."""


def is_terminal(stage: ScanStage) -> bool:
    """True when ``stage`` is an exit with no outgoing transitions."""
    return stage in TERMINAL


def next_stage(stage: ScanStage) -> ScanStage | None:
    """The one state that may follow ``stage``, or None if it is terminal."""
    return NEXT_STAGE.get(stage)


def validate_transition(current: ScanStage, target: ScanStage) -> ScanStage:
    """Return ``target`` if the move is legal, else raise.

    Raises ``IllegalTransitionError`` for skipped stages, rewinds, repeat
    visits, and any attempt to leave COMPLETE or FAILED.
    """
    allowed = LEGAL_TRANSITIONS[current]
    if target not in allowed:
        legal = ", ".join(sorted(s.value for s in allowed)) or "<none: terminal>"
        raise IllegalTransitionError(
            f"illegal scan transition {current.value} -> {target.value}; "
            f"legal targets: {legal}"
        )
    return target
