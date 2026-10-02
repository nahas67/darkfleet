/**
 * Debug-layer registry tests (UI-016).
 *
 * DOM-free by design, matching `src/app/SpatialShell.test.ts`: the repo runs
 * vitest in a `node` environment with no jsdom, so the surface is rendered
 * through `react-dom/server` and the registry itself is exercised as pure data.
 * No network: every `ApiClient` is an injected stub.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DebugLayerId } from '../types/api.ts';
import type { DebugLayerResponse, LayerStats } from '../app/useApi.ts';
import {
  DEBUG_LAYER_DEFS,
  DEBUG_LAYER_IDS,
  debugLayerById,
  debugLayerPath,
  debugLayerUnavailableReason,
  debugLayerView,
  declaredOnlyLayers,
  isAliasResponse,
  isDebugEnabled,
  recomputeSensitiveLayers,
  statRows,
} from './debugLayers.ts';
import { AnalysisWorkbench, DebugLayerPanel, DebugStatsTable } from './AnalysisWorkbench.tsx';

// ------------------------------------------------------------- the 13 ids

const THE_THIRTEEN: readonly DebugLayerId[] = [
  'raw',
  'normalized',
  'landmask',
  'filtered',
  'cfar_threshold',
  'detection_mask',
  'components',
  'centroids',
  'ais_observations',
  'ais_predicted',
  'match_radius',
  'correlation_lines',
  'score_decomposition',
];

describe('debug layer registry', () => {
  it('registers exactly the 13 declared ids, in pipeline order', () => {
    expect(DEBUG_LAYER_DEFS).toHaveLength(13);
    expect(DEBUG_LAYER_IDS).toEqual(THE_THIRTEEN);
  });

  it('gives every layer an id, a title and an endpoint path', () => {
    for (const def of DEBUG_LAYER_DEFS) {
      expect(def.id).toBeTruthy();
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.path).toBe(`/api/debug/{scan_id}/${def.endpoint}`);
      expect(def.path.endsWith(def.id)).toBe(true);
      expect(def.kind === 'array' || def.kind === 'table').toBe(true);
      expect(typeof def.requiresRecomputation).toBe('boolean');
      expect(def.recomputeReason.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate ids', () => {
    const ids = DEBUG_LAYER_DEFS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('substitutes the scan id and encodes both segments', () => {
    expect(debugLayerPath('DF-0001', 'raw')).toBe('/api/debug/DF-0001/raw');
    expect(debugLayerPath('DF 0001', 'detection_mask')).toBe('/api/debug/DF%200001/detection_mask');
    expect(() => debugLayerPath('DF-0001', 'nope' as DebugLayerId)).toThrow(/unknown debug layer/);
  });

  it('marks only parameter-dependent layers as needing recomputation', () => {
    const sensitive = recomputeSensitiveLayers().map((def) => def.id);
    expect(sensitive).toEqual([
      'filtered',
      'cfar_threshold',
      'detection_mask',
      'components',
      'centroids',
      'match_radius',
      'correlation_lines',
      'score_decomposition',
    ]);
    // Read straight off the scene, so a parameter edit cannot move them.
    expect(debugLayerById('raw')?.requiresRecomputation).toBe(false);
    expect(debugLayerById('normalized')?.requiresRecomputation).toBe(false);
    expect(debugLayerById('landmask')?.requiresRecomputation).toBe(false);
  });

  it('declares the five layers the backend does not serve, with a stated reason', () => {
    const blocked = declaredOnlyLayers();
    expect(blocked.map((def) => def.id)).toEqual([
      'ais_observations',
      'ais_predicted',
      'match_radius',
      'correlation_lines',
      'score_decomposition',
    ]);
    for (const def of blocked) {
      expect(def.unavailableReason).toBeTruthy();
      expect(def.unavailableReason).toMatch(/does not serve/i);
    }
  });

  it('declares the normalized -> raw alias rather than hiding it', () => {
    const def = debugLayerById('normalized');
    expect(def?.aliasOf).toBe('raw');
    expect(def?.source).toBe('raw_db');
  });
});

// --------------------------------------------------------------- ?debug gate

describe('?debug=true gating', () => {
  it.each([
    '?debug=true',
    'debug=true',
    '?a=1&debug=true&b=2',
    '?debug=TRUE',
    '?debug=1',
    '?debug=yes',
    '?debug=on',
    'http://localhost:5173/?debug=true',
  ])('enables the debug surface for %s', (search) => {
    expect(isDebugEnabled(search)).toBe(true);
  });

  it.each(['', '?', '?debug', '?debug=false', '?debug=0', '?debug=nope', null, undefined])(
    'keeps the debug surface hidden for %s',
    (search) => {
      expect(isDebugEnabled(search)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------- view model

const STATS: LayerStats = {
  size: 4096,
  min: -27.5,
  max: 4.25,
  mean: -18.125,
  std: 3.5,
  p01: -26,
  p50: -18.5,
  p99: -2,
  nan_count: 12,
  finite_fraction: 0.997,
  true_count: null,
};

function response(overrides: Partial<DebugLayerResponse> = {}): DebugLayerResponse {
  return {
    scan_id: 'DF-0001',
    layer: 'raw',
    kind: 'array',
    source: 'raw_db',
    shape: [64, 64],
    dtype: 'float32',
    stats: STATS,
    columns: null,
    rows: null,
    row_limit: null,
    truncated: false,
    grid_size: null,
    grid: null,
    ...overrides,
  } as DebugLayerResponse;
}

describe('debugLayerView', () => {
  it('reports IDLE with no invented data when nothing was requested', () => {
    const view = debugLayerView(debugLayerById('raw')!);
    expect(view.state).toBe('IDLE');
    expect(view.stats).toBeNull();
    expect(view.statRows).toEqual([]);
    expect(view.detail).toMatch(/not requested/i);
  });

  it('renders backend stats verbatim and never fills a null field', () => {
    const view = debugLayerView(debugLayerById('raw')!, { response: response() });
    expect(view.state).toBe('AVAILABLE');
    expect(view.stats).toBe(STATS);
    const rows = statRows(STATS);
    // true_count was null on the wire, so it must not appear as 0.
    expect(rows.find((row) => row.key === 'true_count')?.value).toBeNull();
    expect(rows.find((row) => row.key === 'mean')?.value).toBe('-18.125');
    expect(view.statsMissing).toBe(false);
  });

  it('says so when the backend sent no statistics at all', () => {
    const view = debugLayerView(
      debugLayerById('raw')!,
      { response: response({ stats: null }) },
    );
    expect(view.stats).toBeNull();
    expect(view.detail).toMatch(/no statistics reported/i);
  });

  it('says so when no derived statistic was reported', () => {
    // size / nan_count / finite_fraction are always numeric, so they do not
    // count as a reported statistic.
    const countersOnly: LayerStats = {
      size: 0,
      min: null,
      max: null,
      mean: null,
      std: null,
      p01: null,
      p50: null,
      p99: null,
      nan_count: 0,
      finite_fraction: 0,
      true_count: null,
    };
    const view = debugLayerView(debugLayerById('raw')!, {
      response: response({ stats: countersOnly }),
    });
    expect(view.statsMissing).toBe(true);
    expect(view.detail).toMatch(/no distributional statistics reported/i);

    // A boolean layer carries a real number (true_count) and must not be
    // reported as statistic-less.
    const booleanLayer: LayerStats = { ...countersOnly, true_count: 37 };
    expect(debugLayerView(debugLayerById('raw')!, {
      response: response({ stats: booleanLayer }),
    }).statsMissing).toBe(false);
  });

  it('surfaces the normalized -> raw_db alias instead of hiding it', () => {
    const def = debugLayerById('normalized')!;
    const view = debugLayerView(def, {
      response: response({ layer: 'normalized', source: 'raw_db' }),
    });
    expect(isAliasResponse(def, response({ layer: 'normalized', source: 'raw_db' }))).toBe(true);
    expect(view.aliasOf).toBe('raw');
    expect(view.notes.join(' ')).toMatch(/alias of "raw"/i);
  });

  it('keeps the backend notes, including the calibrated-grid explanation', () => {
    const view = debugLayerView(debugLayerById('normalized')!, {
      response: response({
        layer: 'normalized',
        source: 'raw_db',
        notes: ['normalized reports the calibrated dB grid (raw_db); no separate artifact exists.'],
      } as Partial<DebugLayerResponse>),
    });
    expect(view.notes[0]).toMatch(/calibrated dB grid/i);
  });

  it('marks recompute-sensitive layers stale when the config moved', () => {
    const sensitive = debugLayerView(debugLayerById('detection_mask')!, {
      response: response({ layer: 'detection_mask', source: 'cfar_mask' }),
      stale: true,
    });
    expect(sensitive.stale).toBe(true);
    const insensitive = debugLayerView(debugLayerById('raw')!, {
      response: response(),
      stale: true,
    });
    expect(insensitive.stale).toBe(false);
  });

  it.each([
    ['UNKNOWN_DEBUG_LAYER', /does not recognise/i],
    ['UNKNOWN_SCAN', /No completed scan/i],
    ['LAYERS_NOT_AVAILABLE', /no debug layer index/i],
    ['LAYER_NOT_STORED', /did not store/i],
    ['EMPTY_RESPONSE', /no JSON body/i],
    ['NETWORK_ERROR', /could not be reached/i],
  ])('maps %s into a stated reason', (code, pattern) => {
    const def = debugLayerById('raw')!;
    const reason = debugLayerUnavailableReason(def, { code, message: '' });
    expect(reason).toMatch(pattern);
    const view = debugLayerView(def, { error: { code, message: '' } });
    expect(view.state).toBe('UNAVAILABLE');
    expect(view.reason).toMatch(pattern);
  });

  it('reports DECLARED_ONLY for every layer the backend refuses', () => {
    for (const def of declaredOnlyLayers()) {
      const view = debugLayerView(def);
      expect(view.state).toBe('DECLARED_ONLY');
      expect(view.stats).toBeNull();
      expect(view.reason).toBeTruthy();
    }
  });

  it('reports a truncated table honestly', () => {
    const view = debugLayerView(debugLayerById('components')!, {
      response: response({
        layer: 'components',
        kind: 'table',
        source: 'targets',
        stats: null,
        columns: ['area_px', 'mean_db'],
        rows: 812,
        row_limit: 500,
        truncated: true,
      } as Partial<DebugLayerResponse>),
    });
    expect(view.truncated).toBe(true);
    expect(view.rows).toBe(812);
    expect(view.rowLimit).toBe(500);
    expect(view.detail).toMatch(/812 rows \(500 returned\)/);
    expect(view.columns).toEqual(['area_px', 'mean_db']);
  });
});

// ---------------------------------------------------------------- rendering

describe('debug layer rendering', () => {
  it('renders an explicit unavailable state for a layer the backend cannot serve', () => {
    const def = debugLayerById('score_decomposition')!;
    const view = debugLayerView(def);
    const html = renderToStaticMarkup(
      createElement(DebugLayerPanel, { def, view }),
    );
    expect(html).toContain('data-df-debug-unavailable="score_decomposition"');
    expect(html).toContain('unavailable');
    expect(html).toContain('data-df-debug-state="DECLARED_ONLY"');
    // No stats block may be rendered in place of the missing data.
    expect(html).not.toContain('data-df-debug-stats');
  });

  it('says the backend returned no statistics instead of showing zeros', () => {
    const def = debugLayerById('raw')!;
    const html = renderToStaticMarkup(
      createElement(DebugStatsTable, {
        view: debugLayerView(def, { response: response({ stats: null }) }),
      }),
    );
    expect(html).toContain('data-df-debug-stats="absent"');
    expect(html).toContain('no statistics');
    expect(html).not.toContain('>0<');
  });

  it('lists every one of the 13 layers when ?debug=true', () => {
    const html = renderToStaticMarkup(
      createElement(AnalysisWorkbench, { debugEnabled: true, scanId: null }),
    );
    expect(html).toContain('data-df-debug');
    for (const id of THE_THIRTEEN) {
      expect(html).toContain(`data-df-debug-layer="${id}"`);
    }
    for (const id of ['ais_observations', 'match_radius', 'score_decomposition']) {
      expect(html).toContain(`data-df-debug-unavailable="${id}"`);
    }
  });

  it('omits the whole debug section when the gate is closed', () => {
    const html = renderToStaticMarkup(
      createElement(AnalysisWorkbench, { search: '?debug=false', scanId: 'DF-0001' }),
    );
    expect(html).not.toContain('data-df-debug');
    expect(html).not.toContain('data-df-debug-layer');
  });

  it('honours the raw search string when no explicit flag is passed', () => {
    const open = renderToStaticMarkup(
      createElement(AnalysisWorkbench, { search: '?debug=true', scanId: null }),
    );
    expect(open).toContain('data-df-debug');
  });
});
