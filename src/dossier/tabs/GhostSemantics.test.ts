/**
 * GHOST VESSEL SEMANTICS -- the tests for a surface that was unreachable for an entire checkpoint.
 *
 * ================================ WHY PURE FUNCTIONS FOR A VIEW ================================
 *
 * `coverageVerdict` is the one piece of real logic here, and it is pure on purpose. It maps a
 * backend record to a named state, and every way it can be wrong is a way an operator is told
 * something false about their own data:
 *
 *   - collapsing `candidates_considered === 0` into "no AIS coverage" (the DF-X7 defect)
 *   - rendering `null` as `0` (an unrecorded count presented as a measured one)
 *   - inventing a state the backend never establishes ("zero observations")
 *
 * None of those is visible in a screenshot and all of them are one line of logic. So the states
 * are enumerated here, and the view is left to print them.
 *
 * The rendering assertions are source-level and are labelled as such. What React emits is the
 * E2E's claim; these pin that the values the view is GIVEN are the right ones.
 */

import { describe, expect, it } from 'vitest';

import { coverageVerdict, COVERAGE_VERDICT_LABEL, type CoverageVerdict } from './GhostSemantics';
import type { GhostAssociationDecision } from '../../api/contract';

const SEMANTICS = (await import('./GhostSemantics?raw')).default as string;
const PANEL = (await import('../../ghost_vessel?raw')).default as string;

/** A decision with only the fields a test cares about overridden. */
function decision(over: Partial<GhostAssociationDecision> = {}): GhostAssociationDecision {
  return {
    candidates_considered: 1,
    acceptance_threshold: 0.72,
    closest_rejected_candidate: null,
    reason_no_association: 'test',
    ais_association_confidence: null,
    ais_coverage_state: 'AVAILABLE',
    score_decomposition: null,
    ...over,
  };
}

/* ============================================================================================== *
 * THE COVERAGE QUESTION -- DF-X7's DEFECT, KEPT FROM COMING BACK
 * ============================================================================================== */

describe('coverageVerdict', () => {
  it('distinguishes every state the backend can ACTUALLY establish', () => {
    expect(coverageVerdict(decision({ ais_coverage_state: 'NOT_CONFIGURED' }))).toBe(
      'AIS_SOURCE_NOT_CONFIGURED',
    );
    expect(coverageVerdict(decision({ ais_coverage_state: 'NO_COVERAGE' }))).toBe('NO_COVERAGE');
    expect(coverageVerdict(decision({ ais_coverage_state: 'PARTIAL' }))).toBe('PARTIAL_COVERAGE');
    expect(coverageVerdict(decision({ candidates_considered: 0 }))).toBe('ZERO_CANDIDATES');
    expect(coverageVerdict(decision({ candidates_considered: 3 }))).toBe('CANDIDATES_REJECTED');
  });

  it('ZERO CANDIDATES IS NOT "NO COVERAGE" -- the DF-X7 regression', () => {
    /*
     * THE regression this checkpoint exists to keep fixed.
     *
     * A system with excellent AIS coverage and no vessel near the target yields zero candidates.
     * A system with no AIS source at all also yields zero candidates. Same number, entirely
     * different finding, and an operator told only "0 candidates" cannot tell which they have.
     *
     * The coverage states are therefore checked FIRST, so a missing source is reported as a
     * missing source and never as a measured zero.
     */
    expect(coverageVerdict(decision({ ais_coverage_state: 'NO_COVERAGE', candidates_considered: 0 })))
      .toBe('NO_COVERAGE');
    expect(coverageVerdict(decision({ ais_coverage_state: 'NOT_CONFIGURED', candidates_considered: 0 })))
      .toBe('AIS_SOURCE_NOT_CONFIGURED');
    // And the two remain distinct from the genuinely-zero case.
    expect(coverageVerdict(decision({ ais_coverage_state: 'AVAILABLE', candidates_considered: 0 })))
      .toBe('ZERO_CANDIDATES');
  });

  it('a NULL candidate count is NOT_ESTABLISHED, never zero', () => {
    /*
     * `candidates_considered: null` means the record does not say how many were considered.
     * Rendering it as `0` -- which `value || 0` does silently -- states that nothing was
     * available, which is a measurement the backend never made.
     *
     * This is the same operator as the `0.0 or 1e9` bug in my own measurement harness: a
     * falsy-coalesce on a value where falsy is meaningful.
     */
    expect(coverageVerdict(decision({ candidates_considered: null }))).toBe('NOT_ESTABLISHED');
    expect(coverageVerdict(decision({ ais_coverage_state: 'UNKNOWN_STATE', candidates_considered: null })))
      .toBe('NOT_ESTABLISHED');
  });

  it('a MISSING decision is NOT_ESTABLISHED, not an empty search', () => {
    // An absent record is an absence in the evidence, never a finding that nothing was considered.
    expect(coverageVerdict(null)).toBe('NOT_ESTABLISHED');
    expect(coverageVerdict(undefined)).toBe('NOT_ESTABLISHED');
  });

  it('it does NOT invent a ZERO OBSERVATIONS state', () => {
    /*
     * The tempting state, and the one the backend cannot establish.
     *
     * `candidates_considered` counts AIS vessels CONSIDERED. It does not count observations in the
     * search window. "Zero observations" is a different quantity, not derivable from this record,
     * and reporting it would mean inventing a measurement. So the union has no such member, and
     * this test fails if one is ever added.
     */
    const verdicts = Object.keys(COVERAGE_VERDICT_LABEL);
    expect(verdicts).not.toContain('ZERO_OBSERVATIONS');
    expect(verdicts).toHaveLength(6);
  });

  it('every state has a LABEL, so none renders as undefined', () => {
    // A state with no label renders the word "undefined" as a finding.
    const states: CoverageVerdict[] = [
      'AIS_SOURCE_NOT_CONFIGURED',
      'NO_COVERAGE',
      'PARTIAL_COVERAGE',
      'ZERO_CANDIDATES',
      'CANDIDATES_REJECTED',
      'NOT_ESTABLISHED',
    ];
    for (const state of states) {
      expect(COVERAGE_VERDICT_LABEL[state], `${state} must have a label`).toBeTruthy();
    }
  });

  it('is case-insensitive on the coverage state, because it comes off the wire', () => {
    expect(coverageVerdict(decision({ ais_coverage_state: 'no_coverage' }))).toBe('NO_COVERAGE');
    expect(coverageVerdict(decision({ ais_coverage_state: 'Not_Configured' }))).toBe(
      'AIS_SOURCE_NOT_CONFIGURED',
    );
  });
});

