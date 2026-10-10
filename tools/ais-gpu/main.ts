/**
 * Browser-only DF-X9.8 H7/H8 diagnostic. Serve via `npm run dev` and open
 * `/tools/ais-gpu/index.html` in hardware-accelerated Chrome. No application data, backend or
 * external AIS provider is used: generated contacts are controlled performance fixtures.
 *
 * Evaluate `await window.dfAisGpuBench.runStage(10000)` in DevTools, or use `runAll()`.
 * Frame intervals are requestAnimationFrame wall-clock intervals, NOT GPU timer-query duration.
 * Scene postRender counts show whether Cesium actually rendered during those callbacks.
 */
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { Cartesian2, Cartesian3, Math as CesiumMath, type Viewer } from 'cesium';
import { initializeCesiumViewer } from '../../src/globe/cesiumViewer';
import { AisContactRenderer, type RenderableContact } from '../../src/globe/aisRenderer';
import { displayStateOf } from '../../src/ais/displayState';

const SIZES = [500, 1000, 2500, 5000, 10000] as const;
const T0 = '2026-03-01T12:00:00.000Z';
const viewport = document.getElementById('map')!;
const reportElement = document.getElementById('report')!;
const runStatus = document.getElementById('run-status')!;
const runAllButton = document.getElementById('run-all') as HTMLButtonElement;
const run10kButton = document.getElementById('run-10k') as HTMLButtonElement;
const downloadButton = document.getElementById('download-evidence') as HTMLButtonElement;

let viewer: Viewer;
let renderer: AisContactRenderer;
let contacts: RenderableContact[] = [];
const runLog: unknown[] = [];
let activeJob = false;

function print(value: unknown): void {
  reportElement.textContent = JSON.stringify(value, null, 2);
}

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] * 100) / 100;
}

function heapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return memory?.usedJSHeapSize ?? null;
}

function raf(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function frameSample(n = 90): Promise<{
  rafSamples: number; scenePostRenderEvents: number; sceneRenderedDuringSample: boolean;
  rafP50ms: number | null; rafP95ms: number | null; rafFpsFromP50: number | null;
  sceneIntervalP50ms: number | null; sceneIntervalP95ms: number | null;
  sceneFpsFromP50: number | null;
}> {
  let postRenderEvents = 0;
  const sceneDeltas: number[] = [];
  let previousSceneAt: number | null = null;
  const removeListener = viewer.scene.postRender.addEventListener(() => {
    const at = performance.now();
    if (previousSceneAt !== null) sceneDeltas.push(at - previousSceneAt);
    previousSceneAt = at;
    postRenderEvents++;
  });
  const deltas: number[] = [];
  try {
    let previous = await raf();
    for (let i = 0; i < n; i++) {
      const timestamp = await raf();
      deltas.push(timestamp - previous);
      previous = timestamp;
    }
  } finally {
    removeListener();
  }
  deltas.sort((a, b) => a - b);
  sceneDeltas.sort((a, b) => a - b);
  const rafP50ms = percentile(deltas, 0.5);
  const sceneIntervalP50ms = percentile(sceneDeltas, 0.5);
  return {
    rafSamples: deltas.length, scenePostRenderEvents: postRenderEvents,
    sceneRenderedDuringSample: postRenderEvents > 0,
    rafP50ms, rafP95ms: percentile(deltas, 0.95),
    rafFpsFromP50: rafP50ms ? Math.round(100000 / rafP50ms) / 100 : null,
    sceneIntervalP50ms, sceneIntervalP95ms: percentile(sceneDeltas, 0.95),
    sceneFpsFromP50: sceneIntervalP50ms ? Math.round(100000 / sceneIntervalP50ms) / 100 : null,
  };
}

function makeContacts(count: number, dense = false): RenderableContact[] {
  const results: RenderableContact[] = [];
  for (let i = 0; i < count; i++) {
    const mmsi = String(257000000 + i);
    const lat = dense ? 10 + (i % 37) * 0.0001 : 1 + (i / count) * 20;
    const lon = dense ? 122 + (i % 41) * 0.0001 : 103 + (((i * 7919) % 9973) / 9973) * 40;
    const anchored = i % 8 === 7;
    const obs = { timestamp: T0, mmsi, lat, lon, sog: anchored ? null : 8 + (i % 7),
      cog: anchored ? null : (i * 13) % 360, heading: anchored ? null : (i * 7) % 360,
      ship_name: `BENCH ${i}`, source: 'fixture' };
    results.push({ mmsi, state: displayStateOf([obs], T0), selected: false, associated: false });
  }
  return results;
}

function render(items: readonly RenderableContact[]) {
  return renderer.render({ contacts: items, predicted: [], referenceTimeIso: T0 });
}

function gpuInfo(): Record<string, unknown> {
  // Cesium's WebGL context is diagnostic-only and is deliberately not part of its public types.
  const gl = (viewer.scene as unknown as { context?: { _gl?: WebGLRenderingContext } }).context?._gl;
  if (!gl) return { context: 'UNAVAILABLE' };
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
    unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), webglVersion: gl.getParameter(gl.VERSION),
    webgl2: gl instanceof WebGL2RenderingContext,
  };
}

