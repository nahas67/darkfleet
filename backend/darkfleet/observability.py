"""Structured operational logging. Messages describe ACTUAL events only. (OPS-007)

Format: `SCAN   scan DF-0182 created` — stage, then measured detail.
No decorative telemetry, no invented counts.
"""

from __future__ import annotations

import logging
import sys

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
    logger.info("%-*s%s", _STAGE_WIDTH, tag.upper()[:_STAGE_WIDTH], message)