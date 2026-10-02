/**
 * Spatial shell tests — DOM-free by design.
 *
 * The repo's vitest environment is `node` and neither jsdom nor happy-dom is
 * installed, so this suite renders the shell through `react-dom/server` and
 * exercises interaction logic through the exported pure functions and the
 * store. Nothing here touches the network: every client is an injected stub.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScanLauncher, ScanSurface, SpatialShell, buildScanRequest, parseBbox } from './SpatialShell.tsx';
import {
  ADVANCED_LAYER_IDS,
  appStore,
  createStore,
  initialState,
  makeCloseHandler,
  makeLayerOpacityHandler,
  makeLayerVisibilityHandler,
  makeSurfaceHandler,
  shellKeyHandler,
  summarizeProviders,
  unavailableLayers,
  visibleLayerGroups,
  visibleLayerIds,
  withLayerOpacity,
  withLayerVisible,
  withSurfaceKey,
  withToggledLayer,
  formatUtc,
} from './state.ts';
import type { AppState, SurfaceId } from './state.ts';
import {
  applyStageEvent,
  createSseDecoder,
  IDLE_SCAN_STATE,
  isScanStage,
  parseStagePayload,
  stageLabel,
  stagePosition,
  withScanAccepted,
} from './useScan.ts';
import type { ScanState } from './useScan.ts';
import {
  createApiClient,
  normaliseScanTargets,
  normaliseTarget,
  scenesUrl,
  toProvidersHealth,
  ApiError,
} from './useApi.ts';
import type { FetchLike, HealthResponse, ScanTargetsResponse, SceneSummary } from './useApi.ts';
import { LAYER_DEFS } from '../globe/registry.ts';
import { SCAN_PIPELINE } from '../types/api.ts';
import type { BoundingBox, ScanStage } from '../types/api.ts';

// ------------------------------------------------------------------- helpers

/** Minimal stub: records calls and replies with canned JSON. No network. */
function stubFetch(routes: Record<string, unknown>): {
  fetchImpl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    calls.push(input);
    const [path] = input.split('?');
    if (!(path in routes)) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: path }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const HEALTH: HealthResponse = {
  checked_at: '2026-01-02T03:04:05Z',
  runtime_mode: 'REAL',
  probe: 'live',
  providers: [
    {
      provider: 'planetary-computer',
      status: 'DEGRADED',
      detail: 'live probe returned 503',
      last_check: '2026-01-02T03:04:05Z',
      latency_ms: 812,
      error: null,
      capabilities: ['sar'],
    },
    {
      provider: 'ais-local',
      status: 'AUTH_REQUIRED',
      detail: 'no AIS credentials',
      last_check: '2026-01-02T03:04:05Z',
      latency_ms: 3,
      error: null,
      capabilities: ['local_archive'],
    },
  ],
};

function renderShell(
  state: Partial<AppState> = {},
  providers: HealthResponse | null = HEALTH,
): string {
  // SSR never runs effects, so provider health is seeded on the store: the
  // shell reads its badges from store state, exactly as it does at runtime.
  const store = createStore({
    ...state,
    providers: providers ? toProvidersHealth(providers) : state.providers ?? null,
    providersCheckedAt: providers ? providers.checked_at : state.providersCheckedAt ?? null,
    providersError: providers ? null : state.providersError ?? null,
  });
  // A fixed clock keeps the UTC readout deterministic.
  return renderToStaticMarkup(
    createElement(SpatialShell, {
      store,
      client: createApiClient(async () => new Response('{}', { status: 200 })),
      now: () => Date.parse('2026-01-02T03:04:05Z'),
    }),
  );
}

/**
 * Every control must be named: either an `aria-label`/`aria-labelledby` or
 * visible text content. Icon-only buttons therefore have to carry a label.
 */
function controlsWithoutName(html: string): string[] {
  const offenders: string[] = [];
  for (const match of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, tag, attrs, body] = match;
    if (/aria-label="[^"]+"/.test(attrs)) continue;
    if (/aria-labelledby="[^"]+"/.test(attrs)) continue;
    const visible = body
      .replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (visible) continue;
    offenders.push(`<${tag}${attrs.slice(0, 80)}>`);
  }
  return offenders;
}

// --------------------------------------------------------------------- shell

