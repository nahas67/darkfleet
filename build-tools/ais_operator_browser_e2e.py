"""Controlled *non-live* AIS archive, genuine API, and real Chrome operator E2E.

Run from the repository root: ``python build-tools/ais_operator_browser_e2e.py``.

This DOES NOT validate live AIS, SAR acquisition, or provider delivery. The
isolated archive contains explicitly labelled mathematical fixture observations.
The product refuses synthetic REAL scan records, so this harness places a
test-only NONLIVE scan window descriptor in a temporary store directory and
sets only the selected scan id in the browser. AIS content is fetched by the
unchanged production ``loadScanAis`` client from the actual FastAPI archive.
No synthetic scan is ever represented as a production REAL scan.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import psutil
from playwright.sync_api import Error as BrowserError
from playwright.sync_api import TimeoutError as BrowserTimeout
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
API_SCAN = "AIS-BROWSER-FIXTURE-NONLIVE"
SOURCE = "fixture-browser-nonlive"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
CONTRACTS = (
    "src/ais/displayState.ts", "src/api/client.ts", "src/contacts/ContactList.tsx",
    "src/command/DarkFleetCommandApp.tsx", "src/command/OperationRail.tsx",
    "src/tactical/TacticalWorld.tsx", "src/globe/aisRenderer.ts",
    "src/globe/engine.ts", "src/globe/aisCamera.ts",
    "src/temporal/AisPlaybackBar.tsx", "src/temporal/TemporalController.ts",
    "src/sensors/LayerConsole.tsx", "src/state/store.ts",
    "backend/darkfleet/ais/archive.py", "backend/darkfleet/ais/delivery.py",
    "backend/darkfleet/api/routes.py", "vite.config.ts",
    # These transitive dev modules have previously changed during an AIS run,
    # triggering Vite HMR without changing any of the original 17 digests.
    "src/globe/aisPick.ts", "src/command/SystemPanel.tsx",
    "src/design/tokens.css", "index.html",
)


def fail_unless(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def git(*args: str) -> str:
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else "UNKNOWN"


def hashes() -> dict[str, str | None]:
    """Missing/unreadable watched input is explicit, never a successful hash.

    The *pure* final acceptance check rejects even an identically missing file
    in both snapshots; otherwise two equal partial snapshots could mean PASS.
    """
    snapshot: dict[str, str | None] = {}
    for rel in CONTRACTS:
        try:
            snapshot[rel] = hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()
        except OSError:
            snapshot[rel] = None
    return snapshot


def provenance_failures(
    *,
    head_before: str,
    head_after: str,
    hashes_before: dict[str, str | None],
    hashes_after: dict[str, str | None],
    watched: tuple[str, ...],
    main_frame_navigations: int,
    document_boots: list[int],
    document_origins: list[float],
    vite_messages: list[str],
    source_present: bool,
    hot_probe_attached: bool,
) -> list[str]:
    """Pure fail-closed browser acceptance, independent of existing UI gates.

    MUST be called after teardown/final HEAD and final source-byte sampling;
    never set PASS until this returns an empty list. `vite_messages` includes
    both browser-console HMR events and the isolated Vite server log.
    """
    failures: list[str] = []
    if not re.fullmatch(r"[0-9a-fA-F]{40}", head_before or "") or head_before != head_after:
        failures.append("GIT_HEAD_MISSING_OR_CHANGED")
    if not watched or len(set(watched)) != len(watched):
        failures.append("WATCH_SET_MISSING_OR_DUPLICATE")
    if set(hashes_before) != set(watched) or set(hashes_after) != set(watched):
        failures.append("WATCHED_SHA_SNAPSHOT_INCOMPLETE")
    for path in watched:
        before, after = hashes_before.get(path), hashes_after.get(path)
        if not isinstance(before, str) or not re.fullmatch(r"[0-9a-f]{64}", before):
            failures.append(f"WATCHED_SHA_MISSING_BEFORE:{path}")
        if not isinstance(after, str) or not re.fullmatch(r"[0-9a-f]{64}", after):
            failures.append(f"WATCHED_SHA_MISSING_AFTER:{path}")
        if before != after:
            failures.append(f"WATCHED_SHA_CHANGED:{path}")
    if main_frame_navigations != 1:
        failures.append("UNEXPECTED_MAIN_FRAME_NAVIGATION")
    if not document_boots or any(boot != 1 for boot in document_boots):
        failures.append("UNEXPECTED_DOCUMENT_BOOT_OR_MISSING_PROOF")
    if (not document_origins or not all(isinstance(o, (int, float)) and math.isfinite(o)
                                        for o in document_origins)
            or len(set(document_origins)) != 1):
        failures.append("DOCUMENT_ORIGIN_MISSING_OR_CHANGED")
    if not hot_probe_attached:
        failures.append("VITE_HOT_DIAGNOSTIC_NOT_ATTACHED")
    if any(re.search(r"\b(?:hmr|hot.updated|beforeFullReload|beforeUpdate|afterUpdate|full.reload|page.reload|vite:error)\b",
                     entry, re.IGNORECASE) for entry in vite_messages):
        failures.append("VITE_UNEXPECTED_UPDATE_OR_RELOAD")
    if not source_present:
        failures.append("RAW_AIS_SOURCE_IDENTITY_ABSENT")
    return failures


def finalize_browser_status(provisional_status: str, failures: list[str]) -> str:
    """Only the post-teardown provenance verdict can promote a provisional pass."""
    if provisional_status == "CANDIDATE_PASS":
        return "FAIL_PROVENANCE" if failures else "PASS"
    return provisional_status


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def http_json(base: str, path: str) -> dict:
    with urllib.request.urlopen(base + path, timeout=10) as response:
        fail_unless(response.status == 200, f"Unexpected HTTP {response.status}: {path}")
        return json.load(response)


def wait_http(base: str, path: str, process: subprocess.Popen, timeout: float = 40) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Service {process.pid} exited ({process.returncode})")
        try:
            with urllib.request.urlopen(base + path, timeout=3) as response:
                if response.status == 200:
                    return
        except (OSError, TimeoutError):
            pass
        time.sleep(0.2)
    raise TimeoutError(f"Service failed to start: {base}{path}")


def stop_owned(process: subprocess.Popen | None) -> None:
    if process is None:
        return
    try:
        parent = psutil.Process(process.pid)
        owned = [parent, *parent.children(recursive=True)]
        for item in owned:
            try:
                item.terminate()
            except psutil.NoSuchProcess:
                pass
        _, alive = psutil.wait_procs(owned, timeout=3)
        for item in alive:
            item.kill()
        psutil.wait_procs(alive, timeout=3)
    except psutil.NoSuchProcess:
        pass
    process.wait(timeout=5)


def seed_isolated_archive(root: Path) -> dict:
    sys.path.insert(0, str(ROOT / "backend"))
    from darkfleet.ais.archive import AisArchive
    from darkfleet.ais.models import AisObservation

    start = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
    observations = []
    for index in range(100):
        mmsi = f"257600{index + 1:03d}"
        # A named reporting gap on the first contact is deliberate. The positions
        # are deterministic TEST DATA, not AIS radio observations.
        minutes = (0, 4, 8, 20) if index == 0 else (0, 4, 8, 12, 16)
        for minute in minutes:
            observations.append(AisObservation(
                timestamp=start + timedelta(minutes=minute), mmsi=mmsi,
                lat=1.24 + (index // 10) * 0.012 + minute * 0.0002,
                lon=103.82 + (index % 10) * 0.018 + minute * 0.0002,
                sog=None if index == 1 else (0.0 if index == 2 else 12.5),
                cog=None if index == 1 else 90.0,
                heading=None if index % 2 else 91.0,
                name=f"NONLIVE TEST {index + 1:03d}",
                callsign=f"FIX{index + 1:03d}",
                imo=f"9{index + 1:06d}",
                source=SOURCE,
            ))
    archive = AisArchive(root)
    written = archive.append(observations)
    fail_unless(written["written"] == 499, f"Archive seed count mismatch: {written}")

    # A *non-live descriptor* exists only under TemporaryDirectory. The actual
    # product RunStore.save refuses it (correctly). Store is read-only from here;
    # the /scans/{id}/ais endpoint needs only AOI + acquisition time, and never
    # promises the descriptor is a completed SAR scan. Do NOT use this descriptor
    # to test scan targets or to imply a REAL provider result.
    scans = root / "scans"
    scans.mkdir(parents=True, exist_ok=True)
    descriptor = {
        "scan_id": API_SCAN, "stage": "FIXTURE_ONLY_NOT_A_SCAN",
        "runtime_mode": "FIXTURE_NONLIVE", "synthetic": True,
        "acquisition_time": (start + timedelta(minutes=10)).isoformat(),
        "aoi": [103.79, 1.19, 104.04, 1.43],
        "scene": {"acquisition_time": (start + timedelta(minutes=10)).isoformat(),
                  "item_id": "NOT_AN_ACQUISITION"},
    }
    (scans / f"{API_SCAN}.json").write_text(json.dumps(descriptor), encoding="utf-8")
    part_files = list((root / "ais").rglob("*.parquet"))
    return {"contacts": 100, "observations": len(observations),
            "source": SOURCE, "source_claim": "CONTROLLED_FIXTURE_NOT_LIVE",
            "fixture_parquet_sha256": {
                part.relative_to(root).as_posix(): hashlib.sha256(part.read_bytes()).hexdigest()
                for part in part_files}, "descriptor": descriptor}


# Only loopback is permitted from the isolated API. Import before app creation;
# this guard does not apply to Node or browser contexts (separate guards below).
BACKEND = r'''
import os, socket, ipaddress
connect = socket.socket.connect
lookup = socket.getaddrinfo
def allowed(host):
    if str(host).lower() in ('localhost','localhost.'):
        return True
    try: return ipaddress.ip_address(str(host)).is_loopback
    except ValueError: return False
def restricted(self, address):
    if self.family in (socket.AF_INET,socket.AF_INET6) and not allowed(address[0]):
        raise OSError('AIS_BROWSER_EXTERNAL_CONNECT_BLOCKED')
    return connect(self,address)
def restricted_lookup(host,*args,**kwargs):
    if not allowed(host): raise socket.gaierror('AIS_BROWSER_EXTERNAL_DNS_BLOCKED')
    return lookup(host,*args,**kwargs)
socket.socket.connect = restricted
socket.getaddrinfo = restricted_lookup
import uvicorn
from darkfleet.api.app import create_app
from darkfleet.config.settings import Settings
app=create_app(Settings(data_dir=os.environ['DF_AIS_BROWSER_DATA'],log_level='WARNING'))
uvicorn.run(app,host='127.0.0.1',port=int(os.environ['DF_AIS_BROWSER_PORT']),log_level='error')
'''

# The ordinary Vite config imports build-tools/buildIdentity.ts and restarts
# whenever another verification worker writes that file. This test gets an
# isolated Vite process with identical React, Tailwind, Cesium and API proxy
# plugins but without watching verification scripts/config dependencies.
# Operator code still comes directly from the repo's real src/ TSX modules.
VITE_SERVER = r'''
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import cesium from 'vite-plugin-cesium';
const server=await createServer({
  configFile:false, root:process.cwd(),
  plugins:[react(),tailwindcss(),cesium()],
  resolve:{alias:{'@':process.cwd()}},
  server:{host:'127.0.0.1',port:Number(process.env.DF_AIS_BROWSER_WEB_PORT),
    strictPort:true,proxy:{'/api':{target:process.env.DARKFLEET_API_URL,changeOrigin:true}}}
});
await server.listen();
'''


def dom_readout(page) -> dict:
    return page.evaluate("""() => {
      const one=(q)=>document.querySelector(q);
      const attr=(q,key)=>one(q)?.getAttribute(key) ?? null;
      const txt=(q)=>one(q)?.textContent?.trim() ?? null;
      return {bar:attr('[data-df-ais-playback]','data-df-ais-playback'),
        playing:attr('[data-df-ais-playback]','data-df-ais-playing'),
        selected:attr('[data-df-ais-selected]','data-df-ais-selected'),
        observation:attr('[data-df-ais-selected-observation]','data-df-ais-selected-observation'),
        observationText:txt('[data-df-ais-selected-observation]'),
        source:txt('[data-df-ais-selected-source]'),
        observationCount:txt('[data-df-ais-observation-count]'),
        drawn:txt('[data-df-ais-drawn-counts]'),
        drawnMmsis:attr('[data-df-ais-drawn-counts]','data-df-ais-drawn-mmsis'),
        counts:attr('[data-df-ais-drawn-counts]','data-df-ais-drawn-counts'),
        gapCount:attr('[data-df-ais-gap-count]','data-df-ais-gap-count'),
        now:txt('[data-df-ais-now]'),
        follow:attr('[data-df-ais-follow]','data-df-ais-follow'),
        followStatus:attr('[data-df-ais-follow-status]','data-df-ais-follow-status'),
        canvas:document.querySelectorAll('.cesium-widget canvas').length};
    }""")


def navigation_probe(page, label: str) -> dict:
    """Read the *real* singleton store and DOM after a true pointer action.

    Importing the store is read-only. Time origin and a session-storage boot
    counter distinguish in-page workspace changes from full-document reloads.
    """
    return page.evaluate("""async (label) => {
      const {store} = await import('/src/state/store.ts');
      const state = store.getState();
      const bar = document.querySelector('[data-df-ais-playback]');
      return {label, documentTimeOrigin: performance.timeOrigin,
        documentBoot: Number(sessionStorage.getItem('df_ais_browser_boots') || '0'),
        historicalLifecycleEvents: JSON.parse(sessionStorage.getItem('df_ais_browser_events') || '[]'),
        currentLifecycleEvents: (window.__dfAisBrowserEvents || []).slice(-15),
        route: location.pathname, workspace: state.workspace,
        pressedRail: [...document.querySelectorAll('[data-df-rail-entry][aria-pressed="true"]')]
          .map(el => el.getAttribute('data-df-rail-entry')),
        scanId: state.scanId, scanStage: state.scanStage,
        selectedMmsi: state.selectedAis?.mmsi ?? null,
        selectedObservationAt: state.selectedAis?.observationAt ?? null,
        observations: state.aisObservations.length, contacts: state.aisOnly.length,
        uniqueSources: [...new Set(state.aisObservations.map(row=>row.source))],
        coverageState: state.aisCoverage?.state ?? null,
        barPresent: bar !== null, barMode: bar?.getAttribute('data-df-ais-playback') ?? null,
        drawnCounts: document.querySelector('[data-df-ais-drawn-counts]')?.getAttribute('data-df-ais-drawn-counts') ?? null,
        canvasCount: document.querySelectorAll('.cesium-widget canvas').length,
        appPresent: document.querySelector('[data-df-app]') !== null,
        alertText: document.querySelector('[role="alert"]')?.textContent?.trim()?.slice(0,240) ?? null,
      };
    }""", label)


def run() -> dict:
    result: dict = {"status": "NOT_RUN", "checks": [], "failures": [],
                    "browserActions": [], "browserErrors": [], "blockedRequests": [],
                    "navigationProbes": [], "frameNavigations": [],
                    "viteMessages": [], "aisApiResponses": [], "aisApiFailures": [],
                    "gitHead": git("rev-parse", "HEAD"), "sourceHashesBefore": hashes(),
                    "syntheticProviderClaim": "NONE", "productScanCompleted": False}
    if not CHROME.is_file():
        return {**result, "status": "BLOCKED", "reason": "Chrome executable missing"}
    api_port, web_port = free_port(), free_port()
    fail_unless(api_port != web_port, "Port collision")
    result["ports"] = {"api": api_port, "web": web_port}
    with tempfile.TemporaryDirectory(prefix="df-ais-operator-nonlive-") as scratch:
        temp = Path(scratch)
        data = temp / "data"
        data.mkdir()
        result["fixture"] = seed_isolated_archive(data)
        api_url = f"http://127.0.0.1:{api_port}"
        web_url = f"http://127.0.0.1:{web_port}"
        env = dict(os.environ)
        env["PYTHONPATH"] = str(ROOT / "backend") + os.pathsep + env.get("PYTHONPATH", "")
        env.update(DF_AIS_BROWSER_DATA=str(data), DF_AIS_BROWSER_PORT=str(api_port),
                   PROJ_NETWORK="OFF")
        web_env = dict(env, DARKFLEET_API_URL=api_url,
                       DF_AIS_BROWSER_WEB_PORT=str(web_port))
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        vite = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
        fail_unless(vite.is_file(), "Vite dependency not installed")
        api_proc = web_proc = None
        with (temp / "api.log").open("w", encoding="utf-8") as api_log, \
             (temp / "vite.log").open("w", encoding="utf-8") as web_log:
            try:
                api_proc = subprocess.Popen([sys.executable, "-c", BACKEND], cwd=ROOT, env=env,
                                            stdin=subprocess.DEVNULL, stdout=api_log,
                                            stderr=subprocess.STDOUT, creationflags=flags)
                wait_http(api_url, "/health", api_proc)
                web_proc = subprocess.Popen(["node", "--input-type=module", "-e", VITE_SERVER],
                                            cwd=ROOT, env=web_env, stdin=subprocess.DEVNULL,
                                            stdout=web_log, stderr=subprocess.STDOUT,
                                            creationflags=flags)
                wait_http(web_url, "/", web_proc)
                delivered = http_json(api_url, f"/api/scans/{API_SCAN}/ais")
                rows = delivered["observations"]
                fail_unless(len(rows) == 499 and len({r['mmsi'] for r in rows}) == 100,
                            "FastAPI archive did not deliver exactly 100 contacts / 499 fixes")
                fail_unless({r["source"] for r in rows} == {SOURCE}, "Archive source identity lost")
                fail_unless(http_json(api_url, "/api/ais/coverage")["observation_count"] == 499,
                            "Coverage count differs from archive")
                result["checks"].append("Real FastAPI/AisArchive delivered 499 labelled fixture fixes for 100 MMSIs")
                result["responseSummary"] = {
                    "count": len(rows), "distinctMmsis": len({r['mmsi'] for r in rows}),
                    "source": SOURCE, "firstFix": rows[0]["timestamp"],
                    "lastFix": rows[-1]["timestamp"], "coverage": delivered["coverage"]["state"]}
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(executable_path=str(CHROME),
                        headless=True, args=["--enable-webgl", "--ignore-gpu-blocklist"], timeout=20000)
                    try:
                        result["chromeVersion"] = browser.version
                        context = browser.new_context(viewport={"width": 1920, "height": 1080})
                        # No external map imagery or provider requests. Use a
                        # single Chrome process; allow Cesium local workers and
                        # installed assets, but never network beyond loopback.
                        def offline(route):
                            url = route.request.url
                            hostname = urlsplit(url).hostname
                            if hostname in {"127.0.0.1", "localhost"} or url.startswith(("blob:", "data:")):
                                route.continue_()
                            else:
                                result["blockedRequests"].append(url[:180])
                                route.abort("blockedbyclient")
                        context.route("**/*", offline)
                        # Executes before application modules on every document
                        # load, including HMR-triggered full reload. sessionStorage
                        # persists across a full navigation of this SAME tab.
                        context.add_init_script("""(() => {
                          const key = 'df_ais_browser_boots';
                          const next = Number(sessionStorage.getItem(key) || '0') + 1;
                          sessionStorage.setItem(key, String(next));
                          window.__dfAisBrowserEvents = [];
                          for (const type of ['beforeunload', 'pagehide']) {
                            addEventListener(type, () => {
                              const event = {type, boot: next, url:location.href};
                              window.__dfAisBrowserEvents.push(event);
                              const events = JSON.parse(sessionStorage.getItem('df_ais_browser_events') || '[]');
                              events.push(event);
                              sessionStorage.setItem('df_ais_browser_events', JSON.stringify(events.slice(-30)));
                            });
                          }
                        })()""")
                        page = context.new_page()
                        page.on("pageerror", lambda error: result["browserErrors"].append(str(error)[:400]))
                        page.on("framenavigated", lambda frame: result["frameNavigations"].append({
                            "url": frame.url[:250], "main": frame == page.main_frame,
                            "wallTime": datetime.now(UTC).isoformat(),
                        }) if frame == page.main_frame else None)
                        page.on("console", lambda msg: result["viteMessages"].append({
                            "type": msg.type, "text": msg.text[:350],
                        }) if any(token in msg.text.lower() for token in
                                  ("[vite]", "hmr", "reload", "darkfleet render failure")) else None)
                        page.on("response", lambda response: result["aisApiResponses"].append({
                            "status": response.status, "url": response.url[:250],
                        }) if f"/api/scans/{API_SCAN}/ais" in response.url else None)
                        page.on("requestfailed", lambda request: result["aisApiFailures"].append({
                            "url": request.url[:250], "failure": request.failure,
                        }) if f"/api/scans/{API_SCAN}/ais" in request.url else None)
                        # On a cold workspace Vite 8 first optimizes Cesium's
                        # dependencies; DOMContentLoaded can be delayed by this
                        # compilation despite the HTML already being delivered.
                        response = page.goto(web_url, wait_until="commit", timeout=60000)
                        fail_unless(response is not None and response.status == 200, "No Vite page")
                        page.locator("[data-df-app]").wait_for(timeout=90000)
                        page.locator(".cesium-widget canvas").first.wait_for(timeout=45000)
                        # Observe Vite hot-update lifecycle if supported, not
                        # synthetic events. This probe never writes product state.
                        result["viteProbe"] = page.evaluate("""async () => {
                          try {
                            const module = await import('/@vite/client');
                            if (typeof module.createHotContext !== 'function') return 'UNAVAILABLE';
                            const hot = module.createHotContext('/__df_ais_operator_probe__');
                            for (const type of ['vite:beforeFullReload', 'vite:beforeUpdate',
                                                'vite:afterUpdate', 'vite:error']) {
                              hot.on(type, () => {
                                window.__dfAisBrowserEvents.push({type, boot:Number(sessionStorage.getItem('df_ais_browser_boots')||0)});
                              });
                            }
                            return 'VITE_HOT_CONTEXT_LISTENERS_ATTACHED';
                          } catch(error) { return 'UNAVAILABLE: '+String(error).slice(0,180); }
                        }""")
                        result["buildMeta"] = page.locator('meta[name^="darkfleet-"]').evaluate_all(
                            "els=>els.map(e=>[e.name,e.content])")
                        result["canvasBefore"] = page.locator(".cesium-widget canvas").count()
                        # Only the descriptor/scan id is installed via JS; all
                        # MMSIs, fixes, identity, timestamps and tracks cross the
                        # genuine /api/scans/{id}/ais client + archive boundary.
                        loaded = page.evaluate("""async (scanId) => {
                          const {store} = await import('/src/state/store.ts');
                          const {loadScanAis} = await import('/src/api/client.ts');
                          store.set({scanId, aoi:[103.79,1.19,104.04,1.43]});
                          await loadScanAis(scanId);
                          const state=store.getState();
                          return {contacts:state.aisOnly.length, fixes:state.aisObservations.length,
                            sources:[...new Set(state.aisObservations.map(x=>x.source))],
                            mmsis:[...new Set(state.aisObservations.map(x=>x.mmsi))].length,
                            scanStage:state.scanStage};
                        }""", API_SCAN)
                        result["clientArchiveLoad"] = loaded
                        fail_unless(loaded["contacts"] == 100 and loaded["fixes"] == 499 and
                                    loaded["sources"] == [SOURCE], f"Client archive load drift: {loaded}")
                        page.locator("[data-df-ais-playback]").wait_for(timeout=12000)
                        page.wait_for_function("() => document.querySelector('[data-df-ais-drawn-counts]')?.textContent?.includes('CONTACT')", timeout=10000)
                        result["initialDom"] = dom_readout(page)
                        result["navigationProbes"].append(navigation_probe(page, "after archive load"))
                        result["checks"].append("Unmodified frontend client loaded archive fixture, not mock JSON or REAL scan")
                        page.locator('[data-df-rail-entry="INTELLIGENCE"]').click()
                        row = page.locator('[data-df-contact-row="ais:257600001"]')
                        row.wait_for(timeout=10000)
                        row.click()
                        page.locator('[data-df-ais-selected="257600001"]').wait_for(timeout=7000)
                        selected = dom_readout(page)
                        result["browserActions"].append({"action":"pointer click contact-list AIS 257600001", "dom":selected})
                        fail_unless(selected["source"] == SOURCE and "NONLIVE TEST 001" in
                                    page.locator('[data-df-ais-selected-name]').inner_text(),
                                    "Displayed identity or source differs from archive")
                        fail_unless(selected["observationCount"] == "4 OBSERVATIONS",
                                    "Selected-contact history count not 4")
                        page.locator('[data-df-ais-frame-track]').click()
                        result["browserActions"].append({"action":"pointer click FRAME TRACK", "dom":dom_readout(page)})
                        page.locator('[data-df-ais-frame-contact]').click()
                        result["browserActions"].append({"action":"pointer click FRAME CONTACT", "dom":dom_readout(page)})
                        page.locator('[data-df-ais-follow]').click()
                        page.wait_for_function("() => document.querySelector('[data-df-ais-follow]')?.getAttribute('data-df-ais-follow')==='ON'",timeout=7000)
                        result["browserActions"].append({"action":"pointer click FOLLOW ON", "dom":dom_readout(page)})
                        fail_unless(dom_readout(page)["follow"] == "ON", "FOLLOW failed to engage")
                        slider=page.locator('[data-df-ais-seek]')
                        rect=slider.bounding_box()
                        fail_unless(bool(rect), "Seek slider has no pointer hit box")
                        page.mouse.click(rect["x"] + rect["width"]*0.47, rect["y"] + rect["height"]/2)
                        seeked=dom_readout(page)
                        result["browserActions"].append({"action":"real pointer slider seek near midpoint", "dom":seeked})
                        fail_unless(seeked["now"] != selected["now"], "Seek did not move the playhead")
                        page.locator('[data-df-ais-play]').click()
                        page.wait_for_function("() => document.querySelector('[data-df-ais-playback]')?.getAttribute('data-df-ais-playing')==='true'",timeout=7000)
                        result["browserActions"].append({"action":"pointer PLAY", "dom":dom_readout(page)})
                        page.wait_for_timeout(350)
                        page.locator('[data-df-ais-play]').click()
                        result["browserActions"].append({"action":"pointer PAUSE", "dom":dom_readout(page)})
                        # Rapid switch while playback and follow are active:
                        # later source must win, no stale timestamp from earlier.
                        row2=page.locator('[data-df-contact-row="ais:257600002"]')
                        row2.click()
                        page.locator('[data-df-ais-selected="257600002"]').wait_for(timeout=7000)
                        result["browserActions"].append({"action":"rapid contact switch to 257600002", "dom":dom_readout(page)})
                        fail_unless(dom_readout(page)["source"] == SOURCE, "Second selected source drift")
                        page.locator('[data-df-ais-latest]').click()
                        result["browserActions"].append({"action":"pointer LATEST", "dom":dom_readout(page)})
                        page.locator('[data-df-rail-entry="LAYERS"]').click()
                        layers={}
                        for layer in ("AIS_CONTACTS", "AIS_TRACKS"):
                            button=page.locator(f'[data-df-layer="{layer}"] button').first
                            before=button.get_attribute("aria-pressed")
                            fail_unless(button.is_enabled(), f"Layer {layer} unavailable")
                            button.click()
                            after=button.get_attribute("aria-pressed")
                            fail_unless(before != after, f"Layer {layer} did not toggle")
                            button.click()
                            restored=button.get_attribute("aria-pressed")
                            fail_unless(restored == before, f"Layer {layer} failed restore")
                            layers[layer]={"before":before,"after":after,"restored":restored}
                        result["browserActions"].append({"action":"real pointer AIS layer off/on", "layers":layers,
                                                         "dom":dom_readout(page)})
                        # Genuine wheel input, not a synthetic camera event;
                        # camera owner's listener must release FOLLOW if still ON.
                        page.locator('[data-df-rail-entry="INTELLIGENCE"]').click()
                        if dom_readout(page)["follow"] != "ON":
                            page.locator('[data-df-ais-follow]').click()
                        canvas=page.locator('.cesium-widget canvas').first
                        box=canvas.bounding_box()
                        fail_unless(bool(box), "Cesium canvas not accessible")
                        page.mouse.move(box["x"]+box["width"]*.55, box["y"]+box["height"]*.55)
                        page.mouse.wheel(0,-420)
                        page.wait_for_function("() => document.querySelector('[data-df-ais-follow]')?.getAttribute('data-df-ais-follow')==='OFF'",timeout=7000)
                        result["browserActions"].append({"action":"native pointer wheel releases FOLLOW", "dom":dom_readout(page)})
                        # Exercise actual canvas pick at projected geographic fix;
                        # result depends on Cesium pick priority/visible symbols.
                        page.locator('[data-df-ais-frame-track]').click()
                        page.wait_for_timeout(900)
                        result["canvasPick"]={"status":"NOT_RUN","reason":"Projection/visibility not established"}
                        loc=page.evaluate("""() => {
                          const el=document.querySelector('[data-df-globe]');
                          const pos=el?.projectCoordinates?.(1.24,103.82);
                          return pos ?? null;
                        }""")
                        if loc:
                            box=canvas.bounding_box()
                            page.mouse.click(box["x"]+loc["x"],box["y"]+loc["y"])
                            picked=dom_readout(page)
                            result["canvasPick"]={"status":"EXECUTED", "projectedCanvas":loc,
                                                  "clicked":picked,"observationIdentity":picked["observation"]}
                        for workspace in ("TACTICAL","LAYERS","INTELLIGENCE","SEARCH","INTELLIGENCE"):
                            result["navigationProbes"].append(navigation_probe(page, f"before {workspace}"))
                            page.locator(f'[data-df-rail-entry="{workspace}"]').click()
                            page.wait_for_function("""id =>
                                document.querySelector(`[data-df-rail-entry="${id}"]`)
                                  ?.getAttribute('aria-pressed') === 'true'
                            """, arg=workspace, timeout=10000)
                            result["navigationProbes"].append(navigation_probe(page, f"after {workspace}"))
                        final_dom = dom_readout(page)
                        result["browserActions"].append({"action":"rapid workspace navigation after layer and pick", "dom":final_dom})
                        result["navFinalProbe"] = page.evaluate("""() => ({
                          app:!!document.querySelector('[data-df-app]'),
                          alert:document.querySelector('[role=alert]')?.textContent?.slice(0,300)??null,
                          activeWorkspace:document.querySelector('[aria-label="Operation workspace"]')?.textContent?.slice(0,120)??null,
                          barCount:document.querySelectorAll('[data-df-ais-playback]').length
                        })""")
                        result["canvasAfterNavigation"] = page.locator(".cesium-widget canvas").count()
                        page.close()
                        result["firstPageClosed"] = page.is_closed()
                        # One new page in SAME context: unloaded Cesium canvas
                        # cannot be reused, and its render cycle must initialise.
                        second=context.new_page()
                        second.goto(web_url,wait_until="commit",timeout=45000)
                        second.locator(".cesium-widget canvas").first.wait_for(timeout=45000)
                        result["freshPageCanvas"] = second.locator(".cesium-widget canvas").count()
                        second.close()
                        context.close()
                        result["checks"].append("Real Chrome pointer selection, framing, follow, seek/play/pause, layers, wheel and unload/navigation")
                        # Assert observable postconditions, not merely successful
                        # click dispatches. A prior run exposed a disappearing
                        # AIS bar after rapid workspace navigation; the old
                        # harness incorrectly claimed PASS because errors were
                        # absent from pageerror. Keep this failure visible.
                        result["postconditions"] = {
                            "playbackBarSurvivedNavigation": final_dom["bar"] is not None,
                            "everyNavigationPreservedSourceAndBar": len(result["navigationProbes"]) == 11 and all(
                                p["observations"] == 499 and p["contacts"] == 100
                                and p["uniqueSources"] == [SOURCE]
                                and p["selectedMmsi"] == result["navigationProbes"][1]["selectedMmsi"]
                                and p["barPresent"] and p["canvasCount"] == 1
                                and p["appPresent"] and p["alertText"] is None
                                for p in result["navigationProbes"] if p["label"].startswith(("before ", "after "))
                            ),
                            "noUnexpectedMainFrameReload": sum(
                                1 for record in result["frameNavigations"] if record["main"]
                            ) == 1,
                            "noUnexpectedDocumentBoot": all(
                                probe["documentBoot"] == 1 for probe in result["navigationProbes"]
                            ),
                            "noAisApiFailure": not result["aisApiFailures"] and all(
                                response["status"] == 200 for response in result["aisApiResponses"]
                            ),
                            "cesiumSingleCanvasAfterNavigation": result["canvasAfterNavigation"] == 1,
                            "pageClosed": result["firstPageClosed"],
                            "freshPageSingleCanvas": result["freshPageCanvas"] == 1,
                            "noUncaughtBrowserErrors": not result["browserErrors"],
                            "sourceUnchanged": result["sourceHashesBefore"] == hashes(),
                        }
                        # This is *not* final acceptance: source bytes and Git
                        # HEAD must be sampled AFTER the browser/services close.
                        result["status"] = ("CANDIDATE_PASS" if
                            all(result["postconditions"].values()) else "PARTIAL")
                    finally:
                        browser.close()
            except (AssertionError, BrowserError, BrowserTimeout, OSError, ValueError, RuntimeError) as exc:
                result["status"]="FAIL"
                result["reason"]=f"{type(exc).__name__}: {exc!s}"[:1300]
                result["apiLogTail"]=(temp / "api.log").read_text(encoding="utf-8",errors="replace")[-1200:]
                result["viteLogTail"]=(temp / "vite.log").read_text(encoding="utf-8",errors="replace")[-1200:]
            finally:
                stop_owned(web_proc)
                stop_owned(api_proc)
                result["viteServerLogTail"] = (temp / "vite.log").read_text(
                    encoding="utf-8", errors="replace")[-12000:]
    result["sourceHashesAfter"]=hashes()
    result["sourceChangedDuringRun"]=result["sourceHashesBefore"] != result["sourceHashesAfter"]
    result["headAfter"]=git("rev-parse","HEAD")
    result["headChangedDuringRun"]=result["gitHead"] != result["headAfter"]
    result["rawSourceAttested"] = (
        result.get("responseSummary", {}).get("count") == 499
        and result.get("responseSummary", {}).get("source") == SOURCE
        and result.get("clientArchiveLoad", {}).get("fixes") == 499
        and result.get("clientArchiveLoad", {}).get("sources") == [SOURCE]
        and bool(result.get("aisApiResponses"))
        and all(item.get("status") == 200 for item in result["aisApiResponses"])
        and len(result.get("navigationProbes", [])) == 11
        and all(p.get("uniqueSources") == [SOURCE] and p.get("observations") == 499
                for p in result["navigationProbes"])
    )
    result["provenanceFailures"] = provenance_failures(
        head_before=result["gitHead"], head_after=result["headAfter"],
        hashes_before=result["sourceHashesBefore"], hashes_after=result["sourceHashesAfter"],
        watched=CONTRACTS,
        main_frame_navigations=sum(1 for event in result["frameNavigations"]
                                   if event.get("main")),
        document_boots=[p.get("documentBoot") for p in result["navigationProbes"]],
        document_origins=[p.get("documentTimeOrigin") for p in result["navigationProbes"]],
        vite_messages=[m["text"] for m in result["viteMessages"]]
        + result.get("viteServerLogTail", "").splitlines()
        + [str(event.get("type", "")) for p in result["navigationProbes"]
           for event in p.get("currentLifecycleEvents", [])],
        source_present=result["rawSourceAttested"],
        hot_probe_attached=result.get("viteProbe") == "VITE_HOT_CONTEXT_LISTENERS_ATTACHED",
    )
    result["status"] = finalize_browser_status(result["status"], result["provenanceFailures"])
    return result


if __name__ == "__main__":
    output=run()
    print(json.dumps(output,indent=2,default=str))
    sys.exit(0 if output["status"]=="PASS" else 1)
