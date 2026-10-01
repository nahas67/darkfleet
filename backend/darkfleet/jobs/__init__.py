"""Scan job lifecycle: the canonical 15-state machine and its runner.

``darkfleet.jobs`` owns exactly one question -- what state is a scan in, and who
moved it there. The state machine lives in :mod:`darkfleet.jobs.models`; the
threaded executor, subscriber queues and restart persistence live in
:mod:`darkfleet.jobs.runner`.
"""

from __future__ import annotations

from darkfleet.jobs.models import (
    ALL_STAGES,
    LEGAL_TRANSITIONS,
    NEXT_STAGE,
    PIPELINE,
    STAGE_TAGS,
    TERMINAL,
    IllegalTransitionError,
    RuntimeMode,
    ScanStage,
    is_terminal,
    next_stage,
    validate_transition,
)
from darkfleet.jobs.runner import (
    ScanJob,
    ScanRunner,
    ScanWork,
    StageEvent,
    default_state_dir,
)

__all__ = [
    "ALL_STAGES",
    "LEGAL_TRANSITIONS",
    "NEXT_STAGE",
    "PIPELINE",
    "STAGE_TAGS",
    "TERMINAL",
    "IllegalTransitionError",
    "RuntimeMode",
    "ScanJob",
    "ScanRunner",
    "ScanStage",
    "ScanWork",
    "StageEvent",
    "default_state_dir",
    "is_terminal",
    "next_stage",
    "validate_transition",
]
