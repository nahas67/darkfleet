/**
 * Analysis workbench — the specialist SAR analysis surface (UI-015, UI-016, UI-017).
 *
 * This is NOT the product homepage. The shell (`src/app/SpatialShell.tsx`) owns
 * the globe; this surface owns the analyst's controls, and it exists because a
 * Cesium globe has no equivalent of the interactions the legacy 2-D viewport had.
 *
 * Ported from `src/components/TacticalMap.tsx` (capabilities Cesium cannot
 * reproduce here) — AOI box select, backscatter dB cursor probe, the three
 * raster colormaps and three heatmap palettes with opacity, a labelled lat/lon
 * graticule, a nautical-mile scale bar, and a per-cell dB readout.
 *
 * Extended from `src/components/CFARWorkbench.tsx`, which was missing the
 * min/max component size, kernel size and the speckle `lee` mode. All eight
 * request parameters are here now, and every edit raises an explicit "this change
 * requires recomputation" signal listing the exact keys that moved.
 *
 * Hard rules:
 *  - NO detector maths client-side (API-011). This surface renders backend
 *    output and collects parameters. Recompute is a backend job; the button here
 *    only asks for it. Colour maths and screen geometry are presentation, not
 *    analysis.
 *  - Never fabricate raster statistics. If the endpoint returned nothing, the
 *    surface says the backend returned nothing.
 *  - Layers the backend does not serve render as explicitly unavailable.
 *
 * Rendering is deliberately DOM-light so it is testable without jsdom: the
 * geometry, colour, diffing and handler code is exported as pure functions, and
 * the interaction surfaces are bound through handler factories — the pattern
 * `src/app/state.ts` and `src/search/SpatialSearch.tsx` already use.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BoxSelect, Crosshair, Flame, RefreshCw, Ruler, TriangleAlert } from 'lucide-react';
import type { BoundingBox, DebugLayerId } from '../types/api.ts';
import { createApiClient } from '../app/useApi.ts';
import type { ApiClient } from '../app/useApi.ts';
import {
  CFAR_PARAM_KEYS,
  CFAR_PARAM_SPECS,
  CFAR_PRESETS,
  DEFAULT_CFAR_CONFIG,
  SPECKLE_MODE_LABELS,
  SPECKLE_MODES,
  applyPreset,
  diffConfig,
  formatParam,
  isSpeckleMode,
  parseParamInput,
  recomputeDiff,
  updateParam,
} from './cfar.ts';
import type { CfarConfig, CfarConfigKey, SpeckleMode } from './cfar.ts';
import { DEBUG_LAYER_DEFS, debugLayerView, isDebugEnabled } from './debugLayers.ts';
import type { DebugLayerDef, DebugLayerView } from './debugLayers.ts';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]';

// =========================================================== display palette

/** Raster colour ramps for the backscatter grid (legacy `rasterColorMode`). */
export type RasterColormap = 'radar-green' | 'grayscale' | 'night-flir';

/** Pseudocolour heatmap palettes (legacy `heatmapPalette`). */
export type HeatmapPalette = 'thermal' | 'turbo' | 'plasma';

export const RASTER_COLORMAPS: readonly RasterColormap[] = [
  'radar-green',
  'grayscale',
  'night-flir',
] as const;

export const HEATMAP_PALETTES: readonly HeatmapPalette[] = ['thermal', 'turbo', 'plasma'] as const;

export const RASTER_COLORMAP_LABELS: Readonly<Record<RasterColormap, string>> = {
  'radar-green': 'Radar green',
  grayscale: 'Grayscale',
  'night-flir': 'Night FLIR',
};

export const HEATMAP_PALETTE_LABELS: Readonly<Record<HeatmapPalette, string>> = {
  thermal: 'Thermal',
  turbo: 'Turbo',
  plasma: 'Plasma',
};

/**
 * Display window carried over from the legacy viewport: -28 dB speckle floor to
 * +5 dB hull peak. This maps a value onto a colour; it is NOT calibration and it
 * feeds no threshold.
 */
export const DB_DISPLAY_MIN = -28;
export const DB_DISPLAY_MAX = 5;

export function isRasterColormap(value: unknown): value is RasterColormap {
  return typeof value === 'string' && (RASTER_COLORMAPS as readonly string[]).includes(value);
}

export function isHeatmapPalette(value: unknown): value is HeatmapPalette {
  return typeof value === 'string' && (HEATMAP_PALETTES as readonly string[]).includes(value);
}

/** Clamp a dB value into 0..1 for display. Null when the value is not a number. */
export function normalizeDisplayDb(db: unknown): number | null {
  if (typeof db !== 'number' || !Number.isFinite(db)) return null;
  const t = (db - DB_DISPLAY_MIN) / (DB_DISPLAY_MAX - DB_DISPLAY_MIN);
  return Math.max(0, Math.min(1, t));
}

/**
 * Heatmap colour ramp, ported from the legacy `getHeatmapRgb`. Presentation
 * only — no threshold is derived from a colour.
 */
export function heatmapRgb(t: number, palette: HeatmapPalette): [number, number, number] {
  const v = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));

  if (palette === 'plasma') {
    if (v < 0.25) {
      const f = v / 0.25;
      return [Math.round(15 + f * 95), Math.round(5 + f * 10), Math.round(80 + f * 85)];
    }
    if (v < 0.5) {
      const f = (v - 0.25) / 0.25;
      return [Math.round(110 + f * 90), Math.round(15 + f * 55), Math.round(165 - f * 85)];
    }
    if (v < 0.75) {
      const f = (v - 0.5) / 0.25;
      return [Math.round(200 + f * 45), Math.round(70 + f * 90), Math.round(80 * (1 - f))];
    }
    const f = (v - 0.75) / 0.25;
    return [Math.round(245 + f * 10), Math.round(160 + f * 95), Math.round(20 + f * 80)];
  }

  if (palette === 'turbo') {
    if (v < 0.2) {
      const f = v / 0.2;
      return [Math.round(30 * (1 - f)), Math.round(40 + f * 140), Math.round(160 + f * 95)];
    }
    if (v < 0.4) {
      const f = (v - 0.2) / 0.2;
      return [0, Math.round(180 + f * 60), Math.round(255 * (1 - f) + 50 * f)];
    }
    if (v < 0.65) {
      const f = (v - 0.4) / 0.25;
      return [Math.round(f * 240), Math.round(240 - f * 30), 0];
    }
    if (v < 0.85) {
      const f = (v - 0.65) / 0.2;
      return [Math.round(240 + f * 15), Math.round(210 * (1 - f) + 40 * f), 0];
    }
    const f = (v - 0.85) / 0.15;
    return [255, Math.round(40 * (1 - f)), Math.round(f * 50)];
  }

  if (v < 0.18) {
    const f = v / 0.18;
    return [Math.round(5 + f * 10), Math.round(20 + f * 150), Math.round(90 + f * 140)];
  }
  if (v < 0.42) {
    const f = (v - 0.18) / 0.24;
    return [Math.round(15 + f * 15), Math.round(170 + f * 75), Math.round(230 * (1 - f) + 60 * f)];
  }
  if (v < 0.68) {
    const f = (v - 0.42) / 0.26;
    return [Math.round(30 + f * 225), Math.round(245 - f * 35), Math.round(60 * (1 - f))];
  }
  if (v < 0.88) {
    const f = (v - 0.68) / 0.2;
    return [255, Math.round(210 * (1 - f) + 35 * f), Math.round(15 * f)];
  }
  const f = (v - 0.88) / 0.12;
  return [255, Math.round(35 + f * 220), Math.round(15 + f * 240)];
}

