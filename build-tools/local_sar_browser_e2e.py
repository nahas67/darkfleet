"""Isolated, real-browser regression for the operator GeoTIFF import workflow.

Run from any directory: ``python build-tools/local_sar_browser_e2e.py``.
Only a temporary data directory and processes started here are modified. The
committed fixture is deterministic sample raster data, not a Sentinel-1 scene.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import psutil
import rasterio
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "backend" / "tests" / "fixtures" / "cog" / "fixture_32648.tif"
UNREFERENCED = ROOT / "backend" / "tests" / "fixtures" / "cog" / "fixture_unreferenced.tif"
API_PORT = 8010
WEB_PORT = 5175
LOOPBACK = {"localhost", "127.0.0.1", "::1"}
OWNED_CONTRACTS = (
    "src/scenes/LocalSarImportPanel.tsx",
    "backend/darkfleet/api/local_sar_routes.py",
    "backend/darkfleet/local_sar_import.py",
    "vite.config.ts",
)

# The ASGI process denies outbound IPv4/IPv6 connections outside loopback.
# This guard runs before the application's modules are imported. It does not
# intercept DNS calls that are independent of connect(), or Node subprocesses.
BACKEND_BOOTSTRAP = r'''
import ipaddress, os, socket
_old_connect = socket.socket.connect
_old_connect_ex = socket.socket.connect_ex
_old_getaddrinfo = socket.getaddrinfo
_old_gethostbyname = socket.gethostbyname
def _allowed(host):
    if host is None or str(host).lower() in ('localhost', 'localhost.'):
        return True
    try:
        return ipaddress.ip_address(str(host)).is_loopback
    except ValueError:
        return False
def _log_block(kind, address):
    with open(os.environ['DF_BROWSER_EGRESS_LOG'], 'a', encoding='utf-8') as out:
        out.write(kind + ': ' + repr(address) + '\n')
def _getaddrinfo(host, *args, **kwargs):
    if not _allowed(host):
        _log_block('DNS', host)
        raise socket.gaierror(socket.EAI_NONAME, 'DF_BROWSER_EXTERNAL_DNS_BLOCKED')
    return _old_getaddrinfo(host, *args, **kwargs)
def _gethostbyname(host):
    if not _allowed(host):
        _log_block('DNS_BY_NAME', host)
        raise socket.gaierror(socket.EAI_NONAME, 'DF_BROWSER_EXTERNAL_DNS_BLOCKED')
    return _old_gethostbyname(host)
def _guard(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6):
        host = str(address[0])
        if not _allowed(host):
            _log_block('CONNECT', address)
            raise OSError('DF_BROWSER_EXTERNAL_EGRESS_BLOCKED')
def _connect(self, address):
    _guard(self, address)
    return _old_connect(self, address)
def _connect_ex(self, address):
    _guard(self, address)
    return _old_connect_ex(self, address)
socket.socket.connect = _connect
socket.socket.connect_ex = _connect_ex
socket.getaddrinfo = _getaddrinfo
socket.gethostbyname = _gethostbyname
import uvicorn
from darkfleet.config.settings import Settings
from darkfleet.api.app import create_app
app = create_app(Settings(data_dir=os.environ['DF_BROWSER_DATA_DIR'], log_level='WARNING'))
uvicorn.run(app, host='127.0.0.1', port=int(os.environ['DF_BROWSER_API_PORT']), log_level='warning')
'''


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def request(base: str, route: str, *, body: dict | None = None) -> tuple[int, bytes]:
    encoded = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base + route, data=encoded,
        headers={"Content-Type": "application/json"} if encoded is not None else {},
        method="POST" if encoded is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def json_request(base: str, route: str, *, body: dict | None = None) -> tuple[int, dict]:
    code, payload = request(base, route, body=body)
    return code, json.loads(payload)


def wait_service(base: str, route: str, proc: subprocess.Popen, timeout: int = 45) -> None:
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if proc.poll() is not None:
            raise RuntimeError(f"Service PID {proc.pid} exited with {proc.returncode}")
        try:
            code, _ = request(base, route)
            if code == 200:
                return
        except (OSError, TimeoutError):
            pass
        time.sleep(0.2)
    raise TimeoutError(f"PID {proc.pid} did not respond at {base}{route}")


def assert_unused_port(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        checked(probe.connect_ex(("127.0.0.1", port)) != 0,
                f"Port {port} is already occupied; refusing to use an existing service")


def terminate_owned(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    try:
        parent = psutil.Process(proc.pid)
        children = parent.children(recursive=True)
        parent.terminate()
        for child in children:
            child.terminate()
        _, active = psutil.wait_procs([parent, *children], timeout=3)
        for owned in active:
            owned.kill()
        psutil.wait_procs(active, timeout=3)
    except psutil.NoSuchProcess:
        pass
    except psutil.AccessDenied:
        raise RuntimeError(f"Could not terminate owned process tree PID {proc.pid}")
    finally:
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


def reference_png_pixels(source: Path) -> np.ndarray:
    """Reconstruct the implementation's declared percentile preview from raster pixels."""
    with rasterio.open(source) as ds:
        sample = ds.read(1, masked=True)
        values = np.asarray(sample.data, dtype=np.float64)
        valid = ~np.ma.getmaskarray(sample) & np.isfinite(values)
        checked(bool(valid.any()), "Fixture has no valid pixels")
        low, high = np.percentile(values[valid], [2, 98])
        grey = np.zeros(values.shape, dtype=np.uint8)
        if high > low:
            grey[valid] = np.clip((values[valid] - low) / (high - low) * 255, 0, 255).astype(np.uint8)
        else:
            grey[valid] = 127
        return np.stack((grey, grey, grey, valid.astype(np.uint8) * 255), axis=-1)


