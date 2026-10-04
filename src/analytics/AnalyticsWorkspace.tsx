/**
 * SAR Analytics workspace (DF-X6C).
 *
 * The operator-facing radar-analysis surface. Every artifact here is a real
 * backend product: the rasters are server-rendered from the same cached arrays
 * the detections were computed from, and the tables carry the per-target rows the
 * backend serves.
 *
 * WHAT THIS SURFACE IS NOT
 *
 * It is not a second SAR implementation. It does not threshold, does not find
 * connected components, does not compute centroids, and -- critically -- does not
 * convert a pixel into a coordinate. `NORMALIZED`, `FILTERED` and `CFAR` are
 * names of pipeline products, so they are fetched as artifacts; a browser filter
 * that borrowed one of those names would be a lie about what it is showing.
 *
 * The one thing the browser DOES compute is the display-to-analytical pixel
 * mapping (`pixelMapping.ts`), and even that stops at row/col.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { loadArrayLayer, loadTableLayer, tableColumns, tableRows, rowWindowLabel, layerNotes, cellText, cellIsMeasured, type LayerState, type TableRow } from '../api/debug';
import { DEBUG_LAYERS, LAYER_LABELS, RASTER_LAYERS, inPipelineOrder, isRasterLayer, type DebugLayerId, type RasterLayerId } from '../api/debugLayers';
import { usePixelProbe } from '../api/usePixelProbe';
import { loadRaster } from '../api/client';
import {
  analyticalToScreen,
  fitScale,
  isInsideRaster,
  readGeometry,
  screenToAnalytical,
  type AnalyticalPixel,
  type RasterGeometry,
} from './pixelMapping';
import { store, useStore, type SarTarget } from '../state/store';
import { CfarLab } from './CfarLab';
import { DetectorProvenance } from './DetectorProvenance';
import { NOT_ESTABLISHED } from '../design/format';

const TABLE_ROW_LIMIT = 200;

export function AnalyticsWorkspace() {
  const state = useStore();
  const scanId = state.scanId;

  if (!scanId) {
    return <NoScan />;
  }
  return <ScanAnalytics scanId={scanId} targets={state.targets} />;
}

/* ------------------------------------------------------------- no scan yet */

