"""True Chrome-canvas AIS exact-observation pointer & ordering acceptance.

Uses a small, deliberately NONLIVE local Parquet archive, actual FastAPI
scan-AIS route, Vite production source modules and Cesium scene pick gesture.
Never creates a REAL scan, contacts an AIS provider, or writes to data/.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

from ais_operator_browser_e2e import (
    BACKEND,
    CHROME,
    CONTRACTS,
    ROOT,
    VITE_SERVER,
    fail_unless,
    finalize_browser_status,
    free_port,
    git,
    hashes,
    http_json,
    provenance_failures,
    stop_owned,
    wait_http,
)
from playwright.sync_api import Error as BrowserError
from playwright.sync_api import TimeoutError as BrowserTimeout
from playwright.sync_api import sync_playwright

ID = "AIS-OBS-POINTER-FIXTURE-NONLIVE"
SOURCE = "fixture-ais-pointer-NONLIVE"
MMSI = "257771001"
OTHER = "257771002"
START = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
POINTS = [
    (0, 1.240, 103.820),
    (4, 1.243, 103.830),
    (8, 1.246, 103.840),
    (16, 1.249, 103.850),
]
TARGET = POINTS[1]
TARGET_AT = (START + timedelta(minutes=TARGET[0])).isoformat().replace("+00:00", "Z")
EXTRA_PROVENANCE_SOURCES = (
    "src/globe/aisPick.ts",
    "src/design/tokens.css",
    "src/command/SystemPanel.tsx",
)
WATCHED = tuple(dict.fromkeys((*CONTRACTS, *EXTRA_PROVENANCE_SOURCES)))


def source_hashes() -> dict[str, str | None]:
    """Include app/style HMR dependencies beyond the 17 AIS navigation anchors."""
    snapshot = hashes()
    for path in EXTRA_PROVENANCE_SOURCES:
        try:
            snapshot[path] = hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
        except OSError:
            snapshot[path] = None
    return snapshot


def seed(root: Path) -> dict:
    sys.path.insert(0, str(ROOT / "backend"))
    from darkfleet.ais.archive import AisArchive
    from darkfleet.ais.models import AisObservation

    rows = [AisObservation(
        timestamp=START + timedelta(minutes=minute), mmsi=MMSI,
        lat=lat, lon=lon, sog=0.0 if minute == 4 else 12.5,
        cog=0.0 if minute == 4 else 91.0, heading=None,
        name="NONLIVE POINTER VESSEL A", source=SOURCE,
    ) for minute, lat, lon in POINTS]
    rows += [AisObservation(
        timestamp=START + timedelta(minutes=minute), mmsi=OTHER,
        lat=1.300 + minute * .001, lon=103.900 + minute * .001,
        sog=None, cog=None, heading=None,
        name="NONLIVE POINTER VESSEL B", source=SOURCE,
    ) for minute in (0, 8, 16)]
    receipt = AisArchive(root).append(rows)
    fail_unless(receipt["written"] == 7, f"Archive seeding unexpected: {receipt}")
    descriptor = root / "scans" / f"{ID}.json"
    descriptor.parent.mkdir(parents=True, exist_ok=True)
    descriptor.write_text(json.dumps({
        "scan_id": ID, "stage": "FIXTURE_ONLY_NOT_A_SCAN",
        "runtime_mode": "FIXTURE_NONLIVE", "synthetic": True,
        "acquisition_time": (START + timedelta(minutes=10)).isoformat(),
        "aoi": [103.7, 1.18, 104.1, 1.45],
        "scene": {"item_id": "NOT_A_SAR_ACQUISITION"},
    }), encoding="utf-8")
    parts = sorted((root / "ais").rglob("*.parquet"))
    return {"count": len(rows), "mmsis": [MMSI, OTHER], "source": SOURCE,
            "parquetSha256": {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in parts}, "descriptor": "NONLIVE_ONLY_NOT_A_SCAN"}


def state(page, label: str) -> dict:
    return page.evaluate("""async label => {
      const {store} = await import('/src/state/store.ts');
      const {temporal} = await import('/src/temporal/TemporalController.ts');
      const {engine} = await import('/src/globe/engine.ts');
      const s=store.getState(), t=temporal.state;
      return {label, scanId:s.scanId, stage:s.scanStage,
        mmsi:s.selectedAis?.mmsi??null, observationAt:s.selectedAis?.observationAt??null,
        highlighted:s.highlightedObservation,
        actualRendererHighlight:engine.highlightedAisObservation,
        sarSelection:s.selection, observations:s.aisObservations.length,
        sources:[...new Set(s.aisObservations.map(o=>o.source))],
        playbackMs:t.currentMs, playing:t.playing, mode:t.mode,
        follow:s.aisFollowMode, bar:!!document.querySelector('[data-df-ais-playback]'),
        fixDOM:document.querySelector('[data-df-ais-selected-observation]')?.getAttribute('data-df-ais-selected-observation')??null,
        canvas:document.querySelectorAll('.cesium-widget canvas').length,
        error:document.querySelector('[role=alert]')?.textContent?.trim()?.slice(0,200)??null};
    }""", label)


def run() -> dict:
    result = {"status": "NOT_RUN", "sourceHashesBefore": source_hashes(),
              "headBefore": git("rev-parse", "HEAD"), "events": [],
              "browserErrors": [], "aisRequests": [], "mainFrameNavigations": [],
              "viteConsole": [], "viteHotEvents": [], "externalRequestsBlocked": 0,
              "fixtureStatus": "SYNTHETIC_NONLIVE_ONLY"}
    if not CHROME.is_file():
        return {**result, "status": "BLOCKED", "reason": "Installed Chrome not available"}
    with tempfile.TemporaryDirectory(prefix="df-ais-pointer-NONLIVE-") as scratch:
        temp = Path(scratch)
        data = temp / "data"
        data.mkdir()
        result["fixture"] = seed(data)
        api_port, web_port = free_port(), free_port()
        fail_unless(api_port != web_port, "port collision")
        api_url, web_url = f"http://127.0.0.1:{api_port}", f"http://127.0.0.1:{web_port}"
        result["ports"] = {"api": api_port, "web": web_port}
        env = dict(os.environ)
        env["PYTHONPATH"] = str(ROOT / "backend") + os.pathsep + env.get("PYTHONPATH", "")
        env.update(DF_AIS_BROWSER_DATA=str(data), DF_AIS_BROWSER_PORT=str(api_port), PROJ_NETWORK="OFF")
        web_env = dict(env, DARKFLEET_API_URL=api_url, DF_AIS_BROWSER_WEB_PORT=str(web_port))
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        api_proc = web_proc = None
        with (temp / "backend.log").open("w", encoding="utf-8") as api_log, \
             (temp / "vite.log").open("w", encoding="utf-8") as vite_log:
            try:
                api_proc = subprocess.Popen([sys.executable, "-c", BACKEND], cwd=ROOT,
                    env=env, stdin=subprocess.DEVNULL, stdout=api_log,
                    stderr=subprocess.STDOUT, creationflags=flags)
                wait_http(api_url, "/health", api_proc)
                web_proc = subprocess.Popen(["node", "--input-type=module", "-e", VITE_SERVER],
                    cwd=ROOT, env=web_env, stdin=subprocess.DEVNULL,
                    stdout=vite_log, stderr=subprocess.STDOUT, creationflags=flags)
                wait_http(web_url, "/", web_proc)
                payload = http_json(api_url, f"/api/scans/{ID}/ais")
                fail_unless(len(payload["observations"]) == 7 and
                            {p["source"] for p in payload["observations"]} == {SOURCE},
                            "Archive API provenance/quantity violation")
                result["apiRead"] = {"count": 7, "source": SOURCE,
                    "exactTargetAt": next(p["timestamp"] for p in payload["observations"]
                                          if p["mmsi"] == MMSI and p["lat"] == TARGET[1])}
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(executable_path=str(CHROME), headless=True,
                        args=["--enable-webgl", "--ignore-gpu-blocklist"], timeout=30000)
                    try:
                        result["chromeVersion"] = browser.version
                        context = browser.new_context(viewport={"width": 1920, "height": 1080})
                        def offline(route):
                            hostname = urlsplit(route.request.url).hostname
                            if hostname in {"127.0.0.1", "localhost"} or route.request.url.startswith(("blob:", "data:")):
                                route.continue_()
                            else:
                                result["externalRequestsBlocked"] += 1
                                route.abort("blockedbyclient")
                        context.route("**/*", offline)
                        context.add_init_script("""(() => {
                          const key='df_ais_pointer_document_boot';
                          sessionStorage.setItem(key,String(Number(sessionStorage.getItem(key)||'0')+1));
                        })()""")
                        page = context.new_page()
                        page.on("pageerror", lambda err: result["browserErrors"].append(str(err)[:300]))
                        page.on("framenavigated", lambda frame: result["mainFrameNavigations"].append(
                            frame.url[:250]) if frame == page.main_frame else None)
                        page.on("console", lambda msg: result["viteConsole"].append(
                            {"kind": msg.type, "text": msg.text[:220]})
                            if any(t in msg.text.lower() for t in ("[vite]", "hmr", "reload")) else None)
                        page.on("response", lambda resp: result["aisRequests"].append({
                            "status": resp.status, "url": resp.url[:200]})
                            if f"/api/scans/{ID}/ais" in resp.url else None)
                        response = page.goto(web_url, wait_until="commit", timeout=60000)
                        fail_unless(response is not None and response.status == 200, "Vite did not serve app")
                        page.locator("[data-df-app]").wait_for(timeout=90000)
                        page.locator(".cesium-widget canvas").first.wait_for(timeout=45000)
                        result["firstDocumentOrigin"] = page.evaluate("() => performance.timeOrigin")
                        result["viteProbe"] = page.evaluate("""async () => {
                          try {
                            const {createHotContext}=await import('/@vite/client');
                            if(typeof createHotContext!=='function') return 'UNAVAILABLE';
                            const hot=createHotContext('/__df_ais_pointer_provenance__');
                            window.__dfAisPointerHotEvents=[];
                            for(const type of ['vite:beforeFullReload','vite:beforeUpdate',
                                               'vite:afterUpdate','vite:error']) {
                              hot.on(type,()=>window.__dfAisPointerHotEvents.push(type));
                            }
                            return 'VITE_HOT_CONTEXT_LISTENERS_ATTACHED';
                          }catch(error){return 'UNAVAILABLE: '+String(error).slice(0,160)}
                        }""")
                        loaded = page.evaluate("""async id => {
                          const {store}=await import('/src/state/store.ts');
                          const {loadScanAis}=await import('/src/api/client.ts');
                          store.set({scanId:id,aoi:[103.7,1.18,104.1,1.45]});
                          await loadScanAis(id);
                          return {fixes:store.getState().aisObservations.length,
                                  contacts:store.getState().aisOnly.length};
                        }""", ID)
                        fail_unless(loaded == {"fixes": 7, "contacts": 2}, f"Real AIS client load failed: {loaded}")
                        page.locator("[data-df-ais-playback]").wait_for(timeout=12000)
                        page.wait_for_function("() => document.querySelector('[data-df-ais-drawn-counts]')?.textContent?.includes('7 FIX')", timeout=12000)
                        result["events"].append(state(page, "archive loaded"))

                        # Position camera from the real public engine, then wait for
                        # Cesium's programmatic flight to end before projecting.
                        page.evaluate("""async () => {
                          const {engine}=await import('/src/globe/engine.ts');
                          engine.setViewMode('TOP_DOWN',1.245,103.835,45000);
                        }""")
                        page.wait_for_timeout(2400)
                        result["targetProjection"] = page.evaluate("""async coords => {
                          const {engine}=await import('/src/globe/engine.ts');
                          return coords.map(({minute,lat,lon}) =>
                            ({minute,lat,lon,point:engine.projectToCanvas(lat,lon)}));
                        }""", [{"minute": m, "lat": la, "lon": lo} for m, la, lo in POINTS])
                        result["events"].append(state(page, "after camera settled"))
                        # Read-only observation of the REAL Cesium scene.pick
                        # return value. Instrument the same module URL the app
                        # loaded; wrapper forwards one call and its exact result
                        # unchanged. These records never alter store selection.
                        result["scenePickProbe"] = page.evaluate("""async () => {
                          const seen=performance.getEntriesByType('resource')
                            .map(e=>e.name).filter(u=>u.includes('/cesium.js'));
                          const url=seen.at(-1);
                          if (!url) return {status:'NO_CESIUM_RESOURCE'};
                          try {
                            const {Scene}=await import(url);
                            if (!Scene?.prototype || typeof Scene.prototype.pick!=='function')
                              return {status:'NO_SCENE_PROTOTYPE',url};
                            if (!window.__dfRawScenePicks) {
                              window.__dfRawScenePicks=[];
                              const raw=Scene.prototype.pick;
                              let sampling=false;
                              const tagOf=(picked)=>{
                                const id=picked?.id;
                                return id&&typeof id==='object'&&typeof id.domain==='string'
                                  ? {domain:id.domain,mmsi:id.mmsi,at:id.at??null}:null;
                              };
                              Scene.prototype.pick=function(...args){
                                if(sampling) return raw.apply(this,args);
                                const picked=raw.apply(this,args);
                                const point=args[0];
                                let underneath=[], drillError=null;
                                // Observe Cesium's OWN depth-ordered pick
                                // stack at the exact native input pixel. The
                                // guard avoids nested pick recursion and
                                // never returns a different picked object.
                                try{
                                  sampling=true;
                                  underneath=typeof this.drillPick==='function'
                                    ? this.drillPick(point,10).map(tagOf):[];
                                }catch(error){drillError=String(error).slice(0,140)}
                                finally{sampling=false}
                                window.__dfRawScenePicks.push({
                                  pixel:{x:point?.x,y:point?.y},
                                  tag:tagOf(picked), underlyingTags:underneath,
                                  drillError,
                                  primitiveType:picked?.primitive?.constructor?.name??null,
                                  hasPick:!!picked,
                                });
                                return picked;
                              };
                            }
                            return {status:'INSTRUMENTED',url};
                          }catch(error){return {status:'UNAVAILABLE',url,error:String(error).slice(0,250)}}
                        }""")
                        canvas = page.locator(".cesium-widget canvas").first
                        rectangle = canvas.bounding_box()
                        fail_unless(bool(rectangle), "No native Cesium pointer surface")
                        target = next(p for p in result["targetProjection"] if p["minute"] == 4)
                        fail_unless(target["point"] is not None, "Historical observation is off-screen")
                        pixel = target["point"]
                        fail_unless(5 < pixel["x"] < rectangle["width"]-5 and
                                    5 < pixel["y"] < rectangle["height"]-5,
                                    "Projected historical fix not in canvas viewport")
                        result["clickedCanvasCssPixel"] = pixel
                        # A track polyline and a 7px observation billboard
                        # genuinely overlap at the source vertex. The center
                        # pixel is not guaranteed to select the dot if Cesium
                        # sorts the track above it. Bounded *real* pointer
                        # offsets stay in the 7x7 glyph footprint, and capture
                        # every result; no store write fabricates the pick.
                        result["nativeHitProbes"] = []
                        picked = None
                        for dx, dy in [(0, 0), (0, 2), (0, -2), (2, 0), (-2, 0),
                                       (2, 2), (2, -2), (-2, 2), (-2, -2),
                                       (0, 3), (0, -3), (3, 0), (-3, 0)]:
                            page.mouse.click(rectangle["x"] + pixel["x"] + dx,
                                             rectangle["y"] + pixel["y"] + dy)
                            page.wait_for_timeout(80)
                            probe = state(page, f"NATIVE observation pixel offset {dx},{dy}")
                            result["nativeHitProbes"].append({
                                "dx": dx, "dy": dy, "mmsi": probe["mmsi"],
                                "at": probe["observationAt"],
                                "renderedAt": probe["fixDOM"],
                                "highlighted": probe["actualRendererHighlight"],
                                "rawScenePick": page.evaluate("() => window.__dfRawScenePicks?.at(-1)??null"),
                            })
                            if (probe["mmsi"] == MMSI and
                                    probe["observationAt"] == result["apiRead"]["exactTargetAt"]):
                                picked = probe
                                break
                        if picked is None:
                            result["events"].append(state(page, "source marker after bounded physical hits"))
                            raise AssertionError("No exact observation selected in 13 native clicks within 7px marker")
                        result["events"].append(picked)
                        # Do NOT seed store selection to manufacture a successful
                        # pointer result: this is the hard browser acceptance.
                        fail_unless(picked["mmsi"] == MMSI and
                                    picked["observationAt"] == result["apiRead"]["exactTargetAt"] and
                                    picked["fixDOM"] == result["apiRead"]["exactTargetAt"],
                                    "Real canvas pointer did not select raw historic observation")
                        fail_unless(picked["highlighted"] == {"mmsi": MMSI, "at": picked["observationAt"]}
                                    and picked["actualRendererHighlight"] == picked["highlighted"],
                                    "Source fix selected without real renderer highlight")

                        # Adverse ordering: follow, seek, then a *different* raw
                        # observation canvas-click while follow is enabled.
                        page.locator('[data-df-ais-follow]').click()
                        page.wait_for_function("() => document.querySelector('[data-df-ais-follow]')?.getAttribute('data-df-ais-follow')==='ON'", timeout=7000)
                        result["events"].append(state(page, "FOLLOW ON after historic pick"))
                        page.locator('[data-df-ais-seek]').fill('700')
                        result["events"].append(state(page, "seek during FOLLOW"))
                        page.locator('[data-df-ais-play]').click()
                        result["events"].append(state(page, "PLAY after seek while FOLLOW"))
                        page.locator('[data-df-ais-play]').click()
                        result["events"].append(state(page, "PAUSE after PLAY"))
                        page.locator('[data-df-ais-follow]').click()
                        result["events"].append(state(page, "FOLLOW OFF"))

                        # One more genuine canvas click is expected to replace
                        # the selected observation with a different source fix.
                        page.evaluate("""async () => {
                          const {engine}=await import('/src/globe/engine.ts');
                          engine.setViewMode('TOP_DOWN',1.245,103.835,45000);
                        }""")
                        page.wait_for_timeout(2000)
                        candidate = page.evaluate("""async (v) => {
                          const {engine}=await import('/src/globe/engine.ts');
                          return engine.projectToCanvas(v.lat,v.lon);
                        }""", {"lat": POINTS[2][1], "lon": POINTS[2][2]})
                        fail_unless(candidate is not None, "Second exact fix not projected")
                        rectangle = canvas.bounding_box()
                        page.mouse.click(rectangle["x"]+candidate["x"],rectangle["y"]+candidate["y"])
                        page.wait_for_timeout(500)
                        after_switch = state(page,"NATIVE click different 12:08 source fix")
                        result["events"].append(after_switch)
                        expected_next = (START + timedelta(minutes=8)).isoformat().replace("+00:00", "Z")
                        fail_unless(after_switch["mmsi"] == MMSI and after_switch["observationAt"] == expected_next
                                    and after_switch["fixDOM"] == expected_next,
                                    "Out-of-order marker clicks did not switch exact source identity")

                        # Closure: layer toggles and navigator changes must
                        # retain raw historical identity and DOM event listener.
                        for workspace in ("LAYERS", "INTELLIGENCE", "TACTICAL"):
                            page.locator(f'[data-df-rail-entry="{workspace}"]').click()
                            page.wait_for_function("""id =>
                              document.querySelector(`[data-df-rail-entry="${id}"]`)
                                ?.getAttribute('aria-pressed')==='true'""", arg=workspace)
                            result["events"].append(state(page, f"rail to {workspace}"))
                        final = result["events"][-1]
                        fail_unless(final["mmsi"] == MMSI and final["observationAt"] == expected_next and
                                    final["fixDOM"] == expected_next and final["canvas"] == 1 and
                                    not final["error"], "Canvas identity lost on rail cleanup")
                        result["documentProof"] = page.evaluate("""() => ({
                          boot:Number(sessionStorage.getItem('df_ais_pointer_document_boot')||0),
                          timeOrigin:performance.timeOrigin,
                          hotEvents:window.__dfAisPointerHotEvents ?? null,
                        })""")
                        result["viteHotEvents"] = result["documentProof"]["hotEvents"] or []
                        page.close()
                        result["firstPageClosed"] = page.is_closed()
                        fresh = context.new_page()
                        fresh.goto(web_url, wait_until="commit", timeout=45000)
                        fresh.locator(".cesium-widget canvas").first.wait_for(timeout=45000)
                        result["newPageCanvas"] = fresh.locator(".cesium-widget canvas").count()
                        # Check the original tab's document boot/history before
                        # closing it, not the expected fresh second-page boot.
                        fresh.close()
                        context.close()
                        result["status"] = "CANDIDATE_PASS" if (not result["browserErrors"]
                            and result["firstPageClosed"] and result["newPageCanvas"] == 1
                            and result["sourceHashesBefore"] == source_hashes()) else "PARTIAL"
                    finally:
                        browser.close()
            except (AssertionError, BrowserError, BrowserTimeout, OSError, RuntimeError, ValueError) as exc:
                reason = f"{type(exc).__name__}: {exc}"
                # A dev-server forced navigation destroys the JS execution
                # context; it is NOT evidence that Cesium refused a marker.
                result["status"] = ("INCONCLUSIVE_DEV_RELOAD"
                    if "Execution context was destroyed" in reason
                    else "FAIL")
                result["reason"] = reason[:1400]
                result["backendLogTail"] = (temp / "backend.log").read_text(encoding="utf-8", errors="replace")[-800:]
                result["viteLogTail"] = (temp / "vite.log").read_text(encoding="utf-8", errors="replace")[-800:]
            finally:
                stop_owned(web_proc)
                stop_owned(api_proc)
                result["viteServerLogTail"] = (temp / "vite.log").read_text(
                    encoding="utf-8", errors="replace")[-12000:]
    result["sourceHashesAfter"] = source_hashes()
    result["headAfter"] = git("rev-parse", "HEAD")
    result["sourcesStable"] = result["sourceHashesBefore"] == result["sourceHashesAfter"]
    result["headStable"] = result["headBefore"] == result["headAfter"]
    first_event = result["events"][0] if result["events"] else {}
    result["rawSourceAttested"] = (
        result.get("apiRead", {}).get("count") == 7
        and result.get("apiRead", {}).get("source") == SOURCE
        and result.get("apiRead", {}).get("exactTargetAt") == TARGET_AT
        and first_event.get("observations") == 7
        and first_event.get("sources") == [SOURCE]
        and bool(result["aisRequests"])
        and all(reply.get("status") == 200 for reply in result["aisRequests"])
        and all(event.get("sources") == [SOURCE] and event.get("observations") == 7
                for event in result["events"])
        and result.get("scenePickProbe", {}).get("status") == "INSTRUMENTED"
        and any(
            any(tag and tag.get("domain") == "AIS_OBSERVATION"
                and tag.get("mmsi") == MMSI and tag.get("at") == TARGET_AT
                for tag in ([hit.get("rawScenePick", {}).get("tag")]
                            + (hit.get("rawScenePick", {}).get("underlyingTags") or [])))
            for hit in result.get("nativeHitProbes", [])
            if isinstance(hit.get("rawScenePick"), dict)
        )
    )
    result["provenanceFailures"] = provenance_failures(
        head_before=result["headBefore"], head_after=result["headAfter"],
        hashes_before=result["sourceHashesBefore"], hashes_after=result["sourceHashesAfter"],
        watched=WATCHED, main_frame_navigations=len(result["mainFrameNavigations"]),
        document_boots=[result.get("documentProof", {}).get("boot")],
        document_origins=[result.get("firstDocumentOrigin"),
                          result.get("documentProof", {}).get("timeOrigin")],
        vite_messages=[event["text"] for event in result["viteConsole"]]
        + result.get("viteServerLogTail", "").splitlines()
        + result.get("viteHotEvents", []),
        source_present=result["rawSourceAttested"],
        hot_probe_attached=result.get("viteProbe") == "VITE_HOT_CONTEXT_LISTENERS_ATTACHED",
    )
    result["status"] = finalize_browser_status(result["status"], result["provenanceFailures"])
    return result


if __name__ == "__main__":
    evidence = run()
    print(json.dumps(evidence, indent=2, default=str))
    sys.exit(0 if evidence["status"] == "PASS" else 1)
