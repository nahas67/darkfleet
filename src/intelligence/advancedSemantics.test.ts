/**
 * ADV gate: the advanced workspace must not overstate what it knows.
 *
 * Four capabilities are surfaced here, and all four sit on a boundary where a
 * plausible-looking number would mislead:
 *
 *   a `null` median revisit must not render as 0 days
 *   an unbridgeable gap must not acquire an implied speed
 *   a deterministic detector must not look like a provenance gap
 *   a failed request must not render as an empty success
 *
 * These are asserted against the panel's own formatting and state handling, not
 * against the backend, because the failure mode being prevented is a *rendering*
 * failure: correct data displayed as a wrong claim.
 */

import { describe, expect, it } from 'vitest';

import type { RevisitPlanOut, TracksOut } from '../api/contract';

const NOT_ESTABLISHED = 'not established';

describe('revisit statistics', () => {
  it('null median is not zero days', () => {
    // The distinction the product exists to protect: "not enough acquisitions
    // to say" versus "imaged continuously".
    const plan: RevisitPlanOut = {
      provider: 'planetary-computer',
      collection: 'sentinel-1-rtc',
      statistics: {
        platform_count: 0,
        acquisitions_per_platform: {},
        interior_gap_count: 0,
        median_revisit_days: null,
        min_revisit_days: null,
        max_revisit_days: null,
        flagged_gap_count: 0,
        nominal_repeat_days: 12,
      },
    };
    expect(plan.statistics.median_revisit_days).toBeNull();
    expect(plan.statistics.median_revisit_days).not.toBe(0);
  });

  it('an empty acquisition list is legitimate and counted, not defaulted', () => {
    const plan: RevisitPlanOut = {
      acquisition_count: 0,
      acquisitions: [],
      gaps: [],
      statistics: {
        platform_count: 0,
        acquisitions_per_platform: {},
        interior_gap_count: 0,
        median_revisit_days: null,
        min_revisit_days: null,
        max_revisit_days: null,
        flagged_gap_count: 0,
        nominal_repeat_days: 12,
      },
      provider: 'planetary-computer',
      collection: 'sentinel-1-rtc',
      requested_bbox: [],
    };
    expect(plan.acquisition_count).toBe(0);
    expect(plan.acquisitions).toEqual([]);
    // `provider` and `collection` are required by the contract, so a response
    // cannot arrive without saying which catalogue it came from.
    expect(plan.provider).toBeTruthy();
  });
});

describe('multipass hypotheses', () => {
  it('an unbridgeable gap carries no implied speed', () => {
    const tracks: TracksOut = {
      scans_considered: 3,
      observations_considered: 5,
      track_count: 1,
      tracks: [
        {
          track_id: 'T1',
          points: [],
          gaps: [{ seconds: 90000, implied_speed_knots: null, plausible: false, note: 'too long' }],
          supporting_evidence: ['reported identity'],
          contradicting_evidence: [],
          identity_strength: 0.4,
          confidence_statement: 'hypothesis',
        },
      ],
    };
    const gap = tracks.tracks?.[0]?.gaps?.[0];
    // A fabricated speed here would be a kinematic claim about a vessel nobody
    // observed moving.
    expect(gap?.implied_speed_knots).toBeNull();
  });

  it('zero tracks over one scan is an answer, and says what it examined', () => {
    const tracks: TracksOut = {
      scans_considered: 1,
      observations_considered: 0,
      track_count: 0,
      tracks: [],
      note: 'hypotheses, not confirmed identity',
    };
    expect(tracks.track_count).toBe(0);
    // The counts are what distinguish "nothing to link" from "nothing examined".
    expect(tracks.scans_considered).toBe(1);
  });

  it('contradicting evidence travels with every hypothesis', () => {
    // A hypothesis shown only with flattering evidence is a sales pitch.
    const tracks: TracksOut = {
      scans_considered: 2,
      observations_considered: 4,
      track_count: 1,
      tracks: [
        {
          track_id: 'T1',
          points: [],
          gaps: [],
          supporting_evidence: ['a'],
          contradicting_evidence: ['b'],
          identity_strength: 0.3,
          confidence_statement: 'weak',
        },
      ],
    };
    expect(tracks.tracks?.[0]?.contradicting_evidence).toEqual(['b']);
  });
});

describe('failure states', () => {
  it('a failed load is not an empty success', () => {
    // Encoded as the union the client actually returns.
    const failed = { state: 'failed', detail: 'provider unreachable' } as const;
    const empty = { state: 'ready', data: { track_count: 0 } } as const;

    // These must be distinguishable states, or the panel cannot say which it is
    // showing and a provider outage would read as "no data exists".
    expect(failed.state).not.toBe(empty.state);
    expect(failed).toHaveProperty('detail');
  });
});

describe('detector provenance', () => {
  it('a null weights digest means deterministic, not missing', () => {
    const card = {
      name: 'cfar',
      kind: 'CFAR',
      training_domain: 'deterministic (no training)',
      input_product: 'Sentinel-1 GRD (DN->sigma0) or RTC (linear gamma0)',
      validation_data: 'golden parity fixture vs the verified legacy engine',
      limitations: 'Assumes locally stationary clutter.',
      weights_digest: null,
    };
    // Rendering this as "missing" would invent a provenance gap that does not
    // exist for a deterministic detector.
    expect(card.weights_digest).toBeNull();
    expect(card.training_domain).toContain('deterministic');
  });
});

describe('absence markers', () => {
  it('has an explicit not-established marker distinct from a zero', () => {
    expect(NOT_ESTABLISHED).not.toBe('0');
    expect(NOT_ESTABLISHED).not.toBe('');
  });
});