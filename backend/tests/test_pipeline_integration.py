"""CP6 gate: pipeline + cache + runs + jobs wired together (EVD, OPS, TST-005/006).

Proves: real stage streaming, cache reuse via a REAL hit counter, restart
persistence, and the DEMO/REAL isolation guard.
"""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np
import pytest

from darkfleet.jobs import PIPELINE, ScanRunner, ScanStage
from darkfleet.pipeline import run_scan
from darkfleet.providers import RealDataUnavailableError
from darkfleet.storage.cache import ArtifactCache, cache_key
from darkfleet.storage.runs import RunStore, mark_synthetic

CFG = {"training_cells": 16, "guard_cells": 4, "threshold_factor": 3.5}
SCENE = {
    "id": "SIM-A", "platform": "S1", "polarization": "VV",
    "acquisitionTime": "2026-01-01T00:00:00Z", "resolutionMeters": 10,
    "bbox": [0.0, 0.0, 1.0, 1.0], "seaClutterLevel": "LOW",
}


def _gen(stages: list[ScanStage]) -> Iterator[tuple[ScanStage, str]]:
    """Yield the work-completed event for each stage after QUEUED.

    The runner emits QUEUED itself at submit time, so re-yielding it would be
    an illegal repeat transition.
    """
    for s in stages:
        yield s, "detail"


def test_cache_key_is_stable_and_config_sensitive() -> None:
    a = cache_key("item-1", (1.0, 2.0, 3.0, 4.0), CFG, "v1")
    b = cache_key("item-1", (1.0, 2.0, 3.0, 4.0), CFG, "v1")
    assert a.digest == b.digest
    assert cache_key("item-2", (1.0, 2.0, 3.0, 4.0), CFG, "v1").digest != a.digest
    assert cache_key("item-1", (1.0, 2.0, 3.0, 5.0), CFG, "v1").digest != a.digest
    assert cache_key("item-1", (1.0, 2.0, 3.0, 4.0), {**CFG, "guard_cells": 9}, "v1").digest != a.digest
    assert cache_key("item-1", (1.0, 2.0, 3.0, 4.0), CFG, "v2").digest != a.digest


def test_cache_hit_counter_proves_reuse(tmp_path) -> None:
    cache = ArtifactCache(tmp_path / "c", "v1")
    key = cache_key("item-1", (1.0, 2.0, 3.0, 4.0), CFG, "v1")
    arr = np.arange(12, dtype=np.float64).reshape(3, 4)

    assert cache.get(key, "detections") is None
    assert cache.stats_snapshot().misses == 1

    cache.put(key, "detections", arr)
    # A fresh instance over the same root proves the artifact SURVIVED the write.
    c2 = ArtifactCache(tmp_path / "c", "v1")
    got = c2.get(key, "detections")
    assert got is not None
    s = c2.stats_snapshot()
    assert s.hits == 1 and s.misses == 0, s
    assert c2.get(key, "detections") is not None
    assert c2.stats_snapshot().hits == 2


def test_corrupt_cache_entry_is_a_miss_not_a_silent_success(tmp_path) -> None:
    cache = ArtifactCache(tmp_path / "c", "v1")
    key = cache_key("item-1", (1.0, 2.0, 3.0, 4.0), CFG, "v1")
    cache.put(key, "mask", np.ones((2, 2)))
    c2 = ArtifactCache(tmp_path / "c", "v1")
    assert c2.get(key, "mask") is not None
    stored = tmp_path / "c" / key.shard / key.directory
    files = sorted(stored.glob("*.npz"))
    assert files, f"cache wrote no npz artifact under {stored}"
    files[0].write_bytes(b"not a zip file")
    c3 = ArtifactCache(tmp_path / "c", "v1")
    assert c3.get(key, "mask") is None
    assert c3.stats_snapshot().misses == 1


def test_runs_store_rejects_mode_synthetic_mismatch(tmp_path) -> None:
    store = RunStore(tmp_path)
    with pytest.raises(ValueError):
        store.save({"scan_id": "DF-0001", "runtime_mode": "REAL", "synthetic": True})
    with pytest.raises(ValueError):
        store.save({"scan_id": "DF-0002", "runtime_mode": "DEMO"})
    stamped = mark_synthetic({"scan_id": "DF-0003"}, synthetic=True)
    store.save(stamped)
    assert RunStore(tmp_path).get("DF-0003") is not None
    with pytest.raises(ValueError):
        mark_synthetic({"scan_id": "X"}, synthetic=True, runtime_mode="REAL")


def test_pipeline_stages_stream_into_job_runner(tmp_path) -> None:
    runner = ScanRunner(state_dir=str(tmp_path / "state"))
    job = runner.submit(
        lambda: _gen(list(PIPELINE)[1:]),
        synthetic=True,
    )
    seen: list[ScanStage] = []
    queue = runner.subscribe(job.scan_id)
    while True:
        ev = queue.get(timeout=10)
        seen.append(ev.stage)
        if ev.terminal:
            break
    assert seen[0] is ScanStage.QUEUED
    assert seen[-1] is ScanStage.COMPLETE
    assert runner.get(job.scan_id) is not None


def test_pipeline_failure_maps_to_failed_stage(tmp_path) -> None:
    def boom() -> Iterator[tuple[ScanStage, str]]:
        yield ScanStage.SEARCHING_SCENE, "searching"
        raise RuntimeError("provider exploded")

    runner = ScanRunner(state_dir=str(tmp_path / "state"))
    job = runner.submit(boom, synthetic=True)
    queue = runner.subscribe(job.scan_id)
    while True:
        ev = queue.get(timeout=10)
        if ev.terminal:
            break
    finished = runner.get(job.scan_id)
    assert finished is not None
    assert finished.stage is ScanStage.FAILED
    assert "provider exploded" in (finished.error or "")


def test_real_mode_failure_persists_nothing(tmp_path) -> None:
    with pytest.raises(RealDataUnavailableError):
        run_scan(
            runtime_mode="REAL", bbox=[0.0, 0.0, 1.0, 1.0],
            data_dir=str(tmp_path), cfar_config=CFG,
            scene=None, provider="nonexistent-provider",
        )
    assert RunStore(tmp_path).list() == []