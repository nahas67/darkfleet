/**
 * Analysis workbench tests (UI-015).
 *
 * DOM-free by design, matching `src/app/SpatialShell.test.ts`: the repo runs
 * vitest in a `node` environment with no jsdom, so the surface is rendered
 * through `react-dom/server` and every interaction path is exercised through
 * the exported pure functions and handler factories. No network: the
 * `ApiClient` is always an injected stub.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CFAR_PRESETS,
  DEFAULT_CFAR_CONFIG,
  SPECKLE_MODES,
  applyPreset,
  diffConfig,
  isSpeckleMode,
  normalizeCfarConfig,
  parseParamInput,
  presetById,
  recomputeDiff,
  requiresRecomputation,
  resetConfig,
  toCfarRequestParams,
  updateParam,
} from './cfar.ts';
import type { CfarConfig } from './cfar.ts';
import {
  DB_DISPLAY_MAX,
  DB_DISPLAY_MIN,
  HEATMAP_PALETTES,
  MAX_INLINE_CELL_SIDE,
  RASTER_COLORMAPS,
  bboxFromDrag,
  canvasToGeo,
  colormapStops,
  formatDegree,
  geoToCanvas,
  graticule,
  heatmapRgb,
  isSegmentKey,
  isUsableBbox,
  makeAoiSelectHandlers,
  makeProbeHandler,
  makeViewport,
  matchesPreset,
  nextSegmentIndex,
  normalizeDisplayDb,
  probeAt,
  rasterCellCss,
  scaleBar,
  AnalysisWorkbench,
} from './AnalysisWorkbench.tsx';
import { createApiClient } from '../app/useApi.ts';
import type { ApiClient, FetchLike } from '../app/useApi.ts';

// ------------------------------------------------------------------- fakes

const AOI: [number, number, number, number] = [103.65, 1.1, 104.05, 1.4];

const GRID: number[][] = [
  [-28, -25, -20, -14],
  [-26, -18, -9, -4],
  [-24, -12, -6, 1],
  [-22, -9, -7, 5],
];

/** A client that fails every call: this surface must never depend on the network. */
function deadClient(): ApiClient {
  const fetchImpl: FetchLike = async () => {
    throw new Error('the analysis surface must not fetch in a render test');
  };
  return createApiClient(fetchImpl);
}

function render(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(AnalysisWorkbench, { client: deadClient(), ...props }),
  );
}

// ------------------------------------------------------------- config diff

describe('diffConfig', () => {
  const base: CfarConfig = { ...DEFAULT_CFAR_CONFIG };

  it('is empty for two structurally identical configs', () => {
    expect(diffConfig(base, { ...base })).toEqual([]);
  });

  it('is empty for the same config reached by a different key order', () => {
    const reordered = {
      coastlineBufferMeters: base.coastlineBufferMeters,
      kernelSize: base.kernelSize,
      speckleFilter: base.speckleFilter,
      maxPixels: base.maxPixels,
      minPixels: base.minPixels,
      thresholdFactor: base.thresholdFactor,
      guardCells: base.guardCells,
      trainingCells: base.trainingCells,
    };
    expect(diffConfig(base, reordered)).toEqual([]);
  });

  it.each([
    ['trainingCells', 20],
    ['guardCells', 6],
    ['thresholdFactor', 4.1],
    ['minPixels', 5],
    ['maxPixels', 800],
    ['speckleFilter', 'lee'],
    ['kernelSize', 5],
    ['coastlineBufferMeters', 300],
  ] as const)('detects a change in %s and only that key', (key, value) => {
    const next = updateParam(base, key, value);
    expect(diffConfig(base, next)).toEqual([key]);
    expect(diffConfig(next, base)).toEqual([key]);
  });

  it('reports every changed key at once, in canonical order', () => {
    const next = updateParam(
      updateParam(updateParam(base, 'guardCells', 8), 'thresholdFactor', 5),
      'speckleFilter',
      'none',
    );
    expect(diffConfig(base, next)).toEqual(['guardCells', 'thresholdFactor', 'speckleFilter']);
  });

  it('drives the requires-recomputation flag', () => {
    expect(requiresRecomputation(base, base)).toBe(false);
    expect(requiresRecomputation(base, updateParam(base, 'thresholdFactor', 4))).toBe(true);
  });
});

