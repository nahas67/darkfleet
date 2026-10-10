"""Hardware-gated browser benchmark of DarkFleet's REAL Cesium AIS renderer.

Requires an ALREADY RUNNING DarkFleet Vite server and hardware-backed Chrome.
No application repository files, browser user profile or backend data are changed.
Default action is inspection only; pass --run after coordinating exclusive timing.
--longitudinal adds bounded independent load/render/clear/destroy cycles using
reused synthetic fixture arrays, forced GC, DOM counters and GL call deltas.

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
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, TimeoutError as BrowserTimeout, Error as BrowserError

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
SIZES = (100, 1000, 5000, 10000)
SOURCE_FILES = ("src/globe/engine.ts", "src/globe/aisRenderer.ts",
                "src/globe/aisRenderer.perf.test.ts", "src/ais/displayState.ts",
                "src/state/store.ts", "src/tactical/TacticalWorld.tsx")

# These are the exact raw source texts Vite makes importable in the page. In
# dev mode a Git SHA cannot prove served-bundle identity: compare actual local
# file bytes with the running Vite module's bytes instead.
SERVED_SOURCE = r"""async ({paths,stage}) => {
  const digests={};
  for (const path of paths) {
    const source=(await import('/'+path+'?raw&df_gpu_source_'+stage)).default;
    if (typeof source!=='string') throw new Error('Not a Vite raw source module: '+path);
    const bytes=new TextEncoder().encode(source);
    const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    digests[path]=Array.from(hash).map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  return digests;
}"""


# Executed only on the actual loaded React app, in the original page's Vite
# module graph. This uses the same `engine` singleton as TacticalWorld -- not a
# second Viewer, test double, canvas, copied renderer or mock GPU.
INSTALL = r"""async () => {
  const actualResource = path => {
    const loaded=performance.getEntriesByType('resource')
      .map(x=>x.name).filter(x=>{
        try{
          const parsed=new URL(x);
          return parsed.pathname===path&&!parsed.searchParams.has('raw')&&
            !parsed.searchParams.has('url');
        }catch{return false;}
      });
    // Vite HMR app imports may include ?t=<last-update>. Importing the bare
    // path would then instantiate a SECOND singleton with a null viewer.
    return loaded[loaded.length-1]??path;
  };
  const engineUrl=actualResource('/src/globe/engine.ts');
  const storeUrl=actualResource('/src/state/store.ts');
  const {engine} = await import(/* @vite-ignore */engineUrl);
  const {store} = await import(/* @vite-ignore */storeUrl);
  if(!engine || !store) return {error:'Selected URL resolved to non-app export',engineUrl,storeUrl,
    hasEngine:!!engine,hasStore:!!store};
  const viewer = engine.viewer;
  if (!viewer || !engine.initialised || !viewer.scene?.canvas?.isConnected)
    return {error: 'Actual application engine/viewer/canvas not initialized', initialised:engine.initialised,
      canvasCount:document.querySelectorAll('.cesium-widget canvas').length,
      appStatus:document.body.innerText.slice(0,1800),
      engineUrl,storeUrl,
      matchingResources:performance.getEntriesByType('resource').map(x=>x.name)
        .filter(x=>x.includes('/src/globe/engine.ts')||x.includes('/src/state/store.ts')).slice(-15),
      widgetHtml:document.querySelector('.cesium-widget')?.outerHTML.slice(0,600)};
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
    const stats={created:0,deleted:0,net:0,hooksAttached:false};resources[kind]=stats;
    try {
      const wrappedCreate=function(...args){
        const output=create.apply(gl,args);
        if(output!==null&&typeof output==='object'){
          created.add(output);stats.created++;stats.net++;
        }
        return output;
      };
      const wrappedDelete=function(value){
        if(value&&created.has(value)&&!deleted.has(value)){
          deleted.add(value);stats.deleted++;stats.net--;
        }
        return del.call(gl,value);
      };
      gl[createName]=wrappedCreate;
      gl[deleteName]=wrappedDelete;
      stats.hooksAttached=gl[createName]===wrappedCreate&&gl[deleteName]===wrappedDelete;
    }catch(err){resources[kind]={unavailable:String(err)};}
  }
  const snapshot=()=>({
    primitives:viewer.scene.primitives.length,
    entities:viewer.entities.values.length,
    sceneRequestRenderMode:viewer.scene.requestRenderMode,
    webglContextLost:gl.isContextLost(),
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
    maxRenderbufferSize:gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxVertexAttribs:gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    maxTextureImageUnits:gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxSamples:gl.getParameter(gl.MAX_SAMPLES),
    canvasPixels:[canvas.width,canvas.height],canvasConnected:canvas.isConnected,
    canvasSameAsDom:document.querySelector('.cesium-widget canvas')===canvas,
    documentVisible:document.visibilityState, initialWorkspace:store.getState().workspace,
    previousAisStats, primitivesBeforeIsolation,
    resourceHooksAttached:Object.fromEntries(Object.entries(resources)
      .map(([kind,stats])=>[kind,stats.hooksAttached===true])),
    resourceTrackingNote:'WebGL API call deltas AFTER instrument installation, not all native resources / VRAM.',
    before:snapshot(),engineUrl,storeUrl,
    sourceFixture:'src/globe/aisRenderer.perf.test.ts: makeVessels (transcribed)',
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
      !afterDestroy.webglContextLost && afterLoad.aisStats.billboards===count &&
      cleared.aisStats.billboards===0),
  };
}"""


# This must remain a separate option so the historical 36-frame per-density
# benchmark is comparable byte-for-byte with its pre-longitudinal results.
# Fixed fixture arrays are intentionally reused within a density: changes in
# post-GC empty-scene memory cannot be ascribed to 10k new JS fixture objects
# allocated on each cycle. After the density we release even these references.
LONG_CYCLE = r"""async ({count,cycle,timeoutMs}) => {
  const b=window.__dfGpuBench;
  if(!b?.viewer?.scene || !b?.gl) throw new Error('No real initialized Cesium canvas');
  const {engine,viewer,snapshot,at}=b;
  if(!b.longitudinalFleet || b.longitudinalFleetCount!==count){
    b.longitudinalFleet=b.makeFleet(count);
    b.longitudinalFleetCount=count;
  }
  const fleet=b.longitudinalFleet;
  const before=snapshot();
  if(before.primitives!==0 || before.aisStats?.billboards!==0 || before.webglContextLost)
    throw new Error('NONEMPTY_START_OR_CONTEXT_LOSS_'+count+'_'+cycle);
  const nextRendered=label=>new Promise((resolve,reject)=>{
    let done=false;
    const off=viewer.scene.postRender.addEventListener(()=>{
      if(done)return;done=true;off();clearTimeout(timer);resolve(performance.now());
    });
    const timer=setTimeout(()=>{
      if(done)return;done=true;off();reject(new Error('POST_RENDER_TIMEOUT_'+label+'_'+count+'_'+cycle));
    },timeoutMs);
    viewer.scene.requestRender();
  });
  // Actual app renderer, 5 synthetic observation fixes per contact. This
  // test has no network-backed AIS input, React click or invented SAR scene.
  const start=performance.now();
  engine.setAisObservationSeries(fleet.rows);
  b.setFrame(fleet,8);
  const afterLoad=snapshot();
  if(afterLoad.aisStats?.billboards!==count || afterLoad.primitives!==5)
    throw new Error('RENDERER_DENSITY_COUNT_INVALID_'+count+'_'+cycle);
  await nextRendered('load');
  const loadedRenderAt=performance.now();
  engine.setAisSelection(null);
  engine.setAisContacts([],{referenceTimeIso:at(10),tracks:new Map(),
    observationMarkers:[],predicted:[]});
  engine.setAisObservationSeries(new Map());
  const afterClear=snapshot();
  if(afterClear.aisStats?.billboards!==0)
    throw new Error('RENDERER_DID_NOT_CLEAR_'+count+'_'+cycle);
  await nextRendered('clear');
  engine.destroyAisRenderer();
  await nextRendered('destroy');
  const afterDestroy=snapshot();
  if(afterDestroy.primitives!==0 || afterDestroy.webglContextLost)
    throw new Error('RENDERER_PRIMITIVE_LEAK_OR_CONTEXT_LOST_'+count+'_'+cycle);
  return {count,cycle,fixtureRows:count*5,loadedBillboards:afterLoad.aisStats.billboards,
    renderToFirstPostRenderMs:+(loadedRenderAt-start).toFixed(2),
    lifecycleMs:+(performance.now()-start).toFixed(2),
    before:{primitives:before.primitives,billboards:before.aisStats.billboards},
    afterClear:{primitives:afterClear.primitives,billboards:afterClear.aisStats.billboards},
    afterDestroy:{primitives:afterDestroy.primitives,billboards:afterDestroy.aisStats?.billboards,
      webglContextLost:afterDestroy.webglContextLost,
      observedGlCallsSinceInstall:afterDestroy.webglCallsSinceInstall},
    pass:true};
}"""

LONG_RELEASE = r"""() => {
  const b=window.__dfGpuBench;
  b.longitudinalFleet=null;b.longitudinalFleetCount=null;
  return {primitives:b.viewer.scene.primitives.length,
    canvasSameAsDom:b.canvas===document.querySelector('.cesium-widget canvas')};
}"""

LONG_GC = r"""() => {
  const b=window.__dfGpuBench;
  const available=typeof window.gc==='function';
  if(available){window.gc();window.gc();}
  return {gcAvailable:available,heapBytes:performance.memory?.usedJSHeapSize??null,
    heapLimitBytes:performance.memory?.jsHeapSizeLimit??null,
    domElements:document.querySelectorAll('*').length,
    domCanvases:document.querySelectorAll('canvas').length,
    widgetCount:document.querySelectorAll('.cesium-widget').length,
    canvasConnected:b.canvas.isConnected,
    canvasSameAsDom:b.canvas===document.querySelector('.cesium-widget canvas'),
    primitives:b.viewer.scene.primitives.length,
    entities:b.viewer.entities.values.length,
    webglContextLost:b.gl.isContextLost(),
    observedGlCallsSinceInstall:b.snapshot().webglCallsSinceInstall};
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
    checks['longitudinal_disposes_renderer_every_cycle'] = ('engine.destroyAisRenderer()' in LONG_CYCLE and
        "await nextRendered('destroy')" in LONG_CYCLE)
    checks['longitudinal_reuses_fixture_array'] = ('b.longitudinalFleet=b.makeFleet(count)' in LONG_CYCLE and
        'b.longitudinalFleet=null' in LONG_RELEASE)
    checks['longitudinal_requires_real_scene_render'] = 'viewer.scene.postRender.addEventListener' in LONG_CYCLE
    checks['longitudinal_gc_dom_and_gl'] = ('window.gc();window.gc()' in LONG_GC and
        'observedGlCallsSinceInstall' in LONG_GC and 'domElements' in LONG_GC)
    try:
        parsed = subprocess.run(['node','--check','-'], input='const install='+INSTALL+';\nconst stage='+CASE+';\nconst served='+SERVED_SOURCE+';\nconst longCycle='+LONG_CYCLE+';\nconst longRelease='+LONG_RELEASE+';\nconst longGc='+LONG_GC+';\n',
                                text=True,capture_output=True,timeout=20,check=False)
        checks['javascript_parses_in_node'] = parsed.returncode == 0
        note = parsed.stderr.strip()[:500]
    except (FileNotFoundError,subprocess.TimeoutExpired) as exc:
        checks['javascript_parses_in_node'] = False
        note = str(exc)
    return {'status':'STATIC_PASS' if all(checks.values()) else 'STATIC_FAIL',
            'checks':checks,'jsSyntaxDetail':note,
            'caveat':'Static checks; NO real browser/GPU canvas was exercised.'}


def run(url: str, frames: int, timeout: int, cycles: tuple[int, ...] | None = None) -> dict:
    if urlsplit(url).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Only localhost Vite URLs are allowed")
    result = {"status":"UNVERIFIED", "utc":datetime.now(timezone.utc).isoformat(),"url":url,
              "gitHeadStart":git("rev-parse","HEAD"),"dirtyStart":bool(git("status","--porcelain")),
              "sourceSha256Start":source_sha(),"fixture":"SYNTHETIC, from aisRenderer.perf.test.ts",
              "sizes":list(SIZES),"rows":[],"errors":[],"cdp":{},"storageWrites":"NONE_REQUESTED",
              "browserConsoleErrors":[],
              "browser":"disposable single isolated headless Chrome process; no existing user profile"}
    if cycles:
        result["longitudinal"] = {"requestedCyclesBySize":dict(zip(SIZES,cycles)),
                                  "requestedTotalCycles":sum(cycles),"stages":[],
                                  "method":"real Cesium postRender on load/clear/destroy; reused fixed synthetic fleet per size; CDP GC + two window.gc + 175ms settled empty-scene snapshot",
                                  "gpuVramBytes":"NOT_AVAILABLE"}
    if not CHROME.is_file():
        result["errors"].append(f"Installed Chrome binary missing: {CHROME}")
        return result
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(CHROME), headless=True,
                                            args=["--enable-gpu", "--enable-webgl", "--ignore-gpu-blocklist",
                                                  "--disable-software-rasterizer", "--use-angle=d3d11",
                                                  "--enable-precise-memory-info", "--js-flags=--expose-gc"])
        # Playwright request routing cannot intercept ServiceWorker-owned fetch;
        # disable ServiceWorkers so this isolated browser cannot bypass the
        # localhost-only network policy via a page-installed worker.
        context = browser.new_context(viewport={"width":1440,"height":900},
                                      service_workers="block", device_scale_factor=1)
        result["externalEgress"] = {"blockedCount":0,"blockedHosts":[],"allowedHostnames":["localhost","127.0.0.1","::1"]}
        def restrict_route(route):
            hostname = urlsplit(route.request.url).hostname
            if hostname in {"localhost", "127.0.0.1", "::1"}:
                route.continue_()
            else:
                result["externalEgress"]["blockedCount"] += 1
                if hostname and hostname not in result["externalEgress"]["blockedHosts"] and len(result["externalEgress"]["blockedHosts"]) < 20:
                    result["externalEgress"]["blockedHosts"].append(hostname)
                route.abort()
        context.route("**/*",restrict_route)
        result["externalEgress"]["webSocketsBlockedCount"] = 0
        def restrict_websocket(route):
            hostname=urlsplit(route.url).hostname
            if hostname in {"localhost", "127.0.0.1", "::1"}:
                route.connect_to_server()
            else:
                result["externalEgress"]["webSocketsBlockedCount"] += 1
                route.close(code=1008,reason="external network disallowed in GPU benchmark")
        context.route_web_socket("**/*",restrict_websocket)
        page = context.new_page()
        page.on("pageerror",lambda err: result["errors"].append("PAGE_ERROR: "+str(err)[:500]))
        page.on("console",lambda msg: result["browserConsoleErrors"].append(msg.text[:500])
                if msg.type == 'error' and len(result["browserConsoleErrors"]) < 12 else None)
        try:
            response=page.goto(url,wait_until="domcontentloaded",timeout=20000)
            if not response or response.status!=200:
                raise RuntimeError(f"Vite app unavailable, HTTP {response.status if response else 'NO_RESPONSE'}")
            page.locator('.cesium-widget canvas').first.wait_for(state='visible',timeout=30000)
            page.wait_for_timeout(500)  # allow initial React effects; not part of timed sample
            served=page.evaluate(SERVED_SOURCE,{"paths":list(SOURCE_FILES),"stage":"start"})
            result["servedSourceSha256Start"]=served
            if served != result["sourceSha256Start"]:
                raise RuntimeError('VITE_DEV_SOURCE_MISMATCH: dev app serves different module source bytes than local repository; no valid version provenance')
            # The tactical tab is not required: globe viewer persists app-wide.
            hardware=page.evaluate(INSTALL)
            result["hardware"]=hardware
            if hardware.get("error") or not hardware.get("canvasSameAsDom") or not hardware.get("canvasConnected"):
                raise RuntimeError(f"HARDWARE_OR_APP_CANVAS_GATE_FAILED: {hardware}")
            if cycles and ("AMD" not in str(hardware.get("renderer","")) or
                           "Direct3D11" not in str(hardware.get("renderer","")) or
                           hardware.get('documentVisible') != 'visible'):
                raise RuntimeError('LONGITUDINAL_REQUIRES_VISIBLE_AMD_D3D11_WEBGL2')
            if cycles and not all(hardware.get('resourceHooksAttached',{}).get(k) for k in ('Buffer','Texture','VertexArray','Program')):
                raise RuntimeError('LONGITUDINAL_GL_CALL_TRACKING_HOOKS_NOT_ATTACHED')
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
            if cycles and not result["errors"]:
                longitudinal=result["longitudinal"]
                total_started=time.monotonic()
                def collect_settled():
                    # CDP GC is independent of window.gc; neither proves
                    # that all user/native/GPU object lifetimes were reclaimed.
                    if cdp:
                        try:
                            cdp.send('HeapProfiler.collectGarbage')
                        except Exception as exc:
                            longitudinal.setdefault('gcWarnings',[]).append(str(exc)[:120])
                    page.wait_for_timeout(175)
                    snap=page.evaluate(LONG_GC)
                    if cdp:
                        try:
                            snap['cdpDomCounters']=cdp.send('Memory.getDOMCounters')
                        except Exception as exc:
                            longitudinal.setdefault('domWarnings',[]).append(str(exc)[:120])
                    return snap
                longitudinal['initialEmptySceneAfterGc']=collect_settled()
                for count,ncycles in zip(SIZES,cycles):
                    stage={"count":count,"cycles":[],"fixtureReusedWithinDensity":True}
                    longitudinal['stages'].append(stage)
                    for index in range(1,ncycles+1):
                        if time.monotonic()-total_started > 210:
                            result['errors'].append(f'LONGITUDINAL_GLOBAL_TIME_BUDGET_210S_EXCEEDED_{count}_{index}')
                            break
                        try:
                            cycle=page.evaluate(LONG_CYCLE,{"count":count,"cycle":index,"timeoutMs":15000})
                            cycle['emptyAfterGc']=collect_settled()
                            stage['cycles'].append(cycle)
                            if not (cycle['pass'] and cycle['afterDestroy']['primitives']==0 and
                                    cycle['afterClear']['billboards']==0 and
                                    cycle['emptyAfterGc']['canvasConnected'] and
                                    cycle['emptyAfterGc']['primitives']==0 and
                                    not cycle['emptyAfterGc']['webglContextLost']):
                                result['errors'].append(f'LONGITUDINAL_LIFECYCLE_GATE_FAILED_{count}_{index}')
                                break
                            print(f'LONGITUDINAL {count} {index}/{ncycles} heap={cycle["emptyAfterGc"]["heapBytes"]} primitives={cycle["emptyAfterGc"]["primitives"]}',
                                  file=sys.stderr,flush=True)
                        except Exception as exc:
                            result['errors'].append(f'LONGITUDINAL_{count}_{index}: {type(exc).__name__}: {str(exc)[:1000]}')
                            break
                    if result['errors']:
                        break
                    stage['release']=page.evaluate(LONG_RELEASE)
                    stage['afterFixtureReleaseGc']=collect_settled()
                longitudinal['actualTotalCycles']=sum(len(stage['cycles']) for stage in longitudinal['stages'])
                longitudinal['elapsedSeconds']=round(time.monotonic()-total_started,3)
                if longitudinal['actualTotalCycles']!=sum(cycles):
                    result['errors'].append('LONGITUDINAL_INCOMPLETE_CYCLE_COUNT')
                longitudinal['complete']=longitudinal['actualTotalCycles']==sum(cycles) and not result['errors']
            if cdp:
                result["cdp"]["after"]=cdp.send('Performance.getMetrics')
                result["cdp"]["domCountersAfter"]=cdp.send('Memory.getDOMCounters')
            result["servedSourceSha256End"]=page.evaluate(SERVED_SOURCE,{"paths":list(SOURCE_FILES),"stage":"end"})
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
    if result.get("servedSourceSha256End") is not None and result.get("servedSourceSha256End") != result.get("sourceSha256End"):
        result["errors"].append("SERVED_VITE_SOURCE_DRIFTED_FROM_LOCAL_DURING_HARDWARE_TEST")
    valid=len(result["rows"])==len(SIZES) and not result["errors"]
    if cycles:
        valid=valid and result.get('longitudinal',{}).get('complete',False)
    result["status"]=("MEASURED_LONGITUDINAL" if cycles else "MEASURED") if valid else "UNVERIFIED"
    return result


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test',action='store_true',help='Static JS syntax/fixture checks; never launches browser')
    parser.add_argument('--run',action='store_true',help='Explicitly run one GPU-enabled isolated Chrome (coordinate with other workers)')
    parser.add_argument('--url',default='http://localhost:5174/')
    parser.add_argument('--frames',type=int,default=36,help='Number of active postRender intervals per fleet size')
    parser.add_argument('--timeout',type=int,default=90,help='Seconds allowed for each active postRender sample')
    parser.add_argument('--longitudinal',action='store_true',help='Add bounded hardware GC/GL/DOM repeated lifecycle cycles after standard 4x36 active frames')
    parser.add_argument('--cycles-per-size',default='3,3,3,8',help='With --longitudinal: four 1..12 counts totaling 12..20 (default 3,3,3,8)')
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
    cycles = None
    if options.longitudinal:
        try:
            cycles=tuple(int(x) for x in options.cycles_per_size.split(','))
        except ValueError:
            parser.error('cycles-per-size must be four integers')
        if len(cycles)!=len(SIZES) or not all(1<=n<=12 for n in cycles) or not 12<=sum(cycles)<=20:
            parser.error('cycles-per-size needs four 1..12 integers totaling 12..20')
    try: outcome=run(options.url,options.frames,options.timeout,cycles)
    except Exception as exc:
        outcome={"status":"UNVERIFIED","errors":[f"{type(exc).__name__}: {str(exc)[:1200]}"]}
    print(json.dumps(outcome,indent=2,default=str))
    return 0 if outcome['status'] in {'MEASURED','MEASURED_LONGITUDINAL'} else 1


if __name__=='__main__':
    sys.exit(main())
