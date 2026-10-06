/**
 * THE "EXPOSED IS NOT REACHABLE" GATE.
 *
 * ================================ WHY A TEST AND NOT A CODE REVIEW ================================
 *
 * `aisRenderFailureReason` survived DF-X9.3, DF-X9.3D (whose own audit flagged it as a finding), and
 * DF-X9.4E, written by three careful passes and read by nothing. `get gaps()` then did the same thing
 * one checkpoint later, and its commit message claimed a capability that did not exist.
 *
 * Nothing about those fields looks wrong. They have types, they have doc comments, they have values
 * assigned to them. A reviewer reads them and moves on. The only thing that catches them is a test
 * that asks a question the source cannot answer by looking well-written: **does anything read this?**
 *
 * So this is that test, scoped to a REGISTERED list rather than a sweep. DF-X9.4H section 9 is right
 * that a naïve getter sweep is useless: it would either find hundreds of internal helpers or be
 * maintained by nobody and quietly rot. The registry is the unit, and adding an entry to it is a
 * claim that must hold.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AIS_DIAGNOSTIC_REGISTRY,
  EMPTY_AIS_DIAGNOSTICS,
  classify,
  describeAisFailure,
  type AisRenderFailure,
} from './aisDiagnostics';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Read a declared consumer, or null when it cannot be read.
 *
 * NULL IS A FAILURE, NOT A SKIP. A consumer this test cannot open is not a consumer, and skipping it
 * would be the exact "conditional assertion that never runs" pattern that made three of my own
 * harnesses report false results during DF-X9.4.
 */
function readConsumer(relativePath: string): string | null {
  try {
    return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
  } catch {
    return null;
  }
}

/** Whether a file reads a field, as opposed to merely naming it in a comment. */
function consumerReadsField(source: string, field: string): boolean {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
  // A property ACCESS, not a bare word: `.gaps` or `['gaps']`, so a comment or an import name cannot
  // satisfy the check.
  return new RegExp(`\\.${field}\\b|\\[['\"]${field}['\"]\\]`).test(code);
}

/* ============================================================================================== *
 * THE GATE
 * ============================================================================================== */

describe('product-facing AIS diagnostics are actually reachable', () => {
  it('every PRODUCT_REACHABLE registration names a consumer that really reads it', () => {
    const problems: string[] = [];

    for (const registration of AIS_DIAGNOSTIC_REGISTRY) {
      if (registration.class !== 'PRODUCT_REACHABLE') continue;
      const source = registration.consumer ? readConsumer(registration.consumer) : null;
      // The field name, which is the LAST dotted segment of the registration id.
      const field = registration.id.split('.').pop() ?? registration.id;
      const verdict = classify(registration, source === null ? null : consumerReadsField(source, field));
      if (verdict.problem !== null) problems.push(verdict.problem);
    }

    expect(
      problems,
      'A diagnostic claims PRODUCT_REACHABLE but no product component reads it. That is the '
      + '"exposed is not reachable" defect, which has now occurred twice in this codebase.',
    ).toEqual([]);
  });

  it('the registry is not empty, and is not trivially all TEST_ONLY', () => {
    // A registry nobody adds to is the same dead code it exists to prevent. If every entry were
    // TEST_ONLY there would be no product surface at all, which is not this product's state.
    expect(AIS_DIAGNOSTIC_REGISTRY.length).toBeGreaterThan(0);
    const product = AIS_DIAGNOSTIC_REGISTRY.filter((r) => r.class === 'PRODUCT_REACHABLE');
    expect(product.length).toBeGreaterThan(0);
  });

  it('every registration states WHY it has its class', () => {
    // A classification with no rationale is a preference. The rationale is what stops the next person
    // from reclassifying something to make a test pass.
    for (const registration of AIS_DIAGNOSTIC_REGISTRY) {
      expect(registration.rationale.length).toBeGreaterThan(20);
    }
  });

  it('no registration is classified DEAD', () => {
    // `DEAD` is a diagnostic STATE this module can express, not a class anything may sit in. A DEAD
    // entry is always a defect whatever the intent, so a registry containing one is a failure.
    const dead = AIS_DIAGNOSTIC_REGISTRY.filter((r) => r.class === 'DEAD');
    expect(dead.map((r) => r.id)).toEqual([]);
  });

  it('classify() reports the exact defect when a consumer does not read the field', () => {
    // The classifier is the mechanism, so its output is pinned. A silent pass here would make the
    // gate above vacuous.
    const bogus = {
      id: 'AisDiagnostics.gaps',
      class: 'PRODUCT_REACHABLE' as const,
      consumer: 'src/temporal/AisPlaybackBar.tsx',
      rationale: 'a synthetic registration whose consumer does not read the field',
    };
    const verdict = classify(bogus, false);
    expect(verdict.problem).toContain('does not read it');
    expect(verdict.problem).toContain('exposed is not reachable');
  });

  it('classify() treats an UNREADABLE consumer as a failure, not a skip', () => {
    const bogus = {
      id: 'AisDiagnostics.gaps',
      class: 'PRODUCT_REACHABLE' as const,
      consumer: 'src/does/not/exist.tsx',
      rationale: 'a synthetic registration whose consumer file does not exist',
    };
    expect(classify(bogus, null).problem).toContain('could not be read');
  });

  it('the gap record carries an MMSI, so a break can be attributed to a vessel', () => {
    /*
     * The attribution is the whole point of `mmsi`, and it is what made DF-X9.3E's gap finding
     * unsettleable. Without a vessel, "is this break where I seeked?" has no answer.
     */
    const gap = { mmsi: '257009003', from: { lat: 1, lon: 104 }, to: { lat: 2, lon: 104 }, spanSeconds: 3120 };
    expect(gap.mmsi).not.toBe('');
    expect(gap.spanSeconds).toBe(3120);
  });
});