function NoScan() {
  const stage = useStore().scanStage;
  const inFlight = stage !== 'COMPLETE' && stage !== 'FAILED' && stage !== 'QUEUED';
  return (
    <section className="df-panel h-full overflow-y-auto" data-df-workspace="ANALYTICS">
      <header className="df-panel-head">
        <span className="df-label">SAR analytics</span>
      </header>
      <div className="p-4">
        <p className="df-label text-[11px]" data-df-analytics-empty>
          {inFlight ? 'ANALYSIS IN PROGRESS' : 'NO ANALYSIS SELECTED'}
        </p>
        <p className="df-note mt-1">
          {inFlight
            ? `Waiting for the pipeline to reach COMPLETE. Debug layers are written at COMPLETE, so there is nothing to inspect yet.`
            : 'Run a SAR analysis, or select an existing scan, to inspect the pipeline.'}
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ the workspace */

function ScanAnalytics({ scanId, targets }: { scanId: string; targets: SarTarget[] }) {
  const [layer, setLayer] = useState<DebugLayerId>('raw');
  const [states, setStates] = useState<Record<string, LayerState>>({});
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const probe = usePixelProbe(scanId);
  const selection = useStore().selection;

  /**
   * Which target has been followed into this workspace.
   *
   * Reset by the scan-change effect below, and that ordering is load-bearing.
   * Under StrictMode the effects run twice on mount: without the reset, the first
   * pass follows the target and sets this ref, `probe.clear()` wipes the readout
   * on the second pass, and the follow is then skipped because the ref says it
   * already happened. The result is a target selected elsewhere, shown in the
   * chip, with "NO PROBE" underneath it and no error anywhere.
   */
  const followedRef = useRef<string | null>(null);

  const ordered = useMemo(() => inPipelineOrder([...DEBUG_LAYERS]), []);
  const active = states[layer] ?? { status: 'idle' as const };

  /**
   * The selected target id.
   *
   * The STORE's selection wins over anything local. The store is the single
   * shared reference the whole product selects through, so a target picked on the
   * globe or in the contact list has to light up here -- through the same
   * reference, not a second mechanism that could disagree with it. A local focus
   * is only the fallback for when nothing is selected globally.
   */
  const selectedId = selection.kind === 'target' ? selection.targetId : focusedRow;

  const selectedTarget = useMemo(
    () => targets.find((t) => t.id === selectedId) ?? null,
    [targets, selectedId],
  );

  // Per-layer caching. Scan artifacts are immutable once written, so a layer that
  // has loaded never needs reloading, and one layer failing must not blank the
  // others.
  const request = useCallback(
    (target: DebugLayerId) => {
      setStates((prev) => {
        if (prev[target] && prev[target].status !== 'idle') return prev;
        return { ...prev, [target]: { status: 'loading' } };
      });
      const load = isRasterLayer(target)
        ? loadArrayLayer(scanId, target)
        : loadTableLayer(scanId, target, TABLE_ROW_LIMIT);
      void load.then((next) => {
        setStates((prev) => ({ ...prev, [target]: next }));
      });
    },
    [scanId],
  );

  useEffect(() => {
    request(layer);
  }, [layer, request]);

  // A new scan invalidates every cached layer and any locked probe: the artefacts
  // belong to a different raster now.
  useEffect(() => {
    setStates({});
    setFocusedRow(null);
    // Reset before clearing, so the follow effect below gets its turn again.
    followedRef.current = null;
    probe.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- probe.clear is stable
  }, [scanId]);

  const handleRowSelect = useCallback(
    (row: TableRow) => {
      const targetId = row.target_id;
      if (typeof targetId !== 'string') return;
      setFocusedRow(targetId);
      // Analytics -> target. Only through the authoritative id; the alternative
      // would be nearest-point matching in the browser, which manufactures a
      // relation the backend never asserted.
      store.select({ kind: 'target', targetId, scanId: store.getState().scanId });
      // A centroid row carries the pixel anchor, so lock the probe on it and the
      // coordinate comes from the backend like any other.
      if (typeof row.pixel_row === 'number' && typeof row.pixel_col === 'number') {
        probe.lock({ row: row.pixel_row, col: row.pixel_col });
      }
    },
    [probe],
  );

  /**
   * A target selected elsewhere follows the analyst into this workspace.
   *
   * Selecting DF-002 on the globe and then opening ANALYTICS must show WHERE that
   * detection is, not an unhighlighted raster. The centroid comes from the
   * target record, and the coordinate from the backend probe, so the link is the
   * authoritative one in both directions.
   *
   * Refused rather than approximated: a target with no centroid has no analytical
   * position, and the probe readout says so instead of the surface implying one.
   */
  useEffect(() => {
    if (selection.kind !== 'target') {
      followedRef.current = null;
      return;
    }
    if (followedRef.current === selection.targetId) return;
    const centroid = targets.find((t) => t.id === selection.targetId)?.geoPixelCentroid;
    // Record the id ONLY once the follow actually happened. Marking it before
    // this check would mean the first render -- which can precede the targets
    // arriving -- consumed the one attempt and never retried, leaving a target
    // selected elsewhere with no analytical position shown and no error.
    if (!centroid) return;
    followedRef.current = selection.targetId;
    probe.lock({ row: centroid[1], col: centroid[0] });
  }, [selection, targets, probe]);

  return (
    <section
      className="df-panel flex h-full min-h-0 flex-col overflow-hidden"
      data-df-workspace="ANALYTICS"
    >
      <header className="df-panel-head flex shrink-0 items-center justify-between gap-2">
        <span className="df-label">SAR analytics</span>
        <span className="df-mono text-[10px] text-ink-dim">{scanId}</span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Pipeline navigation */}
        <nav
          className="df-scroll w-[132px] shrink-0 overflow-y-auto border-r border-structural/40"
          aria-label="Pipeline stages"
          data-df-analytics-layers
        >
          {ordered.map((id) => {
            const state = states[id];
            return (
              <button
                key={id}
                type="button"
                className="df-btn w-full justify-start rounded-none border-b border-structural/20 text-left"
                aria-current={layer === id ? 'true' : undefined}
                data-df-layer={id}
                data-df-layer-state={state?.status ?? 'idle'}
                onClick={() => setLayer(id)}
              >
                <span className="truncate">{LAYER_LABELS[id]}</span>
                <LayerDot state={state} />
              </button>
            );
          })}
        </nav>

        {/* The analytical surface */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {isRasterLayer(layer) ? (
              <RasterPane
                scanId={scanId}
                layer={layer}
                state={active}
                targets={targets}
                selectedTargetId={selectedId}
                onTargetSelect={setFocusedRow}
                probe={probe}
              />
            ) : (
              <TablePane
                layer={layer}
                state={active}
                selectedRow={selectedId}
                onSelect={handleRowSelect}
              />
            )}
          </div>

          <TargetChip target={selectedTarget} />

          <ProbeReadout state={probe.state} hovered={probe.hovered} />

          {/* Fixed height. Left to its content this row grew until the raster
              above it had no space at all, which is how an analysis surface ends
              up showing a strip of controls and no imagery. Sized so CURRENT RUN
              and at least one complete row of PROPOSED inputs are visible without
              scrolling. */}
          <div
            className="flex h-[210px] shrink-0 border-t border-structural/40"
            data-df-analytics-footer
          >
            <CfarLab scanId={scanId} />
            <DetectorProvenance />
          </div>
        </div>
      </div>
    </section>
  );
}

function LayerDot({ state }: { state: LayerState | undefined }) {
  const status = state?.status ?? 'idle';
  const colour =
    status === 'ready'
      ? 'var(--df-green)'
      : status === 'failed'
        ? 'var(--df-red)'
        : status === 'loading'
          ? 'var(--df-amber)'
          : 'var(--df-ink-dim)';
  return (
    <span
      aria-hidden="true"
      className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: colour }}
    />
  );
}