/** CSS colour for one raster cell under the selected colormap. */
export function rasterCellCss(db: unknown, colormap: RasterColormap): string {
  const norm = normalizeDisplayDb(db);
  // A non-finite cell is drawn as a dim red wash, never as a plausible value.
  if (norm === null) return 'rgba(255, 104, 104, 0.18)';
  const byte = Math.round(norm * 255);
  if (colormap === 'grayscale') return `rgb(${byte}, ${byte}, ${byte})`;
  if (colormap === 'night-flir') {
    return byte > 180
      ? `rgb(${byte}, ${Math.round(byte * 0.85)}, ${Math.round(byte * 0.95)})`
      : `rgb(${Math.round(byte * 0.1)}, ${Math.round(byte * 0.85)}, ${Math.round(byte * 0.95)})`;
  }
  return `rgb(${Math.round(byte * 0.15)}, ${Math.round(byte * 0.95)}, ${Math.round(byte * 0.45)})`;
}

/** Legend swatches for the raster colormap. Presentation only. */
export function colormapStops(colormap: RasterColormap): string[] {
  return [0, 0.25, 0.5, 0.75, 1].map((t) =>
    rasterCellCss(DB_DISPLAY_MIN + t * (DB_DISPLAY_MAX - DB_DISPLAY_MIN), colormap),
  );
}

/** Legend swatches for the heatmap palette. Presentation only. */
export function paletteStops(palette: HeatmapPalette): string[] {
  return [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => {
    const [r, g, b] = heatmapRgb(t, palette);
    return `rgb(${r}, ${g}, ${b})`;
  });
}

// ================================================================ geometry

export interface ViewportRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface DragRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Screen mapping for one AOI: a plain lon/lat -> pixel ramp, as in the legacy viewport. */
export interface MapViewport {
  readonly bbox: BoundingBox;
  readonly rect: ViewportRect;
  readonly padding: number;
  readonly zoom: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export const DEFAULT_VIEWPORT: Omit<MapViewport, 'bbox'> = {
  rect: { left: 0, top: 0, width: 640, height: 360 },
  padding: 30,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};

/** A bbox is usable only when it is four ordered, finite, in-range degrees. */
export function isUsableBbox(value: unknown): value is BoundingBox {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [minLon, minLat, maxLon, maxLat] = value as number[];
  if (![minLon, minLat, maxLon, maxLat].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return false;
  }
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) return false;
  return maxLon > minLon && maxLat > minLat;
}

export function makeViewport(
  bbox: BoundingBox,
  overrides: Partial<Omit<MapViewport, 'bbox'>> = {},
): MapViewport {
  return { ...DEFAULT_VIEWPORT, ...overrides, bbox };
}

/** A degenerate span divides by 1 so the ramp can never produce NaN. */
function safeSpan(max: number, min: number): number {
  const span = max - min;
  return span === 0 ? 1 : span;
}

export function geoToCanvas(view: MapViewport, lat: number, lon: number): CanvasPoint {
  const [minLon, minLat, maxLon, maxLat] = view.bbox;
  const usableW = Math.max(1, view.rect.width - view.padding * 2);
  const usableH = Math.max(1, view.rect.height - view.padding * 2);
  const x = view.padding + ((lon - minLon) / safeSpan(maxLon, minLon)) * usableW;
  const y = view.padding + ((maxLat - lat) / safeSpan(maxLat, minLat)) * usableH;
  const centerX = view.rect.width / 2;
  const centerY = view.rect.height / 2;
  return {
    x: centerX + (x - centerX + view.offsetX) * view.zoom,
    y: centerY + (y - centerY + view.offsetY) * view.zoom,
  };
}

export function canvasToGeo(
  view: MapViewport,
  screenX: number,
  screenY: number,
): { lat: number; lon: number; normX: number; normY: number } {
  const [minLon, minLat, maxLon, maxLat] = view.bbox;
  const centerX = view.rect.width / 2;
  const centerY = view.rect.height / 2;
  const unzoomedX = (screenX - centerX) / view.zoom + centerX - view.offsetX;
  const unzoomedY = (screenY - centerY) / view.zoom + centerY - view.offsetY;
  const usableW = Math.max(1, view.rect.width - view.padding * 2);
  const usableH = Math.max(1, view.rect.height - view.padding * 2);
  const normX = Math.max(0, Math.min(1, (unzoomedX - view.padding) / usableW));
  const normY = Math.max(0, Math.min(1, (unzoomedY - view.padding) / usableH));
  return {
    lat: maxLat - normY * safeSpan(maxLat, minLat),
    lon: minLon + normX * safeSpan(maxLon, minLon),
    normX,
    normY,
  };
}

export function rectFromPoints(a: CanvasPoint, b: CanvasPoint): DragRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** The lon/lat bbox of a screen-space drag, ordered `minLon,minLat,maxLon,maxLat`. */
export function bboxFromDrag(view: MapViewport, a: CanvasPoint, b: CanvasPoint): BoundingBox {
  const g1 = canvasToGeo(view, a.x, a.y);
  const g2 = canvasToGeo(view, b.x, b.y);
  return [
    Math.min(g1.lon, g2.lon),
    Math.min(g1.lat, g2.lat),
    Math.max(g1.lon, g2.lon),
    Math.max(g1.lat, g2.lat),
  ];
}

// ---------------------------------------------------------------- graticule

export interface GraticuleLine {
  readonly value: number;
  /** Pre-formatted label, e.g. `103.72 E`. Hemispheres are signed honestly. */
  readonly label: string;
}

export interface Graticule {
  readonly lons: readonly GraticuleLine[];
  readonly lats: readonly GraticuleLine[];
}

/** Labelled meridians and parallels across the AOI. */
export function graticule(bbox: BoundingBox, divisions = 8): Graticule {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lonSpan = safeSpan(maxLon, minLon);
  const latSpan = safeSpan(maxLat, minLat);
  const lons: GraticuleLine[] = [];
  const lats: GraticuleLine[] = [];
  for (let i = 0; i <= divisions; i += 1) {
    const lon = minLon + (i / divisions) * lonSpan;
    const lat = minLat + (i / divisions) * latSpan;
    lons.push({ value: lon, label: formatDegree(lon, 'lon') });
    lats.push({ value: lat, label: formatDegree(lat, 'lat') });
  }
  return { lons, lats };
}

/** `103.72 E` / `1.25 N` / `73.40 W` / `20.10 S`. */
export function formatDegree(value: number, axis: 'lon' | 'lat'): string {
  const hemisphere = value < 0 ? (axis === 'lon' ? 'W' : 'S') : axis === 'lon' ? 'E' : 'N';
  return `${Math.abs(value).toFixed(2)} ${hemisphere}`;
}

// ----------------------------------------------------------------- scale bar

export interface ScaleBar {
  readonly nauticalMiles: number;
  readonly meters: number;
  readonly pixels: number;
  readonly label: string;
}

