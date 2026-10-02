"""Gate for content-addressed artifact cache + durable run store.

Requirement coverage: OPS-004 (deterministic keys), OPS-005 (on-disk artifact
cache that survives restart), OPS-006 (real hit/miss counters), OPS-013 (durable
scan/evidence records) and the OPS-014 ``runtime_mode``/``synthetic`` isolation
guard.

The guard still reconciles two modes, because a record written by an older build
can carry ``DEMO``. What changed is which mode this product writes: every record
it creates now says ``REAL``. Both directions are asserted below.

No network, no mocks on the persistence path -- every assertion touches a real
``tmp_path`` on the real filesystem, including a genuinely truncated npz file.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from darkfleet.storage.cache import ArtifactCache, CacheKey, cache_key
from darkfleet.storage.runs import RunRecordError, RunStore, mark_synthetic

ALGO_V1 = "DarkFleet-Core 3.0.0"
ALGO_V2 = "DarkFleet-Core 3.0.1"

BBOX = (103.7838800, 1.2635000, 103.7938800, 1.2735000)
CONFIG = {
    "cell_size_m": 10.0,
    "speckle_filter": "median",
    "threshold_factor": 3.5,
    "nested": {"grid": [1, 2, 3], "window": "7x7"},
}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _key(
    *,
    scene_item_id: str = "S1A_IW_GRDH_1SDV_20241224T224000",
    bbox: tuple[float, float, float, float] = BBOX,
    config: dict[str, object] | None = None,
    algorithm_version: str = ALGO_V1,
) -> CacheKey:
    return cache_key(
        scene_item_id,
        bbox,
        CONFIG if config is None else config,
        algorithm_version,
    )


def _patch() -> np.ndarray:
    rng = np.random.default_rng(20241224)
    return rng.random((8, 8), dtype=np.float64)


def _artifact_path(cache: ArtifactCache, key: CacheKey, name: str = "chip") -> Path:
    return cache.root / key.shard / key.directory / f"{name}.npz"


# --------------------------------------------------------------------------
# OPS-004: deterministic, content-addressed keys
# --------------------------------------------------------------------------


def test_same_inputs_produce_identical_digest() -> None:
    first = _key()
    second = _key()
    assert first.digest == second.digest
    assert len(first.digest) == 64
    assert first == second
    assert hash(first) == hash(second)


def test_config_key_order_does_not_change_digest() -> None:
    forward = _key(config=dict(sorted(CONFIG.items())))
    # Insert the same pairs in descending key order.
    descending = {}
    for name in sorted(CONFIG, reverse=True):
        descending[name] = CONFIG[name]
    assert _key(config=descending).digest == forward.digest

    shuffled = {}
    for name in ["speckle_filter", "nested", "threshold_factor", "cell_size_m"]:
        shuffled[name] = CONFIG[name]
    assert _key(config=shuffled).digest == forward.digest


def test_changed_algorithm_version_changes_digest() -> None:
    assert _key(algorithm_version=ALGO_V1).digest != _key(algorithm_version=ALGO_V2).digest


def test_changed_bbox_changes_digest() -> None:
    shifted = (BBOX[0] + 0.001, BBOX[1], BBOX[2], BBOX[3])
    assert _key().digest != _key(bbox=shifted).digest


def test_changed_scene_item_id_changes_digest() -> None:
    assert _key().digest != _key(scene_item_id="S1B_OTHER").digest


def test_changed_config_changes_digest() -> None:
    tweaked = dict(CONFIG)
    tweaked["threshold_factor"] = 3.6
    assert _key().digest != _key(config=tweaked).digest


def test_bbox_rounded_to_six_decimals_is_stable() -> None:
    noisy = (BBOX[0] + 1e-12, BBOX[1], BBOX[2], BBOX[3])
    assert _key(bbox=noisy).bbox == BBOX
    assert _key(bbox=noisy).digest == _key().digest


def test_key_exposes_its_components() -> None:
    key = _key()
    assert key.scene_item_id.endswith("20241224T224000")
    assert key.bbox == BBOX
    assert key.algorithm_version == ALGO_V1
    assert dict(key.processing_config) == CONFIG
    assert key.shard == key.digest[:2]
    assert key.directory == key.digest


def test_cache_key_rejects_bad_inputs() -> None:
    with pytest.raises(ValueError):
        cache_key("", BBOX, CONFIG, ALGO_V1)
    with pytest.raises(ValueError):
        cache_key("S1", BBOX, CONFIG, "")
    with pytest.raises(ValueError):
        cache_key("S1", (1.0, 2.0, 3.0), CONFIG, ALGO_V1)
    with pytest.raises(ValueError):
        cache_key("S1", (1.0, 2.0, 3.0, float("nan")), CONFIG, ALGO_V1)


# --------------------------------------------------------------------------
# OPS-005 + OPS-006: round-trip, restart, corruption, real counters
# --------------------------------------------------------------------------


def test_put_then_get_returns_payload(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    key = _key()
    payload = _patch()

    written = cache.put(key, "chip", payload)
    assert written.is_file()
    assert written.parent.name == key.digest
    assert written.parent.parent.name == key.shard

    loaded = cache.get(key, "chip")
    assert loaded is not None
    np.testing.assert_array_equal(loaded, payload)
    assert cache.stats() == {"hits": 1, "misses": 0, "writes": 1, "evictions": 0}


def test_unknown_key_is_a_miss(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    assert cache.get(_key(), "chip") is None
    assert cache.stats()["misses"] == 1


def test_different_algorithm_version_lives_in_a_different_entry(tmp_path: Path) -> None:
    root = tmp_path / "cache"
    v1 = ArtifactCache(root, ALGO_V1)
    v1.put(_key(algorithm_version=ALGO_V1), "chip", _patch())

    v2 = ArtifactCache(root, ALGO_V2)
    assert v2.get(_key(algorithm_version=ALGO_V2), "chip") is None
    assert v2.stats()["misses"] == 1

    # Reading a key built for another processor version is a caller error.
    with pytest.raises(ValueError):
        v2.get(_key(algorithm_version=ALGO_V1), "chip")


def test_second_cache_instance_reads_after_restart(tmp_path: Path) -> None:
    root = tmp_path / "cache"
    payload = _patch()
    key = _key()

    first = ArtifactCache(root, ALGO_V1)
    first.put(key, "chip", payload)
    assert first.stats() == {"hits": 0, "misses": 0, "writes": 1, "evictions": 0}

    # Fresh process-equivalent instance: counters reset, data survives.
    second = ArtifactCache(root, ALGO_V1)
    assert second.stats() == {"hits": 0, "misses": 0, "writes": 0, "evictions": 0}
    loaded = second.get(key, "chip")
    assert loaded is not None
    np.testing.assert_array_equal(loaded, payload)
    assert second.stats()["hits"] == 1
    assert second.stats()["misses"] == 0


def test_truncated_artifact_file_is_a_miss(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    key = _key()
    cache.put(key, "chip", _patch())
    assert cache.get(key, "chip") is not None

    artifact = _artifact_path(cache, key)
    raw = artifact.read_bytes()
    # A genuinely truncated npz: keep the header, cut the payload in half.
    artifact.write_bytes(raw[: len(raw) // 2])

    assert cache.get(key, "chip") is None
    assert cache.stats() == {"hits": 1, "misses": 1, "writes": 1, "evictions": 0}


def test_garbage_artifact_file_is_a_miss(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    key = _key()
    cache.put(key, "chip", _patch())
    _artifact_path(cache, key).write_bytes(b"not a zip at all")

    assert cache.get(key, "chip") is None
    assert cache.stats()["misses"] == 1


def test_deleted_metadata_file_is_a_miss(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    key = _key()
    cache.put(key, "chip", _patch())
    (cache.root / key.shard / key.directory / "chip.meta.json").unlink()

    assert cache.get(key, "chip") is None
    assert cache.stats()["misses"] == 1


def test_tampered_payload_fails_checksum(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    key = _key()
    cache.put(key, "chip", _patch())

    artifact = _artifact_path(cache, key)
    raw = bytearray(artifact.read_bytes())
    raw[-1] ^= 0xFF  # same length, different checksum
    artifact.write_bytes(bytes(raw))

    assert cache.get(key, "chip") is None
    assert cache.stats()["misses"] == 1


def test_stats_counters_match_a_known_sequence(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    hit_key = _key()
    miss_key = _key(scene_item_id="S1B_MISS")

    cache.put(hit_key, "chip", _patch())                 # writes 1
    cache.get(hit_key, "chip")                          # hits 1
    cache.get(hit_key, "chip")                          # hits 2
    cache.get(miss_key, "chip")                         # misses 1
    cache.put(_key(scene_item_id="S1C"), "chip", np.zeros((2, 2)))  # writes 2
    cache.get(_key(scene_item_id="S1C"), "chip")        # hits 3
    cache.get(_key(scene_item_id="S1D"), "chip")        # misses 2

    assert cache.stats() == {"hits": 3, "misses": 2, "writes": 2, "evictions": 0}


def test_contains_does_not_move_counters(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    key = _key()
    cache.put(key, "chip", _patch())
    assert cache.contains(key, "chip") is True
    assert cache.contains(key, "other") is False
    assert cache.stats() == {"hits": 0, "misses": 0, "writes": 1, "evictions": 0}


def test_capacity_cap_evicts_and_counts(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1, max_artifacts=2)
    keys = [_key(scene_item_id=f"S1B_{index}") for index in range(4)]
    for key in keys:
        cache.put(key, "chip", _patch())

    stats = cache.stats()
    assert stats["writes"] == 4
    assert stats["evictions"] == 2
    assert len(list((tmp_path / "cache").glob("*/*/*.npz"))) == 2


def test_delete_removes_artifact_and_makes_it_a_miss(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    key = _key()
    cache.put(key, "chip", _patch())

    assert cache.delete(key, "chip") is True
    assert cache.delete(key, "chip") is False
    assert cache.get(key, "chip") is None
    assert cache.stats()["misses"] == 1


def test_artifact_name_is_validated(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    key = _key()
    for bad in ("", "  ", "a/b", "..", "a\\b"):
        with pytest.raises(ValueError):
            cache.put(key, bad, _patch())
        with pytest.raises(ValueError):
            cache.get(key, bad)


def test_object_dtype_payload_is_rejected(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    with pytest.raises(ValueError):
        cache.put(_key(), "chip", np.array([{"a": 1}], dtype=object))
    assert cache.stats()["writes"] == 0


def test_cache_rejects_empty_algorithm_version(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        ArtifactCache(tmp_path / "cache", "")
    with pytest.raises(ValueError):
        ArtifactCache(tmp_path / "cache", ALGO_V1, max_artifacts=0)


def test_multiple_artifacts_share_one_digest_entry(tmp_path: Path) -> None:
    cache = ArtifactCache(tmp_path / "cache", ALGO_V1)
    key = _key()
    cache.put(key, "chip", _patch())
    cache.put(key, "labels", np.ones((8, 8), dtype=np.uint8))

    entry = cache.root / key.shard / key.directory
    assert (entry / "chip.npz").is_file()
    assert (entry / "labels.npz").is_file()
    assert cache.stats()["writes"] == 2
    assert cache.get(key, "labels") is not None
    assert cache.get(key, "chip") is not None
    assert cache.stats()["hits"] == 2


# --------------------------------------------------------------------------
# OPS-013: durable scan / evidence records
# --------------------------------------------------------------------------


def _record(scan_id: str = "scan-0001", **extra: object) -> dict[str, object]:
    """The record shape this product writes today: a REAL, non-synthetic scan."""
    record: dict[str, object] = {
        "scan_id": scan_id,
        "detections": [
            {"bbox": [1.0, 2.0, 3.0, 4.0], "confidence": 0.91, "classification": "unknown"},
        ],
        "ais_correlations": [{"mmsi": "563000000", "score": 0.62}],
    }
    record.update(extra)
    return mark_synthetic(record, synthetic=False)


def _synthetic_record(scan_id: str = "scan-synth") -> dict[str, object]:
    """A record claiming to be synthetic. The store must never accept one."""
    return mark_synthetic({"scan_id": scan_id, "vessels": 3}, synthetic=True)


def test_run_store_save_get_round_trip(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    record = _record()
    path = store.save(record)

    assert path == tmp_path / "runs" / "scans" / "scan-0001.json"
    assert path.is_file()
    loaded = store.get("scan-0001")
    assert loaded is not None
    assert loaded["scan_id"] == "scan-0001"
    assert loaded["runtime_mode"] == "REAL"
    assert loaded["synthetic"] is False
    assert loaded["detections"] == record["detections"]


def test_the_store_refuses_a_synthetic_record_entirely(tmp_path: Path) -> None:
    """There is no world for a synthetic record to be honestly filed in.

    Nothing this build writes is synthetic, so a record that claims to be is not
    merely mislabelled -- it cannot exist, and it must not reach disk where a
    later read might serve it as though it were a measurement.
    """
    store = RunStore(tmp_path / "runs")
    with pytest.raises(ValueError):
        store.save(_synthetic_record())
    assert store.list_ids() == []
    assert RunStore(tmp_path / "runs").get("scan-synth") is None


def test_run_store_survives_new_instance(tmp_path: Path) -> None:
    root = tmp_path / "runs"
    first = RunStore(root)
    first.save(_record("scan-0001"))
    first.save(_record("scan-0002"))
    assert first.stats()["saves"] == 2

    second = RunStore(root)
    assert second.list_ids() == ["scan-0001", "scan-0002"]
    assert len(second.get_all()) == 2
    assert second.get("scan-0002") is not None
    assert second.stats()["saves"] == 0


def test_run_store_list_is_sorted_and_empty_store_is_empty(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    assert store.list_ids() == []
    assert store.get_all() == []
    for scan_id in ("scan-c", "scan-a", "scan-b"):
        store.save(_record(scan_id))
    assert store.list_ids() == ["scan-a", "scan-b", "scan-c"]
    assert [doc["scan_id"] for doc in store.get_all()] == ["scan-a", "scan-b", "scan-c"]


def test_run_store_delete(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    store.save(_record())
    assert store.exists("scan-0001") is True
    assert store.delete("scan-0001") is True
    assert store.delete("scan-0001") is False
    assert store.exists("scan-0001") is False
    assert store.get("scan-0001") is None


def test_run_store_overwrite_same_scan_id(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    store.save(_record())
    store.save(_record(detections=[]))
    loaded = store.get("scan-0001")
    assert loaded is not None
    assert loaded["detections"] == []
    assert store.list_ids() == ["scan-0001"]


def test_run_store_rejects_real_record_claiming_synthetic(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    record = {"scan_id": "scan-bad", "runtime_mode": "REAL", "synthetic": True}

    with pytest.raises(ValueError):
        store.save(record)
    assert store.get("scan-bad") is None
    assert store.list_ids() == []


def test_run_store_rejects_a_legacy_mode_record_that_is_not_labelled(
    tmp_path: Path,
) -> None:
    """A ``DEMO`` record is only accepted when it also says ``synthetic: true``."""
    store = RunStore(tmp_path / "runs")
    with pytest.raises(ValueError):
        store.save({"scan_id": "scan-bad", "runtime_mode": "DEMO"})
    with pytest.raises(ValueError):
        store.save({"scan_id": "scan-bad", "runtime_mode": "DEMO", "synthetic": False})
    with pytest.raises(ValueError):
        store.save({"scan_id": "scan-bad"})
    with pytest.raises(ValueError):
        store.save({"scan_id": "scan-bad", "runtime_mode": "PAPER", "synthetic": True})
    with pytest.raises(ValueError):
        store.save({"scan_id": "scan-bad", "runtime_mode": "DEMO", "synthetic": "yes"})
    with pytest.raises(ValueError):
        store.save({"scan_id": "scan-bad", "runtime_mode": "REAL"})
    assert store.list_ids() == []


def test_run_store_rejects_missing_or_invalid_scan_id(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    with pytest.raises(ValueError):
        store.save({"runtime_mode": "REAL", "synthetic": False})
    with pytest.raises(ValueError):
        store.save({"scan_id": "../escape", "runtime_mode": "REAL", "synthetic": False})
    with pytest.raises(ValueError):
        store.get("")
    with pytest.raises(ValueError):
        store.delete("a/b")


def test_run_store_error_is_valueerror_subclass(tmp_path: Path) -> None:
    assert issubclass(RunRecordError, ValueError)
    store = RunStore(tmp_path / "runs")
    with pytest.raises(RunRecordError):
        store.save({"scan_id": "scan-bad", "runtime_mode": "REAL", "synthetic": True})


def test_mark_synthetic_stamps_both_fields() -> None:
    real = mark_synthetic({"scan_id": "s"}, synthetic=False)
    assert real["runtime_mode"] == "REAL"
    assert real["synthetic"] is False

    # There is exactly one legal combination, so asking for anything else is an
    # error rather than a second stamped answer.
    with pytest.raises(ValueError):
        mark_synthetic({"scan_id": "s"}, synthetic=False, runtime_mode="DEMO")
    with pytest.raises(ValueError):
        mark_synthetic({"scan_id": "s"}, synthetic=False, runtime_mode="PAPER")


def test_mark_synthetic_refuses_to_stamp_a_synthetic_record() -> None:
    """The stamper now refuses it HERE, not at the store further downstream.

    The previous version of this helper accepted ``synthetic=True`` and produced
    a contradictory record stamped ``runtime_mode="REAL"`` alongside
    ``synthetic=True``, relying on :meth:`RunStore.save` to catch it. Failing at
    the call site is better: a helper that cannot produce a wrong record should
    not be able to, and the traceback points at the caller that got it wrong.
    """
    with pytest.raises(ValueError, match="synthetic"):
        mark_synthetic({"scan_id": "s"}, synthetic=True)


def test_the_store_also_refuses_a_hand_written_synthetic_record(tmp_path: Path) -> None:
    """Defence in depth: bypassing the stamper must not reach disk either."""
    forged = {"scan_id": "s", "runtime_mode": "REAL", "synthetic": True}
    with pytest.raises(ValueError):
        RunStore(tmp_path / "runs").save(forged)


def test_the_store_refuses_a_legacy_demo_mode(tmp_path: Path) -> None:
    """A record from a pre-upgrade data directory still cannot be written."""
    legacy = {"scan_id": "s", "runtime_mode": "DEMO", "synthetic": True}
    with pytest.raises(ValueError):
        RunStore(tmp_path / "runs").save(legacy)


def test_mark_synthetic_does_not_mutate_input() -> None:
    original: dict[str, object] = {"scan_id": "s"}
    marked = mark_synthetic(original, synthetic=False)
    assert "runtime_mode" not in original
    assert "synthetic" not in original
    assert marked["runtime_mode"] == "REAL"


def test_real_record_is_accepted_when_consistent(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    record = mark_synthetic({"scan_id": "scan-real", "vessels": 4}, synthetic=False)
    store.save(record)
    loaded = store.get("scan-real")
    assert loaded is not None
    assert loaded["runtime_mode"] == "REAL"
    assert loaded["synthetic"] is False


def test_run_store_record_is_valid_json_with_schema_version(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    store.save(_record())
    raw = (tmp_path / "runs" / "scans" / "scan-0001.json").read_text(encoding="utf-8")
    document = json.loads(raw)
    assert document["schema_version"] == 1
    assert document["scan_id"] == "scan-0001"


def test_run_store_corrupt_file_is_treated_as_absent(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    store.save(_record())
    (tmp_path / "runs" / "scans" / "scan-0001.json").write_text("{ truncated", encoding="utf-8")
    assert store.get("scan-0001") is None
    assert store.list_ids() == ["scan-0001"]
    assert store.get_all() == []


def test_run_store_no_temp_files_left_behind(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    store.save(_record("scan-a"))
    store.save(_record("scan-b"))
    assert sorted(p.name for p in (tmp_path / "runs" / "scans").iterdir()) == [
        "scan-a.json",
        "scan-b.json",
    ]


def test_run_store_save_many_and_load_many(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    paths = store.save_many([_record("scan-a"), _record("scan-b")])
    assert [p.name for p in paths] == ["scan-a.json", "scan-b.json"]
    loaded = store.load_many(["scan-a", "missing", "scan-b"])
    assert [doc["scan_id"] for doc in loaded] == ["scan-a", "scan-b"]
    assert store.stats()["loads"] == 2