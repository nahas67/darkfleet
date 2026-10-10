"""Read-only, fail-closed DarkFleet release build identity and preview verifier.

Run AFTER a clean strict Vite build and localhost preview are available:

    python -B build-tools/release_build_verifier.py --preview-url http://127.0.0.1:4174/

This verifies the exact algorithm in build-tools/buildIdentity.ts. It does not
build, start a server, modify dist, change Git state, or write a report file.
Use --self-test for isolated temporary Git/HTTP fixtures (never project data).
"""

from __future__ import annotations

import argparse
import hashlib
from html.parser import HTMLParser
import ipaddress
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
from typing import Any
from urllib import error, parse, request


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URL = "http://127.0.0.1:4174/"
IDENTITY_META = {
    "head": "darkfleet-build-head",
    "dirty": "darkfleet-build-dirty",
    "builtAt": "darkfleet-build-at",
    "contractHash": "darkfleet-contract-hash",
    "mode": "darkfleet-build-mode",
}
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX16 = re.compile(r"^[0-9a-f]{16}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class VerificationError(Exception):
    """Verification input is malformed, unavailable or unsuitable for release."""


class MetaReader(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.entries: dict[str, str] = {}
        self.duplicates: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "meta":
            return
        attributes = dict(attrs)
        name = attributes.get("name")
        if name not in IDENTITY_META.values():
            return
        if name in self.entries:
            self.duplicates.add(name)
        self.entries[name] = attributes.get("content") or ""


def parse_identity_html(data: bytes, label: str) -> dict[str, str]:
    try:
        parser = MetaReader()
        parser.feed(data.decode("utf-8", errors="strict"))
        parser.close()
    except (UnicodeError, ValueError) as exc:
        raise VerificationError(f"{label}: invalid UTF-8/HTML: {exc}") from exc
    if parser.duplicates:
        raise VerificationError(f"{label}: duplicated build meta names: {sorted(parser.duplicates)}")
    missing = sorted(set(IDENTITY_META.values()) - parser.entries.keys())
    if missing:
        raise VerificationError(f"{label}: missing production build meta tags: {missing}")
    return {field: parser.entries[name] for field, name in IDENTITY_META.items()}


def git_state(root: Path) -> tuple[str, str]:
    def run(*args: str) -> str:
        try:
            completed = subprocess.run(
                ["git", *args], cwd=root, capture_output=True, text=True,
                timeout=10, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise VerificationError(f"git {' '.join(args)} unavailable: {exc}") from exc
        if completed.returncode != 0:
            raise VerificationError(f"git {' '.join(args)} exited {completed.returncode}: {completed.stderr[:300]}")
        return completed.stdout.strip()

    head = run("rev-parse", "HEAD")
    if HEX40.fullmatch(head) is None:
        raise VerificationError(f"git rev-parse HEAD is not a full Git SHA: {head!r}")
    return head, run("status", "--porcelain")


def validate_manifest(raw: bytes) -> dict[str, Any]:
    try:
        manifest = json.loads(raw.decode("utf-8", errors="strict"))
    except (ValueError, UnicodeError) as exc:
        raise VerificationError(f"dist/build-manifest.json malformed: {exc}") from exc
    if not isinstance(manifest, dict):
        raise VerificationError("dist/build-manifest.json must be a JSON object")
    for field, regex in (("head", HEX40), ("contractHash", HEX16), ("bundleDigest", HEX64)):
        value = manifest.get(field)
        if not isinstance(value, str) or regex.fullmatch(value) is None:
            raise VerificationError(f"manifest {field} must match {regex.pattern}")
    if type(manifest.get("dirty")) is not bool:
        raise VerificationError("manifest dirty must be a JSON boolean")
    for name in ("builtAt", "mode"):
        if not isinstance(manifest.get(name), str) or not manifest[name]:
            raise VerificationError(f"manifest {name} must be a nonempty string")
    files = manifest.get("files")
    if not isinstance(files, list) or not files or any(not isinstance(n, str) for n in files):
        raise VerificationError("manifest files must be a nonempty list of strings")
    if sorted(set(files)) != files or "index.html" not in files:
        raise VerificationError("manifest files must be sorted, unique and contain index.html")
    for name in files:
        path = PurePosixPath(name)
        if (not name or path.is_absolute() or "\\" in name or ":" in name
                or any(part in ("", ".", "..") for part in name.split("/"))
                or name == "build-manifest.json"):
            raise VerificationError(f"unsafe manifest filename: {name!r}")
    return manifest


def physical_bundle_names(dist: Path) -> set[str]:
    """Enumerate the final emitted dist tree, including assets copied in closeBundle.

    A manifest covering only Rollup's bundle excludes Cesium static assets and
    cannot attest to everything the preview serves. Never follow local links.
    """
    result: set[str] = set()
    for entry in dist.rglob("*"):
        relative = entry.relative_to(dist).as_posix()
        if entry.is_symlink():
            raise VerificationError(f"emitted path is a symlink: dist/{relative}")
        if entry.is_file() and relative != "build-manifest.json":
            result.add(relative)
        elif not entry.is_dir() and not entry.is_file():
            raise VerificationError(f"unsupported emitted entry: dist/{relative}")
    return result


def bundle_files(dist: Path, manifest: dict[str, Any]) -> tuple[str, dict[str, bytes]]:
    """Mirror buildIdentity.ts: hash every physical emitted file, not a subset."""
    digest = hashlib.sha256()
    content: dict[str, bytes] = {}
    resolved_root = dist.resolve()
    listed = set(manifest["files"])
    physical = physical_bundle_names(dist)
    unlisted = sorted(physical - listed)
    missing = sorted(listed - physical)
    if unlisted or missing:
        raise VerificationError(
            f"emitted-tree coverage mismatch: {len(unlisted)} unlisted files"
            f" {unlisted[:5]}, {len(missing)} missing listed files {missing[:5]}"
        )
    for name in manifest["files"]:
        file_path = dist.joinpath(*name.split("/"))
        if not file_path.resolve().is_relative_to(resolved_root):
            raise VerificationError(f"manifest file escapes dist: {name}")
        # A release verifier must refuse omissions, even though the build plugin
        # skips a missing file if it disappears during writeBundle.
        if not file_path.is_file():
            raise VerificationError(f"emitted file missing: dist/{name}")
        current = dist
        for component in name.split("/"):
            current = current / component
            if current.is_symlink():
                raise VerificationError(f"emitted file uses a symlink: dist/{name}")
        data = file_path.read_bytes()
        content[name] = data
        digest.update(name.encode("utf-8"))
        digest.update(data)
    return digest.hexdigest(), content


def check_cesium_copy(root: Path, emitted: dict[str, bytes]) -> tuple[int, list[str]]:
    """Compare copied Cesium runtime resources against the installed source tree.

    vite-plugin-cesium@1.2.23 catches copy failures and prints an error instead
    of failing the Vite build. Enumerating dist alone could thus certify an
    *incomplete* final tree. Match the package files that this repository's
    default cesium() plugin is supposed to copy, not an arbitrary file-count
    threshold. Generic isolated verifier fixtures without Vite/Cesium opt out.
    """
    config = root / "vite.config.ts"
    if not config.is_file() or "cesium()" not in config.read_text(encoding="utf-8"):
        return 0, []
    source = root / "node_modules" / "cesium" / "Build" / "Cesium"
    expected_roots = ("Assets", "ThirdParty", "Workers", "Widgets")
    failures: list[str] = []
    total = 0
    if not source.is_dir():
        return 0, ["installed Cesium Build/Cesium source tree unavailable"]
    for folder in expected_roots:
        origin_dir = source / folder
        if not origin_dir.is_dir():
            failures.append(f"Cesium source directory missing: {folder}")
            continue
        for entry in origin_dir.rglob("*"):
            if entry.is_symlink():
                failures.append(f"Cesium source contains symlink: {entry.relative_to(source)}")
            elif entry.is_file():
                total += 1
                name = "cesium/" + entry.relative_to(source).as_posix()
                if emitted.get(name) != entry.read_bytes():
                    failures.append(f"missing or mismatched Cesium resource: {name}")
    cesium_script = source / "Cesium.js"
    if not cesium_script.is_file():
        failures.append("installed Cesium.js is missing")
    else:
        total += 1
        if emitted.get("cesium/Cesium.js") != cesium_script.read_bytes():
            failures.append("missing or mismatched Cesium runtime: cesium/Cesium.js")
    return total, failures


def preview_url(url: str) -> str:
    parsed = parse.urlsplit(url)
    hostname = parsed.hostname
    try:
        local = hostname == "localhost"
        if hostname and not local:
            try:
                local = ipaddress.ip_address(hostname).is_loopback
            except ValueError:
                local = False
        port = parsed.port
    except ValueError as exc:
        raise VerificationError(f"preview URL has invalid host/port: {exc}") from exc
    if (parsed.scheme != "http" or not local or not port or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise VerificationError("preview URL must be loopback HTTP at root with an explicit port; e.g. http://127.0.0.1:4174/")
    return url.rstrip("/") + "/"


class RefuseRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def read_http(opener: Any, url: str, expected_size: int, label: str) -> bytes:
    try:
        req = request.Request(url, headers={"Accept-Encoding": "identity", "Cache-Control": "no-cache"})
        with opener.open(req, timeout=5) as response:
            if response.status != 200:
                raise VerificationError(f"{label}: unexpected HTTP {response.status} at {url}")
            data = response.read(expected_size + 1)
    except (error.HTTPError, error.URLError, TimeoutError, OSError) as exc:
        raise VerificationError(f"{label}: preview inaccessible or returned error at {url}: {exc}") from exc
    if len(data) > expected_size:
        raise VerificationError(f"{label}: served content larger than local artifact")
    return data


def verify(root: Path, dist: Path, preview: str) -> dict[str, Any]:
    report: dict[str, Any] = {"status": "FAILED", "previewUrl": preview,
                              "checks": {}, "failures": []}

    def check(label: str, okay: bool, detail: str) -> None:
        report["checks"][label] = "PASS" if okay else "FAIL"
        if not okay:
            report["failures"].append(f"{label}: {detail}")

    try:
        preview = preview_url(preview)
        root = root.resolve()
        dist = dist.resolve()
        head, porcelain = git_state(root)
        report["gitHead"] = head
        check("git_worktree_clean", not porcelain,
              "Git worktree contains modified/untracked files; cannot certify clean release")

        manifest_raw = (dist / "build-manifest.json").read_bytes()
        manifest = validate_manifest(manifest_raw)
        actual_digest, files = bundle_files(dist, manifest)
        html = files["index.html"]
        html_meta = parse_identity_html(html, "dist/index.html")
        contract = hashlib.sha256((root / "src/api/contract.ts").read_bytes()).hexdigest()[:16]
        report.update({"manifestHead": manifest["head"], "distHtmlHead": html_meta["head"],
                       "bundleDigestActual": actual_digest, "bundleDigestExpected": manifest["bundleDigest"],
                       "sourceContractHash": contract, "manifestContractHash": manifest["contractHash"],
                       "emittedFiles": list(manifest["files"])})
        check("manifest_head", manifest["head"] == head,
              f"manifest HEAD {manifest['head']} != Git HEAD {head}")
        check("dist_html_head", html_meta["head"] == head,
              f"dist HTML HEAD {html_meta['head']} != Git HEAD {head}")
        check("manifest_clean", manifest["dirty"] is False,
              f"manifest dirty is {manifest['dirty']!r}, must be false")
        check("dist_html_clean", html_meta["dirty"] == "false",
              f"dist HTML dirty is {html_meta['dirty']!r}, must be 'false'")
        check("build_mode", manifest["mode"] == html_meta["mode"] == "production",
              f"manifest/HTML modes are {manifest['mode']!r}/{html_meta['mode']!r}, must both be production")
        check("build_timestamp", html_meta["builtAt"] == manifest["builtAt"],
              "HTML build timestamp differs from manifest")
        check("contract_hash", HEX16.fullmatch(contract) is not None
              and contract == manifest["contractHash"] == html_meta["contractHash"],
              f"source/manifest/HTML contract hashes: {contract}, {manifest['contractHash']}, {html_meta['contractHash']}")
        check("bundle_digest", actual_digest == manifest["bundleDigest"],
              f"SHA256 mismatch: actual {actual_digest}, manifest {manifest['bundleDigest']}")
        cesium_expected, cesium_missing = check_cesium_copy(root, files)
        report["cesiumSourceFileCount"] = cesium_expected
        check("cesium_source_copy", not cesium_missing,
              f"{len(cesium_missing)} missing or changed copied package resources: {cesium_missing[:5]}")

        opener = request.build_opener(request.ProxyHandler({}), RefuseRedirect())
        served_html = read_http(opener, preview, len(html), "preview index.html")
        served_meta = parse_identity_html(served_html, "preview HTML")
        report["previewHead"] = served_meta["head"]
        check("preview_head", served_meta["head"] == head,
              f"preview HEAD {served_meta['head']} != Git HEAD {head}")
        check("preview_clean", served_meta["dirty"] == "false",
              f"preview dirty is {served_meta['dirty']!r}")
        check("preview_contract_hash", served_meta["contractHash"] == contract,
              f"preview contract hash {served_meta['contractHash']} != source {contract}")
        check("preview_mode_timestamp", served_meta["mode"] == manifest["mode"] == "production"
              and served_meta["builtAt"] == manifest["builtAt"],
              "preview production mode or build timestamp differs from manifest")
        check("preview_index_bytes", served_html == html,
              "preview HTML bytes differ from dist/index.html")
        served_manifest = read_http(opener, preview + "build-manifest.json", len(manifest_raw), "preview manifest")
        check("preview_manifest_bytes", served_manifest == manifest_raw,
              "preview manifest bytes differ from local dist/build-manifest.json")

        differing: list[str] = []
        for name, local in files.items():
            if name == "index.html":
                continue
            data = read_http(opener, preview + name, len(local), f"preview {name}")
            if data != local:
                differing.append(name)
        check("preview_emitted_bundle_bytes", not differing,
              f"preview emits different contents for: {differing}")

        final_head, final_porcelain = git_state(root)
        check("git_stable_during_verification", head == final_head and porcelain == final_porcelain,
              "HEAD or worktree status changed during preview validation")
        check("local_inputs_stable", (dist / "build-manifest.json").read_bytes() == manifest_raw
              and (dist / "index.html").read_bytes() == html
              and hashlib.sha256((root / "src/api/contract.ts").read_bytes()).hexdigest()[:16] == contract
              and all(dist.joinpath(*name.split("/")).read_bytes() == content
                      for name, content in files.items()),
              "dist emitted bytes, manifest or source contract changed during validation")
        check("dist_tree_stable", physical_bundle_names(dist) == set(manifest["files"]),
              "dist file inventory changed during served preview verification")
    except (OSError, UnicodeError, VerificationError, ValueError, json.JSONDecodeError) as exc:
        report["failures"].append(f"BLOCKED: {exc}")
    report["status"] = "VERIFIED" if not report["failures"] else "FAILED"
    return report


def main() -> int:
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--repo-root", type=Path, default=ROOT,
                      help="Git repository whose source contract and HEAD must match")
    args.add_argument("--dist", type=Path, default=None,
                      help="Built dist directory; default <repo-root>/dist")
    args.add_argument("--preview-url", default=DEFAULT_URL,
                      help="Already-running loopback HTTP preview root, e.g. http://127.0.0.1:4174/")
    args.add_argument("--self-test", action="store_true", help="Run hermetic unit/integration tests")
    options = args.parse_args()
    if options.self_test:
        import unittest
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(ReleaseVerifierTests)
        outcome = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if outcome.wasSuccessful() else 1
    report = verify(options.repo_root, options.dist or options.repo_root / "dist", options.preview_url)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["status"] == "VERIFIED" else 1


# Test fixtures are created ONLY in a temporary directory with a loopback HTTP
# server. The released verifier path above performs no writes.
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import shutil
import threading
import unittest
from unittest import mock


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        pass


class ReleaseVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="df-release-gate-")
        self.root = Path(self.tmp.name) / "repo"
        self.root.mkdir()
        (self.root / "src/api").mkdir(parents=True)
        (self.root / "src/api/contract.ts").write_text("export const api = 1;\n", encoding="utf-8")
        (self.root / ".gitignore").write_text("dist/\n", encoding="utf-8")
        for command in (("init", "-q"), ("config", "user.email", "test@example.invalid"),
                        ("config", "user.name", "test"), ("add", "-A"),
                        ("commit", "-q", "-m", "fixture")):
            subprocess.run(("git", *command), cwd=self.root, check=True, capture_output=True)
        self.head = git_state(self.root)[0]
        self.dist = self.root / "dist"
        (self.dist / "assets").mkdir(parents=True)
        (self.dist / "assets/app.js").write_bytes(b"window.dfFixture = true;\n")
        self.contract = hashlib.sha256((self.root / "src/api/contract.ts").read_bytes()).hexdigest()[:16]
        self.write_release()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0),
                                          functools.partial(QuietHandler, directory=str(self.dist)))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def serve_directory(self, directory: Path) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0),
                                          functools.partial(QuietHandler, directory=str(directory)))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/"

    def write_release(self, *, html_head: str | None = None, dirty: bool = False,
                      contract_hash: str | None = None, duplicate: bool = False) -> None:
        head = html_head or self.head
        chash = contract_hash or self.contract
        tags = {"head": head, "dirty": str(dirty).lower(), "builtAt": "2026-10-11T00:00:00.000Z",
                "contractHash": chash, "mode": "production"}
        fragments = [f'<meta name="{name}" content="{tags[field]}">' for field, name in IDENTITY_META.items()]
        if duplicate:
            fragments.append(f'<meta name="darkfleet-build-head" content="{head}">')
        (self.dist / "index.html").write_bytes(("<html><head>" + "".join(fragments)
                                                   + "</head><body>Fixture</body></html>").encode("utf-8"))
        files = ["assets/app.js", "index.html"]
        digest = hashlib.sha256()
        for filename in files:
            digest.update(filename.encode("utf-8"))
            digest.update((self.dist / filename).read_bytes())
        (self.dist / "build-manifest.json").write_text(json.dumps({
            "head": self.head, "dirty": dirty, "builtAt": tags["builtAt"],
            "contractHash": chash, "mode": "production", "bundleDigest": digest.hexdigest(),
            "files": files,
        }) + "\n", encoding="utf-8")

    def test_clean_matching_release_passes(self) -> None:
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["status"], "VERIFIED", result["failures"])
        self.assertTrue(all(value == "PASS" for value in result["checks"].values()))

    def test_dirty_source_fails(self) -> None:
        (self.root / "src/api/contract.ts").write_text("export const api = 2;\n", encoding="utf-8")
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["checks"]["git_worktree_clean"], "FAIL")
        self.assertEqual(result["checks"]["contract_hash"], "FAIL")

    def test_dirty_manifest_fails(self) -> None:
        self.write_release(dirty=True)
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["checks"]["manifest_clean"], "FAIL")
        self.assertEqual(result["checks"]["dist_html_clean"], "FAIL")

    def test_stale_html_head_fails(self) -> None:
        self.write_release(html_head="a" * 40)
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["checks"]["dist_html_head"], "FAIL")

    def test_matching_manifest_and_html_contract_cannot_hide_wrong_source(self) -> None:
        self.write_release(contract_hash="f" * 16)
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["checks"]["contract_hash"], "FAIL")
        self.assertEqual(result["checks"]["preview_contract_hash"], "FAIL")

    def test_digest_tamper_fails(self) -> None:
        (self.dist / "assets/app.js").write_bytes(b"modified fixture\n")
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["checks"]["bundle_digest"], "FAIL")

    def test_unlisted_copied_asset_fails_even_with_valid_listed_digest(self) -> None:
        """Copy plugins can emit files after Rollup bundle inventory is fixed."""
        copied = self.dist / "assets" / "Cesium" / "Workers" / "decode.js"
        copied.parent.mkdir(parents=True)
        copied.write_bytes(b"self.onmessage = function() {};\n")
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["status"], "FAILED", result)
        self.assertIn("unlisted", " ".join(result["failures"]).lower())

    def test_silently_omitted_cesium_source_file_fails_even_if_digest_matches(self) -> None:
        """A swallowed fs.copy error must not yield an apparently valid release."""
        (self.root / "vite.config.ts").write_text("plugins:[cesium()]\n", encoding="utf-8")
        source = self.root / "node_modules/cesium/Build/Cesium/Workers"
        source.mkdir(parents=True)
        (source / "decoder.js").write_bytes(b"source runtime worker bytes\n")
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["checks"]["bundle_digest"], "PASS")
        self.assertEqual(result["checks"]["cesium_source_copy"], "FAIL")

    def test_preview_asset_drift_fails_even_when_local_digest_matches(self) -> None:
        served = Path(self.tmp.name) / "served"
        shutil.copytree(self.dist, served)
        (served / "assets/app.js").write_bytes(b"stale live asset\n")
        self.serve_directory(served)
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["checks"]["bundle_digest"], "PASS")
        self.assertEqual(result["checks"]["preview_emitted_bundle_bytes"], "FAIL")

    def test_stale_preview_html_head_fails(self) -> None:
        served = Path(self.tmp.name) / "served"
        shutil.copytree(self.dist, served)
        index = served / "index.html"
        index.write_bytes(index.read_bytes().replace(self.head.encode("ascii"), b"a" * 40))
        self.serve_directory(served)
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["checks"]["preview_head"], "FAIL")
        self.assertEqual(result["checks"]["preview_index_bytes"], "FAIL")

    def test_stale_preview_manifest_fails_even_with_same_html(self) -> None:
        served = Path(self.tmp.name) / "served"
        shutil.copytree(self.dist, served)
        path = served / "build-manifest.json"
        body = json.loads(path.read_text(encoding="utf-8"))
        body["builtAt"] = "2026-10-10T00:00:00.000Z"
        path.write_text(json.dumps(body), encoding="utf-8")
        self.serve_directory(served)
        result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["checks"]["preview_manifest_bytes"], "FAIL")
        self.assertEqual(result["checks"]["preview_index_bytes"], "PASS")

    def test_preview_inaccessible_is_explicit(self) -> None:
        with mock.patch(__name__ + ".read_http", side_effect=VerificationError("preview refused connection")):
            result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["status"], "FAILED")
        self.assertIn("preview refused connection", " ".join(result["failures"]))

    def test_local_asset_changed_during_check_fails_stability(self) -> None:
        original_http = read_http
        changed = False

        def change_after_snapshot(*args: Any, **kwargs: Any) -> bytes:
            nonlocal changed
            if not changed:
                changed = True
                asset = self.dist / "assets/app.js"
                asset.write_bytes(asset.read_bytes().replace(b"true", b"FAIL"))
            return original_http(*args, **kwargs)

        with mock.patch(__name__ + ".read_http", side_effect=change_after_snapshot):
            result = verify(self.root, self.dist, self.url)
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["checks"]["local_inputs_stable"], "FAIL")

    def test_duplicate_build_meta_fails(self) -> None:
        self.write_release(duplicate=True)
        result = verify(self.root, self.dist, self.url)
        self.assertIn("duplicated", " ".join(result["failures"]))

    def test_path_traversal_fails(self) -> None:
        path = self.dist / "build-manifest.json"
        body = json.loads(path.read_text(encoding="utf-8"))
        body["files"] = ["../outside", "assets/app.js", "index.html"]
        path.write_text(json.dumps(body), encoding="utf-8")
        result = verify(self.root, self.dist, self.url)
        self.assertIn("unsafe manifest filename", " ".join(result["failures"]))

    def test_rejects_external_preview(self) -> None:
        result = verify(self.root, self.dist, "http://example.com:4174/")
        self.assertEqual(result["status"], "FAILED")
        self.assertIn("loopback HTTP", " ".join(result["failures"]))


if __name__ == "__main__":
    sys.exit(main())