export const METERS_PER_NAUTICAL_MILE = 1852;

/** Candidate scale-bar lengths in nautical miles, smallest first. */
export const SCALE_STEPS: readonly number[] = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];

/**
 * Nautical-mile scale bar for the AOI. The legacy bar divided degrees of
 * longitude by a flat 111320 m regardless of latitude; this one scales by the
 * metres-per-degree of longitude at the AOI centre latitude.
 */
export function scaleBar(view: MapViewport, targetPixels = 120): ScaleBar | null {
  const [minLon, minLat, maxLon, maxLat] = view.bbox;
  // A degenerate extent gets NO scale bar: a bar over a zero-width viewport would
  // be a fabricated distance.
  if (!(maxLon > minLon) || !(maxLat > minLat)) return null;
  const centerLat = (minLat + maxLat) / 2;
  const usableW = Math.max(1, view.rect.width - view.padding * 2);
  const metersPerLonDeg = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const lonSpanMeters = (maxLon - minLon) * metersPerLonDeg;
  if (!Number.isFinite(lonSpanMeters) || lonSpanMeters <= 0) return null;
  const pixelsPerMeter = usableW / lonSpanMeters;
  if (!Number.isFinite(pixelsPerMeter) || pixelsPerMeter <= 0) return null;

  let chosen = SCALE_STEPS[0];
  for (const step of SCALE_STEPS) {
    if (step * METERS_PER_NAUTICAL_MILE * pixelsPerMeter <= targetPixels) chosen = step;
  }
  const pixels = chosen * METERS_PER_NAUTICAL_MILE * pixelsPerMeter;
  if (!Number.isFinite(pixels) || pixels <= 0) return null;
  return {
    nauticalMiles: chosen,
    meters: chosen * METERS_PER_NAUTICAL_MILE,
    pixels,
    label: chosen >= 1 ? `${chosen} NM` : `${chosen.toFixed(2)} NM`,
  };
}

// --------------------------------------------------------------- dB probe

export interface RasterGrid {
  readonly rows: readonly (readonly number[])[];
}

export interface CursorReadout {
  readonly lat: number;
  readonly lon: number;
  /** Grid row under the cursor, or null when there is no raster / it missed. */
  readonly row: number | null;
  readonly col: number | null;
  /** The backend cell value in dB. Never interpolated, never invented. */
  readonly db: number | null;
}

export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
}

/** Screen-space pointer position relative to the viewport. */
export function cursorFromEvent(event: PointerLike, rect: ViewportRect): CanvasPoint {
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * The backscatter value under the cursor. Position is always reported; the dB
 * value is null whenever the cursor is off the grid, the grid is absent, or the
 * cell is not a finite number. Nothing is extrapolated or resampled.
 */
export function probeAt(
  grid: RasterGrid | null | undefined,
  view: MapViewport,
  point: CanvasPoint,
): CursorReadout {
  const geo = canvasToGeo(view, point.x, point.y);
  const empty: CursorReadout = { lat: geo.lat, lon: geo.lon, row: null, col: null, db: null };
  if (!grid || grid.rows.length === 0) return empty;
  const firstRow = grid.rows[0];
  if (!firstRow || firstRow.length === 0) return empty;
  const row = Math.floor(geo.normY * grid.rows.length);
  const col = Math.floor(geo.normX * firstRow.length);
  if (row < 0 || row >= grid.rows.length || col < 0 || col >= firstRow.length) return empty;
  const value = grid.rows[row]?.[col];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { lat: geo.lat, lon: geo.lon, row, col, db: null };
  }
  return { lat: geo.lat, lon: geo.lon, row, col, db: value };
}

/** Handler factory for the dB cursor probe. */
export function makeProbeHandler(
  grid: RasterGrid | null | undefined,
  view: MapViewport,
  onReadout: (readout: CursorReadout) => void,
): (event: PointerLike) => void {
  return (event) => {
    onReadout(probeAt(grid, view, cursorFromEvent(event, view.rect)));
  };
}

// ----------------------------------------------------------- AOI selection

export interface AoiSelectOptions {
  /** Read lazily, so a re-render never drops an in-flight drag. */
  readonly getView: () => MapViewport;
  /** Emitted once per completed drag, ordered `minLon,minLat,maxLon,maxLat`. */
  readonly onSelect: (bbox: BoundingBox) => void;
  /** A drag shorter than this emits nothing, so a click cannot zero an AOI. */
  readonly minDragPixels?: number;
}

export interface AoiSelectHandlers {
  readonly begin: (event: PointerLike) => void;
  readonly drag: (event: PointerLike) => void;
  /** Completes the drag and emits the bbox. Safe to call with no drag in flight. */
  readonly finish: () => void;
  readonly cancel: () => void;
  /** The rubber band in viewport pixels, or null when no drag is in flight. */
  readonly rectangle: DragRect | null;
  /** The most recently emitted bbox, for the readout and for tests. */
  readonly lastBbox: BoundingBox | null;
  readonly active: boolean;
}

/**
 * Drag-to-select AOI. A closure over exactly two points: the surface renders the
 * rubber band from `rectangle` and the caller receives a real bbox from
 * `finish()`.
 */
export function makeAoiSelectHandlers(options: AoiSelectOptions): AoiSelectHandlers {
  const minDrag = options.minDragPixels ?? 4;
  let start: CanvasPoint | null = null;
  let current: CanvasPoint | null = null;
  let last: BoundingBox | null = null;

  return {
    begin: (event) => {
      start = cursorFromEvent(event, options.getView().rect);
      current = start;
    },
    drag: (event) => {
      if (!start) return;
      current = cursorFromEvent(event, options.getView().rect);
    },
    finish: () => {
      if (start && current) {
        const rect = rectFromPoints(start, current);
        if (rect.width >= minDrag && rect.height >= minDrag) {
          last = bboxFromDrag(options.getView(), start, current);
          options.onSelect(last);
        }
      }
      start = null;
      current = null;
    },
    cancel: () => {
      start = null;
      current = null;
    },
    get rectangle() {
      return start && current ? rectFromPoints(start, current) : null;
    },
    get lastBbox() {
      return last;
    },
    get active() {
      return start !== null;
    },
  };
}

// ======================================================== keyboard controls

/**
 * Roving index for a segmented control / radiogroup. Returns null for keys the
 * control does not own so the caller can leave them to the browser.
 */
export function nextSegmentIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** True when a keyboard event belongs to the segmented-control key set. */
export function isSegmentKey(key: string): boolean {
  return ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(key);
}

// ========================================================== debug layer hook

export type DebugViews = Record<string, DebugLayerView>;

function initialViews(): DebugViews {
  const out: DebugViews = {};
  for (const def of DEBUG_LAYER_DEFS) out[def.id] = debugLayerView(def);
  return out;
}

export interface DebugLayersState {
  readonly views: DebugViews;
  readonly selected: DebugLayerId;
  readonly select: (id: DebugLayerId) => void;
}

/**
 * Fetch debug layers on demand. DECLARED_ONLY layers are never requested — the
 * registry already knows the backend refuses them, and asking anyway would only
 * produce a 404 to display.
 */