async function runStage(count: number, dense = false): Promise<unknown> {
  if (!SIZES.includes(count as typeof SIZES[number])) throw new Error('Invalid stage');
  contacts = makeContacts(count, dense);
  const begun = performance.now();
  const first = render(contacts);
  const firstBuildMs = performance.now() - begun;
  await raf(); await raf();
  const frames = await frameSample();
  const updateStart = performance.now();
  const updated = render(contacts);
  const updateMs = performance.now() - updateStart;
  await raf();
  const result = {
    stage: count, dense, firstBuildMs: Math.round(firstBuildMs * 100) / 100,
    retainedUpdateMs: Math.round(updateMs * 100) / 100, frames,
    first: { ...first }, updated: { ...updated }, heapBytes: heapBytes(),
    primitives: viewer.scene.primitives.length, imageryLayers: viewer.imageryLayers.length,
    interpretation: 'RAF intervals measure browser callback cadence; scene intervals measure wall-time between Cesium postRender callbacks. Neither is a GPU timer-query benchmark.',
  };
  runLog.push(result);
  print(result);
  return result;
}

async function measureSelectionAndPick(): Promise<unknown> {
  if (!contacts.length) throw new Error('Run a stage first');
  // Pick the *visible topmost* AIS contact at an actual rendered screen pixel,
  // then select that MMSI. An arbitrary array-index contact might be hidden by
  // a different billboard on the same pixel. That would measure occlusion,
  // not the click -> selection -> retained-renderer picking workflow.
  const requested = contacts[Math.floor(contacts.length / 2)];
  const byMmsi = new Map(contacts.map((item) => [item.mmsi, item]));
  const candidates = [requested, ...contacts.filter((_, index) => index % Math.max(1, Math.floor(contacts.length / 64)) === 0)];
  let point: Cartesian2 | undefined;
  let contact: RenderableContact | undefined;
  let firstProbeMmsi: string | null = null;
  let probes = 0;
  for (const candidate of candidates) {
    if (candidate.state.lon === null || candidate.state.lat === null) continue;
    const candidatePoint = viewer.scene.cartesianToCanvasCoordinates(
      Cartesian3.fromDegrees(candidate.state.lon, candidate.state.lat));
    if (!candidatePoint || candidatePoint.x < 0 || candidatePoint.y < 0 ||
        candidatePoint.x > viewer.canvas.clientWidth || candidatePoint.y > viewer.canvas.clientHeight) continue;
    const tagged = viewer.scene.pick(new Cartesian2(candidatePoint.x, candidatePoint.y)) as
      { id?: { domain?: unknown; mmsi?: unknown } } | undefined;
    probes++;
    if (candidate.mmsi === requested.mmsi) {
      firstProbeMmsi = typeof tagged?.id?.mmsi === 'string' ? tagged.id.mmsi : null;
    }
    if (tagged?.id?.domain !== 'AIS_CONTACT' || typeof tagged.id.mmsi !== 'string') continue;
    const visible = byMmsi.get(tagged.id.mmsi);
    if (!visible) continue;
    point = candidatePoint;
    contact = visible;
    break;
  }
  if (!point || !contact) {
    const missing = { pickingVerified: false, reason: 'NO_VISIBLE_TAGGED_AIS_CONTACT',
      requestedMmsi: requested.mmsi, firstProbeMmsi, probeSamples: probes };
    runLog.push(missing); print(missing); return missing;
  }
  contact.selected = true;
  const selectedAt = performance.now();
  const stats = render(contacts);
  const selectionMs = performance.now() - selectedAt;
  await raf(); await raf();
  const withinView = point.x >= 0 && point.y >= 0 && point.x <= viewer.canvas.clientWidth && point.y <= viewer.canvas.clientHeight;
  const picks: Array<{ durationMs: number; id: unknown }> = [];
  if (withinView) {
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const picked = viewer.scene.pick(new Cartesian2(point.x, point.y)) as { id?: unknown } | undefined;
      picks.push({ durationMs: Math.round((performance.now() - start) * 100) / 100, id: picked?.id ?? null });
    }
  }
  const latencies = picks.map((p) => p.durationMs).sort((a, b) => a - b);
  const pickedIds = picks.map((p) => p.id);
  const selectedContactPickCount = pickedIds.filter((id) => {
    const tag = id as { mmsi?: unknown } | null;
    return tag !== null && typeof tag === 'object' && tag.mmsi === contact.mmsi;
  }).length;
  const result = { selectionMs, selectedMmsi: contact.mmsi, requestedMmsi: requested.mmsi,
    firstProbeMmsi, pickTargetMode: 'VISIBLE_TOPMOST_AIS_AT_ACTUAL_CLICK_PIXEL',
    probeSamples: probes, labelsShown: stats.labelsShown,
    withinView, pickSampleCount: picks.length, pickP50ms: percentile(latencies, 0.5),
    pickP95ms: percentile(latencies, 0.95), selectedContactPickCount,
    pickVerified: picks.length === 10 && selectedContactPickCount === 10, pickIds: pickedIds,
    interpretation: 'The clicked contact is the true topmost AIS tag at an actual screen pixel. The requested midpoint candidate may be occluded; the sampled selection must return the chosen visible tag for all ten picks. GPU-rendered picking timing is not a GPU timer query.',
  };
  runLog.push(result); print(result); return result;
}

