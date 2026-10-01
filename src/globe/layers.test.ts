/**
 * Layer tests: the no-leak guarantee, honest-empty behaviour, and the hard gate
 * on advanced layers (UI-006, UI-029/030, UI-031..033).
 *
 * DOM-free by design: the repo runs vitest in a `node` environment with no
 * jsdom, so every test drives a fake Viewer that records entity/imagery adds and
 * removes. Nothing here touches the network or a WebGL context.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Rectangle } from 'cesium';
import type { ImageryProvider, Viewer } from 'cesium';
import { LayerRegistry } from './registry.ts';
import {
  AisContactsLayer,
  AisTrailsLayer,
  CfarDebugLayer,
  CorrelationLinksLayer,
  LandMaskLayer,
  SarDetectionsLayer,
  SarRasterLayer,
  SarSceneFootprintLayer,
  SelectedTargetLayer,
  UncertaintyRadiiLayer,
  UnavailableLayer,
  createGlobeLayer,
  createGlobeLayers,
  footprintCorners,
  gridRectangles,
  gridShape,
  matchRadiusMeters,
  readSarRaster,
  readTargets,
} from './layers.ts';
import type { RegisteredLayer } from './registry.ts';
import { syncGlobeLayers } from './useGlobeLayers.ts';
import { createStore } from '../app/state.ts';
import type { AisOnlyTarget, BoundingBox, ScanResult, VesselTarget } from '../types/api.ts';

// ------------------------------------------------------------------- fakes

class FakeEvent {
  private handlers = new Set<() => void>();
  addEventListener(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  removeEventListener(handler: () => void): void {
    this.handlers.delete(handler);
  }
  raise(): void {
    for (const handler of [...this.handlers]) handler();
  }
}

interface FakeImageryLayer {
  provider: unknown;
  show: boolean;
  alpha: number;
}

export interface FakeViewer {
  entities: { added: unknown[]; add(spec: unknown): unknown; remove(entity: unknown): boolean };
  imageryLayers: {
    layers: FakeImageryLayer[];
    addImageryProvider(provider: unknown): FakeImageryLayer;
    remove(layer: unknown, destroy?: boolean): boolean;
  };
  camera: { moveStart: FakeEvent; moveEnd: FakeEvent };
  /** Number of live entities: proves updates do not accumulate primitives. */
  get entityCount(): number;
  get imageryCount(): number;
}

function fakeViewer(): FakeViewer {
  const entities: unknown[] = [];
  const imagery: FakeImageryLayer[] = [];
  return {
    entities: {
      added: entities,
      add(spec: unknown) {
        const entity = { ...(spec as Record<string, unknown>), show: true };
        entities.push(entity);
        return entity;
      },
      remove(entity: unknown) {
        const index = entities.indexOf(entity);
        if (index < 0) return false;
        entities.splice(index, 1);
        return true;
      },
    },
    imageryLayers: {
      layers: imagery,
      addImageryProvider(provider: unknown): FakeImageryLayer {
        const layer: FakeImageryLayer = { provider, show: true, alpha: 1 };
        imagery.push(layer);
        return layer;
      },
      remove(layer: unknown) {
        const index = imagery.indexOf(layer as FakeImageryLayer);
        if (index < 0) return false;
        imagery.splice(index, 1);
        return true;
      },
    },
    camera: { moveStart: new FakeEvent(), moveEnd: new FakeEvent() },
    get entityCount() {
      return entities.length;
    },
    get imageryCount() {
      return imagery.length;
    },
  };
}

function asViewer(viewer: FakeViewer): Viewer {
  return viewer as unknown as Viewer;
}

/** 5 identical updates; the primitive count must not move. */
function assertStable(
  layer: RegisteredLayer,
  viewer: FakeViewer,
  data: unknown,
  updates = 5,
): number {
  const counts: number[] = [];
  for (let i = 0; i < updates; i++) {
    layer.update(asViewer(viewer), data);
    counts.push(viewer.entityCount + viewer.imageryCount);
  }
  expect(counts[updates - 1]).toBe(counts[0]);
  return counts[0];
}