/* ============================================================================================== *
 * NO BROWSER RESCORE
 * ============================================================================================== */

describe('the surface reports, it does not recompute', () => {
  it('no threshold comparison happens in the frontend', () => {
    /*
     * §9: use only fields supported by the current backend contract, and do not browser-rescore.
     *
     * A second scoring implementation is a second set of answers to the same question, and only
     * one of them is the analytical authority. So there must be no comparison of a candidate's
     * score against a threshold anywhere in this module -- the backend already decided, and its
     * decision is printed.
     */
    const code = SEMANTICS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/score\s*[<>]=?\s*threshold/);
    expect(code).not.toMatch(/threshold\s*[<>]=?\s*score/);
    // Nor any arithmetic on the two: a "short by" recomputed here would be a second opinion.
    expect(code).not.toMatch(/threshold\s*-/);
    expect(code).not.toMatch(/-\s*candidate\.score/);
  });

  it('the rejected candidate is printed from the backend record, field for field', () => {
    const code = SEMANTICS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('candidate.mmsi');
    expect(code).toContain('candidate.score');
    expect(code).toContain('candidate.shortfall');
    expect(code).toContain('candidate.distanceMeters');
    expect(code).toContain('candidate.timeDeltaSeconds');
  });

  it('the score decomposition is rendered in full, so a rejection can be interrogated', () => {
    // A composite score with no decomposition is a verdict an operator cannot check.
    const code = SEMANTICS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const field of [
      'spatialScore',
      'temporalScore',
      'headingScore',
      'sizeScore',
      'compositeScore',
      'matchRadiusMeters',
      'distanceOffsetMeters',
      'timeDeltaSeconds',
    ]) {
      expect(code, `${field} must be rendered`).toContain(field);
    }
  });
});

/* ============================================================================================== *
 * NEGATIVE LANGUAGE -- §18
 * ============================================================================================== */

