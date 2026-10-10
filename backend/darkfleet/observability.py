"""Structured operational logging. Messages describe ACTUAL events only. (OPS-007)

Format: `SCAN   scan DF-0182 created` — stage, then measured detail.
No decorative telemetry, no invented counts.
"""

from __future__ import annotations

import logging
import sys

from .jobs.runner import redact_stage_detail

logger = logging.getLogger("darkfleet")

_STAGE_WIDTH = 7


def configure(level: str = "INFO") -> None:
    if logger.handlers:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    logger.setLevel(level.upper())
    logger.propagate = False


def stage(tag: str, message: str) -> None:
    """Log one real pipeline event. `tag` is the subsystem, e.g. CFAR/AIS/MATCH."""
    # Pipeline code can print metadata read from untrusted STAC scene IDs before
    # those stages reach ScanRunner, where event persistence is independently
    # sanitized. Apply the same reducer at this direct logger boundary too.
    logger.info(
        "%-*s%s", _STAGE_WIDTH, tag.upper()[:_STAGE_WIDTH], redact_stage_detail(message)
    )