// ----------------------------------------------------------------- presets

describe('applyPreset', () => {
  it('exposes the three declared presets with the documented parameters', () => {
    expect(CFAR_PRESETS.map((preset) => preset.id)).toEqual([
      'standard',
      'high-sensitivity',
      'high-clutter',
    ]);
    expect(presetById('standard')?.config).toEqual({
      trainingCells: 16,
      guardCells: 4,
      thresholdFactor: 3.5,
      minPixels: 3,
      maxPixels: 1000,
      speckleFilter: 'median',
      kernelSize: 3,
      coastlineBufferMeters: 150,
    });
    expect(presetById('high-sensitivity')?.config).toMatchObject({
      trainingCells: 12,
      guardCells: 2,
      thresholdFactor: 2.7,
      coastlineBufferMeters: 100,
    });
    expect(presetById('high-clutter')?.config).toMatchObject({
      trainingCells: 24,
      guardCells: 6,
      thresholdFactor: 4.5,
      coastlineBufferMeters: 200,
    });
  });

  it('marks exactly the changed parameters as requiring recomputation', () => {
    // Standard -> High Sensitivity moves six values and nothing else: the four
    // headline parameters plus the component-size bounds the legacy workbench
    // hard-coded but never exposed.
    const high = applyPreset(DEFAULT_CFAR_CONFIG, 'high-sensitivity');
    expect(diffConfig(DEFAULT_CFAR_CONFIG, high)).toEqual([
      'trainingCells',
      'guardCells',
      'thresholdFactor',
      'minPixels',
      'maxPixels',
      'coastlineBufferMeters',
    ]);
    expect(requiresRecomputation(DEFAULT_CFAR_CONFIG, high)).toBe(true);

    const clutter = applyPreset(DEFAULT_CFAR_CONFIG, 'high-clutter');
    expect(diffConfig(DEFAULT_CFAR_CONFIG, clutter)).toEqual([
      'trainingCells',
      'guardCells',
      'thresholdFactor',
      'minPixels',
      'maxPixels',
      'coastlineBufferMeters',
    ]);
  });

  it('re-applying the current preset is a stable no-op', () => {
    expect(diffConfig(DEFAULT_CFAR_CONFIG, applyPreset(DEFAULT_CFAR_CONFIG, 'standard'))).toEqual([]);
    expect(applyPreset(DEFAULT_CFAR_CONFIG, 'standard')).toBe(DEFAULT_CFAR_CONFIG);
  });

  it('ignores an unknown preset id', () => {
    const edited = updateParam(DEFAULT_CFAR_CONFIG, 'thresholdFactor', 4.5);
    expect(applyPreset(edited, 'does-not-exist')).toBe(edited);
  });

  it('marks exactly the speckle key when only lee is selected', () => {
    const lee = updateParam(DEFAULT_CFAR_CONFIG, 'speckleFilter', 'lee');
    expect(diffConfig(DEFAULT_CFAR_CONFIG, lee)).toEqual(['speckleFilter']);
    expect(lee.speckleFilter).toBe('lee');
  });
});

// -------------------------------------------------------------- validation

