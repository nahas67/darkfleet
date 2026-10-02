/**
 * Runtime validation of API responses.
 *
 * WHY THIS EXISTS
 * ---------------
 * The frontend used to declare its own copy of every wire shape and cast the
 * parsed JSON straight into it. Nothing checked the payload. The backend emitted
 * `cls` where the frontend declared `classification`, so `t.classification` was
 * `undefined` in every live render path and no test failed — detections drew,
 * coloured by a default branch, because there was no assertion anywhere that
 * said which key should have been there.
 *
 * Generated types fix the drift going forward (both sides come from one
 * OpenAPI document). They cannot fix a payload that arrives malformed, because
 * TypeScript erases at runtime. This module is the other half: every response
 * passes through here before the application is allowed to believe it.
 *
 * Design
 * ------
 * * Fail LOUDLY. A validation failure throws `ContractViolation` naming the
 *   exact path. It never silently drops a field or substitutes a default — a
 *   quietly-defaulted field is exactly how `undefined` became a live colour.
 * * `null` and `undefined` are DISTINCT from missing. The contract uses `null`
 *   to mean "measured as absent" (e.g. `hdg: null` = no heading measured) and
 *   omission to mean "field not applicable". Collapsing them would erase the
 *   distinction the backend deliberately maintains.
 * * Validation is total and synchronous. No schema library, no async, nothing to
 *   configure. A 200-line file that anyone can read beats a dependency.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AisAssociation,
  AisOnlyTarget,
  ScanTargetsResponse,
  VesselTarget,
} from './contract.ts';

/** Thrown when a response does not match the generated contract. */
export class ContractViolation extends Error {
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string) {
    super(`API contract violated at ${path}: ${detail}`);
    this.name = 'ContractViolation';
    this.path = path;
    this.detail = detail;
  }
}

const CLASSES = new Set([
  'SAR_MATCHED_AIS',
  'SAR_UNMATCHED',
  'AIS_ONLY',
  'STATIONARY_OR_INFRASTRUCTURE',
  'SEA_CLUTTER',
  'LOW_CONFIDENCE',
  'UNRESOLVED',
]);

// Every key the backend is allowed to send for a target. A key outside this set
// means the contract moved and the generated file is stale, which is a build-time
// problem, not something to absorb at runtime.
const TARGET_KEYS = new Set([
  'id',
  'classification',
  'lat',
  'lon',
  'sarConf',
  'aisConf',
  'lenM',
  'widM',
  'lenUncM',
  'hdg',
  'wake',
  'meanDb',
  'maxDb',
  'area',
  'corr',
  'assessment',
  'tags',
]);

const CORR_KEYS = new Set([
  'matched',
  'mmsi',
  'vesselName',
  'distanceOffsetMeters',
  'timeDeltaSeconds',
  'predictedLat',
  'predictedLon',
  'aisAssociationConfidence',
  'scoreDecomposition',
]);

/**
 * Top-level keys of GET /api/scans/{id}/targets.
 *
 * Checked because THIS is where the drift appeared: a `cls` key on a target that
 * the contract did not declare. The per-target check exists too, but a response
 * level unexpected key is the cheapest signal that the server and this build
 * disagree about the shape at all.
 */
