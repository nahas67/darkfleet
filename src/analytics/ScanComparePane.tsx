/**
 * Compare two persisted SAR acquisitions without reclassifying or reprojecting them
 * in the browser. Each image is fetched from its own real backend raster product.
 * Linked scrolling is a navigation aid, not proof of pixel co-registration.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/errors';
import { fmtInstant } from '../design/format';

type ScanEntry = {
  scan_id: string;
  scene_id: string | null;
  acquisition_time: string | null;
  provider: string | null;
  product: string | null;
  polarization: string | null;
  runtime_mode: 'REAL';
  synthetic: false;
};

type ScanCatalogue = { scans: ScanEntry[]; count: number };

type RasterMeta = {
  scan_id: string;
  layer: string;
  crs: string | null;
  transform: readonly number[] | null;
  scene: {
    item_id?: string | null;
    acquisition_time?: string | null;
    provider?: string | null;
    polarization?: string | null;
    product?: string | null;
    resolution_m?: number | null;
  };
  render: { rendered_shape: readonly [number, number] };
};

type LoadState =
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | { status: 'ready'; meta: RasterMeta };

function explain(error: unknown): string {
  return error instanceof Error ? error.message : 'The stored raster could not be read.';
}

function useRaster(scanId: string | null, layer: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    if (!scanId) {
      setState({ status: 'failed', error: 'Select a persisted scan.' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    void api
      .get<RasterMeta>(`/api/scans/${encodeURIComponent(scanId)}/raster/${encodeURIComponent(layer)}`)
      .then((meta) => {
        if (!active) return;
        if (!meta || meta.scan_id !== scanId || meta.layer !== layer || !meta.render?.rendered_shape) {
          setState({ status: 'failed', error: 'The raster response did not match the selected scan.' });
          return;
        }
        setState({ status: 'ready', meta });
      })
      .catch((error: unknown) => {
        if (active) setState({ status: 'failed', error: explain(error) });
      });
    return () => {
      active = false;
    };
  }, [scanId, layer]);

  return state;
}

const LAYERS = ['raw', 'normalized', 'filtered', 'cfar'] as const;

export function ScanComparePane({ scanId, onClose }: { scanId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<ScanEntry[]>([]);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [otherId, setOtherId] = useState<string>('');
  const [layer, setLayer] = useState<(typeof LAYERS)[number]>('raw');
  const [zoom, setZoom] = useState(1);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void api.get<ScanCatalogue>('/api/scans?limit=200').then((result) => {
      if (!active) return;
      const verified = Array.isArray(result.scans)
        ? result.scans.filter((scan) => scan.runtime_mode === 'REAL' && scan.synthetic === false)
        : [];
      setCatalogue(verified);
      setOtherId((current) => verified.some((scan) => scan.scan_id === current)
        ? current
        : verified.find((scan) => scan.scan_id !== scanId)?.scan_id ?? '');
    }).catch((error: unknown) => {
      if (active) setCatalogueError(explain(error));
    });
    return () => { active = false; };
  }, [scanId]);

  const left = useRaster(scanId, layer);
  const right = useRaster(otherId || null, layer);
  const leftScene = left.status === 'ready' ? left.meta.scene : null;
  const rightScene = right.status === 'ready' ? right.meta.scene : null;
  const interval = useMemo(() => {
    const first = Date.parse(leftScene?.acquisition_time ?? '');
    const second = Date.parse(rightScene?.acquisition_time ?? '');
    if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
    return Math.abs(second - first) / 3_600_000;
  }, [leftScene?.acquisition_time, rightScene?.acquisition_time]);

  const match = left.status === 'ready' && right.status === 'ready'
    && left.meta.crs === right.meta.crs
    && JSON.stringify(left.meta.transform) === JSON.stringify(right.meta.transform)
    && JSON.stringify(left.meta.render.rendered_shape) === JSON.stringify(right.meta.render.rendered_shape);

  function linkScroll(source: 'left' | 'right'): void {
    const from = source === 'left' ? leftRef.current : rightRef.current;
    const to = source === 'left' ? rightRef.current : leftRef.current;
    if (!from || !to) return;
    // Mirror normalized viewport progress, which works even when the two source
    // rasters have different pixel dimensions. No geographic alignment is claimed.
    const xRange = from.scrollWidth - from.clientWidth;
    const yRange = from.scrollHeight - from.clientHeight;
    const xTo = to.scrollWidth - to.clientWidth;
    const yTo = to.scrollHeight - to.clientHeight;
    const x = xRange > 0 ? from.scrollLeft / xRange : 0;
    const y = yRange > 0 ? from.scrollTop / yRange : 0;
    if (Math.abs(to.scrollLeft - x * xTo) > 1) to.scrollLeft = x * xTo;
    if (Math.abs(to.scrollTop - y * yTo) > 1) to.scrollTop = y * yTo;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-df-sar-comparison>
      <div className="flex flex-wrap items-center gap-2 border-b border-structural/40 px-3 py-2">
        <span className="df-label">Compare persisted SAR acquisitions</span>
        <label className="df-note ml-auto" htmlFor="df-sar-compare-layer">Raster</label>
        <select id="df-sar-compare-layer" className="df-btn" value={layer}
          onChange={(e) => setLayer(e.target.value as typeof layer)}>
          {LAYERS.map((id) => <option key={id} value={id}>{id.toUpperCase()}</option>)}
        </select>
        <button type="button" className="df-btn" onClick={() => setZoom((z) => Math.max(1, z / 1.4))}>−</button>
        <span className="df-mono text-[10px]" data-df-compare-zoom>{zoom.toFixed(2)}×</span>
        <button type="button" className="df-btn" onClick={() => setZoom((z) => Math.min(6, z * 1.4))}>+</button>
        <button type="button" className="df-btn" onClick={onClose}>RETURN TO ANALYTICS</button>
      </div>
      <div className="grid grid-cols-2 gap-2 border-b border-structural/40 px-3 py-2 text-[11px]">
        <span className="df-mono">CURRENT · {scanId}</span>
        <label className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">COMPARE WITH</span>
          <select aria-label="Comparison scan" className="df-btn min-w-0 flex-1" value={otherId}
            onChange={(e) => setOtherId(e.target.value)}>
            <option value="">Choose a saved acquisition</option>
            {catalogue.filter((record) => record.scan_id !== scanId).map((record) => (
              <option value={record.scan_id} key={record.scan_id}>
                {record.scan_id} · {record.acquisition_time ?? 'time unavailable'}
              </option>
            ))}
          </select>
        </label>
      </div>
      {catalogueError ? <p role="alert" className="df-note p-2">Scan catalogue unavailable: {catalogueError}</p> : null}
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-structural/50">
        <RasterColumn label="Current scan" scanId={scanId} layer={layer} state={left}
          zoom={zoom} scrollRef={leftRef} onScroll={() => linkScroll('left')} />
        <RasterColumn label="Comparison scan" scanId={otherId} layer={layer} state={right}
          zoom={zoom} scrollRef={rightRef} onScroll={() => linkScroll('right')} />
      </div>
      <div className="border-t border-structural/40 px-3 py-2 text-[11px]" data-df-compare-integrity>
        <p>{interval === null ? 'Acquisition time interval not established.' : `Acquisitions are ${interval.toFixed(2)} hours apart (recorded scene timestamps).`}</p>
        <p>{match
          ? 'Raster CRS, transform and rendered dimensions match; scientific change detection still requires calibrated source alignment.'
          : 'Raster grids are not established as identical. Scroll and zoom are linked for visual inspection only; pixels and targets are not co-registered or differenced.'}</p>
      </div>
    </div>
  );
}

function RasterColumn({ label, scanId, layer, state, zoom, scrollRef, onScroll }: {
  label: string;
  scanId: string;
  layer: string;
  state: LoadState;
  zoom: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}) {
  const scene = state.status === 'ready' ? state.meta.scene : null;
  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-raised/40" data-df-compare-scan={scanId}>
      <div className="border-b border-structural/30 p-2 text-[10px]">
        <div className="df-label">{label} · {scanId || 'none'}</div>
        {scene ? (
          <div className="df-mono text-ink-dim">
            <span>{scene.item_id ?? 'Scene ID unavailable'}</span>
            <span> · {fmtInstant(scene.acquisition_time ?? '')}</span>
            <span> · {scene.product ?? '?'} / {scene.polarization ?? '?'}</span>
            <span> · {scene.provider ?? 'provider unavailable'}</span>
          </div>
        ) : null}
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="df-scroll relative min-h-0 flex-1 overflow-auto">
        {state.status === 'loading' ? <p className="df-note p-3">Loading stored raster metadata…</p> : null}
        {state.status === 'failed' ? <p role="status" className="df-note p-3">{state.error}</p> : null}
        {state.status === 'ready' ? (
          <img
            key={`${scanId}:${layer}`}
            src={`/api/scans/${encodeURIComponent(scanId)}/raster/${encodeURIComponent(layer)}/image`}
            alt={`${label}: ${layer} SAR raster from scan ${scanId}`}
            draggable={false}
            className="block h-auto object-contain"
            style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
          />
        ) : null}
      </div>
    </section>
  );
}
