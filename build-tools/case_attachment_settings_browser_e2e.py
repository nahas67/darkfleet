"""Isolated real-Chrome case attachment, rename, report, settings and restart acceptance.

Run at repository root: python build-tools/case_attachment_settings_browser_e2e.py
Uses two unused dedicated loopback ports and a disposable SQLite root only.
No browser HTTP stubs, production data writes or fabricated sensor evidence.
"""

from __future__ import annotations

import hashlib
import json
import os
import runpy
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
API_PORT = 8015
WEB_PORT = 5179
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
SOURCES = (
    "backend/darkfleet/api/investigations.py",
    "backend/darkfleet/api/investigation_attachments.py",
    "backend/darkfleet/api/operator_settings.py",
    "backend/darkfleet/investigation_reports.py",
    "src/reports/InvestigationNotebook.tsx",
    "src/reports/InvestigationAttachments.tsx",
    "src/command/SystemPanel.tsx",
    "src/api/investigationAttachments.ts",
    "src/api/operatorSettings.ts",
)
LAST_PROGRESS: dict = {}
# Reuse tested isolated-process/security guard, not existing active services.
HELPERS = runpy.run_path(str(ROOT / "build-tools/operator_workflow_browser_e2e.py"))
BOOTSTRAP = HELPERS["BACKEND_BOOTSTRAP"]
wait_service = HELPERS["wait_service"]
end_owned = HELPERS["end_owned"]
unused_port = HELPERS["unused_port"]
check = HELPERS["check"]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_hashes() -> dict[str, str]:
    return {file: digest((ROOT / file).read_bytes()) for file in SOURCES}


def git_head() -> str:
    head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], text=True, cwd=ROOT, timeout=10,
    ).strip()
    check(len(head) == 40 and all(c in "0123456789abcdef" for c in head),
          "Repository Git HEAD is not a full source identity")
    return head