async function lifecycle(cycles = 25): Promise<unknown> {
  // Compare memory at two *empty renderer* points, not a 10K populated scene
  // against an empty scene. If exposed by the browser runner, force GC at both
  // points to reduce the effect of incidental allocation, but never infer VRAM.
  contacts = [];
  render([]);
  await raf();
  const gc = (window as Window & { gc?: () => void }).gc;
  const gcAvailable = typeof gc === 'function';
  if (gcAvailable) gc();
  const emptyHeapBeforeCycles = heapBytes();
  const initialPrimitives = viewer.scene.primitives.length;
  const initialImagery = viewer.imageryLayers.length;
  const firstHeap = heapBytes();
  const perCycle: Array<{ cycle: number; primitivesAfterClear: number; primitivesAfterDestroy: number;
    primitivesAfterRecreate: number; labels: number; billboards: number; heapBytes: number | null }> = [];
  for (let i = 0; i < cycles; i++) {
    render(makeContacts(500, i % 2 === 0));
    await raf();
    const cleared = render([]);
    const countAfterClear = viewer.scene.primitives.length;
    renderer.destroy();
    const countAfterDestroy = viewer.scene.primitives.length;
    // A render between destroy/recreate exposes references to destroyed Cesium collections.
    viewer.scene.render();
    renderer = new AisContactRenderer(viewer);
    perCycle.push({ cycle: i + 1, primitivesAfterClear: countAfterClear,
      primitivesAfterDestroy: countAfterDestroy, primitivesAfterRecreate: viewer.scene.primitives.length,
      labels: cleared.labels, billboards: cleared.billboards, heapBytes: heapBytes() });
  }
  contacts = [];
  render([]);
  await raf();
  if (gcAvailable) gc();
  const emptyHeapAfterCycles = heapBytes();
  const result = { cycles, initialPrimitives, finalPrimitives: viewer.scene.primitives.length,
    initialImagery, finalImagery: viewer.imageryLayers.length, firstHeap, lastHeap: heapBytes(), perCycle,
    gcAvailable, emptyHeapBeforeCycles, emptyHeapAfterCycles,
    emptyHeapDeltaBytes: emptyHeapBeforeCycles !== null && emptyHeapAfterCycles !== null
      ? emptyHeapAfterCycles - emptyHeapBeforeCycles : null,
    collectionsStable: perCycle.every((row) => row.primitivesAfterClear === initialPrimitives
      && row.primitivesAfterDestroy === initialPrimitives - 5
      && row.primitivesAfterRecreate === initialPrimitives),
    note: 'When window.gc is exposed, empty-collection JS heap is compared after forced GC at both endpoints; this is NOT GPU VRAM and does not establish long-run leak-free operation.',
  };
  runLog.push(result); print(result); return result;
}