describe('no unsupported inference is claimed by the surface', () => {
  /*
   * Phrases that would each be an UNSUPPORTED INFERENCE if the product asserted them.
   *
   * Checked on SOURCE, not on documentation: a doc that says "we never claim evasion" proves
   * nothing about what a string literal in a component says.
   *
   * "dark" was in the first list and had to come out -- it matches `DarkFleet`, the package name
   * and half the type imports, so it flagged the product's own name rather than any claim it makes.
   * A forbidden-word list is only useful while every entry is a phrase nobody would legitimately
   * write; the day one entry is unavoidable the whole check stops being read.
   */
  const forbidden = [
    'ais disabled',
    'turned off',
    'transponder',
    'evasive',
    'evasion',
    'smuggl',
    'illegal fishing',
    'criminal',
    'sanction',
    'hostile',
    'conceal',
    'deliberate',
  ];

  /** Comments stripped, so the check cannot be satisfied by the sentence that bans a phrase. */
  function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').toLowerCase();
  }

  it('the SURFACE asserts none of them', () => {
    const code = codeOnly(SEMANTICS);
    for (const phrase of forbidden) {
      expect(code, `"${phrase}" must not be asserted by the Ghost Vessel surface`).not.toContain(phrase);
    }
  });

  it('the vocabulary module asserts none of them OUTSIDE the ban list', async () => {
    /*
     * `src/ghost_vessel.ts` DOES contain every one of these phrases -- inside
     * `FORBIDDEN_INFERENCES`, the list that forbids them. A substring check cannot tell a ban from
     * a claim, and this failure is the proof: the first version of this test flagged the ban list
     * for containing the banned words.
     *
     * So the ban list is excluded by construction and then checked for INTEGRITY, which is the
     * stronger claim: the phrases must be listed as forbidden, not merely absent from the file.
     */
    /*
     * The array is declared with `readonly string[] = [` -- SQUARE brackets. An earlier version of
     * this line matched a parenthesised list, which does not exist here, so the substitution was a
     * no-op and the ban list was never actually excluded. A regex that matches nothing fails
     * silently and leaves the check looking like it ran.
     */
    const withoutBanList = codeOnly(PANEL).replace(
      /forbidden_inferences[^\n]*=\s*[[(][\s\S]*?[\])]/,
      'FORBIDDEN_INFERENCES_BANLIST',
    );
    // Prove the exclusion actually happened rather than trusting the regex.
    expect(withoutBanList, 'the ban list must have been excluded from the scan').not.toContain(
      'transponder',
    );
    for (const phrase of forbidden) {
      expect(withoutBanList, `"${phrase}" must not be asserted outside FORBIDDEN_INFERENCES`).not.toContain(
        phrase,
      );
    }

    // `../../ghost_vessel`, not `../`: this file is at `src/dossier/tabs/`, and the module is at
    // `src/ghost_vessel.ts`. One `..` too few is a module-not-found at runtime, not a type error.
    const banList = (await import('../../ghost_vessel')).FORBIDDEN_INFERENCES.map((s) => s.toLowerCase());
    for (const phrase of ['transponder', 'smuggling', 'criminal', 'hostile', 'concealment']) {
      expect(
        banList.some((entry) => entry.includes(phrase)),
        `FORBIDDEN_INFERENCES must still ban "${phrase}"`,
      ).toBe(true);
    }
  });

  it('the ban list is never RENDERED -- it is a fixture, not product copy', () => {
    /*
     * A ban list that reached the screen would be the most confusing string in the product: the
     * operator would read a list of things DarkFleet does not claim, which is the opposite of an
     * answer. It is referenced by tests only.
     */
    const { readFileSync, readdirSync } = require('node:fs') as typeof import('node:fs');
    const { resolve } = require('node:path') as typeof import('node:path');
    const root = resolve(__dirname, '..', '..', '..');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx$/.test(entry.name) || /\.test\.tsx$/.test(entry.name)) continue;
        const source = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/FORBIDDEN_INFERENCES/.test(source)) offenders.push(full.replace(`${root}\\`, ''));
      }
    };
    walk(resolve(root, 'src'));

    expect(offenders, 'FORBIDDEN_INFERENCES must never reach a component').toEqual([]);
  });

  it('the designation and the analytical class are shown as TWO different claims', async () => {
    /*
     * §7. A reader who sees only "Ghost Vessel" has been given a question, not an answer.
     *
     * Checked in `EvidenceTab`, not here: this module receives the already-narrowed dossier and
     * renders the decision, while the designation pair is rendered one level up beside it. An
     * earlier version of this assertion looked in the wrong file and failed on correct code.
     */
    const tab = (await import('./EvidenceTab?raw')).default as string;
    expect(tab).toContain('ghost.analytical_classification');
    expect(tab).toContain('ghost.is_ghost_vessel');
  });
});

/* ============================================================================================== *
 * THE RETIRED PANEL STAYS RETIRED
 * ============================================================================================== */

describe('the dead panel is gone and cannot drift back', () => {
  it('no component imports the retired GhostVesselPanel', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    /*
     * THREE levels up, not two. This file lives at `src/dossier/tabs/`, so `..`, `..` lands on
     * `src/` and `walk('src/src')` throws ENOENT -- which surfaced as a failing test with no
     * offenders listed, which is the least informative failure shape available. The sibling gate
     * in `src/diagnostics/` is two levels deep for the same reason it needs three here.
     */
    const root = resolve(__dirname, '..', '..', '..');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const source = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/from\s+['"][^'"]*GhostVesselPanel['"]/.test(source)) {
          offenders.push(full.replace(`${root}\\`, ''));
        }
      }
    };
    walk(resolve(root, 'src'));

    expect(
      offenders,
      'GhostVesselPanel was DELETED in DF-X9.4R. Re-importing it would restore a second, divergent '
      + 'copy of the ghost-vessel epistemics beside the dossier one.',
    ).toEqual([]);
  });

  it('the dossier renders the semantics itself, so nothing needs the retired panel', async () => {
    const tab = (await import('./EvidenceTab?raw')).default as string;
    expect(tab).toContain('GhostSemantics');
    expect(tab).toContain('<GhostSemantics ghost={ghost} />');
  });

  it('a Ghost Vessel reads its OWN epistemics, not the record-wide lists', async () => {
    /*
     * Both are arrays of `{ text }`, so reading the wrong one throws nothing and looks fine. It
     * puts generic hypotheses beside a specific finding, which is the arrangement this feature
     * exists to prevent.
     */
    const tab = (await import('./EvidenceTab?raw')).default as string;
    expect(tab).toContain('ghost?.hypotheses ?? evidence.hypotheses');
    expect(tab).toContain('ghost?.unknowns ?? evidence.unknowns');
  });
});