export function useDebugLayers(
  client: ApiClient,
  scanId: string | null,
  enabled: boolean,
  stale: boolean,
): DebugLayersState {
  const [views, setViews] = useState<DebugViews>(initialViews);
  const [selected, setSelected] = useState<DebugLayerId>('raw');

  useEffect(() => {
    if (!enabled) return;
    const def = DEBUG_LAYER_DEFS.find((entry) => entry.id === selected);
    if (!scanId || !def || def.serverStatus !== 'SERVED') return;
    let cancelled = false;
    client
      .getDebugLayer(scanId, selected)
      .then((response) => {
        if (cancelled) return;
        setViews((prev) => ({ ...prev, [selected]: debugLayerView(def, { response, stale }) }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setViews((prev) => ({ ...prev, [selected]: debugLayerView(def, { error, stale }) }));
      });
    return () => {
      cancelled = true;
    };
  }, [client, enabled, scanId, selected, stale]);

  const select = useCallback((id: DebugLayerId) => setSelected(id), []);
  return { views, selected, select };
}

// ============================================================== the surface

export interface AnalysisWorkbenchProps {
  /** Injectable client. Defaults to a real fetch-backed client. */
  readonly client?: ApiClient;
  /** The scan whose debug layers are being inspected. */
  readonly scanId?: string | null;
  /** The AOI extent the plot maps to. */
  readonly bbox?: BoundingBox | null;
  /** Backend raster grid, used for the dB probe and the inline preview. */
  readonly grid?: RasterGrid | null;
  /** Baseline: the parameters the CURRENT backend result was produced with. */
  readonly cfarConfig?: CfarConfig;
  /** An already-edited draft to open with. Raises the recompute banner at once. */
  readonly pendingConfig?: CfarConfig;
  readonly onCfarConfigChange?: (config: CfarConfig) => void;
  /** Ask the backend to re-run detection. Never computes anything locally. */
  readonly onRecompute?: (config: CfarConfig) => void;
  readonly onAoiSelected?: (bbox: BoundingBox) => void;
  /** `?debug=true`. When false the whole debug section is omitted. */
  readonly debugEnabled?: boolean;
  /** Raw `location.search`; used to derive `debugEnabled` when it is not passed. */
  readonly search?: string;
}

export const PLOT_VIEW_WIDTH = 640;
export const PLOT_VIEW_HEIGHT = 360;

/** Cells rendered inline as SVG. Larger grids render a stated summary instead. */
export const MAX_INLINE_CELL_SIDE = 24;

export function AnalysisWorkbench(props: AnalysisWorkbenchProps): React.ReactElement {
  const { client: clientProp, onRecompute, onAoiSelected, onCfarConfigChange } = props;
  const client = useMemo(() => clientProp ?? createApiClient(), [clientProp]);

  const baseline = props.cfarConfig ?? DEFAULT_CFAR_CONFIG;
  const [config, setConfig] = useState<CfarConfig>(() => props.pendingConfig ?? baseline);

  const [colormap, setColormap] = useState<RasterColormap>('radar-green');
  const [palette, setPalette] = useState<HeatmapPalette>('thermal');
  const [heatmapOpacity, setHeatmapOpacity] = useState(0.7);
  const [showGraticule, setShowGraticule] = useState(true);
  const [showScaleBar, setShowScaleBar] = useState(true);

  const [readout, setReadout] = useState<CursorReadout | null>(null);
  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [lastAoi, setLastAoi] = useState<BoundingBox | null>(null);

  const bbox = isUsableBbox(props.bbox) ? props.bbox : null;

  const view = useMemo(
    () =>
      makeViewport(bbox ?? [0, 0, 1, 1], {
        rect: { left: 0, top: 0, width: PLOT_VIEW_WIDTH, height: PLOT_VIEW_HEIGHT },
      }),
    [bbox],
  );

  // The viewport is read lazily so a re-render never drops an in-flight drag.
  const viewRef = useRef(view);
  viewRef.current = view;
  const aoiRef = useRef<AoiSelectHandlers | null>(null);
  if (!aoiRef.current) {
    aoiRef.current = makeAoiSelectHandlers({
      getView: () => viewRef.current,
      onSelect: (emitted) => {
        setLastAoi(emitted);
        onAoiSelected?.(emitted);
      },
    });
  }
  const aoi = aoiRef.current;

  const grid = props.grid ?? null;
  const probeHandler = useMemo(
    () => makeProbeHandler(grid, view, setReadout),
    [grid, view],
  );

  const diff = useMemo(() => recomputeDiff(baseline, config), [baseline, config]);

  const applyConfig = useCallback(
    (next: CfarConfig) => {
      setConfig(next);
      onCfarConfigChange?.(next);
    },
    [onCfarConfigChange],
  );

  const debugOn = props.debugEnabled ?? isDebugEnabled(props.search);
  const debug = useDebugLayers(client, props.scanId ?? null, debugOn, diff.requiresRecomputation);

  return (
    <section
      data-df-analysis
      aria-label="SAR analysis workbench"
      className="df-glass-strong space-y-4 rounded-[var(--df-panel-radius)] p-4 font-mono text-[var(--df-text)]"
    >
      <header className="border-b border-[var(--df-border)] pb-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--df-accent)]">
          Analysis workbench
        </h2>
        <span className="mt-1 block text-[10px] leading-snug text-[var(--df-text-dim)]">
          Controls collect request parameters and render backend output. Detection, correlation and
          classification run in the Python backend; this surface computes neither.
        </span>
      </header>

      <CfarSection config={config} diff={diff} onChange={applyConfig} onRecompute={onRecompute} />

      <DisplaySection
        colormap={colormap}
        palette={palette}
        heatmapOpacity={heatmapOpacity}
        showGraticule={showGraticule}
        showScaleBar={showScaleBar}
        onColormap={setColormap}
        onPalette={setPalette}
        onHeatmapOpacity={setHeatmapOpacity}
        onToggleGraticule={() => setShowGraticule((value) => !value)}
        onToggleScaleBar={() => setShowScaleBar((value) => !value)}
      />

      <PlotSection
        view={view}
        bbox={bbox}
        grid={grid}
        colormap={colormap}
        heatmapOpacity={heatmapOpacity}
        showGraticule={showGraticule}
        showScaleBar={showScaleBar}
        dragRect={dragRect}
        readout={readout}
        lastAoi={lastAoi}
        aoi={aoi}
        probeHandler={probeHandler}
        onDragRect={setDragRect}
      />

      {debugOn && (
        <DebugSection scanId={props.scanId ?? null} state={debug} stale={diff.requiresRecomputation} />
      )}
    </section>
  );
}

// ------------------------------------------------------------ CFAR section

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h3 className="text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">{title}</h3>
      {hint && <span className="mt-0.5 block text-[10px] leading-snug text-[var(--df-text-dim)]">{hint}</span>}
    </div>
  );
}

/** True when the config matches a preset exactly. */
export function matchesPreset(config: CfarConfig, presetId: string): boolean {
  const preset = CFAR_PRESETS.find((entry) => entry.id === presetId);
  return preset ? diffConfig(preset.config, config).length === 0 : false;
}

const NUMERIC_PARAM_KEYS = CFAR_PARAM_KEYS.filter(
  (key): key is Exclude<CfarConfigKey, 'speckleFilter'> => key !== 'speckleFilter',
);

