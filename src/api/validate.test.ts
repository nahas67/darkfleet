/**
 * Contract tests: the drift that shipped, pinned so it cannot ship again.
 *
 * The defect these exist to prevent
 * -------------------------------
 * The backend emitted `cls` on a detection; the frontend declared
 * `classification`. A live target had `cls: 'SAR_UNMATCHED'` and NO
 * `classification` key, so the detection's class was `undefined` in every live
 * render path -- detections drew, coloured by a default branch. Nothing failed:
 * the types were hand-written on both sides, so neither could see the other.
 *
 * Three layers guard it now:
 *   1. the backend validates every target (Pydantic, additionalProperties:false)
 *   2. `src/api/contract.ts` is GENERATED from that OpenAPI schema
 *   3. `src/api/validate.ts` re-checks the payload on arrival
 *
 * These tests cover layer 3, and assert that the keys layer 2 depends on are the
 * ones the server actually sends.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { CLASSIFICATION_VALUES } from '../api/contract.ts';
import {
  ContractViolation,
  validateAisAssociation,
  validateAisOnlyTarget,
  validateScanTargetsResponse,
  validateVesselTarget,
} from './validate.ts';

/** A target exactly as the live API returned it on 2026-10-02 (scan DF-0011). */
const LIVE_TARGET = {
  id: 'DF-001',
  cls: 'SAR_UNMATCHED',
  lat: 1.267269,
  lon: 103.85533,
  sarConf: 0.54,
  aisConf: 0.0,
  lenM: 15,
  widM: 12,
  lenUncM: 10,
  hdg: 89,
  wake: false,
  meanDb: -10.3,
  maxDb: -9.4,
  area: 5,
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
  assessment:
    'Unmatched surface radar return (~15m). No sufficiently confident AIS association in the available observations.',
  tags: ['SAR_UNMATCHED', 'AIS_UNASSOCIATED'],
} as unknown;

describe('the drift that shipped', () => {
  it('the live payload used `cls`, and the contract now uses `classification`', () => {
    // Recorded as a fact about the incident, not as a live assertion about the
    // server: the server no longer sends `cls`. This test exists so the history is
    // in the suite -- if someone reintroduces `cls`, the key-rejection test below
    // fires and this one explains why it matters.
    expect(LIVE_TARGET).toHaveProperty('cls');
    expect(LIVE_TARGET).not.toHaveProperty('classification');
  });

  it('rejects a target carrying the old `cls` key instead of ignoring it', () => {
    // The important half. Silently ignoring an unknown key is what let the drift
    // be invisible: `cls` was dropped, `classification` read as undefined, and
    // the default colour branch drew every detection identically.
    expect(() => validateVesselTarget(LIVE_TARGET)).toThrow(ContractViolation);
    expect(() => validateVesselTarget(LIVE_TARGET)).toThrow(/cls/);
  });

  it('accepts the same target once the field is named `classification`', () => {
    const wire = { ...(LIVE_TARGET as object), classification: 'SAR_UNMATCHED' };
    delete (wire as Record<string, unknown>).cls;
    const target = validateVesselTarget(wire);
    expect(target.classification).toBe('SAR_UNMATCHED');
    expect(target.sarConf).toBeCloseTo(0.54, 6);
    expect(target.lenUncM).toBe(10);
  });
});

describe('classification is never silently absent', () => {
  it('rejects a target with no classification at all', () => {
    const t = { ...(LIVE_TARGET as object), classification: undefined };
    delete (t as Record<string, unknown>).cls;
    expect(() => validateVesselTarget(t)).toThrow(/classification/);
  });

  it('rejects a classification outside the canonical seven', () => {
    const t = { ...(LIVE_TARGET as object), classification: 'DARK_VESSEL' };
    delete (t as Record<string, unknown>).cls;
    // A made-up class is refused rather than rendered with a fallback colour.
    expect(() => validateVesselTarget(t)).toThrow(/canonical/);
  });

  it('the generated contract lists exactly the seven classes', () => {
    expect([...CLASSIFICATION_VALUES].sort()).toEqual(
      [
        'AIS_ONLY',
        'LOW_CONFIDENCE',
        'SAR_MATCHED_AIS',
        'SAR_UNMATCHED',
        'SEA_CLUTTER',
        'STATIONARY_OR_INFRASTRUCTURE',
        'UNRESOLVED',
      ].sort(),
    );
  });
});

describe('uncertainty is never defaulted', () => {
  it('rejects a target whose lenUncM is missing', () => {
    const t = { ...(LIVE_TARGET as object), classification: 'SAR_UNMATCHED' };
    delete (t as Record<string, unknown>).cls;
    delete (t as Record<string, unknown>).lenUncM;
    // A missing uncertainty would let the globe draw a confident circle the
    // detector never justified.
    expect(() => validateVesselTarget(t)).toThrow(/lenUncM/);
  });

  it('rejects a negative uncertainty', () => {
    const t = {
      ...(LIVE_TARGET as object),
      classification: 'SAR_UNMATCHED',
      lenUncM: -4,
    };
    delete (t as Record<string, unknown>).cls;
    expect(() => validateVesselTarget(t)).toThrow(/lenUncM/);
  });
});