def api_json(base: str, path: str, *, method: str = "GET",
             body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = Request(base + path, data=data, method=method, headers={
        "Content-Type": "application/json", "Accept": "application/json",
    })
    try:
        with urlopen(req, timeout=15) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.loads(error.read())


def run() -> dict:
    global LAST_PROGRESS
    unused_port(API_PORT)
    unused_port(WEB_PORT)
    check((ROOT / "node_modules/vite/bin/vite.js").is_file(), "Vite installation unavailable")
    before = source_hashes()
    report: dict = {
        "timestamp_utc": datetime.now(UTC).isoformat(),
        "git_head": git_head(),
        "source_sha256_before": before,
        "api_port": API_PORT, "vite_port": WEB_PORT,
        "real_chrome": True, "http_response_mocks": 0, "synthetic_real_scans": 0,
        "checks": [], "not_run": [
            "No authenticated user/role identity: existing API is local-first and unauthenticated",
            "No verified real satellite/AIS scan or target-linked operator file source",
        ],
    }
    LAST_PROGRESS = report
    with tempfile.TemporaryDirectory(prefix="darkfleet-case-settings-browser-") as scratch_str:
        scratch = Path(scratch_str)
        data_dir = scratch / "data"
        data_dir.mkdir()
        report["temporary_data_root"] = str(data_dir)
        env = dict(os.environ)
        env["PYTHONPATH"] = str(ROOT / "backend") + os.pathsep + env.get("PYTHONPATH", "")
        env["DF_OPERATOR_DATA"] = str(data_dir)
        env["DF_OPERATOR_API_PORT"] = str(API_PORT)
        env["DF_OPERATOR_EGRESS_LOG"] = str(scratch / "backend-egress.log")
        env["PROJ_NETWORK"] = "OFF"
        web_env = dict(env, DARKFLEET_API_URL=f"http://127.0.0.1:{API_PORT}")
        base = f"http://127.0.0.1:{API_PORT}"
        web = f"http://127.0.0.1:{WEB_PORT}"
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        api_proc = vite_proc = None
        with (scratch / "backend.log").open("w", encoding="utf-8") as api_log, (
            scratch / "vite.log"
        ).open("w", encoding="utf-8") as vite_log:
            try:
                def start_api():
                    return subprocess.Popen(
                        [sys.executable, "-c", BOOTSTRAP],
                        cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                        stdout=api_log, stderr=subprocess.STDOUT, creationflags=flags,
                    )

                api_proc = start_api()
                report["initial_backend_pid"] = api_proc.pid
                wait_service(base + "/health", api_proc)
                vite_proc = subprocess.Popen(
                    ["node", str(ROOT / "node_modules/vite/bin/vite.js"),
                     "--host", "127.0.0.1", "--port", str(WEB_PORT), "--strictPort"],
                    cwd=ROOT, env=web_env, stdin=subprocess.DEVNULL, stdout=vite_log,
                    stderr=subprocess.STDOUT, creationflags=flags,
                )
                report["vite_pid"] = vite_proc.pid
                wait_service(web + "/", vite_proc)
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(channel="chrome", headless=True)
                    report["chrome_version"] = browser.version
                    context = browser.new_context(
                        viewport={"width": 1600, "height": 980},
                        accept_downloads=True, service_workers="block",
                    )
                    blocked: Counter[str] = Counter()
                    writes: list[dict] = []
                    js_errors: list[str] = []

                    def loopback_only(route):
                        url = urlsplit(route.request.url)
                        if url.scheme in ("data", "blob", "about") or (
                            url.scheme in ("http", "https") and url.hostname in LOOPBACK
                        ):
                            route.continue_()
                        else:
                            blocked[url.hostname or url.scheme] += 1
                            route.abort("blockedbyclient")

                    context.route("**/*", loopback_only)

                    def ws_guard(socket):
                        if urlsplit(socket.url).hostname in LOOPBACK:
                            socket.connect_to_server()
                        else:
                            blocked[urlsplit(socket.url).hostname or "websocket"] += 1
                            socket.close()

                    context.route_web_socket("**/*", ws_guard)
                    page = context.new_page()
                    page.set_default_timeout(20000)
                    page.on("pageerror", lambda err: js_errors.append(str(err)[:500]))
                    page.on("response", lambda resp: writes.append({
                        "path": urlsplit(resp.url).path,
                        "method": resp.request.method,
                        "status": resp.status,
                    }) if resp.request.method in ("POST", "PUT", "DELETE") and
                    urlsplit(resp.url).path.startswith("/api/") else None)

                    def rail(name: str):
                        page.locator(f'[data-df-rail-entry="{name}"]').click()
                        page.locator(f'[data-df-workspace="{name}"]').wait_for(state="visible")

                    page.goto(web + "/", wait_until="domcontentloaded", timeout=45000)
                    page.locator("[data-df-app]").wait_for()
                    rail("REPORTS")
                    page.locator("#df-new-case").fill("Local binary operator case")
                    with page.expect_response(lambda r: r.request.method == "POST" and
                                              r.url.endswith("/api/investigations")) as event:
                        page.locator("[data-df-investigation-create]").click()
                    check(event.value.status == 201, "Browser case create did not return 201")
                    case_id = event.value.json()["id"]
                    report["case_id"] = case_id
                    page.locator(f'[data-df-investigation-detail="{case_id}"]').wait_for()
                    report["checks"].append("Browser case created via real POST 201")

                    page.locator("[data-df-investigation-rename]").click()
                    page.locator("#df-case-rename").fill("Local binary operator case RENAMED")
                    with page.expect_response(lambda r: r.request.method == "PUT" and
                                              r.url.endswith(f"/api/investigations/{case_id}")) as event:
                        page.locator("[data-df-investigation-rename-save]").click()
                    check(event.value.status == 200, "Case rename PUT did not return 200")
                    check(event.value.json()["scan_id"] is None, "Rename fabricated a scan link")
                    report["checks"].append("Browser case title updated with immutable empty scan link")

                    payload = b"Operator-authored isolated acceptance byte evidence 2026-10-11\n"
                    filename = "operator-acceptance.txt"
                    page.locator("[data-df-attachment-file]").set_input_files({
                        "name": filename, "mimeType": "text/plain", "buffer": payload,
                    })
                    with page.expect_response(lambda r: r.request.method == "POST" and
                                              r.url.endswith(f"/api/investigations/{case_id}/attachments")) as event:
                        page.locator("[data-df-attachment-upload]").click()
                    created = event.value
                    check(created.status == 201, f"Browser attachment upload: {created.status}")
                    item = created.json()
                    aid = item["id"]
                    report["attachment_id"] = aid
                    check(item["sha256"] == digest(payload), "Upload receipt is not source-byte hash")
                    check(item["provenance"] == "OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE",
                          "Operator upload claimed sensor provenance")
                    page.locator(f'[data-df-attachment-id="{aid}"]').wait_for()
                    page.locator("[data-df-attachment-receipt]").get_by_text(
                        "Attachment stored on server").wait_for()
                    with page.expect_download() as binary_download:
                        page.locator(f'[data-df-attachment-id="{aid}"] [data-df-attachment-download]').click()
                    downloaded = Path(binary_download.value.path()).read_bytes()
                    check(downloaded == payload, "Browser binary downloaded wrong bytes")
                    report["attachment_sha256"] = digest(downloaded)
                    report["checks"].append("Browser upload POST201/list/real download exact bytes SHA256 and provenance")

                    with page.expect_download() as json_download:
                        page.locator("[data-df-case-report-json]").click()
                    json_bytes = Path(json_download.value.path()).read_bytes()
                    document = json.loads(json_bytes)
                    check(document["source_status"] == "NO_SCAN_LINKED",
                          "User attachment falsely promoted to real sensor evidence")
                    manifests = document["operator_material"]["attachments"]
                    check(len(manifests) == 1 and manifests[0]["sha256"] == digest(payload),
                          "Report omitted canonical attachment metadata")
                    check(payload not in json_bytes, "Binary file embedded in JSON report")
                    canonical = json.dumps({
                        key: value for key, value in document.items()
                        if key not in ("content_sha256", "hash_algorithm")
                    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                        allow_nan=False).encode()
                    check(digest(canonical) == document["content_sha256"],
                          "Report canonical hash mismatch")
                    report["case_report_sha256"] = digest(json_bytes)
                    with page.expect_download() as pdf_download:
                        page.locator("[data-df-case-report-pdf]").click()
                    pdf_bytes = Path(pdf_download.value.path()).read_bytes()
                    check(pdf_bytes.startswith(b"%PDF-") and item["sha256"].encode() in pdf_bytes,
                          "PDF report omitted operator attachment checksum")
                    check(payload not in pdf_bytes, "Binary file embedded in PDF report")
                    report["checks"].append("Browser JSON/PDF downloads include hash manifest without file bytes")

                    rail("SYSTEM")
                    panel = page.locator("[data-df-operator-settings]")
                    panel.wait_for()
                    page.locator('[data-df-operator-setting="show_keyboard_reference"]').uncheck()
                    with page.expect_response(lambda r: r.request.method == "PUT" and
                                              r.url.endswith("/api/operator-settings")) as event:
                        page.locator("[data-df-settings-save]").click()
                    check(event.value.status == 200, "Settings SAVE HTTP not 200")
                    revision1 = event.value.json()
                    check(revision1["revision"] == 1 and
                          revision1["preferences"]["show_keyboard_reference"] is False,
                          "Settings update was not persisted")
                    page.locator("[data-df-settings-revision]").get_by_text("Revision 1").wait_for()
                    check(page.locator("[data-df-provenance-mandatory]").count() == 1,
                          "Settings hid mandatory source statuses")
                    report["checks"].append("Browser settings SAVE persisted revision1; mandatory status still visible")

                    other = dict(revision1["preferences"], show_provider_details=False)
                    http, external_revision = api_json(base, "/api/operator-settings", method="PUT",
                                                       body={"expected_revision": 1, "preferences": other})
                    check(http == 200 and external_revision["revision"] == 2,
                          "Independent settings revision update did not occur")
                    page.locator('[data-df-operator-setting="show_provenance_summary"]').uncheck()
                    with page.expect_response(lambda r: r.request.method == "PUT" and
                                              r.url.endswith("/api/operator-settings")) as event:
                        page.locator("[data-df-settings-save]").click()
                    check(event.value.status == 409, "Stale browser settings write was not 409")
                    page.locator("[data-df-settings-error]").get_by_text(
                        "changed in another session", exact=False).wait_for()
                    check(page.locator("[data-df-provenance-mandatory]").count() == 1,
                          "Settings conflict masked mandatory status")
                    page.locator("[data-df-settings-reload]").click()
                    page.locator("[data-df-settings-revision]").get_by_text("Revision 2").wait_for()
                    with page.expect_response(lambda r: r.request.method == "POST" and
                                              r.url.endswith("/api/operator-settings/reset")) as event:
                        page.locator("[data-df-settings-reset]").click()
                    check(event.value.status == 200, "Settings reset HTTP not 200")
                    check(event.value.json()["revision"] == 3, "Reset did not advance revision")
                    report["checks"].append("Independent revision2 caused genuine UI stale PUT409; reload and reset POST200 revision3")

                    old_pid = api_proc.pid
                    end_owned(api_proc)
                    api_proc = None
                    unused_port(API_PORT)
                    api_proc = start_api()
                    wait_service(base + "/health", api_proc)
                    report["backend_restarted_pid"] = api_proc.pid
                    check(api_proc.pid != old_pid, "Backend PID unchanged across restart")
                    page.close()
                    page = context.new_page()
                    page.set_default_timeout(20000)
                    page.goto(web + "/", wait_until="domcontentloaded", timeout=45000)
                    page.locator("[data-df-app]").wait_for()
                    rail("SYSTEM")
                    page.locator("[data-df-settings-revision]").get_by_text("Revision 3").wait_for()
                    check(page.locator('[data-df-operator-setting="show_keyboard_reference"]').is_checked(),
                          "Reset preferences did not survive independent backend/browser restart")
                    check(page.locator("[data-df-provenance-mandatory]").count() == 1,
                          "Mandatory provenance disappeared after reopening")
                    rail("REPORTS")
                    page.locator(f'[data-df-investigation-detail="{case_id}"]').wait_for()
                    page.locator(f'[data-df-attachment-id="{aid}"]').wait_for()
                    check(page.locator(f'[data-df-attachment-id="{aid}"]')
                          .get_by_text(filename, exact=False).count() > 0,
                          "Attachment name missing after restart")
                    with page.expect_download() as after_restart_download:
                        page.locator(f'[data-df-attachment-id="{aid}"] [data-df-attachment-download]').click()
                    check(digest(Path(after_restart_download.value.path()).read_bytes()) ==
                          report["attachment_sha256"], "Attachment bytes drifted across backend restart")
                    with page.expect_download() as after_restart_json:
                        page.locator("[data-df-case-report-json]").click()
                    check(digest(Path(after_restart_json.value.path()).read_bytes()) ==
                          report["case_report_sha256"], "Canonical report JSON changed across restart")
                    http, persisted = api_json(base, f"/api/investigations/{case_id}")
                    check(http == 200 and persisted["title"].endswith("RENAMED"),
                          "Case title not durable across backend restart")
                    http, stable = api_json(base, "/api/operator-settings")
                    check(http == 200 and stable["revision"] == 3, "Settings restart reloaded stale revision")
                    report["checks"].append(
                        "New backend PID and browser page reopened case/title/file+SHA/report hash and revision3 defaults")

                    page.locator(f'[data-df-attachment-id="{aid}"] [data-df-attachment-delete]').click()
                    with page.expect_response(lambda r: r.request.method == "DELETE" and
                                              r.url.endswith(f"/attachments/{aid}")) as event:
                        page.locator("[data-df-attachment-confirm-delete]").click()
                    check(event.value.status == 204, "Attachment UI DELETE HTTP not 204")
                    page.locator("[data-df-attachment-count]").get_by_text(
                        "Persisted attachments (0)").wait_for()
                    page.reload(wait_until="domcontentloaded", timeout=45000)
                    rail("REPORTS")
                    page.locator(f'[data-df-investigation-detail="{case_id}"]').wait_for()
                    page.locator("[data-df-attachment-count]").get_by_text(
                        "Persisted attachments (0)").wait_for()
                    http, after = api_json(base, f"/api/investigations/{case_id}/attachments")
                    check(http == 200 and after["count"] == 0, "Deleted bytes persisted after reopen")
                    report["checks"].append("Browser DELETE 204 + reload verified attachment removal")
                    report["browser_write_responses"] = writes
                    report["javascript_errors"] = js_errors
                    report["blocked_browser_hosts"] = dict(blocked)
                    context.close()
                    browser.close()

                report["backend_egress_attempts_blocked"] = (
                    (scratch / "backend-egress.log").read_text(encoding="utf-8").splitlines()
                    if (scratch / "backend-egress.log").exists() else []
                )
                report["temp_files"] = sorted(p.relative_to(data_dir).as_posix()
                                              for p in data_dir.rglob("*") if p.is_file())
                check(not js_errors, f"Browser had JavaScript exceptions: {js_errors}")
                check(git_head() == report["git_head"],
                      "Git HEAD changed during browser run; invalid source/build identity")
                check(source_hashes() == before, "Production source changed during this browser run")
                report["git_head_after"] = git_head()
                ending_head = subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], text=True, cwd=ROOT,
                ).strip()
                check(ending_head == report["git_head"],
                      "Repository HEAD changed while measuring browser workflow")
                report["git_head_after"] = ending_head
                report["source_sha256_after"] = source_hashes()
                check(len(report["checks"]) >= 8, "Not all browser acceptance steps passed")
                report["status"] = "PASS_SUPPORTED_CASE_SETTINGS_WORKFLOW"
            finally:
                end_owned(vite_proc)
                end_owned(api_proc)
        report["temp_deleted_on_exit"] = True
        return report


if __name__ == "__main__":
    try:
        result = run()
    except Exception as exc:
        print(json.dumps({
            "status": "FAILED_OR_BLOCKED", "error": str(exc),
            "error_type": type(exc).__name__, "not_a_pass": True,
            "completed_browser_checks": LAST_PROGRESS.get("checks", []),
            "execution_head": LAST_PROGRESS.get("git_head"),
        }, indent=2))
        raise
    print(json.dumps(result, indent=2))