function target(overrides: Partial<VesselTarget> = {}): VesselTarget {
  return {
    id: 'DF-T01',
    classification: 'SAR_MATCHED_AIS',
    lat: 1.2644,
    lon: 103.84,
    sarConf: 0.91,
    aisConf: 0.83,
    lenM: 88,
    widM: 12,
    lenUncM: 6,
    hdg: 90,
    wake: false,
    meanDb: -14,
    maxDb: 3.2,
    area: 41,
    corr: {
      matched: true,
      mmsi: '563000111',
      vesselName: 'STELLAR',
      distanceOffsetMeters: 120,
      timeDeltaSeconds: 90,
      predictedLat: 1.2651,
      predictedLon: 103.8422,
      aisAssociationConfidence: 0.83,
      scoreDecomposition: {
        spatialScore: 0.9,
        temporalScore: 0.85,
        headingScore: 0.7,
        sizeScore: 0.6,
        compositeScore: 0.83,
        matchRadiusMeters: 750,
        distanceOffsetMeters: 120,
        timeDeltaSeconds: 90,
      },
    },
    assessment: 'Matched to a broadcast transponder.',
    tags: [],
    ...overrides,
  };
}

const AOI: BoundingBox = [103.7, 1.2, 103.95, 1.35];

// ------------------------------------------------------------------- tests

