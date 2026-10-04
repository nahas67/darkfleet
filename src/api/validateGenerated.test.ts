/**
 * The generic contract validator.
 *
 * Its value is that it CANNOT GO STALE. The field lists it checks come from
 * `contract.ts`, which is generated from the backend's OpenAPI document. Adding a
 * field to a Pydantic model propagates here on regeneration, so there is no
 * hand-maintained key list to drift.
 *
 * The failure it is built to prevent is the one that actually happened: the backend
 * emitted `cls`, the frontend declared `classification`, `t.classification` was
 * `undefined` in every live render path, and no test failed because nothing asserted
 * which key should be there.
 */

import { describe, expect, it } from 'vitest';

import {
  AISCOVERAGEOUT_FIELDS,
  TARGETAISRESPONSE_FIELDS,
  TRACKSOUT_FIELDS,
} from './contract';
import { ContractViolation } from './errors';
import { contractValidator, validateArray, validateShape } from './validateGenerated';

/** Build a payload that carries every declared key, with a recognisable value. */
function complete(fields: readonly string[], marker = 'x'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = marker;
  return out;
}

describe('a missing required key is a loud failure', () => {
  it('names the key it expected', () => {
    // Silently dropping a field is how `undefined` becomes a live colour: the panel
    // renders with a default and nothing indicates the payload was wrong.
    const partial = complete(TARGETAISRESPONSE_FIELDS);
    delete partial.target_id;
    expect(() => validateShape(partial, TARGETAISRESPONSE_FIELDS, 'TargetAisResponse')).toThrow(
      /target_id/,
    );
  });

  it('reports the path so the reader knows which object failed', () => {
    expect(() => validateShape({}, TRACKSOUT_FIELDS, 'TracksOut')).toThrow(ContractViolation);
    try {
      validateShape({}, TRACKSOUT_FIELDS, 'TracksOut');
    } catch (error) {
      // Whichever key is iterated first; the point is that the path names the OBJECT.
      expect((error as ContractViolation).path).toMatch(/^TracksOut[.]\w+$/);
    }
  });

  it('accepts a null where the contract declares a nullable field', () => {
    // `null` means the backend measured an absence and said so. Collapsing it into
    // "missing" would erase a distinction the whole evidence surface depends on.
    const payload = complete(TARGETAISRESPONSE_FIELDS);
    payload.mmsi = null;
    expect(() => validateShape(payload, TARGETAISRESPONSE_FIELDS, 'TargetAisResponse')).not.toThrow();
  });
});

describe('an unexpected key is a failure, not something to ignore', () => {
  it('rejects a key the contract does not declare', () => {
    // An extra key almost always means the frontend is reading a field the backend
    // renamed or removed. Ignoring it is how that becomes a silently blank panel.
    const payload = complete(TARGETAISRESPONSE_FIELDS);
    (payload as Record<string, unknown>).cls = 'SAR_UNMATCHED';
    expect(() => validateShape(payload, TARGETAISRESPONSE_FIELDS, 'TargetAisResponse')).toThrow(
      /unexpected key "cls"/,
    );
  });

  it('rejects a payload that is not an object at all', () => {
    for (const bad of [null, 'a string', 42, ['an', 'array']]) {
      expect(() => validateShape(bad, TRACKSOUT_FIELDS, 'TracksOut')).toThrow(ContractViolation);
    }
  });
});

describe('a validator built from the contract tracks the contract', () => {
  it('accepts a payload shaped exactly as the generated fields', () => {
    const validate = contractValidator<Record<string, unknown>>(AISCOVERAGEOUT_FIELDS, 'AisCoverageOut');
    const payload = complete(AISCOVERAGEOUT_FIELDS);
    expect(validate(payload)).toBe(payload);
  });

  it('passes a check that a hand-written mirror of the same fields would', () => {
    // This is the property that makes the generic form worth having: it agrees with
    // a hand-written check while being unable to drift from the contract.
    const validate = contractValidator<Record<string, unknown>>(AISCOVERAGEOUT_FIELDS, 'AisCoverageOut');
    expect(() => validate(complete(AISCOVERAGEOUT_FIELDS))).not.toThrow();
    const missingOne = complete(AISCOVERAGEOUT_FIELDS);
    delete missingOne.state;
    expect(() => validate(missingOne)).toThrow(/state/);
  });
});

describe('array validation names the offending index', () => {
  it('points at the item that failed rather than the whole array', () => {
    // "array invalid" sends the reader to the wrong record in a 200-row list.
    const rows = [complete(TRACKSOUT_FIELDS), complete(TRACKSOUT_FIELDS), {}];
    try {
      validateArray(rows, (v) => validateShape(v, TRACKSOUT_FIELDS, 'TracksOut'), 'TracksOut[]');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as ContractViolation).path).toBe('TracksOut[][2].scans_considered');
    }
  });

  it('rejects a non-array', () => {
    const item = (v: unknown) => v;
    expect(() => validateArray({ not: 'an array' }, item, 'X')).toThrow(/not an array/);
  });

  it('returns an empty array for an empty input', () => {
    expect(validateArray([], (v) => v, 'X')).toEqual([]);
  });
});