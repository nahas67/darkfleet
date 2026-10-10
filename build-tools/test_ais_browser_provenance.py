"""Offline, pure negative acceptance tests. Never starts Vite, API or Chrome."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ais_operator_browser_e2e as operator

WATCH = ("src/globe/aisPick.ts", "src/design/tokens.css")
HEAD = "a" * 40
SNAPSHOT = {WATCH[0]: "1" * 64, WATCH[1]: "2" * 64}


def verify(**overrides: object) -> list[str]:
    values = {
        "head_before": HEAD,
        "head_after": HEAD,
        "hashes_before": SNAPSHOT.copy(),
        "hashes_after": SNAPSHOT.copy(),
        "watched": WATCH,
        "main_frame_navigations": 1,
        "document_boots": [1, 1, 1],
        "document_origins": [1234567.125, 1234567.125],
        "vite_messages": ["[vite] connecting...", "[vite] connected."],
        "source_present": True,
        "hot_probe_attached": True,
    }
    values.update(overrides)
    return operator.provenance_failures(**values)


class FailClosedBrowserProvenanceTests(unittest.TestCase):
    def test_complete_stable_snapshot_has_no_failures(self) -> None:
        self.assertEqual(verify(), [])
        self.assertEqual(operator.finalize_browser_status("CANDIDATE_PASS", []), "PASS")

    def test_head_advanced_even_with_unchanged_source_hashes(self) -> None:
        failures = verify(head_after="b" * 40)
        self.assertIn("GIT_HEAD_MISSING_OR_CHANGED", failures)
        self.assertEqual(operator.finalize_browser_status("CANDIDATE_PASS", failures),
                         "FAIL_PROVENANCE")

    def test_existing_failure_cannot_be_promoted_by_clean_final_snapshot(self) -> None:
        self.assertEqual(operator.finalize_browser_status("INCONCLUSIVE_DEV_RELOAD", []),
                         "INCONCLUSIVE_DEV_RELOAD")
        self.assertEqual(operator.finalize_browser_status("FAIL", []), "FAIL")

    def test_unknown_head_equal_on_both_sides_is_not_proof(self) -> None:
        self.assertIn("GIT_HEAD_MISSING_OR_CHANGED",
                      verify(head_before="UNKNOWN", head_after="UNKNOWN"))

    def test_changed_watched_hash_fails(self) -> None:
        after = {**SNAPSHOT, WATCH[1]: "f" * 64}
        self.assertIn(f"WATCHED_SHA_CHANGED:{WATCH[1]}", verify(hashes_after=after))

    def test_missing_watched_hash_even_when_missing_on_both_sides(self) -> None:
        missing = {**SNAPSHOT, WATCH[1]: None}
        failures = verify(hashes_before=missing, hashes_after=missing)
        self.assertIn(f"WATCHED_SHA_MISSING_BEFORE:{WATCH[1]}", failures)
        self.assertIn(f"WATCHED_SHA_MISSING_AFTER:{WATCH[1]}", failures)

    def test_dropped_watched_key_cannot_validate_smaller_snapshot(self) -> None:
        failures = verify(hashes_after={WATCH[0]: SNAPSHOT[WATCH[0]]})
        self.assertIn("WATCHED_SHA_SNAPSHOT_INCOMPLETE", failures)
        self.assertIn(f"WATCHED_SHA_MISSING_AFTER:{WATCH[1]}", failures)

    def test_unexpected_extra_watched_key_rejected(self) -> None:
        self.assertIn("WATCHED_SHA_SNAPSHOT_INCOMPLETE",
                      verify(hashes_after={**SNAPSHOT, "extra.ts": "3" * 64}))

    def test_malformed_digest_is_absent_evidence(self) -> None:
        self.assertIn(f"WATCHED_SHA_MISSING_BEFORE:{WATCH[0]}",
                      verify(hashes_before={**SNAPSHOT, WATCH[0]: "not_sha256"}))

    def test_different_or_absent_page_navigation_is_rejected(self) -> None:
        self.assertIn("UNEXPECTED_MAIN_FRAME_NAVIGATION",
                      verify(main_frame_navigations=2))
        self.assertIn("UNEXPECTED_MAIN_FRAME_NAVIGATION",
                      verify(main_frame_navigations=0))

    def test_reloaded_or_missing_document_boot_rejected(self) -> None:
        self.assertIn("UNEXPECTED_DOCUMENT_BOOT_OR_MISSING_PROOF",
                      verify(document_boots=[1, 2]))
        self.assertIn("UNEXPECTED_DOCUMENT_BOOT_OR_MISSING_PROOF",
                      verify(document_boots=[]))

    def test_changed_document_time_origin_rejected(self) -> None:
        self.assertIn("DOCUMENT_ORIGIN_MISSING_OR_CHANGED",
                      verify(document_origins=[1234567.125, 1234570.0]))

    def test_vite_hmr_and_full_reload_both_rejected(self) -> None:
        for message in ("4:57 [vite] (client) hmr update /src/design/tokens.css",
                        "vite:beforeFullReload", "[vite] hot updated: /src/foo.ts"):
            with self.subTest(message=message):
                self.assertIn("VITE_UNEXPECTED_UPDATE_OR_RELOAD",
                              verify(vite_messages=[message]))

    def test_missing_hot_diagnostic_is_not_pass(self) -> None:
        self.assertIn("VITE_HOT_DIAGNOSTIC_NOT_ATTACHED",
                      verify(hot_probe_attached=False))

    def test_absent_raw_archive_source_is_not_pass(self) -> None:
        self.assertIn("RAW_AIS_SOURCE_IDENTITY_ABSENT", verify(source_present=False))

    def test_on_disk_missing_watched_input_is_explicit_none_not_hash(self) -> None:
        with tempfile.TemporaryDirectory(prefix="df-ais-provenance-test-") as root:
            test_root = Path(root)
            (test_root / "exists.ts").write_text("source", encoding="utf-8")
            with patch.object(operator, "ROOT", test_root), patch.object(
                operator, "CONTRACTS", ("exists.ts", "missing.ts")
            ):
                actual = operator.hashes()
            self.assertEqual(len(actual["exists.ts"]), 64)
            self.assertIsNone(actual["missing.ts"])
            self.assertIn("WATCHED_SHA_MISSING_BEFORE:missing.ts", verify(
                watched=("exists.ts", "missing.ts"),
                hashes_before=actual, hashes_after=actual,
            ))


if __name__ == "__main__":
    unittest.main()
