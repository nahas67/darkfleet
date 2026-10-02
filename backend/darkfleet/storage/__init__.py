"""Persistent artifact cache and evidence run store.

Two bounded facilities, both backed by the filesystem so state survives a
process restart:

* :mod:`darkfleet.storage.cache` -- deterministic content-addressed cache for
  derived SAR artifacts (OPS-004, OPS-005, OPS-006).
* :mod:`darkfleet.storage.runs` -- durable scan/evidence records with a hard
  real-data isolation guard (OPS-013, OPS-014): every record must be ``REAL``
  and not synthetic, and both fields are asserted on write.

No network access, no in-memory-only state.
"""

from __future__ import annotations

from darkfleet.storage.cache import ArtifactCache, CacheKey, CacheStats, cache_key
from darkfleet.storage.runs import RunStore, mark_synthetic

__all__ = [
    "ArtifactCache",
    "CacheKey",
    "CacheStats",
    "RunStore",
    "cache_key",
    "mark_synthetic",
]