describe('updateParam', () => {
  it('clamps an out-of-range number instead of forwarding it', () => {
    expect(updateParam(DEFAULT_CFAR_CONFIG, 'thresholdFactor', 99).thresholdFactor).toBe(5.5);
    expect(updateParam(DEFAULT_CFAR_CONFIG, 'thresholdFactor', 0).thresholdFactor).toBe(2);
    expect(updateParam(DEFAULT_CFAR_CONFIG, 'trainingCells', 100).trainingCells).toBe(32);
  });

  it('rounds whole-cell parameters', () => {
    expect(updateParam(DEFAULT_CFAR_CONFIG, 'guardCells', 4.4).guardCells).toBe(4);
  });

  it('returns the identical object for an unusable or unchanged value', () => {
    expect(updateParam(DEFAULT_CFAR_CONFIG, 'thresholdFactor', Number.NaN)).toBe(
      DEFAULT_CFAR_CONFIG,
    );
    expect(updateParam(DEFAULT_CFAR_CONFIG, 'speckleFilter', 'wavelet')).toBe(DEFAULT_CFAR_CONFIG);
    expect(updateParam(DEFAULT_CFAR_CONFIG, 'speckleFilter', 'median')).toBe(DEFAULT_CFAR_CONFIG);
  });

  it('accepts every declared speckle mode, including lee', () => {
    expect(SPECKLE_MODES).toEqual(['none', 'median', 'lee']);
    for (const mode of SPECKLE_MODES) {
      expect(isSpeckleMode(mode)).toBe(true);
      expect(updateParam(DEFAULT_CFAR_CONFIG, 'speckleFilter', mode).speckleFilter).toBe(mode);
    }
    expect(isSpeckleMode('wavelet')).toBe(false);
  });

  it('falls back to the baseline for a malformed config', () => {
    expect(normalizeCfarConfig(null)).toEqual(DEFAULT_CFAR_CONFIG);
    expect(normalizeCfarConfig({ thresholdFactor: 'loud' }).thresholdFactor).toBe(3.5);
    expect(normalizeCfarConfig({ speckleFilter: 'lee' }).speckleFilter).toBe('lee');
  });

  it('rejects an unparseable slider string', () => {
    expect(parseParamInput('')).toBeNull();
    expect(parseParamInput('abc')).toBeNull();
    expect(parseParamInput('3.5')).toBe(3.5);
  });

  it('resets to the standard preset', () => {
    const edited = applyPreset(DEFAULT_CFAR_CONFIG, 'high-clutter');
    expect(diffConfig(DEFAULT_CFAR_CONFIG, resetConfig(edited))).toEqual([]);
  });

  it('serialises request parameters only — never a detection', () => {
    const params = toCfarRequestParams(applyPreset(DEFAULT_CFAR_CONFIG, 'high-clutter'));
    expect(Object.keys(params).sort()).toEqual([
      'coastlineBufferMeters',
      'guardCells',
      'kernelSize',
      'maxPixels',
      'minPixels',
      'speckleFilter',
      'thresholdFactor',
      'trainingCells',
    ]);
    expect(params.speckleFilter).toBe('median');
    expect(params.thresholdFactor).toBe(4.5);
    expect(Object.values(params).every((v) => typeof v === 'number' || typeof v === 'string')).toBe(true);
  });

  it('describes the before/after diagnostics in canonical order', () => {
    const diff = recomputeDiff(DEFAULT_CFAR_CONFIG, applyPreset(DEFAULT_CFAR_CONFIG, 'high-clutter'));
    expect(diff.entries.map((entry) => entry.key)).toEqual([
      'trainingCells',
      'guardCells',
      'thresholdFactor',
      'minPixels',
      'maxPixels',
      'coastlineBufferMeters',
    ]);
    expect(diff.entries[0].before).toBe('16 cells');
    expect(diff.entries[0].after).toBe('24 cells');
    expect(diff.summary).toMatch(/must recompute/i);

    const clean = recomputeDiff(DEFAULT_CFAR_CONFIG, DEFAULT_CFAR_CONFIG);
    expect(clean.requiresRecomputation).toBe(false);
    expect(clean.summary).toMatch(/No parameter change/i);
  });

  it('recognises the config that matches a preset exactly', () => {
    expect(matchesPreset(DEFAULT_CFAR_CONFIG, 'standard')).toBe(true);
    expect(matchesPreset(updateParam(DEFAULT_CFAR_CONFIG, 'guardCells', 6), 'standard')).toBe(false);
  });
});

// ----------------------------------------------------------------- geometry