interface CfarSectionProps {
  readonly config: CfarConfig;
  readonly diff: ReturnType<typeof recomputeDiff>;
  readonly onChange: (config: CfarConfig) => void;
  readonly onRecompute?: ((config: CfarConfig) => void) | undefined;
}

function CfarSection({ config, diff, onChange, onRecompute }: CfarSectionProps) {
  return (
    <section data-df-cfar aria-label="CA-CFAR detection parameters" className="space-y-2">
      <SectionHeading
        title="CA-CFAR detection parameters"
        hint="Request parameters for the backend detector. Nothing here is computed in the browser."
      />

      <div role="radiogroup" aria-label="CFAR preset" className="grid grid-cols-3 gap-1.5">
        {CFAR_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={matchesPreset(config, preset.id)}
            aria-label={`${preset.name} preset. ${preset.description}`}
            data-df-cfar-preset={preset.id}
            onClick={() => onChange(applyPreset(config, preset.id))}
            title={preset.description}
            className={[
              'rounded-[6px] border border-[var(--df-border)] px-2 py-1.5 text-left text-[10px] transition',
              'text-[var(--df-text-secondary)] hover:border-[var(--df-border-active)] hover:text-[var(--df-accent)]',
              FOCUS_RING,
            ].join(' ')}
          >
            <span className="block truncate font-semibold">{preset.name}</span>
            <span className="mt-0.5 block truncate text-[9px] text-[var(--df-text-dim)]">
              {preset.description}
            </span>
          </button>
        ))}
      </div>

      <SpeckleControl
        value={config.speckleFilter}
        onChange={(mode) => onChange(updateParam(config, 'speckleFilter', mode))}
      />

      <dl className="grid grid-cols-1 gap-1.5">
        {NUMERIC_PARAM_KEYS.map((key) => (
          <ParamSlider
            key={key}
            spec={CFAR_PARAM_SPECS[key]}
            value={config[key]}
            onChange={(next) => onChange(updateParam(config, key, next))}
          />
        ))}
      </dl>

      <RecomputeBanner diff={diff} onRecompute={() => onRecompute?.(config)} />
    </section>
  );
}

