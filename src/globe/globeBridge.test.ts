/**
 * The globe bridge: the wiring CP9 described and never built.
 *
 * A minimal fake viewer stands in for Cesium. That is the point of the split in
 * `scanLayers.ts` — the decisions are testable without WebGL, so what is asserted
 * here is which entities were added and, more importantly, which were refused.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  BRIDGE_LAYERS,
  createGlobeBridge,
  disposeGlobeBridge,
  layerCounts,
  pushScanResult,
} from './globeBridge.ts';
import { assertReal } from '../api/client.ts';
import { ContractViolation, validateScanTargetsResponse } from '../api/validate.ts';
import type { ScanTargetsResponse } from '../api/contract';
import type { ScanResult } from '../types/api.ts';

interface FakeEntity {
  id: string;
  show: boolean;
}

/** Stands in for Cesium's EntityCollection: the three methods the layer uses. */
class FakeEntityCollection {
  private readonly byId = new Map<string, FakeEntity>();

  add(entity: FakeEntity): FakeEntity {
    this.byId.set(entity.id, entity);
    return entity;
  }

  remove(entity: FakeEntity): void {
    this.byId.delete(entity.id);
  }

  getById(id: string): FakeEntity | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  ids(prefix: string): string[] {
    return [...this.byId.keys()].filter((id) => id.startsWith(prefix)).sort();
  }
}

class FakeViewer {
  readonly entities = new FakeEntityCollection();
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function target(over: Record<string, unknown> = {}): ScanResult['targets'][number] {
  return {
    id: 'DF-001',
    classification: 'SAR_UNMATCHED',
    lat: 1.267269,
    lon: 103.85533,
    sarConf: 0.72,
    aisConf: 0,
    lenM: 18.4,
    widM: 4.1,
    lenUncM: 6.2,
    hdg: 118,
    wake: false,
    meanDb: -8.4,
    maxDb: -1.2,
    area: 12,
    corr: {
      matched: false,
      mmsi: null,
      vesselName: null,
      distanceOffsetMeters: null,
      timeDeltaSeconds: null,
      predictedLat: null,
      predictedLon: null,
      aisAssociationConfidence: 0,
      scoreDecomposition: null,
    },
    assessment: null,
    tags: [],
    ...over,
  } as ScanResult['targets'][number];
}

const MATCHED_CORR = {
  matched: true,
  mmsi: '565123456',
  vesselName: 'STRAIT VOYAGER',
  distanceOffsetMeters: 14.2,
  timeDeltaSeconds: 3.1,
  predictedLat: 1.267511,
  predictedLon: 103.855401,
  aisAssociationConfidence: 0.88,
  scoreDecomposition: null,
};

function result(over: Partial<ScanResult> = {}): ScanResult {
  return {
    scan_id: 'DF-0001',
    runtime_mode: 'REAL',
    synthetic: false,
    scene: {} as ScanResult['scene'],
    aoi: [103.8, 1.24, 103.86, 1.28],
    acquisition_time: '2026-09-27T11:24:58.180786Z',
    config: {},
    targets: [],
    ais_only: [],
    counts: {},
    provenance: {} as ScanResult['provenance'],
    processing_time_ms: 1234,
    created_at: '2026-10-02T00:00:00Z',
    ...over,
  };
}

// ------------------------------------------------------------ the wiring

describe('globe bridge', () => {
  it('draws a detection, its uncertainty ring, and the AOI for a real scan', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);

    pushScanResult(registry, viewer as never, result({ targets: [target()] }));

    expect(viewer.entities.ids('df-detection-')).toEqual(['df-detection-DF-001']);
    expect(viewer.entities.ids('df-uncertainty-')).toEqual(['df-uncertainty-DF-001']);
    expect(viewer.entities.ids('df-aoi-')).toEqual(['df-aoi-footprint']);
    disposeGlobeBridge(registry);
  });

  it('draws an association link and the AIS mark only for a real match', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);

    pushScanResult(
      registry,
      viewer as never,
      result({ targets: [target({ corr: MATCHED_CORR })] }),
    );

