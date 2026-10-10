"""Real Chrome operator-workflow acceptance, restricted to an isolated data root.

Run: python build-tools/operator_workflow_browser_e2e.py

The script starts its OWN loopback FastAPI/Vite processes on dedicated ports,
uses an actual Chrome browser to CLICK/FILL/SELECT controls, verifies real HTTP
responses and persisted SQLite records after backend restart and browser reopen.
No fake scan records, HTTP intercept/mock responses, production data writes,
or external network access are permitted. Fails closed when ports are occupied.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

import psutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
API_PORT = 8013
WEB_PORT = 5177
LOOPBACK = {"localhost", "127.0.0.1", "::1"}
LAST_PROGRESS: dict = {}

# Executed only in the owned child. Block backend DNS + TCP calls to every
# external destination, including accidental provider health checks.
BACKEND_BOOTSTRAP = r"""
import ipaddress, os, socket
original_connect = socket.socket.connect
original_connect_ex = socket.socket.connect_ex
original_resolve = socket.getaddrinfo
original_hostname = socket.gethostbyname

def allowed(host):
    if str(host).lower() in ("localhost", "localhost."):
        return True
    try:
        return ipaddress.ip_address(str(host)).is_loopback
    except ValueError:
        return False

def deny(action, host):
    with open(os.environ["DF_OPERATOR_EGRESS_LOG"], "a", encoding="utf-8") as log:
        log.write(action + ": " + repr(host) + "\n")
    raise OSError("EXTERNAL_EGRESS_BLOCKED_IN_OPERATOR_BROWSER_ACCEPTANCE")

def connect(sock, address):
    if sock.family in (socket.AF_INET, socket.AF_INET6) and not allowed(address[0]):
        deny("connect", address)
    return original_connect(sock, address)

def connect_ex(sock, address):
    if sock.family in (socket.AF_INET, socket.AF_INET6) and not allowed(address[0]):
        deny("connect_ex", address)
    return original_connect_ex(sock, address)

def resolve(host, *args, **kwargs):
    if not allowed(host):
        deny("dns", host)
    return original_resolve(host, *args, **kwargs)

def hostname(host):
    if not allowed(host):
        deny("hostname", host)
    return original_hostname(host)

socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
socket.getaddrinfo = resolve
socket.gethostbyname = hostname
import uvicorn
from darkfleet.config.settings import Settings
from darkfleet.api.app import create_app
app = create_app(Settings(data_dir=os.environ["DF_OPERATOR_DATA"], log_level="WARNING"))
uvicorn.run(app, host="127.0.0.1", port=int(os.environ["DF_OPERATOR_API_PORT"]), log_level="warning")
"""


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def unused_port(port: int) -> None:
    with socket.socket() as probe:
        check(probe.connect_ex(("127.0.0.1", port)) != 0,
              f"Refusing existing service on {port}; choose unused dedicated ports")


def wait_service(url: str, proc: subprocess.Popen, timeout: int = 50) -> None:
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        check(proc.poll() is None, f"Owned service {proc.pid} exited with {proc.poll()}")
        try:
            with urlopen(url, timeout=1) as reply:
                if reply.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"Owned service {proc.pid} not ready at {url}")


def end_owned(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    try:
        parent = psutil.Process(proc.pid)
        children = parent.children(recursive=True)
        for process in [*children, parent]:
            try:
                process.terminate()
            except psutil.NoSuchProcess:
                pass
        _, active = psutil.wait_procs([*children, parent], timeout=5)
        for process in active:
            process.kill()
        psutil.wait_procs(active, timeout=4)
    except psutil.NoSuchProcess:
        pass
    finally:
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


def get_json(url: str) -> dict:
    with urlopen(url, timeout=15) as response:
        check(response.status == 200, f"Unexpected GET status {response.status} for {url}")
        return json.load(response)


def run() -> dict:
    global LAST_PROGRESS
    unused_port(API_PORT)
    unused_port(WEB_PORT)
    check((ROOT / "node_modules/vite/bin/vite.js").is_file(),
          "Local vite dependency unavailable")
    check(Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe").is_file(),
          "Installed stable Chrome unavailable; browser acceptance NOT RUN")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    report: dict = {
        "time_utc": datetime.now(UTC).isoformat(),
        "git_head": head,
        "ports": {"backend": API_PORT, "vite": WEB_PORT},
        "backend": "ISOLATED_REAL_FASTAPI",
        "browser": "REAL_HEADLESS_GOOGLE_CHROME",
        "http_mock_responses": 0,
        "synthetic_real_scans_created": 0,
        "browser_checks": [],
        "api_cross_checks": [],
        "not_run": [
            "REAL scan / target-specific evidence linkage: no verified REAL source available; never forge scan linkage",
        ],
        "feature_not_implemented": [
            "Binary evidence upload: no investigation binary-attachment UI/API exists",
            "Persisted SYSTEM settings edit: no mutable settings API or UI exists",
            "Case title update: current API offers create/read/delete, not update",
        ],
    }
    LAST_PROGRESS = report
    with tempfile.TemporaryDirectory(prefix="darkfleet-operator-browser-") as tmp:
        scratch = Path(tmp)
        data_dir = scratch / "data"
        data_dir.mkdir()
        report["temporary_root"] = str(data_dir)
        api_base = f"http://127.0.0.1:{API_PORT}"
        web_base = f"http://127.0.0.1:{WEB_PORT}"
        env = dict(os.environ)
        env["PYTHONPATH"] = str(ROOT / "backend") + os.pathsep + env.get("PYTHONPATH", "")
        env["DF_OPERATOR_DATA"] = str(data_dir)
        env["DF_OPERATOR_API_PORT"] = str(API_PORT)
        env["DF_OPERATOR_EGRESS_LOG"] = str(scratch / "backend-egress.log")
        env["PROJ_NETWORK"] = "OFF"
        node_env = dict(env, DARKFLEET_API_URL=api_base)
        api = vite = None
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        with (scratch / "backend.log").open("w", encoding="utf-8") as api_log, \
             (scratch / "vite.log").open("w", encoding="utf-8") as vite_log:
            try:
                def start_api() -> subprocess.Popen:
                    return subprocess.Popen(
                        [sys.executable, "-c", BACKEND_BOOTSTRAP], cwd=ROOT, env=env,
                        stdin=subprocess.DEVNULL, stdout=api_log,
                        stderr=subprocess.STDOUT, creationflags=creation_flags,
                    )

                api = start_api()
                report["api_initial_pid"] = api.pid
                wait_service(api_base + "/health", api)
                vite = subprocess.Popen([
                    "node", str(ROOT / "node_modules/vite/bin/vite.js"),
                    "--host", "127.0.0.1", "--port", str(WEB_PORT), "--strictPort",
                ], cwd=ROOT, env=node_env, stdin=subprocess.DEVNULL,
                    stdout=vite_log, stderr=subprocess.STDOUT, creationflags=creation_flags)
                report["vite_pid"] = vite.pid
                wait_service(web_base + "/", vite)
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(channel="chrome", headless=True)
                    report["chrome_version"] = browser.version
                    context = browser.new_context(
                        viewport={"width": 1500, "height": 950}, accept_downloads=True,
                        service_workers="block",
                    )
                    blocked = Counter()
                    responses: list[dict] = []
                    errors: list[str] = []

                    def local_only(route) -> None:
                        url = urlsplit(route.request.url)
                        if url.scheme in ("data", "blob", "about") or (
                            url.scheme in ("http", "https") and url.hostname in LOOPBACK
                        ):
                            route.continue_()
                        else:
                            blocked[url.hostname or url.scheme] += 1
                            route.abort("blockedbyclient")

                    context.route("**/*", local_only)
                    def local_ws(ws) -> None:
                        parsed = urlsplit(ws.url)
                        if parsed.hostname in LOOPBACK:
                            ws.connect_to_server()
                        else:
                            blocked[parsed.hostname or "unknown-websocket"] += 1
                            ws.close()

                    context.route_web_socket("**/*", local_ws)
                    page = context.new_page()
                    page.set_default_timeout(20000)
                    page.on("pageerror", lambda error: errors.append(str(error)[:500]))
                    page.on("response", lambda response: responses.append({
                        "method": response.request.method,
                        "path": urlsplit(response.url).path,
                        "status": response.status,
                    }) if "/api/investigations" in response.url or
                    "/api/missions" in response.url or
                    "/api/investigation-reports" in response.url else None)

                    def rail(name: str) -> None:
                        page.locator(f'[data-df-rail-entry="{name}"]').click()
                        page.locator(f'[data-df-workspace="{name}"]').wait_for(state="visible")

                    page.goto(web_base + "/", wait_until="domcontentloaded", timeout=45000)
                    page.locator("[data-df-app]").wait_for()
                    rail("REPORTS")
                    notebook = page.locator("[data-df-investigations]")
                    notebook.wait_for()
                    title = "Operator E2E Case 2026-10-11"
                    note = "Operator observation only. AIS coverage NOT VERIFIED; no satellite receipt."
                    page.locator("#df-new-case").fill(title)
                    with page.expect_response(lambda r: r.url.endswith("/api/investigations") and
                                              r.request.method == "POST") as event:
                        page.locator("[data-df-investigation-create]").click()
                    response = event.value
                    check(response.status == 201, f"Case UI POST failed: {response.status}")
                    case = response.json()
                    case_id = case["id"]
                    check(case["scan_id"] is None, "Unlinked case unexpectedly claims a REAL scan")
                    page.locator(f'[data-df-investigation-detail="{case_id}"]').wait_for()
                    report["case_id"] = case_id
                    report["browser_checks"].append("UI case POST 201, true unlinked case visible")

                    page.locator("#df-note").fill(note)
                    with page.expect_response(lambda r: r.request.method == "POST" and
                                              r.url.endswith(f"/api/investigations/{case_id}/annotations")) as event:
                        page.locator("[data-df-investigation-save-note]").click()
                    check(event.value.status == 201, f"UI annotation POST {event.value.status}")
                    annotation_id = event.value.json()["id"]
                    page.locator("[data-df-investigation-notes]").get_by_text(note).wait_for()
                    report["annotation_id"] = annotation_id
                    report["browser_checks"].append("UI case-wide annotation POST 201, persisted and visible")

                    page.locator("[data-df-geo-kind]").select_option("polyline")
                    page.locator("[data-df-geo-label]").fill("Operator route geometry")
                    page.locator("[data-df-geo-vertices]").fill("103.801, 1.281\n103.811, 1.292")
                    page.locator("[data-df-geo-notes]").fill("Operator drawn, not remotely sensed")
                    with page.expect_response(lambda r: r.request.method == "POST" and
                                              r.url.endswith(f"/api/investigations/{case_id}/geometries")) as event:
                        page.locator("[data-df-geo-save]").click()
                    check(event.value.status == 201, f"UI geometry POST {event.value.status}")
                    geometry = event.value.json()
                    geometry_id = geometry["id"]
                    page.locator(f'[data-df-geo-item="{geometry_id}"]').wait_for()
                    page.locator("[data-df-geo-persistence-receipt]").get_by_text(
                        "Geometry saved and reloaded.").wait_for()
                    check(geometry["provenance"] == "OPERATOR_ANNOTATION_NOT_SENSOR_EVIDENCE",
                          "Operator geometry claimed sensor provenance")
                    report["geometry_id"] = geometry_id
                    report["browser_checks"].append("UI WGS84 geometry POST 201, measured by backend")

                    page.locator(f'[data-df-geo-item="{geometry_id}"] [data-df-geo-edit]').click()
                    page.locator("[data-df-geo-label]").fill("Operator route revised")
                    page.locator("[data-df-geo-vertices]").fill("103.801, 1.281\n103.821, 1.302")
                    with page.expect_response(lambda r: r.request.method == "PUT" and
                                              f"/geometries/{geometry_id}" in r.url) as event:
                        page.locator("[data-df-geo-save]").click()
                    check(event.value.status == 200, f"UI geometry PUT {event.value.status}")
                    page.locator(f'[data-df-geo-item="{geometry_id}"]').get_by_text("Operator route revised").wait_for()
                    page.locator("[data-df-geo-persistence-receipt]").get_by_text(
                        "Geometry update saved and reloaded.").wait_for()
                    report["browser_checks"].append("UI geometry edit PUT 200 and updated result visible")

                    with page.expect_download() as received_json:
                        page.locator("[data-df-case-report-json]").click()
                    json_download = received_json.value
                    json_bytes = Path(json_download.path()).read_bytes()
                    report_body = json.loads(json_bytes)
                    check(report_body["source_status"] == "NO_SCAN_LINKED",
                          "Unlinked report fabricated a source scan")
                    canonical = json.dumps(
                        {key: value for key, value in report_body.items()
                         if key not in ("hash_algorithm", "content_sha256")},
                        sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                        allow_nan=False,
                    ).encode("utf-8")
                    check(report_body["content_sha256"] == sha256(canonical),
                          "Downloaded report integrity digest is invalid")
                    check(note in json_bytes.decode(), "JSON download omitted operator annotation")
                    check(b"Operator route revised" in json_bytes,
                          "JSON download omitted revised operator geometry")
                    report["json_download_sha256"] = sha256(json_bytes)
                    report["browser_checks"].append("Browser downloaded real report JSON, source NO_SCAN_LINKED")
                    with page.expect_download() as received_pdf:
                        page.locator("[data-df-case-report-pdf]").click()
                    pdf_bytes = Path(received_pdf.value.path()).read_bytes()
                    check(pdf_bytes.startswith(b"%PDF-") and len(pdf_bytes) > 600,
                          "Browser PDF download lacks valid PDF header/bytes")
                    report["pdf_download_sha256"] = sha256(pdf_bytes)
                    report["browser_checks"].append("Browser downloaded real, nonempty PDF from backend")

                    rail("MISSIONS")
                    page.locator("[data-df-mission-title]").fill("Operator E2E Mission")
                    page.locator("[data-df-mission-aoi]").fill("103.0, 1.0, 104.0, 2.0")
                    with page.expect_response(lambda r: r.request.method == "POST" and
                                              r.url.endswith("/api/missions")) as event:
                        page.locator("[data-df-mission-create]").click()
                    check(event.value.status == 201, f"Mission UI POST {event.value.status}")
                    mission_id = event.value.json()["id"]
                    page.locator(f'[data-df-mission-detail="{mission_id}"]').wait_for()
                    report["mission_id"] = mission_id
                    page.locator("[data-df-mission-status]").select_option("ACTIVE")
                    with page.expect_response(lambda r: r.request.method == "PUT" and
                                              r.url.endswith(f"/api/missions/{mission_id}")) as event:
                        page.locator("[data-df-mission-save-status]").click()
                    check(event.value.status == 200, f"Mission UI PUT {event.value.status}")
                    check(event.value.json()["status"] == "ACTIVE", "Mission status did not persist")
                    report["browser_checks"].append("UI mission POST 201 + status change PUT 200 ACTIVE")

                    rail("VIEWS")
                    page.locator("#df-view-name").fill("Operator E2E workspace view")
                    with page.expect_response(lambda r: r.request.method == "POST" and
                                              r.url.endswith("/api/views")) as event:
                        page.locator("[data-df-view-save]").click()
                    check(event.value.status == 201, f"Saved view UI POST {event.value.status}")
                    view_id = event.value.json()["id"]
                    page.locator(f'[data-df-view-selected="{view_id}"]').wait_for()
                    page.locator("[data-df-view-rename]").click()
                    check(page.locator("#df-view-name").evaluate("el => document.activeElement === el"),
                          "EDIT NAME did not focus the real input control")
                    report["browser_checks"].append("UI EDIT NAME focuses editable saved-view title")
                    page.locator("#df-view-name").fill("Operator E2E workspace revised")
                    with page.expect_response(lambda r: r.request.method == "PUT" and
                                              r.url.endswith(f"/api/views/{view_id}")) as event:
                        page.locator("[data-df-view-update]").click()
                    check(event.value.status == 200, f"Saved view UI PUT {event.value.status}")
                    check(event.value.json()["revision"] == 2,
                          "Saved view update did not increment durable revision")
                    report["view_id"] = view_id
                    report["browser_checks"].append("UI view POST 201 + PUT 200, durable revision 2")

                    # Independent backend restart; no TestClient substitution.
                    original_api_pid = api.pid
                    end_owned(api)
                    api = None
                    unused_port(API_PORT)
                    api = start_api()
                    report["api_restarted_pid"] = api.pid
                    wait_service(api_base + "/health", api)
                    check(api.pid != original_api_pid, "Backend restart did not change process")
                    # Reopen in a *fresh browser page*, not React local state.
                    page.close()
                    reopened = context.new_page()
                    page = reopened
                    page.set_default_timeout(20000)
                    page.goto(web_base + "/", wait_until="domcontentloaded", timeout=45000)
                    page.locator("[data-df-app]").wait_for()
                    rail("MISSIONS")
                    page.locator(f'[data-df-mission-detail="{mission_id}"]').wait_for()
                    check(page.locator("[data-df-mission-status]").input_value() == "ACTIVE",
                          "Restart/reopen lost mission status")
                    rail("REPORTS")
                    page.locator(f'[data-df-investigation-detail="{case_id}"]').wait_for()
                    page.locator("[data-df-investigation-notes]").get_by_text(note).wait_for()
                    page.locator(f'[data-df-geo-item="{geometry_id}"]').get_by_text("Operator route revised").wait_for()
                    with page.expect_download() as reopened_json:
                        page.locator("[data-df-case-report-json]").click()
                    reopened_report = Path(reopened_json.value.path()).read_bytes()
                    check(sha256(reopened_report) == report["json_download_sha256"],
                          "Downloaded investigation JSON changed across backend restart")
                    report["browser_checks"].append(
                        "New backend PID + fresh browser page: case/note/geometry/mission restored, JSON SHA-256 stable")
                    rail("VIEWS")
                    page.locator(f'[data-df-view-selected="{view_id}"]').wait_for()
                    page.locator(f'[data-df-view-selected="{view_id}"]').get_by_text("Revision 2").wait_for()
                    page.locator("[data-df-view-restore]").click()
                    page.get_by_text("restored", exact=False).first.wait_for()
                    report["browser_checks"].append(
                        "Reopened view library showed revision 2; clicked restore on persisted snapshot")
                    case_after = get_json(api_base + f"/api/investigations/{case_id}")
                    mission_after = get_json(api_base + f"/api/missions/{mission_id}")
                    geometries_after = get_json(api_base + f"/api/investigations/{case_id}/geometries")
                    view_after = get_json(api_base + f"/api/views/{view_id}")
                    check(case_after["annotations"][0]["id"] == annotation_id,
                          "API after restart lost annotation identity")
                    check(mission_after["status"] == "ACTIVE", "API after restart lost mission update")
                    check(geometries_after["geometries"][0]["label"] == "Operator route revised",
                          "API after restart lost geometry update")
                    check(view_after["revision"] == 2 and
                          view_after["title"] == "Operator E2E workspace revised",
                          "API after restart lost saved view update")
                    report["api_cross_checks"].append(
                        "Fresh FastAPI persisted read of case note, geometry, mission and view verified")
                    report["browser_http_responses"] = responses
                    report["blocked_browser_external_hosts"] = dict(blocked)
                    report["page_errors"] = errors
                    context.close()
                    browser.close()

                egress = scratch / "backend-egress.log"
                report["blocked_backend_egress"] = (
                    egress.read_text(encoding="utf-8").splitlines() if egress.is_file() else [])
                report["persistent_files"] = sorted(str(p.relative_to(data_dir))
                                                    for p in data_dir.rglob("*") if p.is_file())
                check(all(p.endswith(".sqlite3") or p.startswith(("scans", "cache"))
                          for p in report["persistent_files"]),
                      f"Unexpected temp-root file: {report['persistent_files']}")
                check(len(report["browser_checks"]) >= 8,
                      "Browser did not complete all supported workflow checks")
                report["status"] = "PASS_SUPPORTED_WORKFLOWS"
            finally:
                end_owned(vite)
                end_owned(api)
        report["temporary_data_deleted_on_exit"] = True
        return report


if __name__ == "__main__":
    try:
        result = run()
    except Exception as failure:
        print(json.dumps({
            "status": "FAILED_OR_BLOCKED", "error_type": type(failure).__name__,
            "error": str(failure), "warning": "Never interpret as browser PASS",
            "partial_browser_checks": LAST_PROGRESS.get("browser_checks", []),
            "partial_api_cross_checks": LAST_PROGRESS.get("api_cross_checks", []),
        }, indent=2), flush=True)
        raise
    print(json.dumps(result, indent=2), flush=True)