async function basemapCycles(cycles = 25): Promise<unknown> {
  const basemap = (viewer as Viewer & { basemap?: { controller: { select: (id: string) => unknown; reportFailure: () => unknown; status: () => { activeId: string | null } }; applyActive: () => void } }).basemap;
  if (!basemap) throw new Error('No production basemap handle');
  const records: Array<{ cycle: number; fallbackId: string | null; recoveryViaManualSelection: string | null; imageryLayers: number }> = [];
  for (let i = 0; i < cycles; i++) {
    basemap.controller.select('OSM'); basemap.applyActive();
    for (let f = 0; f < 5; f++) basemap.controller.reportFailure();
    basemap.applyActive();
    const fallbackId = basemap.controller.status().activeId;
    basemap.controller.select('OSM'); basemap.applyActive();
    records.push({ cycle: i + 1, fallbackId, recoveryViaManualSelection: basemap.controller.status().activeId,
      imageryLayers: viewer.imageryLayers.length });
    await raf();
  }
  const result = { cycles, semantics: 'forced failure plus manual primary reselection; does NOT test cooldown maybeRecover()', records };
  runLog.push(result); print(result); return result;
}

async function runAll(): Promise<unknown> {
  const sizes = [];
  for (const count of SIZES) sizes.push(await runStage(count));
  // Evaluate picking while the 10K contacts remain spatially distributed. In a
  // dense cluster the selected point can share a pixel with many other MMSIs.
  const picking = await measureSelectionAndPick();
  const dense = await runStage(10000, true);
  const resources = await lifecycle();
  const basemap = await basemapCycles();
  const result = { gpu: gpuInfo(), sizes, dense, picking, resources, basemap,
    collectedAt: new Date().toISOString(),
    harnessUrl: window.location.href,
    sourceBuildRevision: 'UNVERIFIED_VITE_DEV_SOURCE',
    note: 'Synthetic performance inputs; not a real AIS provider or SAR observation.' };
  runLog.push(result);
  print(result);
  return result;
}

async function runFromButton(job: () => Promise<unknown>): Promise<void> {
  if (activeJob) return;
  activeJob = true;
  runAllButton.disabled = true;
  run10kButton.disabled = true;
  runStatus.textContent = 'Measurement in progress; leave the tab visible and foregrounded.';
  try {
    await job();
    runStatus.textContent = 'Measurement completed. Download JSON and inspect hardware identity and verification flags.';
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    runStatus.textContent = `Measurement failed: ${error}`;
    print({ measurementFailed: true, error, gpu: gpuInfo(), collectedAt: new Date().toISOString() });
  } finally {
    activeJob = false;
    runAllButton.disabled = false;
    run10kButton.disabled = false;
  }
}

function downloadEvidence(): void {
  const snapshot = {
    sourceBuildRevision: 'UNVERIFIED_VITE_DEV_SOURCE',
    harnessUrl: window.location.href,
    exportedAt: new Date().toISOString(),
    gpu: gpuInfo(), records: runLog,
    caveat: 'These are browser measurements from controlled fixtures, not genuine AIS observations. GPU driver information may be masked; no direct GPU timer-query or VRAM measurement.',
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'darkfleet-ais-h7-h8-browser-evidence.json';
  anchor.click();
  // Keep the Blob URL alive until the browser has accepted the download event.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

declare global {
  interface Window {
    dfAisGpuBench: { gpuInfo: typeof gpuInfo; runStage: typeof runStage; measureSelectionAndPick: typeof measureSelectionAndPick;
      lifecycle: typeof lifecycle; basemapCycles: typeof basemapCycles; runAll: typeof runAll; log: typeof runLog };
  }
}

viewer = initializeCesiumViewer({ container: viewport });
viewer.camera.setView({ destination: Cartesian3.fromDegrees(123, 11, 5000000),
  orientation: { heading: 0, pitch: CesiumMath.toRadians(-90), roll: 0 } });
renderer = new AisContactRenderer(viewer);
window.dfAisGpuBench = { gpuInfo, runStage, measureSelectionAndPick, lifecycle, basemapCycles, runAll, log: runLog };
runAllButton.addEventListener('click', () => { void runFromButton(runAll); });
run10kButton.addEventListener('click', () => { void runFromButton(() => runStage(10000)); });
downloadButton.addEventListener('click', downloadEvidence);
print({ ready: true, gpu: gpuInfo(), canvas: [viewer.canvas.clientWidth, viewer.canvas.clientHeight],
  primitives: viewer.scene.primitives.length, imageryLayers: viewer.imageryLayers.length });