const RESPONSE_KEYS = new Set([
  'scan_id',
  'stage',
  'runtime_mode',
  'synthetic',
  'aoi',
  'count',
  'ais_only_count',
  'counts',
  'targets',
  'ais_only',
  'provenance',
  'scene',
  'acquisition_time',
]);

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation(path, `expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * A required finite number, unless `nullable`.
 *
 * `nullable` tolerates BOTH `null` and `undefined`, because the backend expresses
 * absence both ways: a field with a Pydantic default is omitted entirely, and one
 * explicitly set to None arrives as `null`. Both mean "not measured" and neither
 * may be turned into a 0. The first version tolerated only `null`, so every
 * omitted optional measurement failed validation before the semantic checks could
 * run -- which is how a matched association with no MMSI got reported as a type
 * error about `distanceOffsetMeters` instead.
 */
function num(v: unknown, path: string, opts: { nullable?: boolean } = {}): void {
  if (opts.nullable && (v === null || v === undefined)) return;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ContractViolation(path, `expected a finite number, got ${describe(v)}`);
  }
}

/**
 * A required string, unless `nullable`.
 *
 * An empty string is rejected wherever the field is nullable. AIS providers send
 * `""` for "no vessel name", and the backend normalises that to `null`; if a blank
 * reaches this validator the normaliser did not run, and the honest response is to
 * say so. Accepting it would draw a label containing nothing while looking like a
 * named contact.
 */
function str(v: unknown, path: string, opts: { nullable?: boolean } = {}): void {
  if (opts.nullable && (v === null || v === undefined)) return;
  if (typeof v !== 'string') {
    throw new ContractViolation(path, `expected a string, got ${describe(v)}`);
  }
  if (v === '' && opts.nullable) {
    throw new ContractViolation(
      path,
      'expected null for an absent value, got an empty string; the backend ' +
        'normalises blank provider names to null',
    );
  }
}

function bool(v: unknown, path: string): void {
  if (typeof v !== 'boolean') {
    throw new ContractViolation(path, `expected a boolean, got ${describe(v)}`);
  }
}

/**
 * Reject a key the contract does not declare.
 *
 * This is the check that would have caught the `cls` / `classification` drift on
 * day one. Absorbing the unknown key instead is what made the bug invisible.
 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ContractViolation(
        `${path}.${key}`,
        `key is not in the generated contract. The backend changed; re-run ` +
          `python -m tools.export_contract.`,
      );
    }
  }
}

/** Validate one association. Returns a narrowed, trusted value. */
export function validateAisAssociation(raw: unknown, path = 'corr'): AisAssociation {
  const o = obj(raw, path);
  rejectUnknownKeys(o, CORR_KEYS, path);

  bool(o['matched'], `${path}.matched`);
  str(o['mmsi'], `${path}.mmsi`, { nullable: true });
  str(o['vesselName'], `${path}.vesselName`, { nullable: true });
  num(o['distanceOffsetMeters'], `${path}.distanceOffsetMeters`, { nullable: true });
  num(o['timeDeltaSeconds'], `${path}.timeDeltaSeconds`, { nullable: true });
  num(o['predictedLat'], `${path}.predictedLat`, { nullable: true });
  num(o['predictedLon'], `${path}.predictedLon`, { nullable: true });

  if (o['matched'] === true) {
    // A match with no MMSI is not a match. This is the specific shape that would
    // render as "associated" in the UI while naming nothing.
    if (typeof o['mmsi'] !== 'string' || o['mmsi'] === '') {
      throw new ContractViolation(`${path}.mmsi`, 'matched=true requires an MMSI');
    }
    if (o['predictedLat'] === null || o['predictedLat'] === undefined) {
      throw new ContractViolation(
        `${path}.predictedLat`,
        'matched=true requires a predicted position, otherwise no link can be drawn',
      );
    }
  }

  if (o['scoreDecomposition'] !== null && o['scoreDecomposition'] !== undefined) {
    const sd = obj(o['scoreDecomposition'], `${path}.scoreDecomposition`);
    for (const k of [
      'spatialScore',
      'temporalScore',
      'headingScore',
      'sizeScore',
      'compositeScore',
      'matchRadiusMeters',
      'distanceOffsetMeters',
      'timeDeltaSeconds',
    ]) {
      num(sd[k], `${path}.scoreDecomposition.${k}`);
    }
  }

  return o as unknown as AisAssociation;
}

/** Validate one detection. Returns a narrowed, trusted value. */
export function validateVesselTarget(raw: unknown, path = 'target'): VesselTarget {
  const o = obj(raw, path);
  rejectUnknownKeys(o, TARGET_KEYS, path);

  str(o['id'], `${path}.id`);
  num(o['lat'], `${path}.lat`);
  num(o['lon'], `${path}.lon`);
  num(o['sarConf'], `${path}.sarConf`);
  num(o['lenM'], `${path}.lenM`);
  num(o['widM'], `${path}.widM`);
  num(o['meanDb'], `${path}.meanDb`);
  num(o['maxDb'], `${path}.maxDb`);
  num(o['area'], `${path}.area`);

  // The two fields whose absence would silently degrade a rendered judgement.
  const cls = o['classification'];
  if (typeof cls !== 'string' || !CLASSES.has(cls)) {
    throw new ContractViolation(
      `${path}.classification`,
      `expected one of the 7 canonical classes, got ${JSON.stringify(cls)}. ` +
        `A missing class must fail loudly, not render as a default colour.`,
    );
  }

  // lenUncM carries the footprint uncertainty. A missing one would let a
  // consumer draw a confident circle the detector never justified.
  const unc = o['lenUncM'];
  if (typeof unc !== 'number' || !Number.isFinite(unc) || unc < 0) {
    throw new ContractViolation(
      `${path}.lenUncM`,
      `expected a non-negative uncertainty, got ${describe(unc)}`,
    );
  }

  num(o['hdg'], `${path}.hdg`, { nullable: true });
  num(o['aisConf'], `${path}.aisConf`);
  str(o['assessment'], `${path}.assessment`, { nullable: true });

  if (!Array.isArray(o['tags'])) {
    throw new ContractViolation(`${path}.tags`, `expected an array, got ${describe(o['tags'])}`);
  }
  for (const [i, t] of (o['tags'] as unknown[]).entries()) {
    str(t, `${path}.tags[${i}]`);
  }

  validateAisAssociation(o['corr'], `${path}.corr`);
  return o as unknown as VesselTarget;
}

/** Validate one AIS-only contact. */
export function validateAisOnlyTarget(raw: unknown, path = 'ais_only'): AisOnlyTarget {
  const o = obj(raw, path);
  str(o['mmsi'], `${path}.mmsi`);
  str(o['vesselName'], `${path}.vesselName`, { nullable: true });
  num(o['lat'], `${path}.lat`);
  num(o['lon'], `${path}.lon`);
  str(o['timestamp'], `${path}.timestamp`);
  return o as unknown as AisOnlyTarget;
}

/**
 * Validate `GET /api/scans/{id}/targets`.
 *
 * Also enforces the two cross-field invariants the types cannot express:
 * `count` must equal `targets.length`, and `runtime_mode`/`synthetic` must
 * agree. A record claiming real data while flagged synthetic is the exact
 * failure the store exists to prevent, and this is the last point in the browser
 * where it can still be caught.
 */
export function validateScanTargetsResponse(raw: unknown): ScanTargetsResponse {
  const o = obj(raw, 'response');
  rejectUnknownKeys(o, RESPONSE_KEYS, 'response');

  str(o['scan_id'], 'response.scan_id');
  str(o['stage'], 'response.stage');
  bool(o['synthetic'], 'response.synthetic');

  if (o['runtime_mode'] !== 'REAL') {
    throw new ContractViolation(
      'response.runtime_mode',
      `expected "REAL", got ${JSON.stringify(o['runtime_mode'])}. There is no ` +
        `other mode; a payload claiming one is not a scan this build can read.`,
    );
  }
  if (o['synthetic'] !== false) {
    throw new ContractViolation(
      'response.synthetic',
      'expected false: this build has no synthetic path, so a payload claiming ' +
        'synthetic data must not reach the map or the evidence panel.',
    );
  }

  if (!Array.isArray(o['aoi'])) {
    throw new ContractViolation('response.aoi', `expected an array, got ${describe(o['aoi'])}`);
  }
  for (const [i, v] of (o['aoi'] as unknown[]).entries()) {
    num(v, `response.aoi[${i}]`);
  }

  if (!Array.isArray(o['targets'])) {
    throw new ContractViolation(
      'response.targets',
      `expected an array, got ${describe(o['targets'])}`,
    );
  }
  const targets = (o['targets'] as unknown[]).map((t, i) => validateVesselTarget(t, `response.targets[${i}]`));

  if (typeof o['count'] !== 'number' || o['count'] !== targets.length) {
    throw new ContractViolation(
      'response.count',
      `declared ${String(o['count'])} but carried ${targets.length} targets; ` +
        `a disagreement means the record is inconsistent, not merely surprising.`,
    );
  }

  if (!Array.isArray(o['ais_only'])) {
    // Strict, like `targets` and `aoi`. This was briefly tolerant, and the
    // inconsistency is worse than either choice alone: a payload missing its
    // AIS contacts passed validation and rendered as "zero AIS-only contacts",
    // which reads as a measured finding rather than a missing field.
    throw new ContractViolation(
      'response.ais_only',
      `expected an array, got ${describe(o['ais_only'])}`,
    );
  }
  const aisOnly = (o['ais_only'] as unknown[]).map((t, i) =>
    validateAisOnlyTarget(t, `response.ais_only[${i}]`),
  );
  if (typeof o['ais_only_count'] !== 'number' || o['ais_only_count'] !== aisOnly.length) {
    throw new ContractViolation(
      'response.ais_only_count',
      `declared ${String(o['ais_only_count'])} but carried ${aisOnly.length}`,
    );
  }

  if (typeof o['counts'] !== 'object' || o['counts'] === null) {
    throw new ContractViolation('response.counts', 'expected an object of class -> number');
  }
  for (const [k, v] of Object.entries(o['counts'] as Record<string, unknown>)) {
    if (typeof v !== 'number') {
      throw new ContractViolation(`response.counts.${k}`, `expected a number, got ${describe(v)}`);
    }
  }

  return o as unknown as ScanTargetsResponse;
}