describe('viewport geometry', () => {
  const view = makeViewport(AOI);

  it('maps the AOI corners onto the padded viewport', () => {
    const tl = geoToCanvas(view, AOI[3], AOI[0]);
    const br = geoToCanvas(view, AOI[1], AOI[2]);
    expect(tl.x).toBeCloseTo(view.padding, 6);
    expect(tl.y).toBeCloseTo(view.padding, 6);
    expect(br.x).toBeCloseTo(view.rect.width - view.padding, 6);
    expect(br.y).toBeCloseTo(view.rect.height - view.padding, 6);
  });

  it('round-trips lon/lat through the canvas', () => {
    const point = geoToCanvas(view, 1.25, 103.85);
    const geo = canvasToGeo(view, point.x, point.y);
    expect(geo.lat).toBeCloseTo(1.25, 6);
    expect(geo.lon).toBeCloseTo(103.85, 6);
  });

  it('clamps a pointer outside the plot instead of producing NaN', () => {
    const geo = canvasToGeo(view, 9999, -9999);
    expect(Number.isFinite(geo.lat)).toBe(true);
    expect(Number.isFinite(geo.lon)).toBe(true);
    expect(geo.normX).toBe(1);
    expect(geo.normY).toBe(0);
    expect(geo.lat).toBe(AOI[3]);
    expect(geo.lon).toBe(AOI[2]);
  });

  it('rejects an unusable bbox instead of drawing a nonsense plot', () => {
    expect(isUsableBbox(AOI)).toBe(true);
    expect(isUsableBbox([104.05, 1.1, 103.65, 1.4])).toBe(false);
    expect(isUsableBbox([0, 0, 0, 1])).toBe(false);
    expect(isUsableBbox([0, 0, 200, 1])).toBe(false);
    expect(isUsableBbox(null)).toBe(false);
  });

  it('emits an ordered bbox from a screen drag, in either direction', () => {
    const forward = bboxFromDrag(view, { x: 40, y: 40 }, { x: 500, y: 300 });
    const backward = bboxFromDrag(view, { x: 500, y: 300 }, { x: 40, y: 40 });
    expect(forward).toEqual(backward);
    expect(forward[0]).toBeLessThan(forward[2]);
    expect(forward[1]).toBeLessThan(forward[3]);
    expect(forward[0]).toBeGreaterThanOrEqual(AOI[0]);
    expect(forward[2]).toBeLessThanOrEqual(AOI[2]);
  });
});