def run() -> dict:
    assert_unused_port(API_PORT)
    assert_unused_port(WEB_PORT)
    checked(FIXTURE.is_file() and UNREFERENCED.is_file(), "Committed GeoTIFF fixtures missing")
    fixture_sha = digest(FIXTURE.read_bytes())
    sha_unreferenced = digest(UNREFERENCED.read_bytes())
    report: dict = {
        "git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "fixture_relative": FIXTURE.relative_to(ROOT).as_posix(),
        "fixture_sha256": fixture_sha,
        "fixture_size": FIXTURE.stat().st_size,
        "unsupported_fixture_sha256": sha_unreferenced,
        "ports": {"api": API_PORT, "vite": WEB_PORT},
        "checks": [],
        "contract_source_sha256": {
            relative: digest((ROOT / relative).read_bytes()) for relative in OWNED_CONTRACTS
        },
    }
    with tempfile.TemporaryDirectory(prefix="darkfleet-local-sar-browser-") as scratch:
        temporary = Path(scratch)
        data = temporary / "operator-data"
        inbox = data / "local-sar-inbox"
        inbox.mkdir(parents=True)
        source = inbox / "fixture_32648.tif"
        shutil.copyfile(FIXTURE, source)
        checked(digest(source.read_bytes()) == fixture_sha, "Temporary source copy checksum differs")
        report["temp_data_dir"] = str(data)
        api_base = f"http://127.0.0.1:{API_PORT}"
        web_base = f"http://127.0.0.1:{WEB_PORT}"
        env = dict(os.environ)
        env.pop("DARKFLEET_LOCAL_SAR_ROOT", None)
        env["PYTHONPATH"] = str(ROOT / "backend") + os.pathsep + env.get("PYTHONPATH", "")
        env["DF_BROWSER_DATA_DIR"] = str(data)
        env["DF_BROWSER_API_PORT"] = str(API_PORT)
        env["DF_BROWSER_EGRESS_LOG"] = str(temporary / "backend-egress.log")
        env["PROJ_NETWORK"] = "OFF"
        vite_env = dict(env, DARKFLEET_API_URL=api_base)
        vite_js = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
        checked(vite_js.is_file(), "node_modules/vite/bin/vite.js unavailable")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        api_proc = vite_proc = None
        with (temporary / "api.log").open("w", encoding="utf-8") as api_log, \
             (temporary / "vite.log").open("w", encoding="utf-8") as vite_log:
            try:
                api_proc = subprocess.Popen(
                    [sys.executable, "-c", BACKEND_BOOTSTRAP], cwd=ROOT,
                    env=env, stdin=subprocess.DEVNULL, stdout=api_log,
                    stderr=subprocess.STDOUT, creationflags=flags,
                )
                report["api_pid"] = api_proc.pid
                wait_service(api_base, "/api/sar/local/status", api_proc)
                vite_proc = subprocess.Popen(
                    ["node", str(vite_js), "--host", "127.0.0.1", "--port",
                     str(WEB_PORT), "--strictPort"], cwd=ROOT, env=vite_env,
                    stdin=subprocess.DEVNULL, stdout=vite_log,
                    stderr=subprocess.STDOUT, creationflags=flags,
                )
                report["vite_pid"] = vite_proc.pid
                wait_service(web_base, "/", vite_proc)
                report["checks"].append("isolated FastAPI and Vite started")
                with sync_playwright() as playwright:
                    # Chrome's installed stable channel is usable even when the
                    # optional Playwright headless-shell download is absent.
                    browser = playwright.chromium.launch(channel="chrome", headless=True)
                    report["browser_version"] = browser.version
                    try:
                        context = browser.new_context(viewport={"width": 1920, "height": 1080})
                        blocked = Counter()

                        def mute_websocket(ws):
                            hostname = urlsplit(ws.url).hostname
                            if hostname not in LOOPBACK:
                                blocked[hostname or "unknown-websocket"] += 1
                                ws.close()
                            # Keep the local Vite HMR socket open without forwarding:
                            # concurrent workers edit other UI files during this run,
                            # and hot reload would replace the operator's in-progress form.

                        context.route_web_socket("**/*", mute_websocket)
                        report["vite_hmr_suppressed"] = True

                        def local_only(route):
                            parsed = urlsplit(route.request.url)
                            if parsed.scheme in ("data", "blob", "about") or (
                                parsed.scheme in ("http", "https") and parsed.hostname in LOOPBACK
                            ):
                                route.continue_()
                            else:
                                blocked[parsed.hostname or parsed.scheme] += 1
                                route.abort("blockedbyclient")

                        context.route("**/*", local_only)
                        page = context.new_page()
                        page.set_default_timeout(15000)
                        sar_responses = []
                        page.on("response", lambda response: sar_responses.append(
                            {"path": urlsplit(response.url).path, "status": response.status}
                        ) if "/api/sar/local/" in response.url else None)
                        page.goto(web_base + "/", wait_until="domcontentloaded", timeout=45000)
                        page.locator('[data-df-rail-entry="ADVANCED"]').click(timeout=30000)
                        page.locator('[data-df-advanced-tab="LOCAL_SAR"]').click()
                        panel = page.locator("[data-df-local-sar-import-panel]")
                        panel.wait_for(state="visible", timeout=20000)
                        page.get_by_text("Server inbox configured").wait_for()
                        report["checks"].append("real browser rail ADVANCED -> Local GeoTIFF, service READY")
                        page.locator("[data-df-local-sar-path]").fill(source.name)
                        page.locator("[data-df-local-sar-product]").select_option("GRD")
                        page.locator("[data-df-local-sar-polarization]").select_option("VV")
                        page.locator("[data-df-local-sar-calibration]").select_option("RAW_DN")
                        page.locator("[data-df-local-sar-acquired]").fill("2026-10-11T00:15:00Z")
                        with page.expect_response(lambda response: response.url.endswith("/api/sar/local/import") and
                                                  response.request.method == "POST", timeout=30000) as created_response:
                            page.locator("[data-df-local-sar-submit]").click()
                        actual_response = created_response.value
                        receipt = actual_response.json()
                        report["raw_import_receipt"] = receipt
                        checked(actual_response.status == 201, f"UI import HTTP {actual_response.status}: {receipt}")
                        checked(receipt["status"] == "IMPORTED_NOT_ANALYZED", "UI import claimed analysis")
                        checked(receipt["sha256"] == fixture_sha, "Receipt source bytes do not match fixture")
                        checked(receipt["source_integrity"] == "VERIFIED", "Source not verified on creation")
                        checked(receipt["snapshot_integrity"] == "VERIFIED", "Snapshot not verified on creation")
                        checked(receipt["metadata"]["calibration_verified"] is False, "Calibration falsely verified")
                        import_id = receipt["import_id"]
                        report["import_id"] = import_id
                        report["request_body"] = actual_response.request.post_data_json
                        report["import_status"] = actual_response.status
                        page.locator(f'[data-df-local-sar-detail="{import_id}"]').wait_for(timeout=30000)
                        page.get_by_text("IMPORTED_NOT_ANALYZED", exact=True).first.wait_for()
                        image = page.locator("[data-df-local-sar-preview] img")
                        image.wait_for()
                        image_state = image.evaluate("img => ({complete:img.complete,width:img.naturalWidth,height:img.naturalHeight})")
                        checked(image_state["complete"] and image_state["width"] > 0,
                                f"Browser preview did not load genuine image pixels: {image_state}")
                        code, png = request(api_base, receipt["image_url"])
                        checked(code == 200 and png.startswith(b"\x89PNG\r\n\x1a\n"), "Preview is not PNG")
                        with Image.open(io.BytesIO(png)) as png_image:
                            observed = np.asarray(png_image.convert("RGBA"))
                        expected = reference_png_pixels(source)
                        checked(np.array_equal(expected, observed), "PNG pixels diverged from actual source raster")
                        checked(int(np.ptp(observed[:, :, 0])) > 0, "PNG displays constant dummy pixels")
                        report.update({"png_sha256": digest(png), "png_shape": list(observed.shape),
                                       "browser_image": image_state, "pixel_match": True})
                        capture = temporary / "local-sar-browser.png"
                        page.locator("[data-df-local-sar-import-panel]").screenshot(path=str(capture))
                        report["screenshot_sha256"] = digest(capture.read_bytes())
                        report["screenshot_note"] = "Captured in disposable temp directory; erased after the run"
                        report["checks"].append("UI POST 201, honest import-only provenance and exact 400x400 PNG pixel match")

                        # Actual mouse click on the same form, not an injected DOM event.
                        with page.expect_response(lambda response: response.url.endswith("/api/sar/local/import") and
                                                  response.request.method == "POST") as repeated_response:
                            page.locator("[data-df-local-sar-submit]").click()
                        second = repeated_response.value.json()
                        checked(second["import_id"] == import_id, "Duplicate input generated a new identity")
                        list_status, listing = json_request(api_base, "/api/sar/local/imports")
                        checked(list_status == 200 and listing["total"] == 1, "Duplicate wrote a second receipt")
                        report["checks"].append("UI duplicate import remains same identity; catalogue total=1")

                        # UI input rejects traversal before a POST, while API enforces it independently.
                        count_before = len([r for r in sar_responses if r["path"] == "/api/sar/local/import"])
                        page.locator("[data-df-local-sar-path]").fill("../secret.tif")
                        page.locator("[data-df-local-sar-submit]").click()
                        page.locator("[data-df-local-sar-error]").get_by_text("basename", exact=False).wait_for()
                        checked(len([r for r in sar_responses if r["path"] == "/api/sar/local/import"]) == count_before,
                                "Traversal unexpectedly posted from UI")
                        bad_cases = [
                            ({"relative_path": "../secret.tif", "product": "RTC"}, 422, "INVALID_RELATIVE_TIFF_BASENAME"),
                            ({"relative_path": source.name, "product": "RTC", "calibration": "FABRICATED"}, 422, None),
                            ({"relative_path": source.name, "product": "RAW"}, 422, None),
                            ({"relative_path": source.name, "product": "RTC", "acquisition_time": "2026-10-11T00:15:00"}, 422, None),
                        ]
                        report["negative_responses"] = []
                        for body, expected_code, code_name in bad_cases:
                            http, response = json_request(api_base, "/api/sar/local/import", body=body)
                            checked(http == expected_code and (code_name is None or response.get("status") == code_name),
                                    f"Unexpected negative response {http}, {response}")
                            report["negative_responses"].append({"request": body, "http": http,
                                                                 "status": response.get("status")})
                        shutil.copyfile(UNREFERENCED, inbox / "fixture_unreferenced.tif")
                        http, response = json_request(api_base, "/api/sar/local/import",
                                                      body={"relative_path": "fixture_unreferenced.tif", "product": "RTC"})
                        checked(http == 422 and response.get("status") == "GEOREFERENCE_AFFINE_INVALID",
                                f"Unreferenced affine fixture unexpectedly accepted: {http} {response}")
                        report["negative_responses"].append({"request": "fixture_unreferenced.tif",
                                                             "http": http, "status": response.get("status")})
                        report["checks"].append("UI/API traversal, invalid declarations and affine-invalid fixture refused")

                        # Change only the private copy; archive preview must stay the original.
                        with rasterio.open(source, "r+") as ds:
                            data_array = ds.read(1)
                            data_array[0, 0] += 10.0
                            ds.write(data_array, 1)
                        changed_sha = digest(source.read_bytes())
                        checked(changed_sha != fixture_sha, "Source mutation produced same hash")
                        page.locator("[data-df-local-sar-refresh]").click()
                        page.get_by_text("SOURCE CHANGED", exact=False).wait_for()
                        code, after_change = request(api_base, receipt["image_url"])
                        checked(code == 200 and digest(after_change) == digest(png), "Source drift changed snapshot PNG")
                        report["changed_source_sha256"] = changed_sha
                        report["checks"].append("source drift marked CHANGED; immutable preview remains identical")
                        source.unlink()
                        page.locator("[data-df-local-sar-refresh]").click()
                        page.get_by_text("SOURCE MISSING", exact=False).wait_for()
                        page.locator("[data-df-local-sar-path]").fill("fixture_32648.tif")
                        with page.expect_response(lambda response: response.url.endswith("/api/sar/local/import") and
                                                  response.request.method == "POST") as missing_response:
                            page.locator("[data-df-local-sar-submit]").click()
                        checked(missing_response.value.status == 404 and
                                missing_response.value.json().get("status") == "SOURCE_NOT_FOUND",
                                "Missing source did not return structured 404")
                        page.locator("[data-df-local-sar-error]").get_by_text("SOURCE_NOT_FOUND", exact=False).wait_for()
                        report["checks"].append("disappeared source marked MISSING; repeat import 404 SOURCE_NOT_FOUND")

                        # Restart only the owned backend; browser + Vite retain the same temporary store.
                        old_pid = api_proc.pid
                        terminate_owned(api_proc)
                        api_proc = None
                        assert_unused_port(API_PORT)
                        api_proc = subprocess.Popen([sys.executable, "-c", BACKEND_BOOTSTRAP], cwd=ROOT,
                                                    env=env, stdin=subprocess.DEVNULL, stdout=api_log,
                                                    stderr=subprocess.STDOUT, creationflags=flags)
                        report["restarted_api_pid"] = api_proc.pid
                        wait_service(api_base, "/api/sar/local/status", api_proc)
                        page.reload(wait_until="domcontentloaded", timeout=45000)
                        page.locator('[data-df-rail-entry="ADVANCED"]').click()
                        page.locator('[data-df-advanced-tab="LOCAL_SAR"]').click()
                        page.locator(f'[data-df-local-sar-detail="{import_id}"]').wait_for(timeout=30000)
                        page.get_by_text("SOURCE MISSING", exact=False).wait_for()
                        image.wait_for()
                        code, restart_png = request(api_base, receipt["image_url"])
                        checked(code == 200 and digest(restart_png) == digest(png), "Snapshot changed across server restart")
                        code, after_restart = json_request(api_base, "/api/sar/local/imports")
                        checked(code == 200 and after_restart["total"] == 1 and
                                after_restart["imports"][0]["import_id"] == import_id,
                                "Restart lost persisted receipt")
                        checked(not list((data / "scans").glob("*.json")), "Local import fabricated scan records")
                        report["checks"].append(f"FastAPI PID {old_pid} restarted; receipt/image persisted with missing source")
                        report["browser_api_responses"] = sar_responses
                        report["blocked_browser_external_hosts"] = dict(blocked)
                    finally:
                        browser.close()
                egress = temporary / "backend-egress.log"
                report["blocked_backend_egress"] = egress.read_text(encoding="utf-8").splitlines() if egress.exists() else []
                report["archive_receipts"] = len(list((data / "local-sar-imports").glob("*.json")))
                report["source_scans"] = len(list((data / "scans").glob("*.json")))
                report["git_head_end"] = subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
                ).strip()
                checked(all(digest((ROOT / relative).read_bytes()) == sha
                            for relative, sha in report["contract_source_sha256"].items()),
                        "GeoTIFF UI/backend contracts changed during the browser test")
                return report
            except BaseException:
                api_log.flush()
                vite_log.flush()
                report["api_log_tail"] = (temporary / "api.log").read_text(encoding="utf-8", errors="replace")[-2500:]
                report["vite_log_tail"] = (temporary / "vite.log").read_text(encoding="utf-8", errors="replace")[-2500:]
                print(json.dumps(report, indent=2), file=sys.stderr)
                raise
            finally:
                terminate_owned(vite_proc)
                terminate_owned(api_proc)


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
