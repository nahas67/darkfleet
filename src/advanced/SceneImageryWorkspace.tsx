/** Two independently navigable recorded RTC imagery panes. No change inference. */
import { useEffect, useRef, useState } from 'react';
import { api, ContractViolation, explain } from '../api/errors';
import { readSceneCandidates, type Candidate } from './SceneComparisonWorkbench';

export type ImageryStatus = 'READY' | 'UNAVAILABLE';

export interface ImageryScene {
  scan_id: string;
  status: ImageryStatus;
  reason: string;
  item_id: string | null;
  acquisition_time: string | null;
  product: string | null;
  polarization: string | null;
  platform: string | null;
  provider: string | null;
  crs: string | null;
  transform: number[] | null;
  wgs84_corners_lon_lat: number[][] | null;
  raster_window: number[] | null;
  source_shape: number[] | null;
  preview_shape: number[] | null;
  sample_stride: number | null;
  valid_source_pixels: number | null;
  total_source_pixels: number | null;
  displayed_valid_pixels: number | null;
  image_url: string | null;
  display_window_db: number[] | null;
  source: 'PERSISTED_REAL_SCAN_CHECKSUM_VERIFIED_RTC' | null;
}

export interface ImageryPair {
  status: 'READY' | 'PARTIAL' | 'UNAVAILABLE';
  first: ImageryScene;
  second: ImageryScene;
  interpretation: string;
}

const identifier = /^[A-Za-z0-9_-]{1,200}$/;
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractViolation(field, 'Expected an object.');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length) {
    throw new ContractViolation(field, 'Expected non-empty text.');
  }
  return value;
}
function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractViolation(field, 'Expected a finite number.');
  }
  return value;
}
function numbers(value: unknown, field: string, size: number): number[] {
  if (!Array.isArray(value) || value.length !== size) {
    throw new ContractViolation(field, `Expected ${size} numeric entries.`);
  }
  return value.map((n) => number(n, field));
}

export function readImageryPair(value: unknown, firstScan: string, secondScan: string): ImageryPair {
  const pair = object(value, 'ImageryPair');
  text(pair.interpretation, 'ImageryPair.interpretation');
  if (!['READY', 'PARTIAL', 'UNAVAILABLE'].includes(String(pair.status))) {
    throw new ContractViolation('ImageryPair.status', 'Unrecognized availability state.');
  }
  const parse = (value: unknown, expected: string, field: string): ImageryScene => {
    const scene = object(value, field);
    if (scene.scan_id !== expected || !identifier.test(expected)) {
      throw new ContractViolation(`${field}.scan_id`, 'Source identity mismatch.');
    }
    text(scene.reason, `${field}.reason`);
    if (scene.status !== 'READY' && scene.status !== 'UNAVAILABLE') {
      throw new ContractViolation(`${field}.status`, 'Unrecognized imagery status.');
    }
    if (scene.status === 'UNAVAILABLE') {
      if (scene.image_url !== null || scene.source !== null) {
        throw new ContractViolation(field, 'Unavailable image must have no source assertion or image URL.');
      }
      return scene as unknown as ImageryScene;
    }
    for (const key of ['item_id', 'acquisition_time', 'platform', 'provider', 'polarization', 'crs']) {
      text(scene[key], `${field}.${key}`);
    }
    if (scene.product !== 'RTC' || scene.source !== 'PERSISTED_REAL_SCAN_CHECKSUM_VERIFIED_RTC') {
      throw new ContractViolation(field, 'Verified REAL RTC source assertion missing.');
    }
    if (scene.image_url !== `/api/sar/imagery/scans/${expected}/image`) {
      throw new ContractViolation(`${field}.image_url`, 'Expected a local scan-specific image endpoint.');
    }
    const shape = numbers(scene.source_shape, `${field}.source_shape`, 2);
    const preview = numbers(scene.preview_shape, `${field}.preview_shape`, 2);
    const affine = numbers(scene.transform, `${field}.transform`, 6);
    if (!Array.isArray(scene.wgs84_corners_lon_lat) || scene.wgs84_corners_lon_lat.length !== 4) {
      throw new ContractViolation(`${field}.wgs84_corners_lon_lat`, 'Expected four source-derived corners.');
    }
    const corners = scene.wgs84_corners_lon_lat.map((p) =>
      numbers(p, `${field}.wgs84_corners_lon_lat`, 2));
    const window = numbers(scene.raster_window, `${field}.raster_window`, 4);
    const db = numbers(scene.display_window_db, `${field}.display_window_db`, 2);
    const stride = number(scene.sample_stride, `${field}.sample_stride`);
    const valid = number(scene.valid_source_pixels, `${field}.valid_source_pixels`);
    const total = number(scene.total_source_pixels, `${field}.total_source_pixels`);
    const displayed = number(scene.displayed_valid_pixels, `${field}.displayed_valid_pixels`);
    if (
      shape.some((v) => !Number.isInteger(v) || v < 1) || shape[0] * shape[1] !== total ||
      total > 8_000_000 || !Number.isInteger(stride) || stride < 1 ||
      preview[0] !== Math.ceil(shape[0] / stride) ||
      preview[1] !== Math.ceil(shape[1] / stride) || Math.max(...preview) > 1024 ||
      window.some((v) => !Number.isInteger(v) || v < 0) ||
      window[2] !== shape[0] || window[3] !== shape[1] ||
      !Number.isInteger(valid) || valid <= 0 || valid > total ||
      !Number.isInteger(displayed) || displayed < 0 || displayed > preview[0] * preview[1] ||
      affine[0] * affine[4] === affine[1] * affine[3] ||
      corners.some(([lon, lat]) => lon < -180 || lon > 180 || lat < -90 || lat > 90) ||
      db[0] !== -30 || db[1] !== 5
    ) {
      throw new ContractViolation(field, 'Source geometry, sample counts or rendering bounds inconsistent.');
    }
    return scene as unknown as ImageryScene;
  };
  const first = parse(pair.first, firstScan, 'ImageryPair.first');
  const second = parse(pair.second, secondScan, 'ImageryPair.second');
  const expected = first.status === 'READY' && second.status === 'READY' ? 'READY'
    : first.status === 'UNAVAILABLE' && second.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'PARTIAL';
  if (pair.status !== expected) {
    throw new ContractViolation('ImageryPair.status', 'Availability does not match scene readiness.');
  }
  return { first, second, status: expected, interpretation: pair.interpretation as string };
}