describe('AOI box select', () => {
  const view = makeViewport(AOI);

  it('emits a bbox when a drag completes', () => {
    const onSelect = vi.fn();
    const aoi = makeAoiSelectHandlers({ getView: () => view, onSelect, minDragPixels: 0 });

    expect(aoi.active).toBe(false);
    aoi.begin({ clientX: 40, clientY: 40 });
    expect(aoi.active).toBe(true);
    expect(aoi.rectangle).toEqual({ x: 40, y: 40, width: 0, height: 0 });

    aoi.drag({ clientX: 520, clientY: 300 });
    expect(aoi.rectangle).toEqual({ x: 40, y: 40, width: 480, height: 260 });

    aoi.finish();
    expect(onSelect).toHaveBeenCalledTimes(1);
    const emitted = onSelect.mock.calls[0][0] as [number, number, number, number];
    expect(emitted).toHaveLength(4);
    expect(emitted[0]).toBeLessThan(emitted[2]);
    expect(emitted[1]).toBeLessThan(emitted[3]);
    expect(emitted).toEqual(aoi.lastBbox);
    expect(aoi.active).toBe(false);
    expect(aoi.rectangle).toBeNull();
  });

  it('reads the viewport lazily, so a re-render never drops the drag', () => {
    let current = makeViewport(AOI);
    const onSelect = vi.fn();
    const aoi = makeAoiSelectHandlers({ getView: () => current, onSelect });
    aoi.begin({ clientX: 100, clientY: 100 });
    current = makeViewport(AOI);
    aoi.drag({ clientX: 400, clientY: 250 });
    aoi.finish();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('ignores a click too small to be an AOI', () => {
    const onSelect = vi.fn();
    const aoi = makeAoiSelectHandlers({ getView: () => view, onSelect, minDragPixels: 10 });
    aoi.begin({ clientX: 100, clientY: 100 });
    aoi.drag({ clientX: 102, clientY: 103 });
    aoi.finish();
    expect(onSelect).not.toHaveBeenCalled();
    expect(aoi.lastBbox).toBeNull();
  });

  it('cancel drops the in-flight drag without emitting', () => {
    const onSelect = vi.fn();
    const aoi = makeAoiSelectHandlers({ getView: () => view, onSelect });
    aoi.begin({ clientX: 100, clientY: 100 });
    aoi.cancel();
    aoi.drag({ clientX: 400, clientY: 250 });
    aoi.finish();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('backscatter dB probe', () => {
  const view = makeViewport(AOI);

  it('returns the cell value under a cursor position', () => {
    // Centre of the plot lands on the middle of a 4x4 grid.
    const readout = probeAt({ rows: GRID }, view, { x: view.rect.width / 2, y: view.rect.height / 2 });
    expect(readout.db).toBe(-6);
    expect(readout.row).toBeGreaterThanOrEqual(0);
    expect(readout.col).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(readout.lat)).toBe(true);
    expect(Number.isFinite(readout.lon)).toBe(true);
  });

  it('reads a specific corner cell', () => {
    const tl = geoToCanvas(view, AOI[3], AOI[0]);
    const first = probeAt({ rows: GRID }, view, { x: tl.x + 1, y: tl.y + 1 });
    expect(first.row).toBe(0);
    expect(first.col).toBe(0);
    expect(first.db).toBe(-28);
  });

  it('never interpolates or invents a value when there is no raster', () => {
    const readout = probeAt(null, view, { x: 200, y: 200 });
    expect(readout.db).toBeNull();
    expect(readout.row).toBeNull();
    expect(readout.col).toBeNull();
    expect(Number.isFinite(readout.lat)).toBe(true);
  });

  it('reports a null value for a non-finite cell instead of coercing it', () => {
    const readout = probeAt({ rows: [[Number.NaN]] }, view, { x: 200, y: 200 });
    expect(readout.db).toBeNull();
    expect(readout.row).toBe(0);
  });

  it('drives a handler factory that emits a readout per pointer event', () => {
    const onReadout = vi.fn();
    const handler = makeProbeHandler({ rows: GRID }, view, onReadout);
    handler({ clientX: view.rect.width / 2, clientY: view.rect.height / 2 });
    expect(onReadout).toHaveBeenCalledTimes(1);
    expect(onReadout.mock.calls[0][0].db).toBeTypeOf('number');
  });
});

describe('graticule, scale bar and colour', () => {
  it('labels meridians and parallels with a signed hemisphere', () => {
    const lines = graticule(AOI, 4);
    expect(lines.lons).toHaveLength(5);
    expect(lines.lats).toHaveLength(5);
    expect(lines.lons[0].label).toBe('103.65 E');
    expect(lines.lats[0].label).toBe('1.10 N');
    expect(formatDegree(-73.4, 'lon')).toBe('73.40 W');
    expect(formatDegree(-1.2, 'lat')).toBe('1.20 S');
  });

  it('produces a nautical-mile scale bar inside the target width', () => {
    const view = makeViewport(AOI);
    const bar = scaleBar(view, 120);
    expect(bar).not.toBeNull();
    expect(bar!.nauticalMiles).toBeGreaterThan(0);
    expect(bar!.pixels).toBeLessThanOrEqual(120.001);
    expect(bar!.label).toMatch(/NM$/);
    expect(bar!.meters).toBeCloseTo(bar!.nauticalMiles * 1852, 6);
  });

  it('has no scale bar for a degenerate extent', () => {
    // A zero-width AOI would make any bar a fabricated distance.
    expect(scaleBar(makeViewport([10, 5, 10, 6]))).toBeNull();
    expect(scaleBar(makeViewport([10, 6, 9, 5]))).toBeNull();
  });

  it('offers three raster colormaps and three heatmap palettes', () => {
    expect(RASTER_COLORMAPS).toEqual(['radar-green', 'grayscale', 'night-flir']);
    expect(HEATMAP_PALETTES).toEqual(['thermal', 'turbo', 'plasma']);
    expect(colormapStops('grayscale')).toHaveLength(5);
    expect(heatmapRgb(0, 'thermal')).toEqual([5, 20, 90]);
    expect(heatmapRgb(1, 'plasma')).toEqual([255, 255, 100]);
  });

  it('clamps the display window and refuses a non-numeric cell', () => {
    expect(normalizeDisplayDb(DB_DISPLAY_MIN)).toBe(0);
    expect(normalizeDisplayDb(DB_DISPLAY_MAX)).toBe(1);
    expect(normalizeDisplayDb(DB_DISPLAY_MAX + 40)).toBe(1);
    expect(normalizeDisplayDb(Number.NaN)).toBeNull();
    expect(rasterCellCss(Number.NaN, 'grayscale')).toContain('255, 104, 104');
    expect(rasterCellCss(DB_DISPLAY_MIN, 'grayscale')).toBe('rgb(0, 0, 0)');
    expect(rasterCellCss(DB_DISPLAY_MAX, 'grayscale')).toBe('rgb(255, 255, 255)');
  });
});

describe('keyboard controls', () => {
  it('cycles a segmented control with arrows and wraps', () => {
    expect(nextSegmentIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextSegmentIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextSegmentIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextSegmentIndex('ArrowUp', 2, 3)).toBe(1);
    expect(nextSegmentIndex('Home', 2, 3)).toBe(0);
    expect(nextSegmentIndex('End', 0, 3)).toBe(2);
  });

  it('ignores keys it does not own', () => {
    expect(nextSegmentIndex('a', 0, 3)).toBeNull();
    expect(nextSegmentIndex('Enter', 0, 3)).toBeNull();
    expect(nextSegmentIndex('ArrowRight', 0, 0)).toBeNull();
    expect(isSegmentKey('ArrowLeft')).toBe(true);
    expect(isSegmentKey('Escape')).toBe(false);
  });
});

// ---------------------------------------------------------------- rendering

describe('AnalysisWorkbench render', () => {
  it('renders the colormap and heatmap controls with accessible names', () => {
    const html = render({ bbox: AOI, grid: { rows: GRID } });
    expect(html).toContain('aria-label="Raster colormap"');
    for (const id of RASTER_COLORMAPS) {
      expect(html).toContain(`data-df-option="${id}"`);
      expect(html).toContain(`Raster colormap: `);
    }
    expect(html).toContain('aria-label="Heatmap palette"');
    for (const id of HEATMAP_PALETTES) {
      expect(html).toContain(`data-df-option="${id}"`);
    }
    expect(html).toContain('data-df-heatmap-opacity');
    expect(html).toContain('aria-label="Heatmap opacity"');
  });

  it('renders all three speckle modes, and lee is selectable', () => {
    const html = render({ bbox: AOI });
    expect(html).toContain('data-df-speckle-group');
    for (const mode of SPECKLE_MODES) {
      expect(html).toContain(`data-df-speckle="${mode}"`);
      // A legacy bug made `lee` unreachable: it must not be disabled.
      expect(html).not.toMatch(new RegExp(`data-df-speckle="${mode}"[^>]*disabled`));
    }
    expect(html).toContain('aria-label="Speckle filter: Lee (edge-preserving)"');
    expect(html).toContain('aria-checked="true"');
  });

  it('renders all eight CFAR parameters, including the ones the legacy UI omitted', () => {
    const html = render({ bbox: AOI });
    for (const key of [
      'trainingCells',
      'guardCells',
      'thresholdFactor',
      'minPixels',
      'maxPixels',
      'kernelSize',
      'coastlineBufferMeters',
    ]) {
      expect(html).toContain(`data-df-param="${key}"`);
    }
    expect(html).toContain('data-df-cfar-preset="standard"');
    expect(html).toContain('data-df-cfar-preset="high-sensitivity"');
    expect(html).toContain('data-df-cfar-preset="high-clutter"');
  });

  it('starts clean and signals the recomputation requirement on any change', () => {
    const clean = render({ bbox: AOI, cfarConfig: DEFAULT_CFAR_CONFIG });
    expect(clean).toContain('data-df-recompute="clean"');
    expect(clean).not.toContain('data-df-recompute-diff');
    expect(clean).toContain('No parameter change');

    // A draft that differs from the baseline the backend last used.
    const edited = render({
      bbox: AOI,
      cfarConfig: DEFAULT_CFAR_CONFIG,
      pendingConfig: updateParam(DEFAULT_CFAR_CONFIG, 'speckleFilter', 'lee'),
    });
    expect(edited).toContain('data-df-recompute="required"');
    expect(edited).toContain('data-df-recompute-diff');
    expect(edited).toContain('data-df-recompute-key="speckleFilter"');
    expect(edited).toContain('3x3 median');
    expect(edited).toContain('Lee (edge-preserving)');
    expect(edited).toContain('must recompute');
  });

  it('offers a backend recompute request and never a local detect button', () => {
    const html = render({ bbox: AOI });
    expect(html).toContain('data-df-recompute-request');
    expect(html).toContain('Request backend recompute');
    expect(html).toMatch(/computes neither/);
  });

  it('draws the graticule with lat/lon labels and a nautical-mile scale bar', () => {
    const html = render({ bbox: AOI, grid: { rows: GRID } });
    expect(html).toContain('data-df-graticule');
    expect(html).toContain('data-df-graticule-label="lon:103.65 E"');
    expect(html).toContain('data-df-graticule-label="lat:1.10 N"');
    expect(html).toContain('data-df-scale-bar');
    expect(html).toMatch(/data-df-scale-label="[0-9.]+ ?NM"/);
  });

  it('renders the backend raster cells with their dB values', () => {
    const html = render({ bbox: AOI, grid: { rows: GRID } });
    expect(html).toContain('data-df-raster-preview');
    expect(html).toContain('data-df-raster-cell="0:0"');
    expect(html).toContain('data-df-raster-db="-28"');
  });

  it('states the grid size instead of drawing a raster it cannot render', () => {
    const big = {
      rows: Array.from({ length: MAX_INLINE_CELL_SIDE + 1 }, () =>
        Array.from({ length: MAX_INLINE_CELL_SIDE + 1 }, () => -10),
      ),
    };
    const html = render({ bbox: AOI, grid: big });
    expect(html).not.toContain('data-df-raster-preview');
    expect(html).toContain('data-df-raster-summary');
    expect(html).toMatch(/too large to draw inline/);
  });

  it('says nothing is drawn when there is no backend raster', () => {
    const html = render({ bbox: AOI, grid: null });
    expect(html).toContain('No backend raster for this scan');
    expect(html).not.toContain('data-df-raster-preview');
  });

  it('says when no AOI is loaded instead of inventing an extent', () => {
    const html = render({ bbox: null });
    expect(html).toContain('data-df-plot-empty');
    expect(html).toContain('No area of interest is loaded');
    expect(html).not.toContain('data-df-graticule');
  });

  it('names the AOI it is drawing and reports no selection yet', () => {
    const html = render({ bbox: AOI });
    expect(html).toContain('data-df-plot-surface');
    expect(html).toContain('data-df-aoi-bbox="none"');
    expect(html).toContain('103.650, 1.100, 104.050, 1.400');
    expect(html).toContain('Position telemetry idle');
    expect(html).toContain('no cell value');
  });

  it('gives every interactive control an accessible name', () => {
    const html = render({ bbox: AOI, grid: { rows: GRID }, debugEnabled: true, scanId: null });
    const offenders: string[] = [];
    for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const [, attrs, body] = match;
      if (/aria-label="[^"]+"/.test(attrs)) continue;
      const visible = body.replace(/<[^>]*>/g, '').trim();
      if (visible.length === 0) offenders.push(attrs.slice(0, 80));
    }
    expect(offenders).toEqual([]);
  });
});