describe('association consistency', () => {
  it('accepts a real association with both endpoints', () => {
    const corr = validateAisAssociation({
      matched: true,
      mmsi: '565123456',
      vesselName: 'STRAIT VOYAGER',
      distanceOffsetMeters: 14.2,
      timeDeltaSeconds: 3.1,
      predictedLat: 1.267511,
      predictedLon: 103.855401,
      aisAssociationConfidence: 0.88,
      scoreDecomposition: {
        spatialScore: 0.9,
        temporalScore: 0.85,
        headingScore: 0.72,
        sizeScore: 0.8,
        compositeScore: 0.84,
        matchRadiusMeters: 400,
        distanceOffsetMeters: 14.2,
        timeDeltaSeconds: 3.1,
      },
    });
    expect(corr.matched).toBe(true);
    expect(corr.mmsi).toBe('565123456');
  });

  it('rejects matched=true with no MMSI', () => {
    // Would render as an association while naming nothing.
    expect(() =>
      validateAisAssociation({
        matched: true,
        mmsi: null,
        predictedLat: 1.2,
        predictedLon: 103.8,
      }),
    ).toThrow(/MMSI/);
  });

  it('rejects matched=true with no predicted position', () => {
    // No second point, so no link can be drawn; the validator refuses rather than
    // letting a consumer substitute one.
    expect(() =>
      validateAisAssociation({ matched: true, mmsi: '111222333' }),
    ).toThrow(/predicted position/);
  });

  it('accepts an unmatched association with every measurement null', () => {
    const corr = validateAisAssociation({
      matched: false,
      mmsi: null,
      vesselName: null,
      distanceOffsetMeters: null,
      timeDeltaSeconds: null,
      predictedLat: null,
      predictedLon: null,
      aisAssociationConfidence: 0,
      scoreDecomposition: null,
    });
    expect(corr.matched).toBe(false);
  });

  it('rejects a blank vessel name rather than rendering an empty label', () => {
    // The BACKEND normalises "" to None (`AisAssociation._blank_to_none`), so a
    // blank name should never arrive. If one does, the normaliser did not run and
    // the right response is to say so -- not to silently convert here too, and
    // certainly not to draw a label with nothing in it.
    expect(() =>
      validateAisAssociation({ matched: false, mmsi: null, vesselName: '' }),
    ).toThrow(/vesselName/);
  });
});

describe('scan response invariants', () => {
  /** LIVE_TARGET with `cls` properly removed, not set to undefined. */
  const wireTarget = (): Record<string, unknown> => {
    const t: Record<string, unknown> = {
      ...(LIVE_TARGET as Record<string, unknown>),
      classification: 'SAR_UNMATCHED',
    };
    delete t['cls'];
    return t;
  };

  const response = (over: Record<string, unknown> = {}) =>
    ({
      scan_id: 'DF-0001',
      stage: 'COMPLETE',
      runtime_mode: 'REAL',
      synthetic: false,
      aoi: [103.8, 1.24, 103.86, 1.28],
      count: 1,
      ais_only_count: 0,
      counts: { SAR_UNMATCHED: 1 },
      targets: [wireTarget()],
      ais_only: [],
      provenance: {},
      scene: null,
      acquisition_time: '2026-09-27T11:24:58.180786Z',
      ...over,
    }) as unknown;

  it('accepts a well-formed real response', () => {
    const parsed = validateScanTargetsResponse(response());
    expect(parsed.count).toBe(1);
    expect(parsed.targets[0].classification).toBe('SAR_UNMATCHED');
  });

  it('refuses a payload that claims to be synthetic', () => {
    // The single most important assertion here. A globe full of fabricated marks
    // is the worst failure this tool could have.
    expect(() => validateScanTargetsResponse(response({ synthetic: true }))).toThrow(
      /synthetic/,
    );
  });

  it('refuses any runtime_mode other than REAL', () => {
    expect(() => validateScanTargetsResponse(response({ runtime_mode: 'DEMO' }))).toThrow(
      /REAL/,
    );
  });

  it('refuses a count that disagrees with the targets carried', () => {
    expect(() => validateScanTargetsResponse(response({ count: 12 }))).toThrow(/count/i);
  });

  it('refuses a missing targets array rather than treating it as empty', () => {
    expect(() => validateScanTargetsResponse(response({ targets: undefined }))).toThrow(
      /targets/,
    );
  });

  it('refuses a non-numeric count entry', () => {
    expect(() =>
      validateScanTargetsResponse(response({ counts: { SAR_UNMATCHED: 'many' } })),
    ).toThrow(/counts/);
  });

  it('rejects an unknown top-level key', () => {
    expect(() => validateScanTargetsResponse(response({ surprise: true }))).toThrow(
      ContractViolation,
    );
  });
});

describe('AIS-only contacts', () => {
  it('accepts a real contact', () => {
    const a = validateAisOnlyTarget({
      cls: 'AIS_ONLY',
      mmsi: '999888777',
      vesselName: null,
      lat: 1.25,
      lon: 103.83,
      timestamp: '2026-09-27T11:20:00Z',
    });
    expect(a.mmsi).toBe('999888777');
  });

  it('requires an MMSI', () => {
    expect(() =>
      validateAisOnlyTarget({ lat: 1.25, lon: 103.83, timestamp: 'x' }),
    ).toThrow(/mmsi/);
  });
});
