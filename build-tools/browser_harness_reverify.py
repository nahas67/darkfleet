"""Read-only local DarkFleet UI smoke harness using an isolated headless Chrome.

Run from the repository root: python build-tools/browser_harness_reverify.py
The live Vite dev server must already serve http://localhost:5174 and proxy /api.
The test never submits forms, creates records, modifies saved application data,
or requests external map imagery; it exercises navigation and cached imagery.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
URL = "http://localhost:5174/"
SOURCES = (
    "src/command/DarkFleetCommandApp.tsx",
    "src/intelligence/AdvancedWorkspace.tsx",
    "src/advanced/SceneImageryWorkspace.tsx",
    "src/scenes/LocalSarImportPanel.tsx",
    "src/globe/engine.ts",
)
WORKSPACES = (
    "SEARCH", "INTELLIGENCE", "TASKING", "MISSIONS", "LAYERS",
    "ANALYTICS", "ADVANCED", "REPORTS", "VIEWS", "SYSTEM", "TACTICAL",
)


def source_digest() -> dict[str, str]:
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}


def git(*args: str) -> str:
    result = subprocess.run(["git", *args], cwd=ROOT, text=True,
                            capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else "UNKNOWN"


FRAME_SAMPLE = """async () => {
  const canvas = document.querySelector('.cesium-widget canvas');
  const gl = canvas?.getContext('webgl2');
  const raf = [];
  let lastRaf = null;
  await new Promise(resolve => {
    const step = now => {
      if (lastRaf !== null) raf.push(now - lastRaf);
      lastRaf = now;
      if (raf.length < 90) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  const percentile = (values, fraction) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return Math.round(sorted[Math.ceil(fraction * sorted.length) - 1] * 100) / 100;
  };
  return {visibility: document.visibilityState,
    canvasConnected: !!canvas?.isConnected, canvasWebgl2: !!gl,
    canvasPixels: canvas ? [canvas.width,canvas.height] : null,
    raf: {intervalCount:raf.length,p50Ms:percentile(raf,.5),p95Ms:percentile(raf,.95)},
    note:'Browser requestAnimationFrame intervals only, NOT Cesium postRender or GPU draw durations'};
}"""


def run() -> dict:
    result: dict = {
        "timestampUtc": datetime.now(timezone.utc).isoformat(),
        "url": URL, "gitHead": git("rev-parse", "HEAD"),
        "dirty": bool(git("status", "--porcelain")),
        "sourceSha256Before": source_digest(), "workspaces": [],
        "pageErrors": [], "consoleErrors": [], "failedRequests": [],
        "dataMutations": "NONE_REQUESTED_BY_HARNESS",
        "externalRequests": "BLOCKED_AT_BROWSER_CONTEXT",
    }
    if not CHROME.is_file():
        return {**result, "status": "BLOCKED", "reason": "Installed Chrome executable unavailable"}

    with sync_playwright() as p:
        browser = None
        try:
            browser = p.chromium.launch(
                executable_path=str(CHROME), headless=True,
                args=["--enable-gpu", "--enable-webgl", "--ignore-gpu-blocklist",
                      "--disable-software-rasterizer", "--use-angle=d3d11"],
                timeout=20000,
            )
            result["browserVersion"] = browser.version
            context = browser.new_context(viewport={"width": 1440, "height": 900})
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url.startswith(
                              ("http://localhost:5174/", "http://127.0.0.1:8000/",
                               "data:", "blob:"))
                          else route.abort("blockedbyclient"))
            page = context.new_page()
            page.on("pageerror", lambda error: result["pageErrors"].append(str(error)[:500]))
            page.on("console", lambda msg: result["consoleErrors"].append(msg.text[:500])
                    if msg.type == "error" and "ERR_BLOCKED_BY_CLIENT" not in msg.text else None)
            page.on("requestfailed", lambda request: result["failedRequests"].append(
                {"url": request.url[:220], "failure": request.failure})
                    if request.url.startswith("http://localhost:5174/api/") else None)

            response = page.goto(URL, wait_until="domcontentloaded", timeout=20000)
            result["documentStatus"] = response.status if response else None
            page.locator("[data-df-app]").wait_for(timeout=15000)
            result["title"] = page.title()
            result["buildMeta"] = page.locator('meta[name^="darkfleet-"]').evaluate_all(
                "els => els.map(e => [e.name, e.content])")
            result["canvasCount"] = page.locator("canvas").count()
            result["webgl"] = page.evaluate("""() => {
              const canvas = document.createElement('canvas');
              const gl = canvas.getContext('webgl2');
              if (!gl) return { webgl2: false };
              const debug = gl.getExtension('WEBGL_debug_renderer_info');
              return { webgl2: true, version: gl.getParameter(gl.VERSION),
                renderer: gl.getParameter(gl.RENDERER),
                unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
                unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null };
            }""")
            result["moduleProbe"] = {}
            for path in ("/src/command/DarkFleetCommandApp.tsx",
                         "/src/intelligence/AdvancedWorkspace.tsx"):
                fetched = context.request.get(URL.rstrip("/") + path, timeout=9000)
                raw = context.request.get(URL.rstrip("/") + path + "?raw", timeout=9000)
                raw_text = raw.text()
                raw_source = json.loads(raw_text.removeprefix("export default ").rstrip(";\r\n"))
                source_path = path.lstrip("/")
                result["moduleProbe"][path] = {"status": fetched.status,
                    "contentType": fetched.headers.get("content-type"),
                    "hasExpectedMarker": ("data-df-app" if "DarkFleetCommandApp" in path
                        else "Local GeoTIFF") in fetched.text(),
                    "rawSha256MatchesDisk": (hashlib.sha256(raw_source.encode("utf-8")).hexdigest()
                                             == source_digest()[source_path])}

            for workspace in WORKSPACES:
                entry = page.locator(f'[data-df-rail-entry="{workspace}"]')
                began = perf_counter()
                entry.click(timeout=5000)
                entry.wait_for(state="visible", timeout=5000)
                page.wait_for_function("name => document.querySelector('[data-df-rail-entry=\"' + name + '\"]')?.getAttribute('aria-pressed') === 'true'", arg=workspace, timeout=5000)
                panel = page.locator("[data-df-workspace-panel]")
                result["workspaces"].append({"name": workspace,
                    "active": entry.get_attribute("aria-pressed"),
                    "clickToActiveMs": round((perf_counter() - began) * 1000, 1),
                    "panelVisible": panel.is_visible(),
                    "text": panel.inner_text(timeout=5000)[:160]})

            page.locator('[data-df-rail-entry="ADVANCED"]').click(timeout=5000)
            page.locator('[data-df-advanced-tab="LOCAL_SAR"]').click(timeout=5000)
            local_panel = page.locator("[data-df-local-sar-import-panel]")
            local_panel.wait_for(timeout=5000)
            try:
                page.wait_for_function("() => !document.querySelector('[data-df-local-sar-service-state]')?.textContent?.includes('Checking local source service')", timeout=6000)
            except PlaywrightTimeout:
                pass
            result["localImport"] = {"visible": local_panel.is_visible(),
                "serviceState": page.locator("[data-df-local-sar-service-state]").inner_text(timeout=6000)[:400],
                "importFormPresent": page.locator("[data-df-local-sar-form]").count() == 1,
                "importSubmitNotClicked": True}

            page.locator('[data-df-advanced-tab="IMAGERY"]').click(timeout=5000)
            page.locator("[data-df-scene-imagery-workspace]").wait_for(timeout=5000)
            # Catalogue loading is asynchronous. A valid pre-load empty select
            # must not be mistaken for a real no-scenes state.
            page.wait_for_function("() => document.querySelectorAll('[data-df-scene-imagery-workspace] select option').length >= 6", timeout=12000)
            imagery = {"choices": [
                page.get_by_label("First acquisition").input_value(timeout=10000),
                page.get_by_label("Second acquisition").input_value(timeout=10000)],
                "buttonEnabled": page.locator("[data-df-imagery-load]").is_enabled()}
            if imagery["buttonEnabled"]:
                page.locator("[data-df-imagery-load]").click(timeout=5000)
                page.locator("[data-df-imagery-result]").wait_for(timeout=15000)
                imagery["resultStatus"] = page.locator("[data-df-imagery-result]").get_attribute("data-df-imagery-result")
                imagery["panes"] = page.locator("[data-df-imagery-pane]").count()
                try:
                    page.wait_for_function("() => {const imgs=[...document.querySelectorAll('[data-df-imagery-pane] img')]; return imgs.length===2 && imgs.every(x => x.complete)}", timeout=12000)
                except PlaywrightTimeout:
                    imagery["imageLoadTimeout"] = True
                imagery["sourceImages"] = page.locator("[data-df-imagery-pane] img").evaluate_all(
                    "imgs => imgs.map(x => ({complete:x.complete,width:x.naturalWidth,height:x.naturalHeight,src:x.getAttribute('src')}))")
                imagery["text"] = page.locator("[data-df-imagery-result]").inner_text()[:420]
            result["sceneImagery"] = imagery
            # Closing each page unloads the app. The next page creates a fresh
            # app + Cesium canvas. Three bounded lifecycle observations only.
            result["repeatCycles"] = []
            page.close()
            for cycle in range(1, 4):
                page = context.new_page()
                page.goto(URL, wait_until="domcontentloaded", timeout=20000)
                page.locator("[data-df-app]").wait_for(timeout=15000)
                page.locator(".cesium-widget canvas").first.wait_for(timeout=15000)
                sample = page.evaluate(FRAME_SAMPLE)
                page.locator('[data-df-rail-entry="ADVANCED"]').click(timeout=5000)
                page.evaluate("""() => {
                  window.__dfRailInput = null;
                  const target = document.querySelector('[data-df-rail-entry="TACTICAL"]');
                  target.addEventListener('click', () => {
                    const clickedAt = performance.now();
                    requestAnimationFrame(() => {window.__dfRailInput = {
                      clickToNextRafMs: Math.round((performance.now()-clickedAt)*100)/100,
                      targetActiveAtNextRaf:target.getAttribute('aria-pressed')==='true'};});
                  }, {once:true});
                }""")
                page.locator('[data-df-rail-entry="TACTICAL"]').click(timeout=5000)
                page.wait_for_function("() => window.__dfRailInput !== null", timeout=5000)
                sample["input"] = page.evaluate("window.__dfRailInput")
                page.locator('[data-df-rail-entry="LAYERS"]').click(timeout=5000)
                page.locator('[data-df-rail-entry="TACTICAL"]').click(timeout=5000)
                sample["canvasAfterNavigation"] = page.locator(".cesium-widget canvas").count()
                sample["cycle"] = cycle
                result["repeatCycles"].append(sample)
                page.close()

            images = imagery.get("sourceImages", [])
            full_check = (
                len(result["workspaces"]) == len(WORKSPACES)
                and all(entry["active"] == "true" and entry["panelVisible"]
                        for entry in result["workspaces"])
                and result["localImport"]["visible"]
                and all(entry["status"] == 200 and entry["hasExpectedMarker"]
                        and entry["rawSha256MatchesDisk"]
                        for entry in result["moduleProbe"].values())
                and imagery.get("resultStatus") == "READY"
                and len(images) == 2
                and all(image["complete"] and image["width"] > 0 and image["height"] > 0
                        for image in images)
                and not result["pageErrors"]
                and len(result["repeatCycles"]) == 3
                and all(sample["canvasConnected"] and sample["canvasWebgl2"]
                        and sample["raf"]["intervalCount"] == 90
                        and sample["input"]["targetActiveAtNextRaf"]
                        and sample["canvasAfterNavigation"] == 1
                        for sample in result["repeatCycles"])
            )
            result["status"] = "BROWSER_EXECUTED" if full_check else "PARTIAL_OR_BLOCKED"
            if not full_check:
                result["reason"] = "One or more observable read-only UI smoke criteria failed; inspect fields"
        except (PlaywrightError, PlaywrightTimeout, OSError, ValueError) as exc:
            result["status"] = "PARTIAL_OR_BLOCKED"
            result["reason"] = f"{type(exc).__name__}: {str(exc)[:1000]}"
        finally:
            result["gitHeadAfter"] = git("rev-parse", "HEAD")
            result["headChangedDuringRun"] = result["gitHead"] != result["gitHeadAfter"]
            result["sourceSha256After"] = source_digest()
            result["sourceChangedDuringRun"] = result["sourceSha256Before"] != result["sourceSha256After"]
            if browser is not None:
                browser.close()
    return result


if __name__ == "__main__":
    report = run()
    print(json.dumps(report, indent=2))
    sys.exit(0 if report.get("status") == "BROWSER_EXECUTED" else 1)