/* --------------------------------------------------------------- raster pane */

function RasterPane({
  scanId,
  layer,
  state,
  targets,
  selectedTargetId,
  onTargetSelect,
  probe,
}: {
  scanId: string;
  layer: RasterLayerId;
  state: LayerState;
  targets: SarTarget[];
  selectedTargetId: string | null;
  onTargetSelect: (id: string | null) => void;
  probe: ReturnType<typeof usePixelProbe>;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [geometry, setGeometry] = useState<RasterGeometry | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [opacity, setOpacity] = useState(1);

  // The frame's own rect, tracked continuously rather than sampled once.
  //
  // A rect captured at load time goes stale the moment the window resizes or the
  // workspace panel changes width, and a stale rect maps clicks to the wrong
  // analytical pixel -- silently, because the arithmetic still succeeds. A
  // ResizeObserver keeps the pointer mapping honest for the life of the pane.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setRect(frame.getBoundingClientRect());
    });
    observer.observe(frame);
    setRect(frame.getBoundingClientRect());
    return () => observer.disconnect();
  }, []);

  // The raster metadata: analytical shape, rendered shape, downsample. All three
  // are needed for the pixel mapping; assuming any of them is 1:1 is the defect.
  useEffect(() => {
    let cancelled = false;
    void loadRaster(scanId, layer);
    return () => {
      cancelled = true;
    };
  }, [scanId, layer]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/scans/${scanId}/raster/${layer}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (cancelled) return;
        const next = readGeometry(body);
        if (next) setGeometry(next);
      })
      .catch(() => {
        /* A layer with no readable geometry simply has no probe target. */
      });
    return () => {
      cancelled = true;
    };
  }, [scanId, layer]);

  /**
   * FIT: scale so the whole rendered image is visible, and CENTRE it.
   *
   * Centring matters as much as the scale. Zoom alone leaves the image pinned to
   * the container's top-left corner, so most of the frame is letterbox and a
   * click in the middle of the visible area resolves to no pixel at all.
   */
  const fit = useCallback(() => {
    const frame = frameRef.current;
    const box = rect ?? frame?.getBoundingClientRect() ?? null;
    if (!geometry || !box) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    const [renderedRows, renderedCols] = geometry.renderedShape;
    const scale = fitScale(geometry, box.width, box.height);
    setZoom(scale);
    setPan({
      x: Math.max(0, (box.width - renderedCols * scale) / 2),
      y: Math.max(0, (box.height - renderedRows * scale) / 2),
    });
  }, [geometry, rect]);

  // Fit as soon as both the geometry and a measured frame exist, so the first
  // thing an operator sees is the whole raster rather than one corner of it.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!geometry || !rect || rect.width === 0) return;
    const key = `${scanId}:${layer}:${Math.round(rect.width)}x${Math.round(rect.height)}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    fit();
  }, [geometry, rect, scanId, layer, fit]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!rect || !geometry) return;
      const pixel = screenToAnalytical(
        { clientX: event.clientX, clientY: event.clientY },
        { left: rect.left, top: rect.top },
        { scale: zoom, offsetX: pan.x, offsetY: pan.y, containerWidth: rect.width, containerHeight: rect.height },
        geometry,
      );
      probe.hover(pixel);
    },
    [rect, geometry, zoom, pan, probe],
  );

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!rect || !geometry) return;
      const pixel = screenToAnalytical(
        { clientX: event.clientX, clientY: event.clientY },
        { left: rect.left, top: rect.top },
        { scale: zoom, offsetX: pan.x, offsetY: pan.y, containerWidth: rect.width, containerHeight: rect.height },
        geometry,
      );
      // No pixel (letterbox, or past the edge) is not a probe. The backend
      // refuses out-of-bounds pixels too; this stops us asking at all.
      if (!pixel || !isInsideRaster(pixel, geometry)) return;
      probe.lock(pixel);
    },
    [rect, geometry, zoom, pan, probe],
  );

  const markers = useMemo(() => {
    if (!geometry) return [];
    return targets
      .filter((t) => t.geoPixelCentroid !== null)
      .map((t) => {
        const [col, row] = t.geoPixelCentroid as [number, number];
        const pixel: AnalyticalPixel = { row, col };
        const point = analyticalToScreen(
          pixel,
          { scale: zoom, offsetX: pan.x, offsetY: pan.y, containerWidth: rect?.width ?? 0, containerHeight: rect?.height ?? 0 },
          geometry,
        );
        return { target: t, x: point.x, y: point.y };
      });
  }, [targets, geometry, zoom, pan, rect]);

  return (
    <div className="flex h-full flex-col" data-df-raster-pane={layer}>
      <div className="flex items-center gap-2 border-b border-structural/40 px-2 py-1">
        <button type="button" className="df-btn" onClick={fit} data-df-raster-fit>
          FIT
        </button>
        <button
          type="button"
          className="df-btn"
          onClick={() => setZoom((z) => Math.min(z * 1.5, 16))}
          data-df-raster-zoom-in
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="df-btn"
          onClick={() => setZoom((z) => Math.max(z / 1.5, 1 / 16))}
          data-df-raster-zoom-out
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="df-mono text-[10px] text-ink-dim">{zoom.toFixed(2)}×</span>
        <label className="ml-2 flex items-center gap-1">
          <span className="df-label text-[10px]">OPACITY</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="w-20"
            aria-label="Display opacity"
          />
        </label>
        {geometry ? (
          <span className="df-mono ml-auto text-[10px] text-ink-dim" data-df-raster-shapes>
            {geometry.sourceShape[0]}×{geometry.sourceShape[1]} analytical /{' '}
            {geometry.renderedShape[0]}×{geometry.renderedShape[1]} rendered
          </span>
        ) : null}
      </div>

      <div
        ref={frameRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-void"
        onPointerMove={onPointerMove}
        onPointerLeave={() => probe.hover(null)}
        onClick={onClick}
        data-df-raster-frame
      >
        {state.status === 'loading' ? <PaneNote>Loading {LAYER_LABELS[layer]}…</PaneNote> : null}
        {state.status === 'failed' ? (
          <PaneNote tone="error">
            {LAYER_LABELS[layer].toUpperCase()} UNAVAILABLE — {state.detail}
          </PaneNote>
        ) : null}
        {state.status === 'ready' ? (
          <>
            <img
              src={`/api/scans/${scanId}/raster/${layer}/image?mode=stretch`}
              alt={`${LAYER_LABELS[layer]} raster`}
              className="absolute select-none"
              style={{
                left: pan.x,
                top: pan.y,
                transform: `scale(${zoom})`,
                transformOrigin: '0 0',
                opacity,
                imageRendering: zoom > 2 ? 'pixelated' : 'auto',
              }}
              draggable={false}
              data-df-raster-image
            />
            <svg className="pointer-events-none absolute inset-0 h-full w-full">
              {markers.map(({ target, x, y }) => {
                const selected = target.id === selectedTargetId;
                return (
                  <g key={target.id} data-df-centroid-marker={target.id}>
                    <rect
                      x={x - 4}
                      y={y - 4}
                      width={8}
                      height={8}
                      fill="none"
                      stroke={selected ? 'var(--df-cyan)' : 'var(--df-amber)'}
                      strokeWidth={selected ? 2 : 1}
                    />
                    <circle cx={x} cy={y} r={1.5} fill={selected ? 'var(--df-cyan)' : 'var(--df-amber)'} />
                  </g>
                );
              })}
            </svg>
          </>
        ) : null}
      </div>

      {state.status === 'ready' ? <ArrayStats state={state} /> : null}

      <div className="shrink-0 border-t border-structural/40 px-2 py-1">
        <p className="df-note text-[10px]">
          Click to probe. Hover shows the pixel address only. Coordinates come from the
          backend.
        </p>
      </div>
    </div>
  );
}

function PaneNote({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <p
      className="df-note p-3 text-[11px]"
      style={tone === 'error' ? { color: 'var(--df-red)' } : undefined}
      role={tone === 'error' ? 'alert' : undefined}
      data-df-raster-note={tone ?? 'info'}
    >
      {children}
    </p>
  );
}

function ArrayStats({ state }: { state: LayerState }) {
  if (state.status !== 'ready') return null;
  const stats = state.data.stats;
  if (!stats) return null;
  const entries: Array<[string, string]> = [
    ['size', String(stats.size ?? '—')],
    ['min', fmtNum(stats.min)],
    ['max', fmtNum(stats.max)],
    ['mean', fmtNum(stats.mean)],
    ['p01', fmtNum(stats.p01)],
    ['p99', fmtNum(stats.p99)],
  ];
  if (typeof stats.true_count === 'number') {
    entries.push(['true px', String(stats.true_count)]);
  }
  return (
    <div className="shrink-0 border-t border-structural/40 px-2 py-1" data-df-raster-stats>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {entries.map(([k, v]) => (
          <span key={k} className="df-num text-[10px] text-ink-2">
            {k} {v}
          </span>
        ))}
      </div>
      <LayerNotes state={state} />
    </div>
  );
}

function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/* --------------------------------------------------------------- table pane */

function TablePane({
  layer,
  state,
  selectedRow,
  onSelect,
}: {
  layer: DebugLayerId;
  state: LayerState;
  selectedRow: string | null;
  onSelect: (row: TableRow) => void;
}) {
  const columns = tableColumns(state);
  const rows = tableRows(state);
  const window = rowWindowLabel(state);

  return (
    <div className="df-scroll h-full overflow-auto" data-df-table-pane={layer}>
      <div className="flex items-center gap-2 border-b border-structural/40 px-2 py-1">
        <span className="df-label text-[10px]">{LAYER_LABELS[layer]}</span>
        {window ? (
          <span
            className="df-mono text-[10px]"
            style={state.status === 'ready' && state.data.truncated ? { color: 'var(--df-amber)' } : undefined}
            data-df-table-window
          >
            {window}
          </span>
        ) : null}
      </div>

      {state.status === 'loading' ? <PaneNote>Loading {LAYER_LABELS[layer]}…</PaneNote> : null}
      {state.status === 'failed' ? (
        <PaneNote tone="error">
          {LAYER_LABELS[layer].toUpperCase()} UNAVAILABLE — {state.detail}
        </PaneNote>
      ) : null}

      {state.status === 'ready' && rows.length === 0 ? (
        <PaneNote>
          This layer is EMPTY. That is a measurement — the pipeline produced no rows — and it
          is not the same as the layer being unavailable.
        </PaneNote>
      ) : null}

      {rows.length > 0 ? (
        <table className="w-full text-[10px]" data-df-table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} className="df-label border-b border-structural/40 px-2 py-1 text-left">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const key = String(row.target_id ?? i);
              const selected = key === selectedRow;
              const selectable = typeof row.target_id === 'string';
              return (
                <tr
                  key={key}
                  data-df-table-row={key}
                  aria-selected={selected}
                  tabIndex={selectable ? 0 : -1}
                  className={selectable ? 'cursor-pointer hover:bg-raised/40' : ''}
                  style={selected ? { background: 'var(--df-raised)' } : undefined}
                  onClick={() => selectable && onSelect(row)}
                  onKeyDown={(e) => {
                    if (selectable && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onSelect(row);
                    }
                  }}
                >
                  {columns.map((c) => {
                    const value = row[c];
                    return (
                      <td
                        key={c}
                        className="df-num px-2 py-0.5"
                        style={cellIsMeasured(value) ? undefined : { color: 'var(--df-ink-dim)' }}
                      >
                        {cellText(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      <LayerNotes state={state} />
    </div>
  );
}

function LayerNotes({ state }: { state: LayerState }) {
  const notes = layerNotes(state);
  if (notes.length === 0) return null;
  return (
    <details className="border-t border-structural/40 px-2 py-1" data-df-layer-notes>
      <summary className="df-label cursor-pointer text-[10px]">PROVENANCE ({notes.length})</summary>
      <ul className="mt-1 space-y-0.5">
        {notes.map((note) => (
          <li key={note} className="text-[10px] leading-relaxed text-ink-dim">
            · {note}
          </li>
        ))}
      </ul>
    </details>
  );
}

/* -------------------------------------------------------------- target chip */

/**
 * What is selected, and whether it can be placed analytically.
 *
 * Two requirements pull against each other here. The operator needs context
 * about the detection they just picked; and the chip must not imply a
 * raster-to-target link that does not exist. So every figure is one the backend
 * supplied, and the absence of an analytical anchor is stated in words rather than
 * left as an empty field.
 *
 * `sarConf` and `aisConf` are reported separately and never summed. A combined
 * "confidence" would be a number this product cannot derive.
 */
function TargetChip({ target }: { target: SarTarget | null }) {
  return (
    <div
      className="shrink-0 border-t border-structural/40 px-2 py-1"
      data-df-target-chip={target?.id ?? 'none'}
    >
      {!target ? (
        <p className="df-mono text-[10px] text-ink-dim">NO TARGET SELECTED</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="df-mono text-[11px] text-ink-2" data-df-chip-id>
            {target.id}
          </span>
          <span className="df-mono text-[10px] text-ink-dim">
            {target.classification}
          </span>
          <span className="df-num text-[10px] text-ink-2">
            SAR {target.sarConf.toFixed(2)} · AIS {target.aisConf.toFixed(2)}
          </span>
          {target.geoPixelCentroid ? (
            <span className="df-num text-[10px] text-ink-2" data-df-chip-centroid>
              CENTROID {target.geoPixelCentroid[1].toFixed(3)},{' '}
              {target.geoPixelCentroid[0].toFixed(3)}
            </span>
          ) : (
            <span
              className="df-mono text-[10px]"
              style={{ color: 'var(--df-amber)' }}
              data-df-chip-no-link
            >
              ANALYTICAL COMPONENT LINK NOT ESTABLISHED
            </span>
          )}
          {target.mmsi ? (
            <span className="df-mono text-[10px] text-ink-dim">MMSI {target.mmsi}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ probe readout */

function ProbeReadout({
  state,
  hovered,
}: {
  state: ReturnType<typeof usePixelProbe>['state'];
  hovered: AnalyticalPixel | null;
}) {
  return (
    <div
      className="shrink-0 border-t border-structural/40 px-2 py-1"
      data-df-probe-readout
      aria-live="polite"
    >
      {state.status === 'ready' ? (
        <ProbeFields
          pixel={state.pixel}
          lat={state.result.wgs84_lat}
          lon={state.result.wgs84_lon}
          crs={state.result.source.crs}
          x={state.result.source.x}
          y={state.result.source.y}
          convention={state.result.pixel.convention ?? 'UNSTATED'}
          offset={
            state.result.pixel.centre_offset === undefined
              ? 'UNSTATED'
              : state.result.pixel.centre_offset.toFixed(3)
          }
          width={state.result.georeferencing.raster_width}
          height={state.result.georeferencing.raster_height}
        />
      ) : state.status === 'pending' ? (
        <p className="df-mono text-[10px] text-amber-ink">
          PROBING row {state.pixel.row.toFixed(3)} col {state.pixel.col.toFixed(3)}…
        </p>
      ) : state.status === 'refused' ? (
        <p className="df-mono text-[10px]" style={{ color: 'var(--df-amber)' }} role="alert">
          PROBE REFUSED — {state.reason} No coordinate is shown.
        </p>
      ) : hovered ? (
        <p className="df-mono text-[10px] text-ink-dim">
          HOVER row {hovered.row.toFixed(3)} col {hovered.col.toFixed(3)} — click to probe
        </p>
      ) : (
        <p className="df-mono text-[10px] text-ink-dim">NO PROBE</p>
      )}
    </div>
  );
}

function ProbeFields({
  pixel,
  lat,
  lon,
  crs,
  x,
  y,
  convention,
  offset,
  width,
  height,
}: {
  pixel: AnalyticalPixel;
  lat: number;
  lon: number;
  crs: string;
  x: number;
  y: number;
  convention: string;
  /** Already formatted: the backend may state no offset, and an absent offset
   *  must read as absent rather than as a number nobody applied. */
  offset: string;
  width: number;
  height: number;
}) {
  const fields: Array<[string, string]> = [
    ['ROW', pixel.row.toFixed(4)],
    ['COL', pixel.col.toFixed(4)],
    ['X', x.toFixed(2)],
    ['Y', y.toFixed(2)],
    ['LAT', lat.toFixed(6)],
    ['LON', lon.toFixed(6)],
    ['CRS', crs],
    ['CONVENTION', `${convention} (offset ${offset})`],
    ['RASTER', `${width}×${height}`],
  ];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
      {fields.map(([k, v]) => (
        <span key={k} className="df-num text-[10px] text-ink-2" data-df-probe-field={k}>
          {k} {v}
        </span>
      ))}
    </div>
  );
}

export { NOT_ESTABLISHED };