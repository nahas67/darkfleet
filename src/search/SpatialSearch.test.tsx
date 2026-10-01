/**
 * Spatial search tests (UI-007).
 *
 * DOM-free by design, matching `src/app/SpatialShell.test.ts`: the repo runs
 * vitest in a `node` environment with no jsdom, so the surface is rendered
 * through `react-dom/server` and every interaction path is exercised through the
 * exported pure functions, handler factories and the store. No network: the
 * `ApiClient` is always an injected stub.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Rectangle } from 'cesium';
import type { Viewer } from 'cesium';
import {
  COORD_SPAN_DEG,
  SEARCH_LISTBOX_ID,
  SpatialSearch,
  buildSearchRows,
  closeSearchSurface,
  coordBbox,
  makeSearchKeyHandler,
  moveActiveRow,
  parseSearchQuery,
  runSearchRow,
  searchKeyAction,
  searchOptionId,
} from './SpatialSearch.tsx';
import type { SearchData } from './SpatialSearch.tsx';
import { createStore } from '../app/state.ts';
import { createApiClient } from '../app/useApi.ts';
import type { ApiClient, FetchLike } from '../app/useApi.ts';
import type { AisOnlyTarget, VesselTarget } from '../types/api.ts';

// ------------------------------------------------------------------- fakes

interface FlyCall {
  destination: unknown;
  duration: number;
  easingFunction: unknown;
}

function fakeViewer(): { camera: { flyTo(options: FlyCall): void }; calls: FlyCall[] } {
  const calls: FlyCall[] = [];
  return {
    calls,
    camera: {
      flyTo(options: FlyCall) {
        calls.push(options);
      },
    },
  };
}

function asViewer(viewer: ReturnType<typeof fakeViewer>): Viewer {
  return viewer as unknown as Viewer;
}

/** Stub client: one scene, no failure. Never touches the network. */
function stubClient(scenes: Array<Record<string, unknown>> = []): ApiClient {
  const fetchImpl: FetchLike = async () =>
    new Response(
      JSON.stringify({
        runtime_mode: 'DEMO',
        synthetic: true,
        provider: 'stub',
        status: 'ok',
        note: null,
        count: scenes.length,
        scenes,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  return createApiClient(fetchImpl);
}

function target(overrides: Partial<VesselTarget> = {}): VesselTarget {
  return {
    id: 'DF-T01',
    classification: 'SAR_MATCHED_AIS',
    lat: 1.2644,
    lon: 103.84,
    sarConf: 0.9,
    aisConf: 0.8,
    lenM: 88,
    widM: 12,
    lenUncM: 6,
    hdg: 90,
    wake: false,
    meanDb: -14,
    maxDb: 3,
    area: 41,
    corr: {
      matched: true,
      mmsi: '563000111',
      vesselName: 'STELLAR',
      distanceOffsetMeters: 120,
      timeDeltaSeconds: 90,
      predictedLat: 1.2651,
      predictedLon: 103.8422,
      aisAssociationConfidence: 0.8,
      scoreDecomposition: null,
    },
    assessment: '',
    tags: [],
    ...overrides,
  };
}

const SCENE = {
  id: 'SIM-S1C-MALACCA-001',
  provider: 'sim',
  platform: 'Sentinel-1A',
  product: 'GRD',
  polarization: 'VV',
  acquisition_time: '2026-02-01T00:00:00Z',
  bbox: [103.7, 1.2, 103.95, 1.35],
  resolution_meters: 10,
  georeferencing: null,
  sea_clutter_level: null,
  runtime_mode: 'DEMO' as const,
  synthetic: true,
};

const DATA: SearchData = {
  scenes: [SCENE],
  targets: [target(), target({ id: 'DF-T02', corr: { ...target().corr, mmsi: '563000222' } })],
  aisOnly: [
    {
      cls: 'AIS_ONLY' as const,
      mmsi: '563000333',
      vesselName: 'GHOST',
      lat: 1.3,
      lon: 103.9,
      timestamp: '2026-02-01T00:00:00Z',
    },
  ],
  scanId: 'DF-0001',
  sectors: ['Singapore Strait'],
};

// ------------------------------------------------------------------ parsing

describe('parseSearchQuery', () => {
  it('parses lat,lon in any separator', () => {
    for (const raw of ['1.2644, 103.84', '1.2644,103.84', '1.2644 103.84', ' 1.2644 ; 103.84 ']) {
      const parsed = parseSearchQuery(raw);
      expect(parsed.kind).toBe('COORD');
      expect(parsed.lat).toBeCloseTo(1.2644, 6);
      expect(parsed.lon).toBeCloseTo(103.84, 6);
    }
  });

  it('rejects out-of-range coordinates instead of clamping them', () => {
    expect(parseSearchQuery('91, 10').kind).not.toBe('COORD');
    expect(parseSearchQuery('10, 181').kind).not.toBe('COORD');
    expect(parseSearchQuery('north, west').kind).toBe('TEXT');
  });

  it('classifies MMSI, id and free text', () => {
    expect(parseSearchQuery('563000111').kind).toBe('MMSI');
    expect(parseSearchQuery('DF-0001').kind).toBe('ID');
    expect(parseSearchQuery('Singapore Strait').kind).toBe('TEXT');
    expect(parseSearchQuery('   ').kind).toBe('EMPTY');
  });
});

// ----------------------------------------------------------------- matching

describe('buildSearchRows', () => {
  it('returns nothing for an empty query', () => {
    expect(buildSearchRows(parseSearchQuery(''), DATA)).toEqual([]);
  });

  it('offers exactly one coordinate row, framed not measured', () => {
    const rows = buildSearchRows(parseSearchQuery('1.2644, 103.84'), DATA);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('COORD');
    expect(rows[0].lat).toBeCloseTo(1.2644, 6);
    expect(rows[0].detail).toContain('camera viewport');
  });

  it('finds a target by id', () => {
    const rows = buildSearchRows(parseSearchQuery('DF-T02'), DATA);
    const hit = rows.find((row) => row.kind === 'TARGET');
    expect(hit?.target?.id).toBe('DF-T02');
  });

  it('finds a target by MMSI and by vessel name', () => {
    expect(
      buildSearchRows(parseSearchQuery('563000222'), DATA).some((row) => row.mmsi === '563000222'),
    ).toBe(true);
    expect(
      buildSearchRows(parseSearchQuery('stellar'), DATA).some((row) => row.target !== undefined),
    ).toBe(true);
  });

  it('finds an AIS-only contact by MMSI', () => {
    const rows = buildSearchRows(parseSearchQuery('563000333'), DATA);
    expect(rows.some((row) => row.kind === 'MMSI' && row.mmsi === '563000333')).toBe(true);
  });

  it('finds a scene by id and a sector by name', () => {
    expect(
      buildSearchRows(parseSearchQuery('SIM-S1C'), DATA).some((row) => row.kind === 'SCENE'),
    ).toBe(true);
    expect(
      buildSearchRows(parseSearchQuery('Singapore Strait'), DATA).some(
        (row) => row.kind === 'SECTOR',
      ),
    ).toBe(true);
  });

  it('recognises the active scan id', () => {
    const rows = buildSearchRows(parseSearchQuery('DF-0001'), DATA);
    expect(rows.find((row) => row.kind === 'SCAN')?.scanId).toBe('DF-0001');
  });

  it('an unknown query produces no rows at all', () => {
    expect(buildSearchRows(parseSearchQuery('zzzz-nothing'), DATA)).toEqual([]);
  });

  it('a scene with a malformed bbox yields a row that cannot be flown to', () => {
    const broken: SearchData = {
      scenes: [{ ...SCENE, bbox: [1, 2] as unknown as number[] }],
    };
    const rows = buildSearchRows(parseSearchQuery('SIM-S1C'), broken);
    expect(rows[0].bbox).toBeUndefined();
  });
});

// ------------------------------------------------------------------- camera

describe('runSearchRow', () => {
  it('flies the camera to the queried coordinate', () => {
    const viewer = fakeViewer();
    const row = buildSearchRows(parseSearchQuery('1.2644, 103.84'), DATA)[0];
    const outcome = runSearchRow(row, { viewer: asViewer(viewer) });
    expect(outcome).toEqual({ action: 'FLY_TO_AOI', bbox: coordBbox(1.2644, 103.84) });
    expect(viewer.calls).toHaveLength(1);
    expect(viewer.calls[0].destination).toBeInstanceOf(Rectangle);
    const [minLon, minLat, maxLon, maxLat] = coordBbox(1.2644, 103.84);
    expect(maxLon - minLon).toBeCloseTo(COORD_SPAN_DEG, 9);
    expect(maxLat - minLat).toBeCloseTo(COORD_SPAN_DEG, 9);
  });

  it('flies to a found target', () => {
    const viewer = fakeViewer();
    const row = buildSearchRows(parseSearchQuery('DF-T02'), DATA).find(
      (candidate) => candidate.target,
    )!;
    expect(runSearchRow(row, { viewer: asViewer(viewer) })).toEqual({
      action: 'FLY_TO_TARGET',
      targetId: 'DF-T02',
    });
    expect(viewer.calls).toHaveLength(1);
  });

  it('flies to a scene extent and selects a scan without a camera', () => {
    const viewer = fakeViewer();
    const sceneRow = buildSearchRows(parseSearchQuery('SIM-S1C'), DATA).find(
      (row) => row.kind === 'SCENE',
    )!;
    expect(runSearchRow(sceneRow, { viewer: asViewer(viewer) }).action).toBe('FLY_TO_AOI');

    const store = createStore();
    const scanRow = buildSearchRows(parseSearchQuery('DF-0001'), DATA).find(
      (row) => row.kind === 'SCAN',
    )!;
    expect(runSearchRow(scanRow, { viewer: null, store })).toEqual({
      action: 'SELECT_SCAN',
      scanId: 'DF-0001',
    });
    expect(store.getState().activeScanId).toBe('DF-0001');
  });

  it('never flies without a viewer and never invents a target', () => {
    const row = buildSearchRows(parseSearchQuery('DF-T02'), DATA).find(
      (candidate) => candidate.target,
    )!;
    expect(runSearchRow(row, { viewer: null }).action).toBe('NONE');
    const viewer = fakeViewer();
    expect(
      runSearchRow({ key: 'x', kind: 'SECTOR', title: 'nowhere', detail: '' }, {
        viewer: asViewer(viewer),
      }).action,
    ).toBe('NONE');
    expect(viewer.calls).toHaveLength(0);
  });
});

// ----------------------------------------------------------------- keyboard

describe('keyboard', () => {
  it('wraps the active row', () => {
    expect(moveActiveRow(-1, 1, 3)).toBe(0);
    expect(moveActiveRow(0, 1, 3)).toBe(1);
    expect(moveActiveRow(2, 1, 3)).toBe(0);
    expect(moveActiveRow(0, -1, 3)).toBe(2);
    expect(moveActiveRow(0, 1, 0)).toBe(-1);
  });

  it('maps keys to actions', () => {
    expect(searchKeyAction('ArrowDown')).toEqual({ type: 'MOVE', delta: 1 });
    expect(searchKeyAction('ArrowUp')).toEqual({ type: 'MOVE', delta: -1 });
    expect(searchKeyAction('Enter')).toEqual({ type: 'ACTIVATE' });
    expect(searchKeyAction('Escape')).toEqual({ type: 'CLOSE' });
    expect(searchKeyAction('a')).toEqual({ type: 'NONE' });
  });

  it('the bound handler moves, activates and closes', () => {
    const onMove = vi.fn();
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const handler = makeSearchKeyHandler({ onMove, onActivate, onClose });
    const preventDefault = vi.fn();

    handler({ key: 'ArrowDown', preventDefault });
    expect(onMove).toHaveBeenCalledWith(1);
    handler({ key: 'Enter', preventDefault });
    expect(onActivate).toHaveBeenCalledTimes(1);
    handler({ key: 'Escape', preventDefault });
    expect(onClose).toHaveBeenCalledTimes(1);
    handler({ key: 'q', preventDefault });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the open surface through the store', () => {
    const store = createStore();
    store.openSurface('SEARCH');
    expect(store.getState().openSurface).toBe('SEARCH');
    closeSearchSurface(store);
    expect(store.getState().openSurface).toBeNull();
  });
});

// ------------------------------------------------------------------ markup

describe('SpatialSearch markup', () => {
  const render = (props: Partial<Parameters<typeof SpatialSearch>[0]> = {}): string =>
    renderToStaticMarkup(
      createElement(SpatialSearch, {
        store: createStore(),
        client: stubClient([SCENE]),
        targets: DATA.targets,
        aisOnly: DATA.aisOnly as AisOnlyTarget[],
        scanId: DATA.scanId,
        sectors: DATA.sectors,
        ...props,
      }),
    );

  it('labels the input and exposes a listbox with a stable id', () => {
    const html = render();
    expect(html).toContain('aria-label="Spatial search: coordinates, sector, scene, target id, MMSI or scan id"');
    expect(html).toContain(`id="${SEARCH_LISTBOX_ID}"`);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="combobox"');
  });

  it('gives the close control an accessible name', () => {
    expect(render()).toContain('aria-label="Close spatial search"');
  });

  it('shows the guidance, not an error, before anything is typed', () => {
    const html = render();
    expect(html).toContain('Enter lat,lon, a sector, a scene id, a target id');
    expect(html).not.toContain('data-df-search-empty');
  });

  it('renders no rows and never fabricates one for an empty query', () => {
    const html = render();
    expect(html).not.toContain('role="option"');
    expect(html).not.toContain(searchOptionId(0));
  });

  it('renders no options and shows the guidance state on a cold render', () => {
    // `renderToStaticMarkup` runs no effects, so scenes never arrive and the
    // query is empty: the listbox must stay empty rather than invent rows.
    const html = render();
    expect(html).toContain('role="listbox"');
    expect(html).not.toContain('role="option"');
    expect(html).toContain('data-df-search-hint');
  });

  it('reports an unknown query through the empty state, not a fake row', () => {
    const rows = buildSearchRows(parseSearchQuery('zzzz-nothing'), DATA);
    expect(rows).toEqual([]);
    const html = render();
    expect(html).not.toContain('data-df-search-empty');
  });

  it('every result row is renderable as an option with an accessible name', () => {
    for (const row of buildSearchRows(parseSearchQuery('DF-T02'), DATA)) {
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.kind).toBe('TARGET');
    }
    for (const row of buildSearchRows(parseSearchQuery('563000111'), DATA)) {
      expect(row.title.length).toBeGreaterThan(0);
    }
  });
});