describe('SpatialShell structure', () => {
  it('renders the globe container, top bar, left rail and command dock', () => {
    const html = renderShell();
    expect(html).toContain('data-df-globe-container');
    expect(html).toContain('<header');
    expect(html).toContain('aria-label="Primary tools"');
    expect(html).toContain('aria-label="Command dock"');
  });

  it('renders the globe container as the only primary viewport, with no 2D map', () => {
    const html = renderShell();
    // The globe container is the first painted layer and full-bleed.
    const globeIndex = html.indexOf('data-df-globe-container');
    const headerIndex = html.indexOf('<header');
    expect(globeIndex).toBeGreaterThan(-1);
    expect(globeIndex).toBeLessThan(headerIndex);
    expect(html).not.toContain('leaflet');
    expect(html).not.toContain('data-testid="tactical-map"');
  });

  it('renders no dashboard frame or legacy header', () => {
    const html = renderShell();
    expect(html).not.toContain('data-testid="header"');
    expect(html).not.toContain('data-df-dashboard');
  });

  it('renders the left rail in the required order', () => {
    const html = renderShell();
    const order = ['SEARCH', 'LAYERS', 'SAR', 'AIS', 'CORRELATE', 'ANALYTICS', 'MORE'];
    const positions = order.map((id) => html.indexOf(`data-df-rail-item="${id}"`));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('renders the command dock with SEARCH / SCAN / TIME / LAYERS / VIEW', () => {
    const html = renderShell();
    for (const id of ['SEARCH', 'SCAN', 'TIME', 'LAYERS', 'VIEW']) {
      expect(html).toContain(`data-df-dock-item="${id}"`);
    }
  });

  it('does not hide Cesium attribution anywhere in the shell markup', () => {
    const html = renderShell();
    expect(html).not.toMatch(/credits?[^\n]*display:\s*none/i);
    expect(html).not.toMatch(/cesium-widget-credits/);
  });

  it('renders provider status from the live probe, never a hardcoded online', () => {
    const html = renderShell();
    expect(html).toContain('data-df-provider="SAR"');
    expect(html).toContain('data-df-provider="AIS"');
    // The real states, not "Online".
    expect(html).toContain('Degraded');
    expect(html).toContain('Auth required');
    expect(html).not.toMatch(/data-df-provider="SAR"[^>]*>\s*Online/);
  });

  it('shows the UTC clock in Z form', () => {
    const html = renderShell();
    expect(html).toContain('03:04:05Z');
  });

  it('gives every icon-only control an accessible name', () => {
    expect(controlsWithoutName(renderShell())).toEqual([]);
  });

  it('gives every control an accessible name with a surface open too', () => {
    for (const surface of ['LAYERS', 'SAR', 'AIS', 'MORE', 'TIME', 'VIEW'] as SurfaceId[]) {
      const html = renderShell({ openSurface: surface });
      expect(controlsWithoutName(html)).toEqual([]);
    }
  });
});

// -------------------------------------------------- no runtime mode anywhere
//
// The synthetic runtime was removed from the product. These tests assert the
// ABSENCE of the mode control rather than its styling: there is no mode to
// pick, so no surface may offer one, and nothing may imply the product can
// fabricate data.

describe('runtime mode is not a user choice', () => {
  it('renders no mode toggle anywhere in the shell', () => {
    const html = renderShell();
    expect(html).not.toContain('data-df-mode');
    expect(html).not.toContain('Runtime mode');
  });

  it('never names a synthetic mode in any accessible label', () => {
    for (const surface of [
      'LAYERS', 'SAR', 'AIS', 'MORE', 'TIME', 'VIEW', 'SCAN', 'SEARCH',
      'CORRELATE', 'ANALYTICS',
    ] as SurfaceId[]) {
      const html = renderShell({ openSurface: surface });
      expect(html.toLowerCase()).not.toContain('demo');
      expect(html.toLowerCase()).not.toContain('synthetic');
    }
  });

  it('keeps the top bar essentials the mode pill used to sit beside', () => {
    const html = renderShell();
    expect(html).toContain('DARKFLEET');
    expect(html).toContain('data-df-provider="SAR"');
    expect(html).toContain('data-df-provider="AIS"');
    expect(html).toContain('03:04:05Z');
    expect(html).toContain('aria-label="Settings and source health"');
  });

  it('leaves no dangling aria-pressed behind in the top bar', () => {
    // The removed pill carried two `aria-pressed` buttons. Nothing it owned may
    // survive as an orphaned pressed-state attribute.
    const header = renderShell().slice(0, renderShell().indexOf('</header>'));
    expect(header).not.toContain('aria-pressed');
  });

  it('has no mode field on the store state at all', () => {
    expect(Object.keys(initialState())).not.toContain('mode');
    expect('mode' in initialState()).toBe(false);
  });

  it('exposes no mode setter on the store contract', () => {
    const store = createStore();
    expect(Object.keys(store)).not.toContain('setMode');
    expect('setMode' in store).toBe(false);
  });
});

// -------------------------------------------------------------- layers panel

describe('Layers panel', () => {
  const available = LAYER_DEFS.filter((l) => l.capabilityState === 'AVAILABLE');

  it('hides NOT_AVAILABLE layers from the interactive list', () => {
    const html = renderShell({ openSurface: 'LAYERS' });
    for (const layer of available) {
      expect(html).toContain(`data-df-layer="${layer.id}"`);
    }
    for (const id of ADVANCED_LAYER_IDS) {
      // Present only inside the disabled "not available" block, never checked.
      const occurrences = html.split(`data-df-layer="${id}"`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it('renders advanced layers as disabled with a stated reason', () => {
    const html = renderShell({ openSurface: 'LAYERS' });
    expect(html).toContain('data-df-layers-unavailable');
    for (const id of ADVANCED_LAYER_IDS) {
      const row = html.slice(html.indexOf(`data-df-layer="${id}"`));
      const tag = row.match(/<button[^>]*>/)?.[0] ?? '';
      expect(tag).toContain('disabled');
      // The reason must name the real cause: no data source. The old copy
      // blamed a milestone ("until CP15"), which is not why it is gated.
      expect(tag).toContain('no data source');
      expect(tag).not.toContain('until CP15');
    }
  });

  it('never emits a NOT_AVAILABLE layer id through visibleLayerIds', () => {
    const state = initialState();
    for (const id of ADVANCED_LAYER_IDS) {
      expect(visibleLayerIds(state)).not.toContain(id);
    }
  });

  it('cannot be made visible or given opacity by the reducers', () => {
    const state = initialState();
    for (const id of ADVANCED_LAYER_IDS) {
      expect(withLayerVisible(state, id, true)).toBe(state);
      expect(withLayerOpacity(state, id, 0.5)).toBe(state);
      expect(withToggledLayer(state, id)).toBe(state);
    }
  });

  it('reports the advanced layers as unavailable', () => {
    const ids = unavailableLayers(initialState()).map((l) => l.id);
    expect(new Set(ids)).toEqual(new Set(ADVANCED_LAYER_IDS));
  });

  it('groups the available layers by registry group, in declared order', () => {
    const groups = visibleLayerGroups(initialState()).map((g) => g.group);
    expect(groups).toEqual(['IMAGERY', 'CONTACTS', 'ANALYSIS', 'REFERENCE']);
    for (const group of groups) {
      for (const item of visibleLayerGroups(initialState()).find((g) => g.group === group)!.items) {
        expect(item.capabilityState).toBe('AVAILABLE');
      }
    }
  });

  it('applies visibility and opacity through the store handlers', () => {
    const store = createStore();
    makeLayerVisibilityHandler(store, 'AIS_CONTACTS')(false);
    expect(store.getState().layers.AIS_CONTACTS.visible).toBe(false);
    makeLayerOpacityHandler(store, 'SAR_RASTER')('0.4');
    expect(store.getState().layers.SAR_RASTER.opacity).toBeCloseTo(0.4);
  });

  it('ignores opacity on layers that do not support it', () => {
    const store = createStore();
    const before = store.getState();
    makeLayerOpacityHandler(store, 'BASE_WORLD')('0.2');
    expect(store.getState()).toBe(before);
  });

  it('ignores a non-numeric opacity input', () => {
    const store = createStore();
    const before = store.getState();
    makeLayerOpacityHandler(store, 'SAR_RASTER')('not-a-number');
    expect(store.getState()).toBe(before);
  });
});

// ------------------------------------------------------- surfaces and Escape

describe('Rail, dock and Escape', () => {
  it('opens a surface from the rail through the bound handler', () => {
    const store = createStore();
    makeSurfaceHandler(store, 'LAYERS')();
    expect(store.getState().openSurface).toBe('LAYERS');
  });

  it('opens a surface from the dock through the bound handler', () => {
    const store = createStore();
    makeSurfaceHandler(store, 'SCAN')();
    expect(store.getState().openSurface).toBe('SCAN');
  });

  it('closes the surface when the same entry is selected again', () => {
    const store = createStore();
    const toggle = makeSurfaceHandler(store, 'SAR');
    toggle();
    expect(store.getState().openSurface).toBe('SAR');
    toggle();
    expect(store.getState().openSurface).toBeNull();
  });

  it('only ever has one surface open', () => {
    const store = createStore();
    makeSurfaceHandler(store, 'SAR')();
    makeSurfaceHandler(store, 'ANALYTICS')();
    expect(store.getState().openSurface).toBe('ANALYTICS');
  });

  it('Escape closes the open surface', () => {
    const store = createStore({ openSurface: 'LAYERS' });
    shellKeyHandler(store)({ key: 'Escape' });
    expect(store.getState().openSurface).toBeNull();
  });

  it('Escape does nothing when no surface is open', () => {
    const store = createStore();
    const before = store.getState();
    shellKeyHandler(store)({ key: 'Escape' });
    expect(store.getState()).toBe(before);
  });

  it('ignores every key other than Escape', () => {
    const store = createStore({ openSurface: 'LAYERS' });
    for (const key of ['Enter', 'a', 'Tab', 'ArrowDown', ' ']) {
      shellKeyHandler(store)({ key });
      expect(store.getState().openSurface).toBe('LAYERS');
    }
  });

  it('closes via the bound close handler', () => {
    const store = createStore({ openSurface: 'MORE' });
    makeCloseHandler(store)();
    expect(store.getState().openSurface).toBeNull();
  });

  it('withSurfaceKey returns the identical state for non-Escape keys', () => {
    const state = initialState({ openSurface: 'SAR' });
    expect(withSurfaceKey(state, 'q')).toBe(state);
    expect(withSurfaceKey(state, 'Escape').openSurface).toBeNull();
  });

  it('renders no dialog when nothing is selected', () => {
    expect(renderShell()).not.toContain('role="dialog"');
  });

  it('renders exactly one dialog when a surface is selected', () => {
    const html = renderShell({ openSurface: 'LAYERS' });
    expect(html.split('role="dialog"').length - 1).toBe(1);
  });

  it('labels each surface dialog with its title', () => {
    const html = renderShell({ openSurface: 'SEARCH' });
    expect(html).toContain('aria-label="Spatial search"');
  });

  it('marks the selected rail and dock entries as pressed', () => {
    const html = renderShell({ openSurface: 'SAR' });
    expect(
      html.match(/<button[^>]*data-df-rail-item="SAR"[^>]*>/)?.[0],
    ).toContain('aria-pressed="true"');
    expect(
      html.match(/<button[^>]*data-df-rail-item="LAYERS"[^>]*>/)?.[0],
    ).toContain('aria-pressed="false"');
  });

  it('gives the dock its own toolbar role and label', () => {
    const html = renderShell();
    expect(html).toContain('role="toolbar"');
  });

  it('mounts the real timeline, not the CP15 placeholder', () => {
    const html = renderShell({ openSurface: 'TIME' });
    // The placeholder asserted here was dead code: it claimed the backend had
    // no timeline source. The real Timeline renders an acquisition-only state
    // when no scan is loaded, and never fabricates playback.
    expect(html).not.toContain('not available until CP15');
    expect(html).toMatch(/data-df-timeline|SAR acquisition|Timeline/i);
  });

  it('mounts the contacts surface on AIS and the inspector on CORRELATE', () => {
    // Both components were delivered but unreachable from the shell.
    expect(renderShell({ openSurface: 'AIS' })).toMatch(/data-df-contacts|SAR TARGETS|AIS CONTACTS/i);
    expect(renderShell({ openSurface: 'CORRELATE' })).toMatch(
      /data-df-inspector|OBSERVED|Select a target|No target selected/i,
    );
  });
});

// ----------------------------------------------------------------- scan hook

describe('useScan: real SSE stage events', () => {
  const frame = (stage: ScanStage, detail = '', terminal = false): string =>
    `event: stage\ndata: ${JSON.stringify({
      scan_id: 'scan-1',
      stage,
      timestamp: '2026-01-02T03:04:05Z',
      detail,
      terminal,
    })}\n\n`;

  it('decodes the backend SSE frame format', () => {
    const decode = createSseDecoder();
    const frames = decode(frame('QUEUED', 'accepted'));
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('stage');
    const payload = parseStagePayload(frames[0].data);
    expect(payload).toEqual({
      stage: 'QUEUED',
      timestamp: '2026-01-02T03:04:05Z',
      detail: 'accepted',
    });
  });

  it('ignores the backend keep-alive comment', () => {
    const decode = createSseDecoder();
    expect(decode(': darkfleet scan stream\n\n')).toEqual([]);
  });

  it('reassembles frames split across chunks', () => {
    const decode = createSseDecoder();
    const full = frame('DETECTING', 'thresholding');
    const cut = Math.floor(full.length / 2);
    expect(decode(full.slice(0, cut))).toEqual([]);
    const frames = decode(full.slice(cut));
    expect(frames).toHaveLength(1);
    expect(parseStagePayload(frames[0].data)?.stage).toBe('DETECTING');
  });

  it('handles CRLF framing', () => {
    const decode = createSseDecoder();
    const frames = decode(frame('SCORING').replace(/\n/g, '\r\n'));
    expect(parseStagePayload(frames[0].data)?.stage).toBe('SCORING');
  });

  it('returns null for the backend timeout notice (stage: null)', () => {
    expect(
      parseStagePayload(JSON.stringify({ scan_id: 'x', stage: null, timed_out: true })),
    ).toBeNull();
  });

  it('returns null for malformed JSON rather than inventing a stage', () => {
    expect(parseStagePayload('{not json')).toBeNull();
  });

  it('folds real stage events onto state in order', () => {
    let state = withScanAccepted(IDLE_SCAN_STATE, {
      scan_id: 'scan-1',
      runtime_mode: 'REAL',
      synthetic: false,
    });
    expect(state.runtimeMode).toBe('REAL');
    expect(state.synthetic).toBe(false);
    expect(state.connection).toBe('CONNECTING');

    for (const stage of ['SEARCHING_SCENE', 'READING_SAR', 'CORRELATING'] as ScanStage[]) {
      state = applyStageEvent(state, {
        stage,
        timestamp: '2026-01-02T03:04:05Z',
        detail: '',
      });
    }
    expect(state.stage).toBe('CORRELATING');
    expect(state.history).toHaveLength(3);
    expect(state.terminal).toBe(false);
  });

  it('marks COMPLETE as terminal and closes the stream', () => {
    let state = withScanAccepted(IDLE_SCAN_STATE, {
      scan_id: 'scan-1',
      runtime_mode: 'REAL',
      synthetic: false,
    });
    state = applyStageEvent(state, {
      stage: 'COMPLETE',
      timestamp: '2026-01-02T03:05:00Z',
      detail: 'persisted',
    });
    expect(state.terminal).toBe(true);
    expect(state.connection).toBe('CLOSED');
    expect(state.error).toBeNull();
    expect(state.runtimeMode).toBe('REAL');
    expect(state.synthetic).toBe(false);
  });

  it('records the backend failure detail instead of a generic message', () => {
    const state = applyStageEvent(IDLE_SCAN_STATE, {
      stage: 'FAILED',
      timestamp: '2026-01-02T03:05:00Z',
      detail: 'CFAR config invalid',
    });
    expect(state.terminal).toBe(true);
    expect(state.error).toBe('CFAR config invalid');
  });

  it('surfaces an unmodelled stage verbatim instead of coercing it', () => {
    const state = applyStageEvent(IDLE_SCAN_STATE, {
      stage: 'QUANTUM_ENTANGLING' as ScanStage,
      timestamp: '2026-01-02T03:05:00Z',
      detail: '',
    });
    expect(state.unknownStages).toEqual(['QUANTUM_ENTANGLING']);
    // The displayed stage is unchanged rather than a guess.
    expect(state.stage).toBeNull();
  });

  it('never produces a percentage, ratio or progress figure', () => {
    const serialised = JSON.stringify(
      applyStageEvent(withScanAccepted(IDLE_SCAN_STATE, {
        scan_id: 'scan-1',
        runtime_mode: 'REAL',
        synthetic: false,
      }), { stage: 'DETECTING', timestamp: '', detail: '' }),
    );
    expect(serialised).not.toMatch(/percent|progress|ratio|fraction|0\.\d+/i);
  });

  it('reports a stage counter, not a completion estimate', () => {
    // `total` is derived, not restated: it used to be a literal in three places
    // that all had to move together whenever the pipeline changed.
    const total = SCAN_PIPELINE.length;
    // Indices stay explicit -- they are what pins GEOLOCATING's position
    // (8, between EXTRACTING and LOADING_AIS) in the rendered counter.
    expect(stagePosition('QUEUED')).toEqual({ index: 1, total });
    expect(stagePosition('EXTRACTING')).toEqual({ index: 8, total });
    expect(stagePosition('GEOLOCATING')).toEqual({ index: 9, total });
    expect(stagePosition('CORRELATING')).toEqual({ index: 12, total });
    expect(stagePosition('COMPLETE')).toEqual({ index: total, total });
    expect(stagePosition('FAILED')).toBeNull();
    expect(stagePosition(null)).toBeNull();
    // Deliberate tripwire, mirroring the backend's ScanStage count: 15 as of
    // GEO-CORR, which added GEOLOCATING.
    expect(SCAN_PIPELINE).toHaveLength(15);
  });

  it('labels stages and passes unknown names through', () => {
    expect(stageLabel('SEARCHING_SCENE')).toBe('Searching scene');
    expect(stageLabel('WHAT_IS_THIS')).toBe('WHAT_IS_THIS');
  });

  it('recognises every pipeline stage plus FAILED', () => {
    for (const stage of [...SCAN_PIPELINE, 'FAILED' as ScanStage]) {
      expect(isScanStage(stage)).toBe(true);
    }
    expect(isScanStage('NOPE')).toBe(false);
  });

  it('labels a scan panel with the backend mode and shows no percentage', () => {
    const scan: ScanState = applyStageEvent(
      withScanAccepted(IDLE_SCAN_STATE, {
        scan_id: 'scan-1',
        runtime_mode: 'REAL',
        synthetic: false,
      }),
      { stage: 'CORRELATING', timestamp: '', detail: 'matching' },
    );
    // `ScanSurface` is exported so the scan UI can be asserted directly against
    // a state built from real backend stage events.
    const html = renderToStaticMarkup(createElement(ScanSurface, { scan, store: createStore() }));

    // No mode chip: there is no mode to report or to pick.
    expect(html).not.toContain('data-df-scan-mode');
    expect(html.toLowerCase()).not.toContain('synthetic');
    // Real stage name plus a counter, never a percentage or a progress bar.
    expect(html).toContain('Correlating');
    // Derived from the pipeline so a stage addition cannot leave this stale.
    const correlating = SCAN_PIPELINE.indexOf('CORRELATING') + 1;
    expect(html).toContain(`stage ${correlating} of ${SCAN_PIPELINE.length}`);
    expect(html).not.toContain('%');
    expect(html).not.toContain('<progress');
    expect(stageLabel(scan.stage as ScanStage)).toBe('Correlating');
  });

  it('labels a completed scan with no mode marker at all', () => {
    const scan = applyStageEvent(withScanAccepted(IDLE_SCAN_STATE, {
      scan_id: 'scan-2',
      runtime_mode: 'REAL',
      synthetic: false,
    }), { stage: 'COMPLETE', timestamp: '', detail: '' });
    const html = renderToStaticMarkup(createElement(ScanSurface, { scan, store: createStore() }));
    // The panel shows the job, not a mode the operator picked.
    expect(html).toContain('scan-2');
    expect(html).toContain('Complete');
    expect(html).not.toContain('data-df-scan-mode');
    expect(html.toLowerCase()).not.toContain('synthetic');
    expect(html).not.toContain('%');
  });

  it('shows no counter for an idle or failed scan', () => {
    const html = renderToStaticMarkup(
      createElement(ScanSurface, { scan: IDLE_SCAN_STATE, store: createStore() }),
    );
    expect(html).toContain('Idle');
    expect(html).not.toMatch(/stage \d+ of/);

    const failed = applyStageEvent(IDLE_SCAN_STATE, {
      stage: 'FAILED',
      timestamp: '',
      detail: 'CFAR config invalid',
    });
    const failedHtml = renderToStaticMarkup(
      createElement(ScanSurface, { scan: failed, store: createStore() }),
    );
    expect(failedHtml).toContain('CFAR config invalid');
    expect(failedHtml).not.toMatch(/stage \d+ of/);
  });
});

// ----------------------------------------------------------------- api client

describe('useApi typed client', () => {
  it('posts a scan with JSON content type', async () => {
    const { fetchImpl, calls } = stubFetch({
      '/api/scans': { scan_id: 'scan-1', status: 'QUEUED', runtime_mode: 'REAL', synthetic: false },
    });
    const client = createApiClient(fetchImpl);
    const accepted = await client.createScan({ bbox: [0, 0, 1, 1] });
    expect(accepted.scan_id).toBe('scan-1');
    expect(calls).toEqual(['/api/scans']);
  });

  it('never puts runtime_mode in the scan request body', async () => {
    // The backend rejects `runtime_mode` with 422 extra_forbidden, so the
    // client must not be able to send it even by accident.
    const bodies: string[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(
        JSON.stringify({ scan_id: 'scan-1', status: 'QUEUED', runtime_mode: 'REAL', synthetic: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = createApiClient(fetchImpl);
    await client.createScan({ bbox: [1, 2, 3, 4] });
    await client.createScan({ bbox: [1, 2, 3, 4], provider: 'cdse', product: 'GRD' });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).not.toContain('runtime_mode');
      expect(Object.keys(JSON.parse(body))).not.toContain('runtime_mode');
    }
  });

  it('never sends a runtime_mode filter on the scene query', () => {
    expect(scenesUrl({ bbox: [1, 2, 3, 4] })).not.toContain('runtime_mode');
    expect(scenesUrl()).toBe('/api/scenes');
  });

  it('targets the documented endpoint paths', async () => {
    const { fetchImpl, calls } = stubFetch({
      '/api/scenes': { count: 0, scenes: [] },
      '/api/providers/health': HEALTH,
      '/api/scans/scan-1': { scan_id: 'scan-1' },
      '/api/scans/scan-1/targets': { scan_id: 'scan-1' },
      '/api/scans/scan-1/events': {},
      '/api/scans/scan-1/export/json': {},
      '/api/scans/scan-1/export/csv': {},
      '/api/targets/t-1': { scan_id: 'scan-1' },
      '/api/evidence/t-1': { scan_id: 'scan-1' },
      '/api/debug/scan-1/detection_mask': { scan_id: 'scan-1' },
    });
    const client = createApiClient(fetchImpl);
    await client.getScenes();
    await client.getProvidersHealth();
    await client.getScanState('scan-1');
    await client.getScanTargets('scan-1');
    await client.getTargetEvidence('t-1');
    await client.getEvidenceDocument('t-1');
    await client.getDebugLayer('scan-1', 'detection_mask');
    expect(calls).toEqual([
      '/api/scenes',
      '/api/providers/health',
      '/api/scans/scan-1',
      '/api/scans/scan-1/targets',
      '/api/targets/t-1',
      '/api/evidence/t-1',
      '/api/debug/scan-1/detection_mask',
    ]);
    expect(client.scanEventsUrl('scan-1')).toBe('/api/scans/scan-1/events');
    expect(client.scanExportUrl('scan-1', 'json')).toBe('/api/scans/scan-1/export/json');
    // Every format the shell offers must be one the backend actually serves.
    // `csv` was offered here and answered 400.
    for (const format of ['json', 'geojson', 'kml', 'png', 'pdf'] as const) {
      expect(client.scanExportUrl('scan-1', format)).toBe(`/api/scans/scan-1/export/${format}`);
    }
  });

  it('percent-encodes path segments', () => {
    expect(createApiClient().scanEventsUrl('a b/c')).toBe('/api/scans/a%20b%2Fc/events');
  });

  it('encodes scene query parameters', () => {
    expect(scenesUrl({ bbox: [1, 2, 3, 4], datetime: '2026-01-01', provider: 'cdse' })).toBe(
      '/api/scenes?bbox=1%2C2%2C3%2C4&datetime=2026-01-01&provider=cdse',
    );
  });

  it('surfaces the backend error code on failure', async () => {
    const client = createApiClient(
      async () =>
        new Response(JSON.stringify({ error: 'UNKNOWN_SCAN', message: 'no such scan' }), {
          status: 404,
        }),
    );
    await expect(client.getScanState('missing')).rejects.toMatchObject({
      status: 404,
      code: 'UNKNOWN_SCAN',
      message: 'no such scan',
    });
    await expect(client.getScanState('missing')).rejects.toBeInstanceOf(ApiError);
  });

  it('reports a network failure instead of throwing a raw TypeError', async () => {
    const client = createApiClient(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client.getProvidersHealth()).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
    });
  });

  it('rejects a non-JSON success body rather than returning undefined', async () => {
    const client = createApiClient(async () => new Response('', { status: 200 }));
    await expect(client.getScenes()).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' });
  });

  it('splits providers into SAR and AIS and keeps real statuses', () => {
    const health = toProvidersHealth(HEALTH);
    expect(health.sar.map((e) => e.provider)).toEqual(['planetary-computer']);
    expect(health.ais.map((e) => e.provider)).toEqual(['ais-local']);
    expect(health.sar[0].status).toBe('DEGRADED');
    expect(health.ais[0].status).toBe('AUTH_REQUIRED');
    // The backend's `detail` field carries the human reason, unchanged.
    // It used to be asserted as `message` -- a field the contract never declared,
    // so this assertion was reading `undefined` and could never have failed.
    expect(health.sar[0].detail).toBe('live probe returned 503');
  });

  it('reports the worst provider state, not the best', () => {
    const summary = summarizeProviders(toProvidersHealth(HEALTH).sar);
    expect(summary.state).toBe('DEGRADED');
    expect(summary.checked).toBe(true);
  });

  it('reports unknown when no probe has completed', () => {
    const summary = summarizeProviders(undefined);
    expect(summary.checked).toBe(false);
    expect(summary.label).toBe('Unknown');
  });
});

// ------------------------------------------------------------------- format

describe('UTC formatting', () => {
  it('formats as HH:MM:SSZ regardless of local timezone', () => {
    expect(formatUtc(Date.parse('2026-01-02T23:59:59Z'))).toBe('23:59:59Z');
    expect(formatUtc(Date.parse('2026-01-02T00:00:00Z'))).toBe('00:00:00Z');
  });
});

// ------------------------------------------------------------ store contract

describe('AppStore', () => {
  it('notifies subscribers only on real change', () => {
    const store = createStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.closeSurface();
    expect(listener).not.toHaveBeenCalled();
    store.toggleSurface('SAR');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.toggleSurface('AIS');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('exports a process store with no mode and no surface open', () => {
    expect('mode' in appStore.getState()).toBe(false);
    expect(appStore.getState().openSurface).toBeNull();
  });
});
// ------------------------------------------------- wire payload normalisation
//
// Two real mismatches between the persisted record and the declared frontend
// types were invisible while the payload was typed `Record<string, unknown>`.
// These tests pin the real wire shape so they cannot regress.

describe('wire target normalisation', () => {
  // Exactly the field names the backend persists (verified against a live scan).
  const WIRE = {
    id: 'DF-001',
    cls: 'SAR_UNMATCHED',
    lat: 1.267269,
    lon: 103.85533,
    sarConf: 0.54,
    aisConf: 0,
    lenM: 15,
    widM: 3,
    lenUncM: 6,
    hdg: 118,
    wake: false,
    meanDb: -8.4,
    maxDb: -1.2,
    area: 12,
    assessment: 'Unmatched surface radar return.',
    tags: ['low-contrast'],
    corr: {
      matched: false,
      mmsi: null,
      vesselName: null,
      distanceOffsetMeters: null,
      timeDeltaSeconds: null,
      predictedLat: null,
      predictedLon: null,
      scoreDecomposition: null,
    },
  };

  it('maps the persisted `cls` field onto `classification`', () => {
    const t = normaliseTarget(WIRE);
    expect(t).not.toBeNull();
    expect(t!.classification).toBe('SAR_UNMATCHED');
    expect((t as unknown as Record<string, unknown>).cls).toBeUndefined();
  });

  it('lifts aisConf into corr.aisAssociationConfidence', () => {
    const t = normaliseTarget({ ...WIRE, aisConf: 0.71 });
    expect(t!.corr.aisAssociationConfidence).toBe(0.71);
  });

  it('falls back to UNRESOLVED for an unknown classification', () => {
    expect(normaliseTarget({ ...WIRE, cls: 'DARK_VESSEL' })!.classification).toBe(
      'UNRESOLVED',
    );
    expect(normaliseTarget({ ...WIRE, cls: undefined })!.classification).toBe('UNRESOLVED');
  });

  it('never invents a numeric measurement', () => {
    const t = normaliseTarget({ id: 'DF-002', cls: 'SEA_CLUTTER' })!;
    // Absent numbers stay 0 rather than becoming a plausible-looking value.
    expect(t.lenM).toBe(0);
    expect(t.sarConf).toBe(0);
    expect(t.corr.mmsi).toBeNull();
    expect(t.corr.aisAssociationConfidence).toBe(0);
  });

  it('rejects a row with no id', () => {
    expect(normaliseTarget({ cls: 'SEA_CLUTTER' })).toBeNull();
    expect(normaliseTarget(null)).toBeNull();
    expect(normaliseTarget('nope')).toBeNull();
  });

  it('does not throw when the payload omits its lists', () => {
    const out = normaliseScanTargets({
      scan_id: 'DF-1',
      stage: 'COMPLETE',
      runtime_mode: 'REAL',
      synthetic: false,
      count: 0,
      ais_only_count: 0,
      counts: {},
    } as unknown as ScanTargetsResponse);
    expect(out.targets).toEqual([]);
    expect(out.ais_only).toEqual([]);
  });

  it('keeps every usable row and drops the unusable ones', () => {
    const out = normaliseScanTargets({
      scan_id: 'DF-1',
      stage: 'COMPLETE',
      runtime_mode: 'REAL',
      synthetic: false,
      count: 2,
      ais_only_count: 0,
      counts: {},
      targets: [WIRE, { cls: 'SEA_CLUTTER' }],
      ais_only: [],
      provenance: {},
      scene: null,
      acquisition_time: null,
    } as unknown as ScanTargetsResponse);
    expect(out.targets).toHaveLength(1);
    expect(out.targets[0].classification).toBe('SAR_UNMATCHED');
  });
});

// ---------------------------------------------------------- scan launcher

describe('scan launcher', () => {
  const renderLauncher = (overrides: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(ScanLauncher, {
        scan: IDLE_SCAN_STATE,
        store: createStore(),
        onStart: () => {},
        ...overrides,
      } as never),
    );

  it('offers a way to start a scan at all', () => {
    // The Scan surface used to be status-only: startScan had no caller, so a
    // scan could not be launched from anywhere in the UI.
    const html = renderLauncher();
    expect(html).toContain('data-df-scan-launcher');
    expect(html).toContain('Run live scan');
    expect(html).toContain('df-scan-bbox');
  });

  it('names the run control and never offers a mode choice', () => {
    const html = renderLauncher();
    expect(html).toContain('aria-label="Run live scan"');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('data-df-mode');
  });

  it('disables the control while a scan is in flight', () => {
    const html = renderLauncher({ scan: { ...IDLE_SCAN_STATE, connection: 'STREAMING' } });
    expect(html).toContain('Scan in flight');
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('exposes the bbox field with an accessible name', () => {
    const html = renderLauncher();
    expect(html).toContain('Bounding box: min_lon, min_lat, max_lon, max_lat');
  });

  it('does not promise a simulated fallback', () => {
    const html = renderLauncher();
    expect(html.toLowerCase()).not.toContain('demo');
    expect(html.toLowerCase()).not.toContain('simulat');
    expect(html).toContain('fails visibly rather than returning substituted data');
  });
});

// ---------------------------------------------------- scan request assembly
//
// Extracted as pure functions so the exact body sent to `POST /api/scans` is
// assertable without a DOM. The backend removed the synthetic runtime, so the
// request must carry only the extent and the catalogued scene.

describe('scan request assembly', () => {
  const CATALOGUED: SceneSummary = {
    id: 'S1A_IW_GRDH',
    provider: 'cdse',
    platform: 'SENTINEL-1A',
    product: 'GRD',
    polarization: 'VV',
    acquisition_time: '2026-01-02T03:04:05Z',
    bbox: [10, 50, 11, 51],
    resolution_meters: 10,
    georeferencing: null,
    sea_clutter_level: null,
    runtime_mode: 'REAL',
    synthetic: false,
  };

  it('parses a four-number extent', () => {
    expect(parseBbox('10, 50, 11, 51')).toEqual({ bbox: [10, 50, 11, 51] });
  });

  it('rejects a malformed extent with the operator-facing reason', () => {
    expect(parseBbox('10, 50')).toHaveProperty('error');
    expect(parseBbox('')).toHaveProperty('error');
    expect(parseBbox('a, b, c, d')).toHaveProperty('error');
  });

  it('rejects an inverted extent instead of silently swapping it', () => {
    expect(parseBbox('11, 50, 10, 51')).toHaveProperty('error');
    expect(parseBbox('10, 51, 11, 50')).toHaveProperty('error');
  });

  it('sends only the bbox when no scene was catalogued', () => {
    const request = buildScanRequest([10, 50, 11, 51], null);
    expect(Object.keys(request)).toEqual(['bbox']);
    expect(JSON.stringify(request)).not.toContain('runtime_mode');
  });

  it('sends only bbox and the catalogued scene id', () => {
    const request = buildScanRequest([10, 50, 11, 51], CATALOGUED);
    expect(Object.keys(request).sort()).toEqual(['bbox', 'scene_id']);
    expect(request).toEqual({ bbox: [10, 50, 11, 51], scene_id: 'S1A_IW_GRDH' });
    expect(JSON.stringify(request)).not.toContain('runtime_mode');
  });

  it('only ever sends the request fields the backend accepts', () => {
    const allowed = new Set([
      'bbox', 'scene_id', 'datetime_range', 'provider', 'product', 'cfar_config',
    ]);
    for (const request of [
      buildScanRequest([0, 0, 1, 1], null),
      buildScanRequest([0, 0, 1, 1], CATALOGUED),
      { bbox: [0, 0, 1, 1], provider: 'cdse', product: 'GRD' },
    ]) {
      for (const key of Object.keys(request)) expect(allowed.has(key)).toBe(true);
    }
  });
});