    expect(viewer.entities.ids('df-link-')).toEqual(['df-link-DF-001']);
    expect(viewer.entities.ids('df-ais-')).toEqual(['df-ais-565123456']);
    disposeGlobeBridge(registry);
  });

  it('draws nothing at all for an unmatched detection', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);

    pushScanResult(registry, viewer as never, result({ targets: [target()] }));

    // No link, no AIS mark. An unmatched detection is an open question, and the
    // map must not imply an association the backend did not make.
    expect(viewer.entities.ids('df-link-')).toEqual([]);
    expect(viewer.entities.ids('df-ais-')).toEqual([]);
    disposeGlobeBridge(registry);
  });

  it('draws an empty globe for a scan that found nothing', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);

    pushScanResult(registry, viewer as never, result({ targets: [] }));

    expect(viewer.entities.ids('df-detection-')).toEqual([]);
    expect(viewer.entities.ids('df-link-')).toEqual([]);
    // The AOI is still real and still worth outlining.
    expect(viewer.entities.ids('df-aoi-')).toEqual(['df-aoi-footprint']);
    disposeGlobeBridge(registry);
  });

  it('a second scan replaces the first rather than accumulating', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);

    pushScanResult(
      registry,
      viewer as never,
      result({ targets: [target({ id: 'DF-001' }), target({ id: 'DF-002', lat: 1.3, lon: 103.9 })] }),
    );
    expect(viewer.entities.ids('df-detection-')).toHaveLength(2);

    pushScanResult(
      registry,
      viewer as never,
      result({ targets: [target({ id: 'DF-009', lat: 1.4, lon: 103.95 })] }),
    );
    // The stale marks are gone. Leaving them up would present the previous
    // scan's real measurements as if they belonged to the current AOI.
    expect(viewer.entities.ids('df-detection-')).toEqual(['df-detection-DF-009']);
    disposeGlobeBridge(registry);
  });

  it('clearing the result empties the globe', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);

    pushScanResult(registry, viewer as never, result({ targets: [target()] }));
    expect(viewer.entities.size).toBeGreaterThan(0);

    pushScanResult(registry, viewer as never, null);

    expect(viewer.entities.size).toBe(0);
    disposeGlobeBridge(registry);
  });

  it('does nothing when the viewer has been destroyed', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);
    viewer.destroyed = true;

    expect(() =>
      pushScanResult(registry, viewer as never, result({ targets: [target()] })),
    ).not.toThrow();
    expect(viewer.entities.size).toBe(0);
  });

  it('a destroyed viewer is not written to during teardown', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);
    pushScanResult(registry, viewer as never, result({ targets: [target()] }));
    viewer.destroyed = true;

    expect(() => disposeGlobeBridge(registry)).not.toThrow();
  });

  it('every fed layer is one the registry actually registered', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);
    for (const id of BRIDGE_LAYERS) {
      expect(registry.get(id)).toBeDefined();
      expect(registry.capability(id)).toBe('AVAILABLE');
    }
    disposeGlobeBridge(registry);
  });

  it('tearing down twice is safe', () => {
    const viewer = new FakeViewer();
    const registry = createGlobeBridge(viewer as never);
    disposeGlobeBridge(registry);
    expect(() => disposeGlobeBridge(registry)).not.toThrow();
    expect(() => disposeGlobeBridge(null)).not.toThrow();
  });
});

// ------------------------------------------------------------- layer counts

describe('layerCounts', () => {
  it('counts only what is drawable', () => {
    const counts = layerCounts(
      result({
        targets: [
          target({ id: 'DF-001', corr: MATCHED_CORR }),
          // No position: not drawable, so it is not counted.
          target({ id: 'DF-002', lat: Number.NaN }),
          // Measured uncertainty missing: drawn, but with no ring.
          target({ id: 'DF-003', lat: 1.31, lon: 103.91, lenUncM: 0 }),
        ],
      }),
    );
    expect(counts.SAR_DETECTIONS).toBe(2);
    expect(counts.UNCERTAINTY_RADII).toBe(1);
    expect(counts.CORRELATION_LINKS).toBe(1);
    expect(counts.AIS_CONTACTS).toBe(1);
    expect(counts.SAR_SCENE_FOOTPRINT).toBe(1);
  });
});

// ------------------------------------------- the last honesty checkpoint

describe('the REAL-only guard', () => {
  // This guard used to live in the retired shell as `toGlobeScanResult`, which is
  // why this test file had to import a presentation module. It now lives in
  // api/client.ts, next to the code that applies it, so the assertion and the
  // behaviour cannot drift apart.
  const base = {
    runtime_mode: 'REAL',
    synthetic: false,
  };

  it('accepts a real, non-synthetic record', () => {
    expect(assertReal(base)).toBe(true);
  });

  it('refuses a payload that claims to be synthetic', () => {
    // The single most important assertion in this file. A globe full of
    // fabricated marks is the worst failure this tool could have.
    expect(assertReal({ ...base, synthetic: true })).toBe(false);
    expect(assertReal({ ...base, runtime_mode: 'DEMO' })).toBe(false);
  });

  it('refuses a record that omits the guarantees rather than assuming them', () => {
    // Absence is not consent. A payload that does not state REAL/synthetic:false
    // is refused, because defaulting it to real would draw whatever arrived.
    expect(assertReal({} as never)).toBe(false);
    expect(assertReal({ runtime_mode: 'REAL' } as never)).toBe(false);
  });

});

describe('scan response validation', () => {
  const base: ScanTargetsResponse = {
    scan_id: 'DF-0001',
    // Present because the validator requires it. The first version of this
    // fixture omitted `stage`, so the count-mismatch test below was actually
    // asserting the stage check -- it failed for the wrong reason while reading
    // as though it had covered something it had not.
    stage: 'COMPLETE',
    runtime_mode: 'REAL',
    synthetic: false,
    aoi: [103.8, 1.24, 103.86, 1.28],
    count: 1,
    ais_only_count: 0,
    counts: { SAR_UNMATCHED: 1 },
    targets: [target()],
    ais_only: [],
    provenance: {},
    scene: {},
    acquisition_time: '2026-09-27T11:24:58.180786Z',
  } as unknown as ScanTargetsResponse;

  it('rejects a payload with missing collections rather than defaulting them', () => {
    // This test used to assert the opposite: that `toGlobeScanResult` turned
    // undefined collections into empty ones. That defensiveness is exactly what
    // hid the `cls` / `classification` drift -- a missing field became a plausible
    // default instead of a visible failure.
    //
    // The guarantee now lives one layer up, in the validator, which refuses the
    // payload outright. Defaulting is not merely moved, it is removed: a scan
    // response missing its targets is an inconsistent record, not an empty scan,
    // and the two must not look the same.
    for (const missing of ['targets', 'ais_only', 'aoi'] as const) {
      const raw = { ...base, [missing]: undefined } as unknown;
      expect(() => validateScanTargetsResponse(raw)).toThrow(ContractViolation);
    }
  });

  it('refuses a payload whose declared count disagrees with its targets', () => {
    // Also previously defaulted away. A record claiming 12 targets while
    // carrying 1 is inconsistent, and rendering 1 silently would misreport what
    // the scan found.
    const raw = { ...base, count: 12 } as unknown;
    expect(() => validateScanTargetsResponse(raw)).toThrow(/count/i);
  });
});