describe('layer factory', () => {
  it('implements every registry id', () => {
    const ids = createGlobeLayers().map((layer) => layer.config.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('SAR_RASTER');
    expect(ids).toContain('CFAR_DEBUG');
    expect(ids).toContain('TEMPORAL_ANOMALIES');
  });

  it('resolves advanced ids to no-op layers marked NOT_AVAILABLE', () => {
    for (const id of ['MULTIPASS_TRACKS', 'WAKE_GEOMETRY', 'ML_OUTPUT', 'TEMPORAL_ANOMALIES'] as const) {
      const layer = createGlobeLayer(id);
      expect(layer).toBeInstanceOf(UnavailableLayer);
      expect(layer.config.capabilityState).toBe('NOT_AVAILABLE');
    }
  });
});

describe('advanced layers never create a primitive', () => {
  const data = {
    tracks: [{ lat: 1, lon: 1 }],
    wake: [{ lat: 1, lon: 1 }],
    detections: [{ lat: 1, lon: 1 }],
    anomalies: [{ lat: 1, lon: 1 }],
  };

  it('update() adds nothing for an unavailable layer', () => {
    for (const id of ['MULTIPASS_TRACKS', 'WAKE_GEOMETRY', 'ML_OUTPUT', 'TEMPORAL_ANOMALIES'] as const) {
      const layer = createGlobeLayer(id);
      const viewer = fakeViewer();
      layer.mount(asViewer(viewer));
      for (let i = 0; i < 5; i++) layer.update(asViewer(viewer), data);
      layer.setVisible(asViewer(viewer), true);
      layer.setOpacity(asViewer(viewer), 0.5);
      layer.dispose(asViewer(viewer));
      expect(viewer.entityCount).toBe(0);
      expect(viewer.imageryCount).toBe(0);
    }
  });

  it('the registry refuses to route data to them', () => {
    const registry = new LayerRegistry();
    for (const layer of createGlobeLayers()) registry.register(layer);
    const viewer = fakeViewer();
    registry.setViewer(asViewer(viewer));
    for (const id of ['MULTIPASS_TRACKS', 'WAKE_GEOMETRY', 'ML_OUTPUT', 'TEMPORAL_ANOMALIES'] as const) {
      registry.update(id, data);
      registry.setVisible(id, true);
    }
    expect(viewer.entityCount).toBe(0);
    expect(viewer.imageryCount).toBe(0);
    expect(registry.capability('ML_OUTPUT')).toBe('NOT_AVAILABLE');
  });
});

describe('SAR_RASTER', () => {
  it('adds exactly one imagery layer per update (no accumulation)', () => {
    const requested: string[] = [];
    const layer = new SarRasterLayer((request) => {
      requested.push(request.url);
      return { stub: true } as unknown as ImageryProvider;
    });
    const viewer = fakeViewer();
    const payload = { url: '/api/debug/DF-0001/raw.png', bbox: AOI };
    const total = assertStable(layer, viewer, payload);
    expect(total).toBe(1);
    expect(viewer.imageryCount).toBe(1);
    expect(requested).toHaveLength(5);
  });

  it('removes the previous imagery layer and adds one for a new raster', () => {
    const layer = new SarRasterLayer(() => ({ stub: true }) as unknown as ImageryProvider);
    const viewer = fakeViewer();
    layer.update(asViewer(viewer), { url: '/a.png', bbox: AOI });
    layer.update(asViewer(viewer), { url: '/b.png', bbox: AOI });
    expect(viewer.imageryCount).toBe(1);
  });

  it('renders nothing when the backend sent no raster', () => {
    const layer = new SarRasterLayer(() => ({ stub: true }) as unknown as ImageryProvider);
    const viewer = fakeViewer();
    layer.update(asViewer(viewer), null);
    layer.update(asViewer(viewer), { bbox: AOI });
    layer.update(asViewer(viewer), { url: '/a.png' });
    expect(viewer.imageryCount).toBe(0);
  });

  it('discards a slow provider that resolves after a newer update', async () => {
    const pending: Array<(provider: ImageryProvider) => void> = [];
    const layer = new SarRasterLayer(
      () => new Promise<ImageryProvider>((resolve) => pending.push(resolve)),
    );
    const viewer = fakeViewer();
    layer.update(asViewer(viewer), { url: '/slow.png', bbox: AOI });
    layer.update(asViewer(viewer), { url: '/fast.png', bbox: AOI });
    pending[0]?.({ stale: true } as unknown as ImageryProvider);
    await Promise.resolve();
    expect(viewer.imageryCount).toBe(0);
    pending[1]?.({ fresh: true } as unknown as ImageryProvider);
    await Promise.resolve();
    expect(viewer.imageryCount).toBe(1);
  });

  it('applies visibility and opacity to the imagery layer', () => {
    const layer = new SarRasterLayer(() => ({ stub: true }) as unknown as ImageryProvider);
    const viewer = fakeViewer();
    layer.update(asViewer(viewer), { url: '/a.png', bbox: AOI });
    layer.setVisible(asViewer(viewer), false);
    expect(viewer.imageryLayers.layers[0].show).toBe(false);
    layer.setOpacity(asViewer(viewer), 0.4);
    expect(viewer.imageryLayers.layers[0].alpha).toBe(0.4);
  });

  it('uses a real rectangle for the tile extent', () => {
    let rectangle: Rectangle | null = null;
    const layer = new SarRasterLayer((request) => {
      rectangle = request.rectangle;
      return { stub: true } as unknown as ImageryProvider;
    });
    layer.update(asViewer(fakeViewer()), { asset_href: '/scene.png', aoi: AOI });
    expect(rectangle).toBeInstanceOf(Rectangle);
    expect(readSarRaster({ asset_href: '/scene.png', aoi: AOI })?.bbox).toEqual(AOI);
  });
});

describe('SAR_SCENE_FOOTPRINT', () => {
  it('is stable across repeated updates', () => {
    const viewer = fakeViewer();
    const layer = new SarSceneFootprintLayer();
    const total = assertStable(layer, viewer, { aoi: AOI });
    expect(total).toBe(2); // fill + perimeter
  });

  it('renders nothing without geometry', () => {
    const viewer = fakeViewer();
    const layer = new SarSceneFootprintLayer();
    layer.update(asViewer(viewer), { aoi: [1, 2] });
    expect(viewer.entityCount).toBe(0);
  });
});

describe('LAND_MASK and CFAR_DEBUG', () => {
  const grid = [
    [0, 1, 1],
    [0, 1, 1],
    [1, 1, 0],
  ];

  it('merges the mask into rectangles', () => {
    expect(gridShape(grid)).toEqual({ rows: 3, cols: 3 });
    const rects = gridRectangles(grid);
    expect(rects).toHaveLength(2);
    expect(rects).toEqual(
      expect.arrayContaining([
        { row: 0, col: 1, rows: 2, cols: 2 },
        { row: 2, col: 0, rows: 1, cols: 2 },
      ]),
    );
    expect(gridRectangles([[0, 0], [0, 0]])).toEqual([]);
    expect(gridRectangles([[1, 2], [3]])).toEqual([]);
  });

  it('LAND_MASK is stable and CFAR_DEBUG outlines the same cells', () => {
    const landViewer = fakeViewer();
    const land = assertStable(new LandMaskLayer(), landViewer, { bbox: AOI, grid });
    expect(land).toBe(gridRectangles(grid).length);

    const debugViewer = fakeViewer();
    const debug = assertStable(new CfarDebugLayer(), debugViewer, { bbox: AOI, grid });
    expect(debug).toBe(gridRectangles(grid).length);
  });

  it('renders nothing when the debug endpoint returned no grid', () => {
    const viewer = fakeViewer();
    new LandMaskLayer().update(asViewer(viewer), { bbox: AOI, grid: null });
    new CfarDebugLayer().update(asViewer(viewer), { bbox: AOI });
    expect(viewer.entityCount).toBe(0);
  });
});

describe('SAR_DETECTIONS', () => {
  it('renders a point and a box per target and never accumulates', () => {
    const viewer = fakeViewer();
    const layer = new SarDetectionsLayer();
    const total = assertStable(layer, viewer, [target(), target({ id: 'DF-T02' })]);
    expect(total).toBe(4); // 2 entities per target
  });

  it('renders nothing when the backend returned no targets', () => {
    const viewer = fakeViewer();
    new SarDetectionsLayer().update(asViewer(viewer), []);
    new SarDetectionsLayer().update(asViewer(viewer), { targets: [] });
    new SarDetectionsLayer().update(asViewer(viewer), undefined);
    expect(viewer.entityCount).toBe(0);
  });

  it('drops malformed targets instead of inventing geometry', () => {
    expect(readTargets([{ id: 'x' }, null, target()])).toHaveLength(1);
    const viewer = fakeViewer();
    new SarDetectionsLayer().update(asViewer(viewer), [{ id: 'broken' }]);
    expect(viewer.entityCount).toBe(0);
  });

  it('orients the footprint box by the backend heading', () => {
    const north = footprintCorners({ lat: 0, lon: 0, lenM: 100, widM: 10, hdg: 0 });
    const east = footprintCorners({ lat: 0, lon: 0, lenM: 100, widM: 10, hdg: 90 });
    expect(north).toHaveLength(5);
    expect(north[0]).toEqual(north[4]);
    const northSpan = north[0].y - north[0].y;
    expect(northSpan).toBe(0);
    expect(north[0].z).not.toBe(east[0].z);
  });

  it('scales tints with layer opacity and hides on toggle', () => {
    const viewer = fakeViewer();
    const layer = new SarDetectionsLayer();
    layer.update(asViewer(viewer), [target()]);
    layer.setOpacity(asViewer(viewer), 0.5);
    const point = viewer.entities.added.find(
      (entity) => (entity as { id?: string }).id === 'df-target:DF-T01:point',
    ) as { point: { color: { alpha: number } }; show: boolean };
    expect(point.point.color.alpha).toBeCloseTo(0.95 * 0.5, 6);
    layer.setVisible(asViewer(viewer), false);
    expect(point.show).toBe(false);
  });
});

describe('AIS_CONTACTS and AIS_TRAILS', () => {
  const contact: AisOnlyTarget = {
    cls: 'AIS_ONLY',
    mmsi: '563000111',
    vesselName: 'STELLAR',
    lat: 1.2,
    lon: 103.8,
    timestamp: '2026-02-01T00:00:00Z',
  };

  it('contacts are stable and honest about emptiness', () => {
    const viewer = fakeViewer();
    expect(assertStable(new AisContactsLayer(), viewer, { ais_only: [contact] })).toBe(1);
    const empty = fakeViewer();
    new AisContactsLayer().update(asViewer(empty), { ais_only: [] });
    expect(empty.entityCount).toBe(0);
  });

  it('one trail per MMSI, ordered by timestamp, never accumulated', () => {
    const viewer = fakeViewer();
    const observations = [
      { mmsi: '563000111', lat: 1.2, lon: 103.8, timestamp: '2026-02-01T00:00:10Z' },
      { mmsi: '563000111', lat: 1.1, lon: 103.7, timestamp: '2026-02-01T00:00:00Z' },
      { mmsi: '563000222', lat: 2, lon: 104, timestamp: '2026-02-01T00:00:00Z' },
      { mmsi: '563000222', lat: 2.1, lon: 104.1, timestamp: '2026-02-01T00:01:00Z' },
    ];
    const total = assertStable(new AisTrailsLayer(), viewer, { observations });
    expect(total).toBe(4); // 2 polylines + 2 head labels
  });

  it('a single observation is not a trail', () => {
    const viewer = fakeViewer();
    new AisTrailsLayer().update(asViewer(viewer), {
      trails: [{ mmsi: '1', points: [{ lat: 1, lon: 1 }] }],
    });
    expect(viewer.entityCount).toBe(0);
  });
});

describe('CORRELATION_LINKS and UNCERTAINTY_RADII', () => {
  it('links draw the detection-to-prediction line and the match radius', () => {
    const viewer = fakeViewer();
    const layer = new CorrelationLinksLayer();
    const total = assertStable(layer, viewer, [target()]);
    // match-radius ellipse + line + predicted-position label entity
    expect(total).toBe(3);
    const ids = viewer.entities.added.map((entity) => (entity as { id: string }).id);
    expect(ids).toContain('df-match-radius:DF-T01');
    expect(ids).toContain('df-link:DF-T01');
  });

  it('reads the radius only from scoreDecomposition', () => {
    expect(matchRadiusMeters(target())).toBe(750);
    const noScore = target({
      corr: { ...target().corr, scoreDecomposition: null },
    });
    expect(matchRadiusMeters(noScore)).toBeNull();
    expect(matchRadiusMeters(target({ corr: { ...target().corr, matched: false } }))).toBe(750);
  });

  it('an unmatched target has no line but keeps its radius', () => {
    const viewer = fakeViewer();
    const unmatched = target({
      corr: { ...target().corr, matched: false, predictedLat: null, predictedLon: null },
    });
    new CorrelationLinksLayer().update(asViewer(viewer), [unmatched]);
    const ids = viewer.entities.added.map((entity) => (entity as { id: string }).id);
    expect(ids).toEqual(['df-match-radius:DF-T01']);
  });

  it('uncertainty radii stay stable and skip targets with no radius', () => {
    const viewer = fakeViewer();
    const noRadius = target({
      id: 'DF-T03',
      corr: { ...target().corr, scoreDecomposition: null },
    });
    expect(assertStable(new UncertaintyRadiiLayer(), viewer, [target(), noRadius])).toBe(1);
  });
});

describe('SELECTED_TARGET', () => {
  it('renders one reticle for the selected id only', () => {
    const viewer = fakeViewer();
    const layer = new SelectedTargetLayer();
    const total = assertStable(layer, viewer, {
      targetId: 'DF-T02',
      targets: [target(), target({ id: 'DF-T02' })],
    });
    expect(total).toBe(2); // reticle + label
    const ids = viewer.entities.added.map((entity) => (entity as { id: string }).id);
    expect(ids).toEqual(['df-selected:DF-T02', 'df-selected-label:DF-T02']);
  });

  it('renders nothing when the selection is cleared or unknown', () => {
    const viewer = fakeViewer();
    const layer = new SelectedTargetLayer();
    layer.update(asViewer(viewer), { targetId: null, targets: [target()] });
    layer.update(asViewer(viewer), { targetId: 'nope', targets: [target()] });
    expect(viewer.entityCount).toBe(0);
  });
});

describe('dispose', () => {
  it('releases every primitive and is safe to call twice', () => {
    const viewer = fakeViewer();
    const layers = [
      new SarSceneFootprintLayer(),
      new LandMaskLayer(),
      new SarDetectionsLayer(),
      new AisContactsLayer(),
      new AisTrailsLayer(),
      new CorrelationLinksLayer(),
      new UncertaintyRadiiLayer(),
      new SelectedTargetLayer(),
      new CfarDebugLayer(),
    ];
    const payloads: unknown[] = [
      { aoi: AOI },
      { bbox: AOI, grid: [[1, 1], [1, 1]] },
      [target()],
      { ais_only: [] },
      { observations: [] },
      [target()],
      [target()],
      { targetId: 'DF-T01', targets: [target()] },
      { bbox: AOI, grid: [[1, 1], [1, 1]] },
    ];
    layers.forEach((layer, index) => layer.update(asViewer(viewer), payloads[index]));
    expect(viewer.entityCount).toBeGreaterThan(0);
    layers.forEach((layer) => {
      layer.dispose(asViewer(viewer));
      layer.dispose(asViewer(viewer));
    });
    expect(viewer.entityCount).toBe(0);
  });
});

describe('syncGlobeLayers', () => {
  const scan = {
    scan_id: 'DF-0001',
    runtime_mode: 'DEMO',
    synthetic: true,
    scene: {
      provider: 'sim',
      collection: 'demo',
      item_id: 'SIM-1',
      platform: 'Simulation',
      acquisition_time: '2026-02-01T00:00:00Z',
      product: 'SIM',
      polarization: 'VV',
      asset_href: '/api/debug/DF-0001/raw.png',
      crs: null,
      resolution_m: 10,
    },
    aoi: [...AOI],
    targets: [target()],
    ais_only: [],
    counts: {},
    counts_note: undefined,
    provenance: {} as never,
    config: {},
    processing_time_ms: 12,
    created_at: '2026-02-01T00:00:00Z',
  } as unknown as ScanResult;

  it('mirrors store visibility and opacity and pushes the scan', () => {
    const registry = new LayerRegistry();
    const detections = new SarDetectionsLayer();
    registry.register(detections);
    const viewer = fakeViewer();
    registry.setViewer(asViewer(viewer));

    const store = createStore();
    syncGlobeLayers(registry, store.getState(), { scan });

    expect(detections.config.visible).toBe(true);
    store.setLayerVisible('SAR_DETECTIONS', false);
    syncGlobeLayers(registry, store.getState(), { scan });
    expect(detections.config.visible).toBe(false);
    store.setLayerOpacity('SAR_DETECTIONS', 0.25);
    syncGlobeLayers(registry, store.getState(), { scan });
    expect(detections.config.opacity).toBe(0.25);
  });

  it('is idempotent: five syncs leave one primitive set', () => {
    const registry = new LayerRegistry();
    const detections = new SarDetectionsLayer();
    const links = new CorrelationLinksLayer();
    registry.register(detections);
    registry.register(links);
    const viewer = fakeViewer();
    registry.setViewer(asViewer(viewer));
    for (let i = 0; i < 5; i++) {
      syncGlobeLayers(registry, createStore().getState(), { scan });
    }
    expect(viewer.entityCount).toBe(5); // 2 detection primitives + 3 correlation primitives
  });

  it('a NOT_AVAILABLE layer is never pushed to even if the store asks', () => {
    const registry = new LayerRegistry();
    const advanced = createGlobeLayer('WAKE_GEOMETRY');
    registry.register(advanced);
    const viewer = fakeViewer();
    registry.setViewer(asViewer(viewer));
    const store = createStore();
    // The store reducer is a no-op for a NOT_AVAILABLE layer...
    store.setLayerVisible('WAKE_GEOMETRY', true);
    expect(store.getState().layers.WAKE_GEOMETRY.visible).toBe(false);
    // ...and the sync honours that state.
    syncGlobeLayers(registry, store.getState(), { scan });
    expect(viewer.entityCount).toBe(0);
  });
});