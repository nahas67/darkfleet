"""In-process memo for simplified display geometry.

WHY THIS EXISTS
---------------
Simplifying the installed Marine Regions snapshot costs 3.6 s at 0.05 deg and 5.9 s at the
default 0.02 deg -- measured, over 3,178,649 vertices across 285 features, one of which
alone has 367,796. A globe layer that takes four seconds to appear is worse than no layer:
the operator concludes the product is broken. The work is a deterministic function of data
that does not change between requests, so it is computed once per process.

WHY AN IN-PROCESS MEMO AND NOT AN ON-DISK CACHE
------------------------------------------------
An on-disk cache was written first and then removed. It needed atomic writes, a cache
schema version, and a stored source digest to stay correct -- and the digest check
re-reads the 84 MB payload, which is most of what the simplification was going to cost
anyway. DarkFleet is local-first and single-process: the memo below gets the same result
with no file-format to version and no stale-file failure mode. If a second process ever
needs this, the honest fix is a shared cache with an explicit invalidation story, not a
JSON file next to the data.

WHY THE KEY CANNOT GO STALE
---------------------------
The key carries ``(data_dir, dataset_id, version, installed_at, tolerance_deg)``:

  * ``version`` is a DIRECTORY NAME on disk, so re-installing a different version changes
    it. This is the same property that makes historical reproducibility structural
    elsewhere in the project.
  * ``installed_at`` is written by the installer. Re-installing the SAME version over an
    existing directory still changes it, so the one case ``version`` alone would miss is
    covered.
  * ``tolerance_deg`` is part of the key, so a caller can never be served geometry
    simplified at a tolerance it did not ask for.

Provenance and install status are NOT cached. Those are computed per request from the
current manifest, so a memo can never make the panel keep displaying a version that has
since been uninstalled.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any, NamedTuple

from darkfleet.maritime.datasets import InstalledDataset
from darkfleet.maritime.store import status_of

#: How many distinct simplifications to retain. Each entry is a few hundred KB of Python
#: tuples, so a handful is a few MB. Bounded because an unbounded memo in a long-lived
#: process is a leak with a confusing name.
_MAX_ENTRIES = 8


class CacheKey(NamedTuple):
    data_dir: str
    dataset_id: str
    version: str
    installed_at: str
    tolerance_deg: float

    def memo_key(self) -> str:
        """A string key, so the memo itself can be a plain dict.

        ``repr`` rather than ``str`` for the float: ``str(0.02)`` is ``"0.02"`` today, and
        the tolerance is part of the identity. Formatting it to a fixed number of places
        would make two distinct tolerances collide and serve the wrong geometry.
        """
        return "|".join(
            [self.data_dir, self.dataset_id, self.version, self.installed_at]
            + [repr(self.tolerance_deg)]
        )


#: Insertion-ordered; the oldest entry is evicted past ``_MAX_ENTRIES``.
_MEMO: dict[str, Any] = {}


def key_for(
    installed: InstalledDataset, data_dir: str, tolerance_deg: float
) -> CacheKey:
    """The memo key for one dataset at one tolerance.

    ``installed_at`` is normalised to a string because it is nullable on the dataclass and
    ``None`` in a tuple key is indistinguishable from the string "None" only if someone
    concatenates it -- which is exactly why :meth:`CacheKey.memo_key` exists.
    """
    return CacheKey(
        data_dir=str(data_dir),
        dataset_id=installed.manifest.id,
        version=installed.manifest.version,
        installed_at=installed.installed_at or "",
        tolerance_deg=round(tolerance_deg, 9),
    )


def get(
    installed: InstalledDataset, data_dir: Path, tolerance_deg: float
) -> Any | None:
    """The memoised result, or None on a miss."""
    return _MEMO.get(key_for(installed, str(data_dir), tolerance_deg).memo_key())


def put(
    installed: InstalledDataset,
    data_dir: Path,
    tolerance_deg: float,
    value: Any,
) -> Any:
    """Store and return the value, evicting the oldest entry when full."""
    memo_key = key_for(installed, str(data_dir), tolerance_deg).memo_key()
    if memo_key in _MEMO:
        # Re-insert so ordering reflects last use rather than first use.
        _MEMO[memo_key] = _MEMO.pop(memo_key)
    else:
        while len(_MEMO) >= _MAX_ENTRIES:
            _MEMO.pop(next(iter(_MEMO)))
    _MEMO[memo_key] = value
    return value


def peek(
    data_dir: Path, dataset_id: str, tolerance_deg: float
) -> tuple[Any | None, InstalledDataset]:
    """``(hit, installed)`` -- the memoised value if present, plus the dataset's state.

    Split from :func:`cached_or_build` because the caller must be able to consult the memo
    BEFORE deciding whether to read the prepared payload. The Marine Regions snapshot is
    84 MB of JSON and parsing it costs 1.5 s; doing that on every request to then throw the
    result away was the reason a warm hit still measured seconds rather than milliseconds.
    """
    installed = status_of(data_dir, dataset_id)
    if not installed.usable:
        return None, installed
    key = key_for(installed, str(data_dir), tolerance_deg).memo_key()
    return _MEMO.get(key), installed


def cached_or_build(
    data_dir: Path,
    dataset_id: str,
    tolerance_deg: float,
    build: Callable[[InstalledDataset], Any],
) -> Any:
    """Memoised ``build()`` for one dataset and tolerance.

    ``build`` receives the :class:`InstalledDataset` and must return a value safe to share
    across requests. Callers pass pure derived data -- lists of tuples and dataclasses --
    and never a live object the response layer mutates, which is why the response models
    are built fresh from the memoised geometry on every call.
    """

    hit, installed = peek(data_dir, dataset_id, tolerance_deg)
    if hit is not None:
        return hit
    # Not memoised when unusable: an absent dataset must be re-checked so that installing
    # it in this running process takes effect immediately.
    return put(installed, data_dir, tolerance_deg, build(installed))


def clear() -> None:
    """Drop every memoised entry. Used by tests and by an explicit install/update."""
    _MEMO.clear()


def size() -> int:
    """How many entries are held. Exposed so the bound is testable rather than assumed."""
    return len(_MEMO)