function SpeckleControl({
  value,
  onChange,
}: {
  value: SpeckleMode;
  onChange: (mode: SpeckleMode) => void;
}) {
  const index = Math.max(
    0,
    SPECKLE_MODES.indexOf(value),
  );
  return (
    <div
      role="radiogroup"
      aria-label="Speckle filter"
      data-df-speckle-group
      className="grid grid-cols-3 gap-1.5"
      onKeyDown={(event) => {
        const next = nextSegmentIndex(event.key, index, SPECKLE_MODES.length);
        if (next === null) return;
        event.preventDefault();
        const mode = SPECKLE_MODES[next];
        if (isSpeckleMode(mode)) onChange(mode);
      }}
    >
      {SPECKLE_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          aria-label={`Speckle filter: ${SPECKLE_MODE_LABELS[mode]}`}
          tabIndex={value === mode ? 0 : -1}
          data-df-speckle={mode}
          onClick={() => onChange(mode)}
          className={[
            'rounded-[6px] border px-2 py-1 text-[10px] transition',
            FOCUS_RING,
            value === mode
              ? 'border-[var(--df-accent)] bg-[var(--df-accent-soft)] font-semibold text-[var(--df-accent)]'
              : 'border-[var(--df-border)] text-[var(--df-text-secondary)] hover:border-[var(--df-border-active)]',
          ].join(' ')}
        >
          {SPECKLE_MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}

function ParamSlider({
  spec,
  value,
  onChange,
}: {
  spec: (typeof CFAR_PARAM_SPECS)[CfarConfigKey];
  value: number;
  onChange: (next: number) => void;
}) {
  const inputId = `df-param-${spec.key}`;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={inputId} className="w-32 shrink-0 text-[10px] text-[var(--df-text-secondary)]">
        {spec.label}
        {spec.unit ? <span className="text-[var(--df-text-dim)]"> ({spec.unit})</span> : null}
      </label>
      <input
        id={inputId}
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        aria-label={`${spec.label} in ${spec.unit || 'steps'}`}
        aria-valuetext={formatParam(spec.key, value)}
        data-df-param={spec.key}
        onChange={(event) => {
          const parsed = parseParamInput(event.target.value);
          if (parsed !== null) onChange(parsed);
        }}
        className={`h-1 min-w-0 flex-1 accent-[var(--df-accent)] ${FOCUS_RING}`}
      />
      <output
        htmlFor={inputId}
        className="w-20 shrink-0 text-right text-[10px] tabular-nums text-[var(--df-accent)]"
      >
        {formatParam(spec.key, value)}
      </output>
    </div>
  );
}

/**
 * UI-015: before/after diagnostics plus the explicit recomputation signal. A
 * parameter change is a REQUEST, not a result — say so, and name the keys.
 */
function RecomputeBanner({
  diff,
  onRecompute,
}: {
  diff: ReturnType<typeof recomputeDiff>;
  onRecompute: () => void;
}) {
  const stale = diff.requiresRecomputation;
  return (
    <div
      data-df-recompute={stale ? 'required' : 'clean'}
      role="status"
      aria-live="polite"
      className={[
        'space-y-1.5 rounded-[8px] border px-2.5 py-2',
        stale ? 'border-[var(--df-warning)]' : 'border-[var(--df-border)]',
      ].join(' ')}
    >
      <span
        className={[
          'flex items-start gap-1.5 text-[10px]',
          stale ? 'text-[var(--df-warning)]' : 'text-[var(--df-text-dim)]',
        ].join(' ')}
      >
        {stale ? (
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <RefreshCw className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        )}
        <span>{diff.summary}</span>
      </span>

      {stale && (
        <table className="w-full text-[10px]" data-df-recompute-diff>
          <caption className="sr-only">Changed CFAR parameters, before and after</caption>
          <thead>
            <tr className="text-left text-[var(--df-text-dim)]">
              <th scope="col" className="font-normal">
                Parameter
              </th>
              <th scope="col" className="font-normal">
                Backend result
              </th>
              <th scope="col" className="font-normal">
                Pending
              </th>
            </tr>
          </thead>
          <tbody>
            {diff.entries.map((entry) => (
              <tr key={entry.key} data-df-recompute-key={entry.key}>
                <th scope="row" className="text-left font-normal text-[var(--df-text-secondary)]">
                  {entry.label}
                </th>
                <td className="tabular-nums text-[var(--df-text-dim)]">{entry.before}</td>
                <td className="tabular-nums text-[var(--df-warning)]">{entry.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button
        type="button"
        onClick={onRecompute}
        aria-label="Request backend recomputation with these parameters"
        data-df-recompute-request
        className={[
          'w-full rounded-[6px] border border-[var(--df-border)] px-2 py-1.5 text-[10px] transition',
          'hover:border-[var(--df-border-active)] hover:text-[var(--df-accent)]',
          FOCUS_RING,
          stale ? 'text-[var(--df-warning)]' : 'text-[var(--df-text-secondary)]',
        ].join(' ')}
      >
        Request backend recompute
      </button>
    </div>
  );
}

// --------------------------------------------------------- display section

interface DisplaySectionProps {
  readonly colormap: RasterColormap;
  readonly palette: HeatmapPalette;
  readonly heatmapOpacity: number;
  readonly showGraticule: boolean;
  readonly showScaleBar: boolean;
  readonly onColormap: (value: RasterColormap) => void;
  readonly onPalette: (value: HeatmapPalette) => void;
  readonly onHeatmapOpacity: (value: number) => void;
  readonly onToggleGraticule: () => void;
  readonly onToggleScaleBar: () => void;
}

function DisplaySection(props: DisplaySectionProps) {
  return (
    <section data-df-display aria-label="Raster display options" className="space-y-2">
      <SectionHeading
        title="Raster display"
        hint="Presentation only. No colormap changes a value or a threshold."
      />

      <SegmentedControl
        legend="Raster colormap"
        groupId="colormap"
        options={RASTER_COLORMAPS.map((id) => ({ id, label: RASTER_COLORMAP_LABELS[id] }))}
        value={props.colormap}
        onChange={(id) => {
          if (isRasterColormap(id)) props.onColormap(id);
        }}
        swatches={colormapStops(props.colormap)}
      />

      <SegmentedControl
        legend="Heatmap palette"
        groupId="heatmap-palette"
        options={HEATMAP_PALETTES.map((id) => ({ id, label: HEATMAP_PALETTE_LABELS[id] }))}
        value={props.palette}
        onChange={(id) => {
          if (isHeatmapPalette(id)) props.onPalette(id);
        }}
        swatches={paletteStops(props.palette)}
      />

      <div className="flex items-center gap-2">
        <label htmlFor="df-heatmap-opacity" className="w-32 shrink-0 text-[10px] text-[var(--df-text-secondary)]">
          Heatmap opacity
        </label>
        <input
          id="df-heatmap-opacity"
          type="range"
          min={0.05}
          max={1}
          step={0.05}
          value={props.heatmapOpacity}
          aria-label="Heatmap opacity"
          aria-valuetext={`${Math.round(props.heatmapOpacity * 100)} percent`}
          data-df-heatmap-opacity
          onChange={(event) => {
            const parsed = parseParamInput(event.target.value);
            if (parsed !== null) props.onHeatmapOpacity(parsed);
          }}
          className={`h-1 min-w-0 flex-1 accent-[var(--df-accent)] ${FOCUS_RING}`}
        />
        <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-[var(--df-accent)]">
          {Math.round(props.heatmapOpacity * 100)}%
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <ToggleChip
          checked={props.showGraticule}
          label="Coordinate graticule"
          onChange={props.onToggleGraticule}
        />
        <ToggleChip
          checked={props.showScaleBar}
          label="Nautical mile scale bar"
          onChange={props.onToggleScaleBar}
        />
      </div>
    </section>
  );
}

interface SegmentedOption {
  readonly id: string;
  readonly label: string;
}

/**
 * A keyboard-operable radiogroup. Only the selected option is tabbable (roving
 * tabindex); arrows / Home / End move the selection.
 */
function SegmentedControl({
  legend,
  groupId,
  options,
  value,
  onChange,
  swatches,
}: {
  legend: string;
  groupId: string;
  options: readonly SegmentedOption[];
  value: string;
  onChange: (id: string) => void;
  readonly swatches?: readonly string[];
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  return (
    <div
      role="radiogroup"
      aria-label={legend}
      data-df-segmented={groupId}
      className="grid grid-cols-3 gap-1.5"
      onKeyDown={(event) => {
        const next = nextSegmentIndex(event.key, index, options.length);
        if (next === null) return;
        event.preventDefault();
        onChange(options[next].id);
      }}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${legend}: ${option.label}`}
            tabIndex={active ? 0 : -1}
            data-df-option={option.id}
            data-df-active={active ? 'true' : 'false'}
            onClick={() => onChange(option.id)}
            className={[
              'rounded-[6px] border px-2 py-1 text-[10px] capitalize transition',
              FOCUS_RING,
              active
                ? 'border-[var(--df-accent)] bg-[var(--df-accent-soft)] font-semibold text-[var(--df-accent)]'
                : 'border-[var(--df-border)] text-[var(--df-text-secondary)] hover:border-[var(--df-border-active)]',
            ].join(' ')}
          >
            {option.label}
          </button>
        );
      })}
      {swatches && (
        <span aria-hidden className="col-span-3 flex h-1.5 overflow-hidden rounded-full border border-[var(--df-border)]">
          {swatches.map((color) => (
            <span key={color} className="flex-1" style={{ backgroundColor: color }} />
          ))}
        </span>
      )}
    </div>
  );
}

function ToggleChip({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-df-toggle={label}
      onClick={onChange}
      className={[
        'rounded-[6px] border px-2 py-1 text-[10px] transition',
        FOCUS_RING,
        checked
          ? 'border-[var(--df-accent)] bg-[var(--df-accent-soft)] text-[var(--df-accent)]'
          : 'border-[var(--df-border)] text-[var(--df-text-secondary)]',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

// ------------------------------------------------------------- plot section

interface PlotSectionProps {
  readonly view: MapViewport;
  readonly bbox: BoundingBox | null;
  readonly grid: RasterGrid | null;
  readonly colormap: RasterColormap;
  readonly heatmapOpacity: number;
  readonly showGraticule: boolean;
  readonly showScaleBar: boolean;
  readonly dragRect: DragRect | null;
  readonly readout: CursorReadout | null;
  readonly lastAoi: BoundingBox | null;
  readonly aoi: AoiSelectHandlers;
  readonly probeHandler: (event: PointerLike) => void;
  /** Mirrors the in-flight rubber band into React state. */
  readonly onDragRect: (rect: DragRect | null) => void;
}

function PlotSection(props: PlotSectionProps) {
  const { view, bbox } = props;
  const width = view.rect.width;
  const height = view.rect.height;
  const lines = useMemo(() => (bbox ? graticule(bbox, 8) : null), [bbox]);
  const bar = useMemo(() => (props.showScaleBar ? scaleBar(view) : null), [props.showScaleBar, view]);
  const shape = gridShapeOf(props.grid);
  const inline =
    shape !== null && shape.rows <= MAX_INLINE_CELL_SIDE && shape.cols <= MAX_INLINE_CELL_SIDE;

  return (
    <section data-df-plot aria-label="Backscatter viewport" className="space-y-2">
      <SectionHeading
        title="Backscatter viewport"
        hint="Drag on the plot to select an AOI. Move the pointer to read the dB value under the cursor."
      />

      {!bbox ? (
        <span
          data-df-plot-empty
          className="block rounded-[6px] border border-[var(--df-border)] px-2 py-3 text-[10px] text-[var(--df-text-dim)]"
        >
          No area of interest is loaded, so no graticule, scale bar or coordinate readout can be
          drawn. Run a scan first.
        </span>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`SAR backscatter plot, ${formatDegree(bbox[1], 'lat')} to ${formatDegree(bbox[3], 'lat')}, ${formatDegree(bbox[0], 'lon')} to ${formatDegree(bbox[2], 'lon')}`}
            data-df-plot-surface
            className="block w-full select-none rounded-[8px] border border-[var(--df-border)] bg-[#05080c]"
            style={{ touchAction: 'none' }}
            onPointerDown={(event) => props.aoi.begin(event)}
            onPointerMove={(event) => {
              props.aoi.drag(event);
              props.probeHandler(event);
              props.onDragRect(props.aoi.rectangle);
            }}
            onPointerUp={() => {
              props.aoi.finish();
              props.onDragRect(props.aoi.rectangle);
            }}
            onPointerLeave={() => {
              props.aoi.cancel();
              props.onDragRect(props.aoi.rectangle);
            }}
          >
            {props.grid && inline && shape && (
              <g data-df-raster-preview opacity={props.heatmapOpacity}>
                {props.grid.rows.map((row, rowIndex) =>
                  (row ?? []).map((cell, colIndex) => {
                    const cellBox = cellRect(view, bbox, rowIndex, colIndex, shape);
                    if (!cellBox) return null;
                    return (
                      <rect
                        key={`${rowIndex}:${colIndex}`}
                        x={cellBox.x}
                        y={cellBox.y}
                        width={cellBox.width}
                        height={cellBox.height}
                        fill={rasterCellCss(cell, props.colormap)}
                        data-df-raster-cell={`${rowIndex}:${colIndex}`}
                        data-df-raster-db={typeof cell === 'number' && Number.isFinite(cell) ? cell : ''}
                      />
                    );
                  }),
                )}
              </g>
            )}

            {props.grid && !inline && shape && (
              <text
                x={width / 2}
                y={height / 2}
                textAnchor="middle"
                fill="rgba(210,230,236,0.32)"
                fontSize="11"
                data-df-raster-summary
              >
                {`Raster ${shape.rows} x ${shape.cols} cells is too large to draw inline; the dB probe still reads it cell by cell.`}
              </text>
            )}

            {!props.grid && (
              <text
                x={width / 2}
                y={height / 2}
                textAnchor="middle"
                fill="rgba(210,230,236,0.32)"
                fontSize="11"
                data-df-raster-summary
              >
                No backend raster for this scan. Nothing is drawn rather than synthesised.
              </text>
            )}

            {props.showGraticule && lines && (
              <g data-df-graticule aria-hidden stroke="rgba(6,182,212,0.14)" strokeWidth="1">
                {lines.lons.map((line) => {
                  const a = geoToCanvas(view, bbox[1], line.value);
                  const b = geoToCanvas(view, bbox[3], line.value);
                  return <line key={`lon:${line.value}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
                })}
                {lines.lats.map((line) => {
                  const a = geoToCanvas(view, line.value, bbox[0]);
                  const b = geoToCanvas(view, line.value, bbox[2]);
                  return <line key={`lat:${line.value}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
                })}
                {lines.lons.map((line) => {
                  const a = geoToCanvas(view, bbox[1], line.value);
                  return (
                    <text
                      key={`lon-label:${line.value}`}
                      x={a.x + 3}
                      y={height - 6}
                      fill="rgba(6,182,212,0.55)"
                      fontSize="9"
                      data-df-graticule-label={`lon:${line.label}`}
                    >
                      {line.label}
                    </text>
                  );
                })}
                {lines.lats.map((line) => {
                  const a = geoToCanvas(view, line.value, bbox[0]);
                  return (
                    <text
                      key={`lat-label:${line.value}`}
                      x={4}
                      y={a.y - 4}
                      fill="rgba(6,182,212,0.55)"
                      fontSize="9"
                      data-df-graticule-label={`lat:${line.label}`}
                    >
                      {line.label}
                    </text>
                  );
                })}
              </g>
            )}

            {bar && (
              <g data-df-scale-bar aria-hidden stroke="rgba(148,163,184,0.8)" strokeWidth="2">
                <line x1={width - 20 - bar.pixels} y1={height - 14} x2={width - 20} y2={height - 14} />
                <line x1={width - 20 - bar.pixels} y1={height - 18} x2={width - 20 - bar.pixels} y2={height - 10} />
                <line x1={width - 20} y1={height - 18} x2={width - 20} y2={height - 10} />
                <text
                  x={width - 20 - bar.pixels}
                  y={height - 20}
                  fill="rgba(148,163,184,0.9)"
                  fontSize="9"
                  data-df-scale-label={bar.label}
                >
                  {bar.label}
                </text>
              </g>
            )}

            {props.dragRect && (
              <rect
                data-df-aoi-rect
                x={props.dragRect.x}
                y={props.dragRect.y}
                width={props.dragRect.width}
                height={props.dragRect.height}
                fill="rgba(6,182,212,0.15)"
                stroke="#06b6d4"
                strokeDasharray="4 4"
              />
            )}

            {props.readout && props.readout.db !== null && (
              <circle
                data-df-probe-marker
                cx={geoToCanvas(view, props.readout.lat, props.readout.lon).x}
                cy={geoToCanvas(view, props.readout.lat, props.readout.lon).y}
                r={5}
                fill="none"
                stroke="#62e8ff"
                strokeWidth="1.5"
              />
            )}
          </svg>

          <span className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center gap-3 px-2 pt-2 font-mono text-[10px]">
            <span className="flex items-center gap-1 text-[var(--df-text-secondary)]">
              <Crosshair className="h-3 w-3 text-[var(--df-accent)]" aria-hidden />
              <span data-df-probe-position>
                {props.readout
                  ? `${formatDegree(props.readout.lat, 'lat')} / ${formatDegree(props.readout.lon, 'lon')}`
                  : 'Position telemetry idle'}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span className="text-[var(--df-text-dim)]">Backscatter:</span>
              <span
                data-df-probe-db
                className={[
                  'font-semibold',
                  props.readout && props.readout.db !== null && props.readout.db > -10
                    ? 'text-[var(--df-warning)]'
                    : 'text-[var(--df-accent)]',
                ].join(' ')}
              >
                {props.readout?.db === null || props.readout?.db === undefined
                  ? 'no cell value'
                  : `${props.readout.db} dB`}
              </span>
            </span>
            {props.readout && props.readout.row !== null && (
              <span className="text-[var(--df-text-dim)]" data-df-probe-cell>
                cell {props.readout.row}:{props.readout.col}
              </span>
            )}
          </span>
        </div>
      )}

      <AoiReadout lastAoi={props.lastAoi} bbox={bbox} zoom={view.zoom} />
    </section>
  );
}

/** AOI summary row: the emitted bbox, or an honest "no selection" state. */
function AoiReadout({
  lastAoi,
  bbox,
  zoom,
}: {
  lastAoi: BoundingBox | null;
  bbox: BoundingBox | null;
  zoom: number;
}) {
  return (
    <div data-df-aoi-readout className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1 text-[10px] text-[var(--df-text-secondary)]">
        <BoxSelect className="h-3 w-3 text-[var(--df-accent)]" aria-hidden />
        AOI
      </span>
      {lastAoi ? (
        <span data-df-aoi-bbox className="font-mono text-[10px] tabular-nums text-[var(--df-accent)]">
          {lastAoi.map((value) => value.toFixed(4)).join(', ')}
        </span>
      ) : (
        <span className="text-[10px] text-[var(--df-text-dim)]" data-df-aoi-bbox="none">
          {bbox
            ? `No selection. Current AOI: ${bbox.map((value) => value.toFixed(3)).join(', ')}.`
            : 'No AOI loaded.'}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1 text-[9px] text-[var(--df-text-dim)]">
        <Ruler className="h-3 w-3" aria-hidden />
        {bbox
          ? `${(bbox[2] - bbox[0]).toFixed(3)} deg x ${(bbox[3] - bbox[1]).toFixed(3)} deg`
          : 'n/a'}
        {zoom !== 1 ? ` · zoom ${zoom.toFixed(2)}x` : ''}
      </span>
    </div>
  );
}

function gridShapeOf(grid: RasterGrid | null): { rows: number; cols: number } | null {
  if (!grid || grid.rows.length === 0) return null;
  const cols = grid.rows[0]?.length ?? 0;
  if (cols === 0) return null;
  return { rows: grid.rows.length, cols };
}

function cellRect(
  view: MapViewport,
  bbox: BoundingBox,
  row: number,
  col: number,
  shape: { rows: number; cols: number },
): DragRect | null {
  const latTop = bbox[3] - (row / shape.rows) * (bbox[3] - bbox[1]);
  const latBottom = bbox[3] - ((row + 1) / shape.rows) * (bbox[3] - bbox[1]);
  const lonLeft = bbox[0] + (col / shape.cols) * (bbox[2] - bbox[0]);
  const lonRight = bbox[0] + ((col + 1) / shape.cols) * (bbox[2] - bbox[0]);
  return rectFromPoints(
    geoToCanvas(view, latTop, lonLeft),
    geoToCanvas(view, latBottom, lonRight),
  );
}

// ----------------------------------------------------------- debug section

/** One debug layer row. Exported so a single layer's honest state is testable. */
export function DebugLayerPanel({
  def,
  view,
  selected,
  onSelect,
}: {
  readonly def: DebugLayerDef;
  readonly view: DebugLayerView;
  readonly selected?: boolean;
  readonly onSelect?: (id: DebugLayerId) => void;
}) {
  const unavailable =
    view.state === 'DECLARED_ONLY' || view.state === 'UNAVAILABLE' || view.state === 'ERROR';

  const body = (
    <>
      <span className="flex items-center gap-1.5">
        <span className="truncate font-semibold text-[var(--df-text)]">{view.title}</span>
        {view.stale && (
          <span
            className="shrink-0 rounded-[4px] border border-[var(--df-warning)] px-1 text-[8px] uppercase tracking-wider text-[var(--df-warning)]"
            title="A pending parameter change invalidates this layer until the backend recomputes."
          >
            stale
          </span>
        )}
        {view.aliasOf && (
          <span
            className="shrink-0 rounded-[4px] border border-[var(--df-warning)] px-1 text-[8px] uppercase tracking-wider text-[var(--df-warning)]"
            title={`The backend answers this from the "${def.source}" artifact; it is an alias of "${view.aliasOf}".`}
          >
            alias of {view.aliasOf}
          </span>
        )}
      </span>
      <span className="block truncate text-[9px] text-[var(--df-text-dim)]">{view.path}</span>

      {unavailable ? (
        <span
          data-df-debug-unavailable={def.id}
          className="flex items-start gap-1 text-[9px] text-[var(--df-warning)]"
        >
          <TriangleAlert className="mt-0.5 h-2.5 w-2.5 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold uppercase tracking-wider">unavailable</span> —{' '}
            {view.reason ?? view.detail}
          </span>
        </span>
      ) : (
        <>
          <span className="block text-[9px] text-[var(--df-text-secondary)]" data-df-debug-detail={def.id}>
            {view.detail}
          </span>
          <DebugStatsTable view={view} />
        </>
      )}

      {view.notes.length > 0 && (
        <ul className="space-y-0.5 text-[9px] text-[var(--df-text-dim)]" data-df-debug-notes={def.id}>
          {view.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </>
  );

  if (!onSelect) {
    return (
      <div
        data-df-debug-layer={def.id}
        data-df-debug-state={view.state}
        className="space-y-0.5 rounded-[6px] border border-[var(--df-border)] px-2 py-1.5"
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(def.id)}
      aria-pressed={Boolean(selected)}
      aria-label={`Debug layer: ${view.title}. ${view.state}`}
      data-df-debug-layer={def.id}
      data-df-debug-state={view.state}
      disabled={view.state === 'DECLARED_ONLY'}
      className={[
        'block w-full space-y-0.5 rounded-[6px] border px-2 py-1.5 text-left transition',
        FOCUS_RING,
        view.state === 'DECLARED_ONLY'
          ? 'cursor-not-allowed border-[var(--df-border)] opacity-70'
          : 'border-[var(--df-border)] hover:border-[var(--df-border-active)]',
        selected ? 'border-[var(--df-accent)] bg-[var(--df-accent-soft)]' : '',
      ].join(' ')}
    >
      {body}
    </button>
  );
}

/** Renders backend stats verbatim. No statistic is derived, averaged or guessed. */
export function DebugStatsTable({ view }: { readonly view: DebugLayerView }) {
  if (view.stats === null) {
    return (
      <span className="block text-[9px] text-[var(--df-text-dim)]" data-df-debug-stats="absent">
        The backend returned no statistics for this layer.
      </span>
    );
  }
  if (view.statRows.length === 0 || view.statsMissing) {
    return (
      <span className="block text-[9px] text-[var(--df-text-dim)]" data-df-debug-stats="null">
        The backend reported no distributional statistic for this layer. Nothing is inferred here.
      </span>
    );
  }
  return (
    <dl className="grid grid-cols-2 gap-x-2 text-[9px]" data-df-debug-stats={view.id}>
      {view.statRows
        .filter((row) => row.value !== null)
        .map((row) => (
          <div key={row.key} className="flex justify-between gap-1">
            <dt className="truncate text-[var(--df-text-dim)]">{row.label}</dt>
            <dd className="tabular-nums text-[var(--df-text-secondary)]">{row.value}</dd>
          </div>
        ))}
    </dl>
  );
}

function DebugSection({
  scanId,
  state,
  stale,
}: {
  scanId: string | null;
  state: DebugLayersState;
  stale: boolean;
}) {
  return (
    <section data-df-debug aria-label="Debug layers" className="space-y-2">
      <SectionHeading
        title="Debug layers"
        hint={
          scanId
            ? `Served by GET /api/debug/${scanId}/{layer}. Statistics are the backend's own.`
            : 'No scan selected: debug layers are written by the backend at COMPLETE and are not requested.'
        }
      />
      {!scanId && (
        <span
          data-df-debug-empty
          className="block rounded-[6px] border border-[var(--df-border)] px-2 py-2 text-[10px] text-[var(--df-text-dim)]"
        >
          Select a scan to inspect its 13 debug layers.
        </span>
      )}
      <ul className="space-y-1.5">
        {DEBUG_LAYER_DEFS.map((def) => (
          <li key={def.id}>
            <DebugLayerPanel
              def={def}
              view={state.views[def.id] ?? debugLayerView(def, { stale })}
              selected={state.selected === def.id}
              onSelect={state.select}
            />
          </li>
        ))}
      </ul>
      <span className="flex items-start gap-1 text-[9px] leading-snug text-[var(--df-text-dim)]">
        <Flame className="mt-0.5 h-2.5 w-2.5 shrink-0" aria-hidden />
        A layer the backend does not serve is listed as unavailable. No data is rendered in its
        place.
      </span>
    </section>
  );
}

export default AnalysisWorkbench;
