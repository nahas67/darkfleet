/**
 * The runtime validator must not be a second source of truth.
 *
 * Found while wiring the analytics surface: `VesselTarget` gained
 * `geoPixelCentroid` and `geoCentreOffset`, the generated contract was
 * regenerated and declared both, and the hand-written `TARGET_KEYS` set in
 * `validate.ts` was not updated. Every real `/targets` response was then rejected
 * at runtime:
 *
 *   API contract violated at response.targets[0].geoPixelCentroid:
 *   key is not in the generated contract
 *
 * The message named the generated contract as the thing that had moved, while
 * the generated contract -- three hundred lines above the failure -- plainly
 * declared the field. The browser showed DET 0 for a scan the backend had just
 * completed with three targets, while the analytics tables read the same backend
 * happily.
 *
 * Both facts were true at once, and nothing failed loudly enough to connect them.
 * The fix was to emit the key sets from the exporter; these tests exist so the
 * mirror cannot come back.
 */

import { describe, expect, it } from 'vitest';

import {
  AISASSOCIATION_FIELDS,
  SCANTARGETSRESPONSE_FIELDS,
  SCOREDECOMPOSITION_FIELDS,
  VESSELTARGET_FIELDS,
} from './contract';
import { validateScanTargetsResponse, ContractViolation } from './validate';

describe('the permitted key sets are generated, not maintained', () => {
  it('emits a field array for every emitted object schema', () => {
    // A schema with no properties would be pointless to emit; the ones below all
    // have them, and each must be present.
    expect(VESSELTARGET_FIELDS.length).toBeGreaterThan(0);
    expect(AISASSOCIATION_FIELDS.length).toBeGreaterThan(0);
    expect(SCANTARGETSRESPONSE_FIELDS.length).toBeGreaterThan(0);
  });

  it('declares the sub-pixel centroid, which is what drifted', () => {
    // The two fields whose absence caused the failure. Named explicitly so that
    // removing them from the backend is a deliberate, visible edit here.
    expect(VESSELTARGET_FIELDS).toContain('geoPixelCentroid');
    expect(VESSELTARGET_FIELDS).toContain('geoCentreOffset');
  });

  it('uses the WIRE name, not the python field name', () => {
    // `cls` is the record's key and `classification` the wire name. Validating
    // against the python name would reject the correct response and accept a
    // stale one, which is worse than not checking at all.
    expect(VESSELTARGET_FIELDS).toContain('classification');
    expect(VESSELTARGET_FIELDS).not.toContain('cls');
    expect(VESSELTARGET_FIELDS).toContain('sarConf');
    expect(VESSELTARGET_FIELDS).not.toContain('sar_conf');
  });

  it('accepts a target carrying every generated field', () => {
    // Built FROM the generated list, so this cannot fall behind: if the backend
    // adds a field, the fixture grows with it and the test still passes; if the
    // validator's own list falls behind, this fails.
    const target: Record<string, unknown> = {};
    for (const key of VESSELTARGET_FIELDS) target[key] = defaultFor(key);

    const response: Record<string, unknown> = {};
    for (const key of SCANTARGETSRESPONSE_FIELDS) response[key] = defaultFor(key);
    response.targets = [target];
    response.ais_only = [];
    response.count = 1;

    expect(() => validateScanTargetsResponse(response)).not.toThrow();
  });

  it('still rejects a key the backend does not declare', () => {
    // The check has to keep its teeth. A validator that accepted everything
    // would pass the test above just as well, and would be worthless.
    const response: Record<string, unknown> = {};
    for (const key of SCANTARGETSRESPONSE_FIELDS) response[key] = defaultFor(key);
    response.targets = [];
    response.ais_only = [];
    response.count = 0;
    response.invented_field = 'should not be accepted';

    expect(() => validateScanTargetsResponse(response)).toThrow(ContractViolation);
  });

  it('rejects a target key that is not in the generated list', () => {
    const response: Record<string, unknown> = {};
    for (const key of SCANTARGETSRESPONSE_FIELDS) response[key] = defaultFor(key);
    response.ais_only = [];
    response.count = 1;
    response.targets = [{ ...blankTarget(), somethingNew: 1 }];

    expect(() => validateScanTargetsResponse(response)).toThrow(/not in the generated contract/);
  });
});

function blankTarget(): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const key of VESSELTARGET_FIELDS) target[key] = defaultFor(key);
  return target;
}

/** A complete association, built from the generated key set like everything else. */
function blankAssociation(): Record<string, unknown> {
  const association: Record<string, unknown> = {};
  for (const key of AISASSOCIATION_FIELDS) {
    // The one nested object is built from its own generated key set.
    association[key] =
      key === 'scoreDecomposition' ? blankScoreDecomposition() : defaultFor(key);
  }
  return association;
}

function blankScoreDecomposition(): Record<string, unknown> {
  const decomposition: Record<string, unknown> = {};
  for (const key of SCOREDECOMPOSITION_FIELDS) decomposition[key] = defaultFor(key);
  return decomposition;
}

/** A plausible value for each declared key, by name rather than by position. */
function defaultFor(key: string): unknown {
  switch (key) {
    case 'classification':
      return 'SAR_UNMATCHED';
    case 'scan_id':
      return 'DF-0001';
    case 'stage':
      return 'COMPLETE';
    case 'runtime_mode':
      return 'REAL';
    case 'synthetic':
      return false;
    case 'aoi':
      return [104.1, 1.35, 104.14, 1.4];
    case 'targets':
      return [];
    case 'ais_only':
      return [];
    case 'count':
      return 0;
    case 'ais_only_count':
      return 0;
    case 'counts':
      return {};
    case 'provenance':
      return {};
    case 'scene':
      return null;
    case 'acquisition_time':
      return '2024-01-01T00:00:00Z';
    case 'id':
      return 'DF-001';
    case 'corr':
      // Present, so it must be a real association: the validator checks nested
      // shape too, and `corr: null` is rejected rather than treated as absent.
      return blankAssociation();
    case 'mmsi':
      return '123456789';
    case 'vesselName':
      return null;
    case 'predictedLat':
    case 'predictedLon':
      return 1.34;
    case 'distanceOffsetMeters':
      return 120;
    case 'timeDeltaSeconds':
      return 30;
    case 'aisAssociationConfidence':
      return 0.9;
    case 'matched':
      return true;
    case 'wake':
      return false;
    case 'tags':
      return [];
    case 'assessment':
      return null;
    case 'matched':
      return false;
    case 'geoPixelCentroid':
      return [199.9895914555838, 119.97797657674496];
    default:
      // Numeric for everything else: lat/lon, confidences, footprints, and the
      // correlation measurements.
      return 0;
  }
}