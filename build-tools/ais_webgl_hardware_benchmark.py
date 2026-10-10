"""Hardware-gated browser benchmark of DarkFleet's REAL Cesium AIS renderer.

Requires an ALREADY RUNNING DarkFleet Vite server and hardware-backed Chrome.
No application repository files, browser user profile or backend data are changed.
Default action is inspection only; pass --run after coordinating exclusive timing.

Examples:
  python -B build-tools/ais_webgl_hardware_benchmark.py
  python -B build-tools/ais_webgl_hardware_benchmark.py --run --url http://localhost:5174/
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, TimeoutError as BrowserTimeout, Error as BrowserError

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
SIZES = (100, 1000, 5000, 10000)
SOURCE_FILES = ("src/globe/engine.ts", "src/globe/aisRenderer.ts",
                "src/globe/aisRenderer.perf.test.ts", "src/ais/displayState.ts")


# Executed only on the actual loaded React app, in the original page's Vite
# module graph. This uses the same `engine` singleton as TacticalWorld -- not a
# second Viewer, test double, canvas, copied renderer or mock GPU.
INSTALL = r"""async () => {
  const {engine} = await import('/src/globe/engine.ts');
  const {store} = await import('/src/state/store.ts');
  const viewer = engine.viewer;
  if (!viewer || !engine.initialised || !viewer.scene?.canvas?.isConnected)
    return {error: 'Actual application engine/viewer/canvas not initialized', initialised:engine.initialised};
  const canvas = viewer.scene.canvas;
  const gl = canvas.getContext('webgl2');
  if (!gl) return {error:'Existing Cesium canvas has no WebGL2 context'};
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : String(gl.getParameter(gl.RENDERER));
  const vendor = info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : String(gl.getParameter(gl.VENDOR));
  // Do not accept a generic WebGL context as proof of hardware rendering.
  // These backend names are actual renderer/driver reports, not benchmark guesses.
  if (!info || /swiftshader|llvmpipe|softpipe|software raster|software renderer|lavapipe|microsoft basic render|warp\b/i.test(renderer)
      || !/nvidia|geforce|radeon|amd|intel|iris|uhd graphics|arc\(tm\)|d3d11|d3d12/i.test(renderer+' '+vendor))
    return {error:'HARDWARE_GPU_NOT_PROVEN_OR_SOFTWARE_RENDERER',renderer,vendor,debugInfoAvailable:!!info};
  if (viewer.scene.context?._gl && viewer.scene.context._gl !== gl)
    return {error:'Cesium underlying GL context differs from probed WebGL2 context',renderer,vendor};
  const origin = Date.parse('2026-03-01T12:00:00Z');
  const at = minute => new Date(origin + minute*60*1000).toISOString();
  function makeFleet(n) {
    const contacts=[];const rows=new Map();
    for(let v=0;v<n;v++) {
      const mmsi=String(257000000+v).padStart(9,'0');
      const lat=1+(v/n)*20, lon=103+(((v*7919)%9973)/9973)*40;
      const anchored=v%8===7, blind=v%4===3;
      const series=[];
      for(let i=0;i<5;i++) {
        const drift=anchored?0:i*.001;
        series.push({timestamp:at(i*4),mmsi,lat:lat+drift,lon:lon+drift,
          sog:anchored?null:8+v%7,cog:anchored||blind?null:(v*13)%360,
          heading:anchored||v%3!==0?null:(v*7)%360,
          ship_name:`MV TEST ${v}`,source:'aistream'});
      }
      rows.set(mmsi,series);
      const latest=series[4];
      contacts.push({mmsi,lat:latest.lat,lon:latest.lon,sog:latest.sog,
        cog:latest.cog,heading:latest.heading,timestamp:latest.timestamp,
        shipName:latest.ship_name});
    }
    return {contacts,rows};
  }
  const pct=(a,p)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return +s[Math.ceil(s.length*p)-1].toFixed(2)};
  const mem=()=>({jsHeapBytes:performance.memory?.usedJSHeapSize??null,
    jsHeapLimitBytes:performance.memory?.jsHeapSizeLimit??null});
  // Count observable WebGL allocations/deletions occurring AFTER this moment.
  // This does not observe Cesium's already-created engine allocations or the
  // driver's physical VRAM. The wrappers exist only in this disposable page.
  const resources={};
  for(const kind of ['Buffer','Texture','Framebuffer','Renderbuffer','VertexArray','Program','Shader']) {
    const createName='create'+kind,deleteName='delete'+kind;
    const create=gl[createName],del=gl[deleteName];
    if(typeof create!=='function'||typeof del!=='function')continue;
    const created=new WeakSet(),deleted=new WeakSet();
    const stats={created:0,deleted:0,net:0};resources[kind]=stats;
    try {
      gl[createName]=function(...args){
        const output=create.apply(gl,args);
        if(output!==null&&typeof output==='object'){
          created.add(output);stats.created++;stats.net++;
        }
        return output;
      };
      gl[deleteName]=function(value){
        if(value&&created.has(value)&&!deleted.has(value)){
          deleted.add(value);stats.deleted++;stats.net--;
        }
        return del.call(gl,value);
      };
    }catch(err){resources[kind]={unavailable:String(err)};}
  }
  const snapshot=()=>({
    primitives:viewer.scene.primitives.length,
    entities:viewer.entities.values.length,
    sceneRequestRenderMode:viewer.scene.requestRenderMode,
    aisStats:engine.aisRenderStats,
    webglCallsSinceInstall:Object.fromEntries(Object.entries(resources).map(([k,v])=>[k,{...v}])),
    ...mem()
  });
  // This global is confined to the new disposable Playwright page; no production
  // JS or app source is modified and no backend API is called by the fixtures.
  const previousAisStats = engine.aisRenderStats;
  const primitivesBeforeIsolation = viewer.scene.primitives.length;
  engine.destroyAisRenderer(); // disposes app's empty AIS renderer, not scene or viewer.
  window.__dfGpuBench = {engine,store,viewer,canvas,gl,at,makeFleet,pct,snapshot,
    setFrame: (fleet, minute, track=null) => engine.setAisContacts(fleet.contacts,{
      referenceTimeIso:at(minute),tracks:track??new Map(),
      observationMarkers:[], predicted:[]}),
  };
  const debug = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  return {renderer,vendor,glVersion:String(gl.getParameter(gl.VERSION)),
    maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE),gpuTimerExtensionAvailable:!!debug,
    canvasPixels:[canvas.width,canvas.height],canvasConnected:canvas.isConnected,
    canvasSameAsDom:document.querySelector('.cesium-widget canvas')===canvas,
    documentVisible:document.visibilityState, initialWorkspace:store.getState().workspace,
    previousAisStats, primitivesBeforeIsolation,
    resourceTrackingNote:'WebGL API call deltas AFTER instrument installation, not all native resources / VRAM.',
    before:snapshot(), sourceFixture:'src/globe/aisRenderer.perf.test.ts: makeVessels (transcribed)',
    note:'The app remains real; AIS records are 100% SYNTHETIC benchmark fixtures, never live AIS.'};
}"""


CASE = r"""async ({count,frames,timeoutMs}) => {
  const b=window.__dfGpuBench;
  if(!b?.engine?.viewer) throw new Error('A real app Cesium engine was not installed');
  const {viewer,engine,at,snapshot,pct}=b;
  const fleet=b.makeFleet(count);
  // Keep exactly ONE selected real observed polyline so playback moves an actual
  // renderer track without charging creation of 10k whole-archive polylines.
  const selected=fleet.contacts[Math.floor(count/2)];
  const track=new Map([[selected.mmsi,fleet.rows.get(selected.mmsi).map(r=>({
    lat:r.lat,lon:r.lon,at:r.timestamp}))]]);
  const before=snapshot();
  const seriesStart=performance.now();
  engine.setAisObservationSeries(fleet.rows);
  const seriesMs=performance.now()-seriesStart;
  const loadStart=performance.now();
  b.setFrame(fleet,8,track);
  const initialLoadMs=performance.now()-loadStart;
  const afterLoad=snapshot();
  if(afterLoad.aisStats.billboards!==count)
    throw new Error(`REAL AIS RENDERER COUNT MISMATCH: wanted ${count} got ${afterLoad.aisStats.billboards}`);
  const baselineMode=viewer.scene.requestRenderMode;
  const intervals=[],updates=[],drawEvents=[];
  let last=null,ticks=0,lastUpdateAt=0;
  viewer.scene.requestRenderMode=false;
  try {
    await new Promise((resolve,reject)=>{
      let disposed=false;
      const off=viewer.scene.postRender.addEventListener(()=>{
        if(disposed) return;
        const now=performance.now();
        if(last!==null) intervals.push(now-last);
        last=now; drawEvents.push(now);
        if(ticks>=frames) {disposed=true;off();clearTimeout(timer);resolve();return;}
        // Work is done after a REAL Cesium render, before the next frame; frame
        // intervals therefore INCLUDE per-frame AIS update, upload and draw.
        const then=performance.now();
        b.setFrame(fleet,ticks%2===0?10:8,track);
        updates.push(performance.now()-then);
        lastUpdateAt=then;ticks++;
        viewer.scene.requestRender();
      });
      const timer=setTimeout(()=>{if(disposed)return;disposed=true;off();reject(new Error(`POST_RENDER_TIMEOUT_${count}_${drawEvents.length}`));},timeoutMs);
      viewer.scene.requestRender();
    });
  } finally { viewer.scene.requestRenderMode=baselineMode;viewer.scene.requestRender(); }
  const afterPlayback=snapshot();
  const selectStart=performance.now();
  engine.setAisSelection(selected.mmsi);
  b.setFrame(fleet,10,track);
  viewer.scene.requestRender();
  const selectBuildDone=performance.now();
  const selectedRenderMs=await new Promise((resolve,reject)=>{
    const off=viewer.scene.postRender.addEventListener(()=>{off();clearTimeout(timer);resolve(performance.now()-selectStart)});
    const timer=setTimeout(()=>{off();reject(new Error('SELECTION_POST_RENDER_TIMEOUT'))},timeoutMs);
    viewer.scene.requestRender();
  });
  const selectedStats=snapshot();
  let physicalPick={verified:false,reason:'NO_VISIBLE_TAGGED_AIS_CONTACT',sampleCount:0,p50Ms:null,p95Ms:null};
  try {
    const candidates=[selected,...fleet.contacts.filter((_,i)=>i%Math.max(1,Math.floor(count/80))===0)];
    for(const candidate of candidates) {
      const screen=engine.projectToCanvas(candidate.lat,candidate.lon);
      if (!screen || screen.x<0 || screen.y<0 || screen.x>=viewer.canvas.clientWidth || screen.y>=viewer.canvas.clientHeight)continue;
      const hit=viewer.scene.pick({x:screen.x,y:screen.y});
      if (hit?.id?.domain!=='AIS_CONTACT'||typeof hit.id.mmsi!=='string')continue;
      const ms=[];const hitMmsi=hit.id.mmsi;
      for(let i=0;i<8;i++) {
        const t=performance.now();const picked=viewer.scene.pick({x:screen.x,y:screen.y});
        const elapsed=performance.now()-t;
        if(picked?.id?.domain!=='AIS_CONTACT'||picked.id.mmsi!==hitMmsi)break;
        ms.push(elapsed);
      }
      physicalPick={verified:ms.length===8,mode:'scene.pick ACTUAL canvas pixels; NOT simulated DOM click',
        pickedMmsi:hitMmsi,requestedMmsi:selected.mmsi,sampleCount:ms.length,p50Ms:pct(ms,.5),p95Ms:pct(ms,.95)};
      break;
    }
  }catch(err){physicalPick={verified:false,reason:'scene.pick failed: '+String(err).slice(0,240)};}
  engine.setAisSelection(null);
  const clearStart=performance.now();
  engine.setAisContacts([],{referenceTimeIso:at(10),tracks:new Map(),observationMarkers:[],predicted:[]});
  const clearMs=performance.now()-clearStart;
  engine.setAisObservationSeries(new Map());
  viewer.scene.requestRender();
  const cleared=snapshot();
  const destroyStart=performance.now();
  engine.destroyAisRenderer();
  const destroyMs=performance.now()-destroyStart;
  viewer.scene.requestRender();
  const afterDestroy=snapshot();
  return {count, fixtureContactCount:fleet.contacts.length,fixtureObservationCount:count*5,
    observedRendererContacts:afterLoad.aisStats.billboards,
    note:'Actual Cesium postRender, not idle rAF; 5 synthetically constructed observations per contact.',
    timingsMs:{observationSeries: +seriesMs.toFixed(2),initialLoad:+initialLoadMs.toFixed(2),
      activeFrameIntervals:{samples:intervals.length,p50:pct(intervals,.5),p95:pct(intervals,.95),max:pct(intervals,1)},
      playbackRendererUpdates:{samples:updates.length,p50:pct(updates,.5),p95:pct(updates,.95),max:pct(updates,1)},
      selectionBuild:+(selectBuildDone-selectStart).toFixed(2),selectionToCesiumPostRender:+selectedRenderMs.toFixed(2),
      clear:+clearMs.toFixed(2),destroy:+destroyMs.toFixed(2)},
    lifecycle:{before,afterLoad,afterPlayback,selectedStats,cleared,afterDestroy},
    physicalPick,
    activeDrawEvents:drawEvents.length,postRenderListenerRemoved:true,
    complete:(intervals.length>=frames && afterDestroy.primitives===before.primitives &&
      afterLoad.aisStats.billboards===count && cleared.aisStats.billboards===0),
  };
}"""


def git(*args: str) -> str:
    out = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=10)
    return out.stdout.strip() if out.returncode == 0 else "UNKNOWN"


def source_sha() -> dict[str, str]:
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCE_FILES}


def self_test() -> dict:
    """Static/JS syntax checks only. Explicitly NOT a GPU benchmark substitute."""
    checks: dict[str, bool] = {}
    source = (ROOT / 'src/globe/aisRenderer.perf.test.ts').read_text(encoding='utf-8')
    engine_source = (ROOT / 'src/globe/engine.ts').read_text(encoding='utf-8')
    checks['canonical_density_sizes'] = 'const SIZES = [100, 1000, 5000, 10000]' in source
    checks['source_five_observation_fixture'] = 'for (let i = 0; i < 5; i += 1)' in source
    checks['fixture_geo_extent'] = 'const LAT_SPAN = 20;' in source and 'const LON_SPAN = 40;' in source
    checks['uses_actual_engine_viewer'] = 'get viewer(): Viewer | null' in engine_source
    checks['scene_postrender_listener'] = 'viewer.scene.postRender.addEventListener' in CASE
    checks['active_updates_per_postrender'] = 'b.setFrame(fleet,ticks%2===0?10:8,track)' in CASE
    checks['hardware_fail_closed_software_markers'] = all(
        tag in INSTALL.lower() for tag in ('swiftshader', 'llvmpipe', 'lavapipe', 'microsoft basic render'))
    checks['synthetic_explicit'] = 'SYNTHETIC' in INSTALL and 'SYNTHETIC' in CASE.upper()
    try:
        parsed = subprocess.run(['node','--check','-'], input='const install='+INSTALL+';\nconst stage='+CASE+';\n',
                                text=True,capture_output=True,timeout=20,check=False)
        checks['javascript_parses_in_node'] = parsed.returncode == 0
        note = parsed.stderr.strip()[:500]
    except (FileNotFoundError,subprocess.TimeoutExpired) as exc:
        checks['javascript_parses_in_node'] = False
        note = str(exc)
    return {'status':'STATIC_PASS' if all(checks.values()) else 'STATIC_FAIL',
            'checks':checks,'jsSyntaxDetail':note,
            'caveat':'Static checks; NO real browser/GPU canvas was exercised.'}


def run(url: str, frames: int, timeout: int) -> dict:
    if urlsplit(url).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Only localhost Vite URLs are allowed")
    result = {"status":"UNVERIFIED", "utc":datetime.now(timezone.utc).isoformat(),"url":url,
              "gitHeadStart":git("rev-parse","HEAD"),"dirtyStart":bool(git("status","--porcelain")),
              "sourceSha256Start":source_sha(),"fixture":"SYNTHETIC, from aisRenderer.perf.test.ts",
              "sizes":list(SIZES),"rows":[],"errors":[],"cdp":{},"storageWrites":"NONE_REQUESTED",
              "browser":"disposable single isolated headless Chrome process; no existing user profile"}
    if not CHROME.is_file():
        result["errors"].append(f"Installed Chrome binary missing: {CHROME}")
        return result
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(CHROME), headless=True,
                                            args=["--enable-gpu", "--enable-webgl", "--ignore-gpu-blocklist",
                                                  "--disable-software-rasterizer", "--use-angle=d3d11",
                                                  "--enable-precise-memory-info", "--js-flags=--expose-gc"])
        context = browser.new_context(viewport={"width":1440,"height":900}, device_scale_factor=1)
        context.route("**/*",lambda route: route.continue_() if urlsplit(route.request.url).hostname in
                      {"localhost","127.0.0.1","::1"} else route.abort())
        page = context.new_page()
        page.on("pageerror",lambda err: result["errors"].append("PAGE_ERROR: "+str(err)[:500]))
        try:
            response=page.goto(url,wait_until="domcontentloaded",timeout=20000)
            if not response or response.status!=200:
                raise RuntimeError(f"Vite app unavailable, HTTP {response.status if response else 'NO_RESPONSE'}")
            page.locator('.cesium-widget canvas').first.wait_for(state='visible',timeout=30000)
            page.wait_for_timeout(500)  # allow initial React effects; not part of timed sample
            # The tactical tab is not required: globe viewer persists app-wide.
            hardware=page.evaluate(INSTALL)
            result["hardware"]=hardware
            if hardware.get("error") or not hardware.get("canvasSameAsDom") or not hardware.get("canvasConnected"):
                raise RuntimeError(f"HARDWARE_OR_APP_CANVAS_GATE_FAILED: {hardware}")
            result["emptySceneBaselineAfterGc"]=page.evaluate("""() => {
              const available=typeof window.gc==='function';
              if(available) window.gc();
              return {gcAvailable:available,...window.__dfGpuBench.snapshot()};
            }""")
            try:
                cdp=context.new_cdp_session(page)
                cdp.send('Performance.enable')
                result["cdp"]["before"]=cdp.send('Performance.getMetrics')
                result["cdp"]["domCountersBefore"]=cdp.send('Memory.getDOMCounters')
                try:
                    info=browser.new_browser_cdp_session().send('SystemInfo.getInfo')
                    result["cdp"]["gpuAux"]={"devices":info.get('gpu',{}).get('devices',[])[:2],
                                                "featureStatus":info.get('gpu',{}).get('featureStatus',{})}
                except Exception as exc:
                    result["cdp"]["gpuAuxUnavailable"]=str(exc)[:150]
            except Exception as exc:
                result["cdp"]["unavailable"]=str(exc)[:250]
                cdp=None
            for count in SIZES:
                try:
                    # Long enough for real 10k postRender events (not idle rAF).
                    row=page.evaluate(CASE,{"count":count,"frames":frames,"timeoutMs":timeout*1000})
                    row["emptyAfterGc"] = page.evaluate("""() => {
                      const available=typeof window.gc==='function';
                      if(available) window.gc();
                      return {gcAvailable:available,...window.__dfGpuBench.snapshot()};
                    }""")
                    result["rows"].append(row)
                    if not row.get("complete"):
                        result["errors"].append(f"INCOMPLETE_{count}_COUNT_OR_PRIMITIVE_CLEANUP")
                    if cdp:
                        result["cdp"][f"after_{count}"]=cdp.send('Performance.getMetrics')
                except Exception as exc:
                    result["errors"].append(f"{count}: {type(exc).__name__}: {str(exc)[:1000]}")
                    break
            if cdp:
                result["cdp"]["after"]=cdp.send('Performance.getMetrics')
                result["cdp"]["domCountersAfter"]=cdp.send('Memory.getDOMCounters')
        except Exception as exc:
            result["errors"].append(f"GATE_FAILURE: {type(exc).__name__}: {str(exc)[:1500]}")
        finally:
            context.close()
            browser.close()
    result.update({"gitHeadEnd":git("rev-parse","HEAD"),
                   "dirtyEnd":bool(git("status","--porcelain")),
                   "sourceSha256End":source_sha()})
    if result["gitHeadStart"]!=result["gitHeadEnd"] or result["sourceSha256Start"]!=result["sourceSha256End"]:
        result["errors"].append("SOURCE_CHANGED_DURING_HARDWARE_TEST")
    result["status"]="MEASURED" if len(result["rows"])==len(SIZES) and not result["errors"] else "UNVERIFIED"
    return result


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test',action='store_true',help='Static JS syntax/fixture checks; never launches browser')
    parser.add_argument('--run',action='store_true',help='Explicitly run one GPU-enabled isolated Chrome (coordinate with other workers)')
    parser.add_argument('--url',default='http://localhost:5174/')
    parser.add_argument('--frames',type=int,default=36,help='Number of active postRender intervals per fleet size')
    parser.add_argument('--timeout',type=int,default=90,help='Seconds allowed for each active postRender sample')
    options=parser.parse_args()
    if options.self_test:
        report=self_test()
        print(json.dumps(report,indent=2))
        return 0 if report['status']=='STATIC_PASS' else 1
    if not options.run:
        print(json.dumps({"status":"NOT_RUN","reason":"Pass --run AFTER exclusive browser/CPU worker coordination",
                          "head":git('rev-parse','HEAD'),"sourceSha256":source_sha(),
                          "fixture":"src/globe/aisRenderer.perf.test.ts; five synthetic AIS observations per MMSI",
                          "requires":"real Vite app on localhost:5174, real ANGLE hardware WebGL2"},indent=2))
        return 0
    if options.frames<8 or options.frames>500 or options.timeout<5 or options.timeout>300:
        parser.error('frames must be 8-500 and timeout must be 5-300 seconds')
    try: outcome=run(options.url,options.frames,options.timeout)
    except Exception as exc:
        outcome={"status":"UNVERIFIED","errors":[f"{type(exc).__name__}: {str(exc)[:1200]}"]}
    print(json.dumps(outcome,indent=2,default=str))
    return 0 if outcome['status']=='MEASURED' else 1


if __name__=='__main__':
    sys.exit(main())