export async function listImageryCandidates(signal?: AbortSignal): Promise<Candidate[]> {
  return readSceneCandidates(await api.get<unknown>('/api/sar/imagery/scans', signal));
}

export async function loadImageryPair(first: string, second: string, signal?: AbortSignal) {
  if (!identifier.test(first) || !identifier.test(second) || first === second) {
    throw new Error('Select two different persisted REAL scan IDs.');
  }
  const raw = await api.post<unknown>('/api/sar/imagery/pair', {
    first_scan_id: first, second_scan_id: second,
  }, signal);
  return readImageryPair(raw, first, second);
}

type View = { x: number; y: number; zoom: number };
const INITIAL_VIEW: View = { x: 0, y: 0, zoom: 1 };

function ImagePane({ scene, title }: { scene: ImageryScene; title: string }) {
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [imageFailed, setImageFailed] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const ready = scene.status === 'READY';
  const changeZoom = (factor: number) => setView((v) => ({
    ...v, zoom: Math.min(8, Math.max(1, +(v.zoom * factor).toFixed(3))),
  }));
  return (
    <article className="min-w-0 space-y-2 border border-structural p-2" data-df-imagery-pane={title}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="df-label text-[11px]">{title} · {scene.scan_id}</h3>
        <span className="df-num text-[10px]">{ready ? 'VERIFIED RTC CACHE' : 'UNAVAILABLE'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <button className="df-btn" type="button" aria-label={`${title} zoom in`} disabled={!ready}
          onClick={() => changeZoom(1.5)}>+</button>
        <button className="df-btn" type="button" aria-label={`${title} zoom out`} disabled={!ready}
          onClick={() => changeZoom(1 / 1.5)}>−</button>
        <button className="df-btn" type="button" disabled={!ready}
          onClick={() => setView(INITIAL_VIEW)}>Reset view</button>
        <span className="df-num text-ink-dim">{view.zoom.toFixed(2)}× · independent</span>
      </div>
      <div className="relative flex h-56 items-center justify-center overflow-hidden bg-black/80 select-none md:h-72"
        data-df-imagery-viewport={title} role="group"
        aria-label={`${title} recorded SAR pixel preview; drag to pan, use zoom buttons`}
        onPointerDown={(event) => {
          if (!ready || imageFailed || event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const { x, y } = drag.current;
          drag.current = { x: event.clientX, y: event.clientY };
          setView((v) => ({ ...v, x: v.x + event.clientX - x, y: v.y + event.clientY - y }));
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => { drag.current = null; }}>
        {ready && !imageFailed ? <img key={scene.image_url!} src={scene.image_url!}
          alt={`${title} cached RTC gamma0 radar amplitude in dB; invalid pixels transparent`}
          draggable={false} onError={() => setImageFailed(true)}
          className="max-h-full max-w-full object-contain"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            transformOrigin: 'center', imageRendering: 'pixelated', touchAction: 'none' }} /> : null}
        {!ready || imageFailed ? <div className="p-3 text-center text-[11px] text-ink-dim" role="alert">
          {imageFailed ? 'Image retrieval failed or the cached source changed after verification.' :
            `Recorded imagery unavailable: ${scene.reason}`}
        </div> : null}
      </div>
      {ready ? <div className="space-y-1 text-[10px] text-ink-dim" data-df-imagery-provenance>
        <p className="df-num break-all text-ink">{scene.item_id}</p>
        <p>Acquired {scene.acquisition_time} · {scene.platform} · {scene.provider}</p>
        <p>RTC gamma0 · {scene.polarization} · fixed display −30 to +5 dB</p>
        <p>CRS {scene.crs} · affine {scene.transform?.join(', ')}</p>
        <p>Measured window corners, WGS84 [longitude, latitude] (TL → TR → BR → BL):{' '}
          {scene.wgs84_corners_lon_lat?.map((corner) =>
            `[${corner.map((coordinate) => coordinate.toFixed(5)).join(', ')}]`).join(' · ')}</p>
        <p>Recorded raster window [row, column, height, width]: {scene.raster_window?.join(', ')}</p>
        <p>Native {scene.source_shape?.join(' × ')} · display {scene.preview_shape?.join(' × ')}
          {' '}· nearest sample every {scene.sample_stride} pixel(s)</p>
        <p>Finite native samples: {scene.valid_source_pixels} / {scene.total_source_pixels}.
          {' '}Invalid pixels transparent. Clipping at display endpoints is visual only.</p>
      </div> : <p className="text-[10px] text-ink-dim">{scene.reason}</p>}
    </article>
  );
}

export function SceneImageryWorkspace() {
  const [scenes, setScenes] = useState<Candidate[]>([]);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [pair, setPair] = useState<ImageryPair | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listImageryCandidates(controller.signal)
      .then((entries) => {
        if (controller.signal.aborted) return;
        setScenes(entries); setFirst(entries[0]?.scan_id ?? '');
        setSecond(entries[1]?.scan_id ?? '');
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(explain(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); request.current?.abort(); };
  }, []);

  const select = (side: 'first' | 'second', value: string) => {
    request.current?.abort();
    setBusy(false); setPair(null); setError(null);
    if (side === 'first') setFirst(value); else setSecond(value);
  };
  const showPair = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPair(null); setError(null); setBusy(true);
    void loadImageryPair(first, second, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setPair(result); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(explain(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
  };
  return (
    <section className="df-panel min-h-0 space-y-3 overflow-y-auto p-3" data-df-scene-imagery-workspace>
      <h2 className="df-label text-xs">Historical SAR · two-scene imagery</h2>
      <p className="text-[11px] text-ink-dim">
        View recorded REAL RTC backscatter pixels side by side. Every image uses the same fixed
        grayscale dB window and independently controlled pan and zoom. Visual proximity is not
        evidence of pixel co-registration, a vessel, or change between acquisitions.
      </p>
      {loading ? <p className="df-note" role="status">Reading saved REAL scan catalogue…</p> : null}
      {!loading && scenes.length < 2 ? <p role="status" className="df-note">
        {scenes.length === 0 ? 'No recorded REAL scans are available.' :
          'A second saved REAL scan is required for a two-scene view.'}
      </p> : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {([['first', first, 'First acquisition'], ['second', second, 'Second acquisition']] as const)
          .map(([side, selected, label]) => <label className="space-y-1 text-[11px]" key={side}>
            <span className="df-label">{label}</span>
            <select className="df-input w-full" value={selected} aria-label={label}
              disabled={loading || busy} onChange={(event) => select(side, event.target.value)}>
              <option value="">Select saved scan</option>
              {scenes.map((scene) => <option key={scene.scan_id} value={scene.scan_id}>
                {scene.scan_id} · {scene.acquisition_time ?? 'time not established'}
              </option>)}
            </select>
          </label>)}
      </div>
      <button type="button" className="df-btn" data-df-imagery-load
        onClick={showPair} disabled={busy || loading || !first || !second || first === second}>
        Display stored imagery
      </button>
      {busy ? <p role="status" className="df-note">Verifying locally cached pixels and provenance…</p> : null}
      {error ? <p className="text-[11px] text-fault" role="alert">{error}</p> : null}
      {pair ? <div className="space-y-2" data-df-imagery-result={pair.status}>
        <p className="df-num text-[10px]">Pair availability: {pair.status}</p>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <ImagePane key={`first-${pair.first.scan_id}`} title="First" scene={pair.first} />
          <ImagePane key={`second-${pair.second.scan_id}`} title="Second" scene={pair.second} />
        </div>
        <p className="text-[11px] text-ink-dim">{pair.interpretation}</p>
      </div> : null}
    </section>
  );
}
