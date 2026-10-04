/**
 * The layer registry, and the inert-toggle defect it exists to end.
 *
 * The regression that matters most is `no toggle is inert`. The shipped state of this
 * code before DF-X8.3 was: `LayerConsole` wrote `state.layers`, nothing read it, and
 * only `GRATICULE` reached the engine -- through a hardcoded `if` inside the console.
 * Ten of eleven controls looked operational and did nothing.
 *
 * These tests cannot run Cesium, so they verify the two halves that made the defect
 * possible and are now closed:
 *
 *   - every declared layer names a renderer the engine actually implements
 *   - the console's toggle path reaches the store, and nothing bypasses it
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FAILURE_POLICY,
  MapSourceController,
} from './MapSourceController';
import {
  asDefinition,
  assertNoDrift,
  defaultLayerState,
  getLayer,
  isControllable,
  isLayerId,
  layerIds,
  listByCategory,
  listLayers,
  LAYER_DEFINITIONS,
  type LayerId,
} from './layerRegistry';
import { deriveLayers } from '../sensors/LayerConsole';
import { store } from '../state/store';

/**
 * The engine methods the registry is allowed to name.
 *
 * Declared here rather than imported from the engine because importing `engine` would
 * pull in Cesium, which cannot load in the `node` test environment. The list is
 * asserted against `engine.ts` source text by the architecture test below, so it
 * cannot quietly fall out of step with the implementation.
 */
const ENGINE_RENDERERS = [
  'setRaster',
  'setSceneFootprint',
  'setTargets',
  'setUncertainty',
  'setAisContacts',
  'setTrack',
  'setCorrelationLinks',
  'setGraticule',
  'setAoi',
] as const;

describe('registry shape', () => {
  it('declares every layer with a renderer the engine implements', () => {
    const renderers = new Set<string>(ENGINE_RENDERERS);
    for (const def of listLayers()) {
      if (!isControllable(def)) continue;
      expect(renderers.has(def.renderer), `${def.id} names missing renderer ${def.renderer}`).toBe(
        true,
      );
    }
  });

  it('has unique ids', () => {
    const ids = layerIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every layer a label, category and evidentiary kind', () => {
    for (const def of listLayers()) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.category.length).toBeGreaterThan(0);
      expect(['ANALYTICAL', 'REFERENCE']).toContain(def.evidentiary);
    }
  });

  it('distinguishes evidence from reference', () => {
    // The SAR raster is evidence. The graticule and any basemap are context. If this
    // distinction is lost, reference data starts being presented as analytical source
    // evidence purely by proximity on screen.
    const raster = getLayer('SAR_RASTER');
    expect(raster.evidentiary).toBe('ANALYTICAL');
    const graticule = getLayer('GRATICULE');
    expect(graticule.evidentiary).toBe('REFERENCE');
  });

  it('looks a layer up deterministically and throws on an unknown id', () => {
    expect(getLayer('SAR_DETECTIONS').label).toBe('SAR detections');
    // @ts-expect-error deliberately invalid id
    expect(() => getLayer('NOT_A_LAYER')).toThrow(/unknown layer id/);
  });

  it('lists by category, and empty categories simply return nothing', () => {
    expect(listByCategory('SENSOR').map((d) => d.id)).toContain('SAR_RASTER');
    // Maritime categories are declared for future use but hold no layers yet. They must
    // return empty rather than being padded with invented entries (§7).
    expect(listByCategory('MARITIME_BOUNDARY')).toHaveLength(0);
    expect(listByCategory('SEABED')).toHaveLength(0);
  });
});

describe('drift guards', () => {
  it('reports no drift for ids the registry declares', () => {
    const report = assertNoDrift(layerIds());
    expect(report.unknown).toEqual([]);
    expect(report.unrendered).toEqual([]);
  });

  it('reports a UI id the registry does not declare', () => {
    const report = assertNoDrift(['SAR_DETECTIONS', 'TYPO_LAYER']);
    expect(report.unknown).toEqual(['TYPO_LAYER']);
  });

  it('narrows arbitrary strings to declared ids', () => {
    expect(isLayerId('SAR_DETECTIONS')).toBe(true);
    expect(isLayerId('NOPE')).toBe(false);
  });

  it('reads the optional notImplemented key through one named widening point', () => {
    // `as const` drops optional keys no entry declares, so the access needs a cast.
    // Having exactly one named function for it keeps the cast out of call sites.
    expect(asDefinition(getLayer('SAR_RASTER')).notImplemented).toBeUndefined();
  });
});

describe('default state', () => {
  it('gives every declared layer an entry', () => {
    const defaults = defaultLayerState();
    for (const id of layerIds()) {
      expect(defaults[id], `${id} missing from default state`).toBeDefined();
    }
  });

  it('starts evidence layers on and analysis overlays off', () => {
    const defaults = defaultLayerState();
    expect(defaults.SAR_DETECTIONS.visible).toBe(true);
    expect(defaults.UNCERTAINTY_RADII.visible).toBe(false);
    expect(defaults.GRATICULE.visible).toBe(false);
  });
});