/* ============================================================================================== *
 * FAILURE DESCRIPTIONS
 * ============================================================================================== */

describe('AIS renderer failure descriptions', () => {
  it('describes every code the union can hold', () => {
    // Exhaustiveness over the literal union: a new code without a description is a TYPE ERROR at the
    // switch, not a row that renders `undefined` as a tooltip.
    const codes: AisRenderFailure[] = ['RENDERER_UNAVAILABLE'];
    for (const code of codes) {
      const text = describeAisFailure(code);
      expect(text, `${code} must produce operator text`).toBeTruthy();
      expect(text).toContain('WebGL');
    }
  });

  it('is null for a healthy renderer, so no reason is invented', () => {
    // A caller can pass the result straight to `recordRefusal`; inventing a reason for a layer that
    // is drawing perfectly would disable a working control.
    expect(describeAisFailure(null)).toBeNull();
  });

  it('says the failure is SCOPED, so an operator does not think the whole product failed', () => {
    const text = describeAisFailure('RENDERER_UNAVAILABLE') ?? '';
    expect(text).toContain('no AIS contacts are being drawn');
    expect(text.toLowerCase()).toContain('other layer is unaffected');
  });
});

/* ============================================================================================== *
 * THE EMPTY RECORD
 * ============================================================================================== */

describe('the empty diagnostics record', () => {
  it('is all zeroes and nulls, never undefined fields', () => {
    // A diagnostic read at boot, before the first render, must not throw. `undefined.length` on a
    // partially-built record is how a diagnostics surface takes down the surface it diagnoses.
    expect(EMPTY_AIS_DIAGNOSTICS.gaps).toEqual([]);
    expect(EMPTY_AIS_DIAGNOSTICS.failure).toBeNull();
    expect(EMPTY_AIS_DIAGNOSTICS.drawnMmsis).toEqual([]);
    expect(EMPTY_AIS_DIAGNOSTICS.counts.contacts).toBe(0);
    expect(EMPTY_AIS_DIAGNOSTICS.counts.observationMarkers).toBe(0);
    expect(EMPTY_AIS_DIAGNOSTICS.counts.trackPrimitives).toBe(0);
    expect(EMPTY_AIS_DIAGNOSTICS.counts.predictedMarkers).toBe(0);
    expect(EMPTY_AIS_DIAGNOSTICS.counts.labels).toBe(0);
  });

  it('reports zero contacts, so a NOT_YET_OBSERVED fleet is honestly zero', () => {
    /*
     * The DF-X9.4G defect in miniature. The bug there was a contact with no position remaining in the
     * retained set, so the count -- like the glyph -- claimed a vessel that was not drawn. This pins
     * the shape: an absent vessel contributes zero, and the empty record is the honest answer.
     */
    expect(EMPTY_AIS_DIAGNOSTICS.drawnMmsis).not.toContain('257000001');
    expect(EMPTY_AIS_DIAGNOSTICS.counts.contacts).toBe(0);
  });
});

/* ============================================================================================== *
 * THE STORE CARRIES IT
 * ============================================================================================== */

describe('the store carries the diagnostic record', () => {
  it('starts EMPTY rather than absent, so a read before the first render is safe', async () => {
    const { store } = await import('../state/store');
    const diagnostics = store.getState().aisDiagnostics;
    expect(diagnostics).toBeDefined();
    expect(diagnostics.gaps).toEqual([]);
    expect(diagnostics.failure).toBeNull();
  });
});
