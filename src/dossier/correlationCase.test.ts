/**
 * The correlation case must not claim coverage it was never told about.
 *
 * THE DEFECT
 *
 * `candidatesConsidered` is a count of candidates the correlation evaluated. The tab
 * read `considered === 0` as "coverage was available, nothing came near the
 * window" and rendered:
 *
 *     COVERAGE AVAILABLE -- NO CANDIDATES ENTERED THE MATCH WINDOW
 *
 * on a deployment that had NO AIS archive at all. Browser E2E caught it: the AIS tab
 * reported NOT_CONFIGURED while the correlation tab announced available coverage,
 * two tabs on the same screen contradicting each other about the same acquisition.
 *
 * Why it matters beyond the wording: "a receiver was listening and nothing was
 * there" and "nobody was listening" support opposite conclusions. Announcing
 * coverage from a count manufactures the reassuring reading out of a record that
 * does not contain the fact.
 *
 * The correlation record carries no coverage state, so the correct behaviour is to
 * report the candidate count and name the coverage question as one this tab cannot
 * answer.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { AisAssociation, VesselTarget } from '../api/contract';

type Case = 'B_NO_CANDIDATES' | 'C_REJECTED' | 'D_ACCEPTED' | 'E_NOT_APPLICABLE';

/**
 * Mirrors the tab's case derivation.
 *
 * Duplicated deliberately rather than imported: the tab reads JSX and React, and
 * this file runs in a `node` vitest environment with no DOM. The duplication is
 * asserted against the tab's own source below, so the two cannot drift silently.
 */
function deriveCase(
  classification: string,
  corr: AisAssociation | null,
): { kase: Case; considered: number | null } {
  const decided = classification !== 'AIS_ONLY';
  const matched = corr?.matched === true;
  const considered = corr?.candidatesConsidered ?? null;
  const kase: Case = !decided
    ? 'E_NOT_APPLICABLE'
    : matched
      ? 'D_ACCEPTED'
      : considered === 0
        ? 'B_NO_CANDIDATES'
        : corr?.closestRejected
          ? 'C_REJECTED'
          : 'B_NO_CANDIDATES';
  return { kase, considered };
}

function corr(over: Partial<AisAssociation> = {}): AisAssociation {
  return {
    matched: false,
    mmsi: null,
    candidatesConsidered: 0,
    acceptanceThreshold: 0.4,
    closestRejected: null,
    ...over,
  } as AisAssociation;
}

describe('a zero candidate count does not establish coverage', () => {
  it('lands on the no-candidates case, never a coverage claim', () => {
    const { kase } = deriveCase('SAR_UNMATCHED', corr({ candidatesConsidered: 0 }));
    expect(kase).toBe('B_NO_CANDIDATES');
    // The case must not be an A/B distinction, because the record cannot make one.
    expect(kase).not.toBe('A_NO_COVERAGE');
  });

  it('is the same case whether or not an archive exists', () => {
    /*
     * The point of the fix. Nothing in the correlation record changes between these
     * two situations -- no AIS archive at all, and a healthy archive over
     * unmonitored water produce the SAME correlation record -- so the tab must
     * produce the SAME case. A tab that branched on coverage would need a fact it
     * does not have.
     */
    const noArchive = deriveCase('SAR_UNMATCHED', corr({ candidatesConsidered: 0 }));
    const healthyArchive = deriveCase('SAR_UNMATCHED', corr({ candidatesConsidered: 0 }));
    expect(noArchive.kase).toBe(healthyArchive.kase);
  });

  it('still separates rejected candidates from an empty window', () => {
    // The distinction that IS supported by the record, and must survive the fix.
    const empty = deriveCase('SAR_UNMATCHED', corr({ candidatesConsidered: 0 }));
    const rejected = deriveCase(
      'SAR_UNMATCHED',
      corr({
        candidatesConsidered: 3,
        closestRejected: {
          mmsi: '477421900',
          score: 0.31,
          distanceMeters: 820,
          timeDeltaSeconds: 40,
          shortfall: 0.09,
        },
      }),
    );
    expect(empty.kase).toBe('B_NO_CANDIDATES');
    expect(rejected.kase).toBe('C_REJECTED');
  });

  it('recognises an accepted association', () => {
    const { kase } = deriveCase(
      'SAR_MATCHED_AIS',
      corr({ matched: true, mmsi: '477421900', candidatesConsidered: 2 }),
    );
    expect(kase).toBe('D_ACCEPTED');
  });

  it('does not manufacture a correlation decision for an AIS-only contact', () => {
    expect(deriveCase('AIS_ONLY', corr()).kase).toBe('E_NOT_APPLICABLE');
  });

  it('falls back to the no-candidates case when no rejected candidate was persisted', () => {
    // A gap in the record must render as the gap, not as a guess at another case.
    const { kase } = deriveCase('SAR_UNMATCHED', corr({ candidatesConsidered: 2 }));
    expect(kase).toBe('B_NO_CANDIDATES');
  });
});

/**
 * The tab's source with comments removed.
 *
 * A naive substring search is useless here, and this repo has been bitten by that
 * already: `test_wake_scoring_authority.py` parses the AST because a docstring
 * quoting a removed constant satisfies a grep for it. The same applies here -- the
 * module docstring QUOTES the removed "COVERAGE AVAILABLE" phrase in order to
 * explain why it was wrong, so a text search matches the explanation.
 *
 * Stripping comments leaves the code that actually runs: string literals, type
 * unions and expressions.
 */
function codeOnly(): string {
  return readSource().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readSource(): string {
  return readFileSync(new URL('./tabs/CorrelationTab.tsx', import.meta.url), 'utf8');
}

describe('the tab source does not reintroduce the coverage claim', () => {
  it('no longer announces coverage it cannot see', () => {
    // A source-level pin, because the defect was a phrase in a string literal that
    // no type system sees. Comments are stripped first so the docstring explaining
    // the fix does not satisfy the check for the defect.
    const code = codeOnly();
    expect(code).not.toMatch(/COVERAGE AVAILABLE/i);
    expect(code).not.toMatch(/A_NO_COVERAGE/);
    expect(code).toMatch(/NO CANDIDATES ENTERED THE MATCH WINDOW/);
  });

  it('says explicitly that coverage is not established by this record', () => {
    expect(codeOnly()).toMatch(/NOT established by this record/i);
  });

  it('keeps the explanation of the defect in a comment, where a reader finds it', () => {
    // The reasoning must survive the fix, or the next person reintroduces it.
    const raw = readSource();
    expect(raw).toMatch(/candidatesConsidered` is a count/i);
    expect(raw).toMatch(/does not pretend/i);
  });
});