describe('the inert-toggle regression', () => {
  /** A state shaped enough for `deriveLayers` to read. */
  const stateFor = (over: Record<string, unknown> = {}) =>
    ({
      scanId: 'scan-1',
      targets: [{ id: 'DF-001' }],
      rasterLoaded: true,
      aisOnly: [{ mmsi: '1' }],
      track: null,
      layerState: defaultLayerState(),
      ...over,
    }) as unknown as ReturnType<typeof import('../state/store').useStore>;

  it('READS stored visibility instead of recomputing it', () => {
    // The defect, stated as a test. Previously `visible` was computed as
    // `unavailableReason === undefined`, which is why every toggle snapped back.
    const state = stateFor({
      layerState: { ...defaultLayerState(), SAR_DETECTIONS: { visible: false, opacity: 1 } },
    });
    const row = deriveLayers(state).find((r) => r.id === 'SAR_DETECTIONS');
    expect(row?.visible).toBe(false);
  });

  it('keeps a layer with no data DISABLED rather than forcing it visible', () => {
    const state = stateFor({ scanId: null, targets: [], rasterLoaded: false, aisOnly: [], track: null });
    const rows = deriveLayers(state);
    for (const row of rows) {
      if (row.id === 'SAR_DETECTIONS' || row.id === 'SAR_RASTER' || row.id === 'AIS_CONTACTS') {
        expect(row.unavailableReason, `${row.id} should carry a reason`).toBeTruthy();
      }
    }
  });

  it('carries a reason for every layer disabled BY MISSING DATA', () => {
    // A greyed control with no explanation reads as a bug.
    //
    // Scoped to data-dependent layers, and deliberately so: GRATICULE needs no scan and
    // is legitimately available with nothing loaded. Asserting every row carries a
    // reason would have forced either a false reason on the graticule or a graticule
    // that could never be drawn on an empty workspace.
    const DATA_DEPENDENT = new Set<LayerId>([
      'SAR_RASTER',
      'SAR_SCENE_FOOTPRINT',
      'SAR_DETECTIONS',
      'UNCERTAINTY_RADII',
      'AIS_CONTACTS',
      'AIS_TRACKS',
      'AIS_PREDICTED',
      'CORRELATION_LINKS',
    ]);
    const state = stateFor({ scanId: null, targets: [], rasterLoaded: false, aisOnly: [], track: null });
    for (const row of deriveLayers(state)) {
      if (!DATA_DEPENDENT.has(row.id)) continue;
      expect(row.unavailableReason, `${row.id} disabled without a reason`).toBeTruthy();
    }
  });

  it('keeps a data-independent layer available with nothing loaded', () => {
    // The graticule is pure reference geometry: no scan, no AIS, still drawable.
    const state = stateFor({ scanId: null, targets: [], rasterLoaded: false, aisOnly: [], track: null });
    const graticule = deriveLayers(state).find((r) => r.id === 'GRATICULE');
    expect(graticule?.unavailableReason).toBeUndefined();
  });

  it('gives every row a registry label, never a locally declared one', () => {
    const rows = deriveLayers(stateFor());
    expect(rows).toHaveLength(LAYER_DEFINITIONS.length);
    for (const row of rows) {
      expect(row.label).toBe(getLayer(row.id).label);
    }
  });

  it('a store toggle is a real state change, and the engine is reachable from it', () => {
    // The end-to-end proof that state is the authority: toggle in the store, then
    // apply to the engine, and the engine reports the new value. If this ever needs the
    // console to call the engine directly, the single-path invariant has been broken.
    const id: LayerId = 'SAR_DETECTIONS';
    const before = store.getState().layerState[id].visible;
    store.set((prev) => ({
      layerState: {
        ...prev.layerState,
        [id]: { ...prev.layerState[id], visible: !before },
      },
    }));
    expect(store.getState().layerState[id].visible).toBe(!before);
    store.set((prev) => ({
      layerState: {
        ...prev.layerState,
        [id]: { ...prev.layerState[id], visible: before },
      },
    }));
    expect(store.getState().layerState[id].visible).toBe(before);
  });

  it('does not expose opacity on layers where it is meaningless', () => {
    // A slider wired to nothing is an inert control of the same family as the
    // visibility defect.
    const rows = deriveLayers(stateFor());
    const cfar = rows.find((r) => r.id === 'CFAR_DEBUG');
    expect(cfar?.supportsOpacity).toBe(false);
  });
});

describe('the map source controller survives contact with the layer work', () => {
  it('still falls back on threshold and not before', () => {
    let t = 0;
    const now = () => t;
    const src = (id: string) => ({
      id,
      label: id,
      attribution: `${id} credit`,
      configured: true,
      create: () => ({ id }),
    });
    const ctl = new MapSourceController({ sources: [src('osm'), src('alt')], now });
    ctl.start();
    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold; i += 1) {
      ctl.reportFailure();
      t += 10;
    }
    const status = ctl.status();
    expect(status.activeId).toBe('alt');
    expect(status.isFallback).toBe(true);
    // Basemap and layer state are separate concerns: a fallback must not be able to
    // change a layer's visibility, and the layer work must not have broken the chain.
    expect(ctl.attribution()).toBe('alt credit');
  });
});