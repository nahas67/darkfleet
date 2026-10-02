/**
 * Target inspector tests (UI-012, UI-021, UI-022, UI-023).
 *
 * DOM-free by design, matching `src/search/SpatialSearch.test.tsx`: vitest runs
 * in a `node` environment with no jsdom, so markup comes from
 * `react-dom/server` and every interaction path goes through an exported pure
 * function or handler factory. No network: the API client is always a stub fed
 * by a fake `fetch`.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CLASSIFICATION_META,
  EVIDENCE_TABS,
  FORBIDDEN_UNMATCHED_TERMS,
  NO_ASSOCIATION_STATEMENT,
  NOT_ESTABLISHED,
  TargetInspector,
  buildAssociationBlocks,
  buildEvidenceBlocks,
  candidateObservations,
  classificationLabel,
  classificationTone,
  coerceEvidence,
  makeInspectorKeyHandler,
  nextTabIndex,
  observedFacts,
  readWakeGeometry,
  sarChipGrid,
  tabKeyAction,
} from './TargetInspector.tsx';
import type { EvidenceBlocks, EvidenceTab } from './TargetInspector.tsx';
import { NOT_ESTABLISHED as SHARED_NOT_ESTABLISHED } from '../timeline/Timeline.tsx';
import { createApiClient } from '../app/useApi.ts';
import type { FetchLike } from '../app/useApi.ts';
import type { SarScene, TargetEvidence, VesselTarget } from '../types/api.ts';

// ------------------------------------------------------------------ fixtures

const SCENE: SarScene = {
  provider: 'pc',
  collection: 'sentinel-1-grd',
  item_id: 'SIM-S1C-MALACCA-001',
  platform: 'Sentinel-1A',
  acquisition_time: '2026-02-01T12:00:00Z',
  product: 'GRD',
  polarization: 'VV',
  asset_href: '/api/scene.tif',
  crs: 'EPSG:4326',
  resolution_m: 10,
};

const PROVENANCE = { recorded_at: '2026-02-01T12:05:00Z' } as unknown as TargetEvidence['provenance'];

function matchedTarget(overrides: Partial<VesselTarget> = {}): VesselTarget {
  return {
    id: 'DF-001',
    classification: 'SAR_MATCHED_AIS',
    lat: 1.2644,
    lon: 103.84,
    sarConf: 0.9,
    aisConf: 0.8,
    lenM: 88,
    widM: 12,
    lenUncM: 6,
    hdg: 90,
    wake: false,
    meanDb: -14.2,
    maxDb: 3.1,
    area: 41,
    corr: {
      matched: true,
      mmsi: '563000111',
      vesselName: 'STELLAR',
      distanceOffsetMeters: 120,
      timeDeltaSeconds: -90,
      predictedLat: 1.2651,
      predictedLon: 103.8422,
      aisAssociationConfidence: 0.8,
      scoreDecomposition: {
        spatialScore: 0.9,
        temporalScore: 0.9,
        headingScore: 0.98,
        sizeScore: 0.8,
        compositeScore: 0.88,
        matchRadiusMeters: 1200,
        distanceOffsetMeters: 120,
        timeDeltaSeconds: -90,
      },
    },
    assessment: 'Correlated with AIS MMSI 563000111 (STELLAR).',
    tags: ['CORRELATED_AIS'],
    ...overrides,
  };
}

/** SAR_UNMATCHED: no MMSI, no decomposition, no predicted position. */
const UNMATCHED_TARGET = matchedTarget({
  id: 'DF-002',
  classification: 'SAR_UNMATCHED',
  wake: true,
  aisConf: 0,
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
  assessment: 'Unmatched surface radar return. No sufficiently confident AIS association.',
  tags: ['SAR_UNMATCHED', 'AIS_UNASSOCIATED'],
});

const EVIDENCE: TargetEvidence = {
  target_id: 'DF-001',
  classification: 'SAR_MATCHED_AIS',
  observed: {
    position: { lat: 1.2644, lon: 103.84 },
    apparent_footprint_m: { length: 88, width: 12 },
    orientation_deg: 90,
    mean_backscatter_db: -14.2,
    max_backscatter_db: 3.1,
    pixel_area: 41,
    wake_evident: false,
    sar_detection_confidence: 0.9,
  },
  uncertainty: {
    length_uncertainty_m: 6,
    match_radius_m: 1200,
    propagation_note: 'AIS position propagated to acquisition time by dead reckoning.',
  },
  association: { mmsi: '563000111', vessel_name: 'STELLAR' },
  summary: 'Correlated with AIS MMSI 563000111 (STELLAR).',
  tags: ['CORRELATED_AIS'],
  sar_chip: { values: [[-24, -12, -8], [-20, 2, -6]], min_db: -24, max_db: 2 },
  provenance: PROVENANCE,
};

const OBSERVATIONS = [
  { mmsi: '563000111', timestamp: '2026-02-01T11:55:00Z', lat: 1.26, lon: 103.83, sog: 6.2, cog: 88, heading: 88, source: 'ais_archive' },
  { mmsi: '563000111', timestamp: '2026-02-01T12:01:30Z', lat: 1.27, lon: 103.85, sog: 6.4, cog: 90, heading: 90, source: 'ais_archive' },
];

/** Stub client. Never touches the network. */
function stubClient(body: unknown): ReturnType<typeof createApiClient> {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  return createApiClient(fetchImpl);
}

function render(props: Partial<Parameters<typeof TargetInspector>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(TargetInspector, {
      target: matchedTarget(),
      evidence: EVIDENCE,
      scene: SCENE,
      aisObservations: OBSERVATIONS,
      ...props,
    }),
  );
}

// ----------------------------------------------------------------- utilities

/** Every control must expose a name via aria-label or a <label for>. */
function unnamedControls(html: string): string[] {
  const failures: string[] = [];
  const open = /<(button|a|input|select|textarea)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const close = html.indexOf(`</${tag}`, match.index + match[0].length);
    const inner = close === -1 ? '' : html.slice(match.index + match[0].length, close);
    let name = /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (!name && /aria-labelledby="([^"]*)"/.test(attrs)) name = 'labelledby';
    if (!name) {
      const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
      if (id && html.includes(`for="${id}"`)) name = 'label';
    }
    if (!name) name = inner.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').trim();
    if (!name) failures.push(`${tag} ${match[0].slice(0, 90)}`);
  }
  return failures;
}

function rowLabels(blocks: EvidenceBlocks, kind: keyof EvidenceBlocks): string[] {
  return blocks[kind].map((row) => row.label);
}

function valueOf(blocks: EvidenceBlocks, kind: keyof EvidenceBlocks, label: string): string | undefined {
  return blocks[kind].find((row) => row.label === label)?.value;
}

// ------------------------------------------------------------ classification

describe('classification vocabulary (UI-024)', () => {
  it('covers every canonical classification', () => {
    expect(Object.keys(CLASSIFICATION_META).sort()).toEqual(
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

  it('gives every classification a distinct text label and a distinct icon', () => {
    const labels = Object.values(CLASSIFICATION_META).map((meta) => meta.label);
    const icons = Object.values(CLASSIFICATION_META).map((meta) => meta.Icon);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(icons).size).toBe(icons.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });

  it('labels SAR_UNMATCHED neutrally', () => {
    const label = classificationLabel('SAR_UNMATCHED').toLowerCase();
    for (const term of FORBIDDEN_UNMATCHED_TERMS) expect(label).not.toContain(term);
    expect(classificationLabel('SAR_UNMATCHED')).toBe('SAR return, unmatched');
  });

  it('passes an unknown value through rather than inventing one', () => {
    expect(classificationLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(classificationTone('SOMETHING_NEW')).toBe('warn');
  });

  it('does not reuse one colour for every state', () => {
    const tones = Object.values(CLASSIFICATION_META).map((meta) => meta.tone);
    expect(new Set(tones).size).toBeGreaterThan(1);
  });
});

// ------------------------------------------------------------- pure builders

describe('buildEvidenceBlocks', () => {
  const input = { target: matchedTarget(), evidence: EVIDENCE, scene: SCENE };
  const blocks = buildEvidenceBlocks(input);

  it('keeps measurements out of the hypotheses block', () => {
    expect(rowLabels(blocks, 'observed')).toContain('Mean backscatter');
    expect(rowLabels(blocks, 'hypotheses')).not.toContain('Mean backscatter');
    expect(rowLabels(blocks, 'unknowns')).not.toContain('Mean backscatter');
  });

  it('keeps inferences out of the observed block', () => {
    expect(rowLabels(blocks, 'hypotheses')).toContain('Classification');
    expect(rowLabels(blocks, 'observed')).not.toContain('Classification');
    expect(rowLabels(blocks, 'observed')).not.toContain('Assessment');
  });

  it('carries the apparent dimension WITH its uncertainty', () => {
    expect(valueOf(blocks, 'observed', 'Apparent length')).toBe('88 m ±6 m');
    expect(valueOf(blocks, 'observed', 'Apparent width')).toBe('12 m');
  });

  it('passes source, product, polarization and pixel spacing through', () => {
    expect(valueOf(blocks, 'observed', 'Source')).toBe('pc');
    expect(valueOf(blocks, 'observed', 'Product')).toBe('GRD');
    expect(valueOf(blocks, 'observed', 'Polarization')).toBe('VV');
    expect(valueOf(blocks, 'observed', 'Pixel spacing')).toBe('10.00 m');
    expect(valueOf(blocks, 'observed', 'Acquisition')).toBe('2026-02-01 12:00:00Z');
  });

  it('reports wake evidence as an observation, not an inference', () => {
    expect(valueOf(blocks, 'observed', 'Wake evidence')).toBe('no wake signature detected in the return');
    // The target's own flag is used when the evidence record carries none.
    expect(
      valueOf(buildEvidenceBlocks({ target: UNMATCHED_TARGET, evidence: null, scene: SCENE }), 'observed', 'Wake evidence'),
    ).toBe('wake signature detected in the return');
  });

  it('prefers the evidence record over the flat target flag when both are present', () => {
    // EVIDENCE.observed.wake_evident is false while the target says true. The
    // per-target evidence slice is the backend's own record, so it wins.
    expect(observedFacts(UNMATCHED_TARGET, EVIDENCE).wakeEvident).toBe(false);
  });

  it('renders the three blocks with no fabricated entries', () => {
    expect(blocks.observed.length).toBeGreaterThan(0);
    expect(blocks.hypotheses.length).toBeGreaterThan(0);
    expect(blocks.unknowns.length).toBeGreaterThan(0);
    expect(rowLabels(blocks, 'unknowns')).toContain('Wake geometry');
    expect(rowLabels(blocks, 'unknowns')).toContain('Multi-pass track');
  });

  it('states the width uncertainty is not established instead of mirroring the length one', () => {
    expect(valueOf(blocks, 'unknowns', 'Apparent width uncertainty')).toBe(NOT_ESTABLISHED);
  });

  it('survives a target with no scene and no evidence at all', () => {
    const bare = buildEvidenceBlocks({ target: matchedTarget() });
    expect(valueOf(bare, 'observed', 'Source')).toBe(NOT_ESTABLISHED);
    expect(valueOf(bare, 'observed', 'Pixel spacing')).toBe(NOT_ESTABLISHED);
    expect(valueOf(bare, 'observed', 'Acquisition')).toBe(NOT_ESTABLISHED);
    expect(valueOf(bare, 'hypotheses', 'Assessment')).toBe(
      'Correlated with AIS MMSI 563000111 (STELLAR).',
    );
  });
});

describe('buildAssociationBlocks', () => {
  const blocks = buildAssociationBlocks({
    target: matchedTarget(),
    evidence: EVIDENCE,
    scene: SCENE,
    aisObservations: OBSERVATIONS,
  });

  it('renders the full five-part score decomposition', () => {
    for (const label of ['Score · spatial', 'Score · temporal', 'Score · heading', 'Score · size', 'Score · composite']) {
      expect(rowLabels(blocks, 'hypotheses')).toContain(label);
      expect(valueOf(blocks, 'hypotheses', label)).not.toBe(NOT_ESTABLISHED);
    }
  });

  it('renders candidate MMSI, distance, delta, radius and confidence', () => {
    expect(valueOf(blocks, 'observed', 'Candidate MMSI')).toBe('563000111');
    expect(valueOf(blocks, 'hypotheses', 'Spatial distance')).toBe('120 m');
    expect(valueOf(blocks, 'hypotheses', 'Time delta')).toBe('-90 s');
    expect(valueOf(blocks, 'hypotheses', 'Match radius')).toBe('1200 m');
    expect(valueOf(blocks, 'hypotheses', 'Association confidence')).toBe('0.80');
    expect(valueOf(blocks, 'hypotheses', 'Predicted position')).toBe('1.2651° N, 103.8422° E');
  });

  it('reads heading and speed from the supplied observations, not from a guess', () => {
    expect(valueOf(blocks, 'observed', 'Heading')).toBe('090°');
    expect(valueOf(blocks, 'observed', 'Speed over ground')).toBe('6.4 kn');
    expect(valueOf(blocks, 'observed', 'Source observations')).toBe('2');
  });

  it('keeps observed and hypothesis labels disjoint', () => {
    expect(rowLabels(blocks, 'observed').some((label) => rowLabels(blocks, 'hypotheses').includes(label))).toBe(false);
  });

  it('shows "not established", never 0 or null, when the association is missing', () => {
    const none = buildAssociationBlocks({ target: UNMATCHED_TARGET, evidence: null, scene: null });
    expect(valueOf(none, 'observed', 'Candidate MMSI')).toBe(NOT_ESTABLISHED);
    expect(valueOf(none, 'observed', 'Heading')).toBe(NOT_ESTABLISHED);
    expect(valueOf(none, 'observed', 'Speed over ground')).toBe(NOT_ESTABLISHED);
    expect(valueOf(none, 'hypotheses', 'Spatial distance')).toBe(NOT_ESTABLISHED);
    expect(valueOf(none, 'hypotheses', 'Time delta')).toBe(NOT_ESTABLISHED);
    expect(valueOf(none, 'hypotheses', 'Match radius')).toBe(NOT_ESTABLISHED);
    for (const label of ['Score · spatial', 'Score · temporal', 'Score · heading', 'Score · size', 'Score · composite']) {
      expect(valueOf(none, 'hypotheses', label)).toBe(NOT_ESTABLISHED);
    }
    for (const kind of ['observed', 'hypotheses', 'unknowns'] as const) {
      for (const row of none[kind]) {
        expect(row.value).not.toBe('0');
        expect(row.value).not.toBe('null');
        expect(row.value).not.toBe('--');
      }
    }
  });

  it('states the neutral association sentence when nothing was associated', () => {
    const none = buildAssociationBlocks({ target: UNMATCHED_TARGET, evidence: null, scene: null });
    expect(valueOf(none, 'hypotheses', 'Association state')).toBe(NO_ASSOCIATION_STATEMENT);
    expect(candidateObservations({ target: UNMATCHED_TARGET })).toEqual([]);
  });
});

// -------------------------------------------------------------- loose readers

describe('payload readers', () => {
  it('re-types a real evidence document', () => {
    const coerced = coerceEvidence(EVIDENCE as unknown as Record<string, unknown>);
    expect(coerced?.target_id).toBe('DF-001');
    expect(coerced?.sar_chip).not.toBeNull();
  });

  it('refuses a payload that is not an evidence document', () => {
    expect(coerceEvidence(null)).toBeNull();
    expect(coerceEvidence('nope')).toBeNull();
    expect(coerceEvidence({ target_id: 'DF-001' })).toBeNull();
    expect(coerceEvidence({ classification: 'SEA_CLUTTER' })).toBeNull();
  });

  it('reads a chip only when the payload really carries a matrix', () => {
    expect(sarChipGrid({ values: [[1, 2], [3, 4]] })).toEqual({
      rows: [[1, 2], [3, 4]],
      width: 2,
      height: 2,
      minDb: null,
      maxDb: null,
    });
    expect(sarChipGrid({ values: [[1, 2], [3]] })).toBeNull();
    expect(sarChipGrid({ values: [[1, Number.NaN]] })).toBeNull();
    expect(sarChipGrid({ values: [] })).toBeNull();
    expect(sarChipGrid({ width: 2, height: 2 })).toBeNull();
    expect(sarChipGrid(null)).toBeNull();
  });

  it('never synthesises a chip from dimensions alone', () => {
    expect(sarChipGrid({ width: 32, height: 32, min_db: -24, max_db: 6 })).toBeNull();
  });

  it('reads ADV-004 wake geometry only when it is present', () => {
    expect(readWakeGeometry(null)).toBeNull();
    expect(readWakeGeometry(EVIDENCE)).toBeNull();
    const withWake: TargetEvidence = {
      ...EVIDENCE,
      observed: { ...EVIDENCE.observed, wake_direction_deg: 92, wake_length_m: 140 },
    };
    expect(readWakeGeometry(withWake)).toEqual({ directionDeg: 92, lengthM: 140 });
    const nested: TargetEvidence = {
      ...EVIDENCE,
      observed: { ...EVIDENCE.observed, wake_geometry: { heading_deg: 91, length_m: 130 } },
    };
    expect(readWakeGeometry(nested)).toEqual({ directionDeg: 91, lengthM: 130 });
  });

  it('merges evidence over the flat target fields and never over a real number', () => {
    const facts = observedFacts(matchedTarget(), EVIDENCE);
    expect(facts.lat).toBeCloseTo(1.2644, 6);
    expect(facts.lengthUncertaintyM).toBe(6);
    expect(facts.wakeEvident).toBe(false);

    const conflicting: TargetEvidence = {
      ...EVIDENCE,
      observed: { ...EVIDENCE.observed, mean_backscatter_db: -9.9 },
    };
    expect(observedFacts(matchedTarget(), conflicting).meanDb).toBeCloseTo(-9.9, 6);

    expect(observedFacts(null, null).lat).toBeNull();
    expect(observedFacts(null, null).wakeEvident).toBeNull();
  });
});

// ------------------------------------------------------------------ keyboard

describe('tabs', () => {
  it('exposes exactly the four canonical tabs', () => {
    expect([...EVIDENCE_TABS]).toEqual(['EVIDENCE', 'AIS', 'IMAGERY', 'TIMELINE']);
  });

  it('wraps movement and reports an empty list honestly', () => {
    expect(nextTabIndex(0, 1, 4)).toBe(1);
    expect(nextTabIndex(3, 1, 4)).toBe(0);
    expect(nextTabIndex(0, -1, 4)).toBe(3);
    expect(nextTabIndex(-1, 1, 4)).toBe(0);
    expect(nextTabIndex(0, 1, 0)).toBe(-1);
  });

  it('maps keys to actions', () => {
    expect(tabKeyAction('ArrowRight')).toEqual({ type: 'MOVE', delta: 1 });
    expect(tabKeyAction('ArrowLeft')).toEqual({ type: 'MOVE', delta: -1 });
    expect(tabKeyAction('Home')).toEqual({ type: 'EDGE', edge: 'FIRST' });
    expect(tabKeyAction('End')).toEqual({ type: 'EDGE', edge: 'LAST' });
    expect(tabKeyAction('Escape')).toEqual({ type: 'CLOSE' });
    expect(tabKeyAction('q')).toEqual({ type: 'NONE' });
  });

  it('drives the tabs and closes through the bound handler', () => {
    const onSelectTab = vi.fn();
    const onClose = vi.fn();
    const preventDefault = vi.fn();
    const handler = makeInspectorKeyHandler({ onSelectTab, onClose });

    handler({ key: 'ArrowRight', preventDefault });
    expect(onSelectTab).toHaveBeenCalledWith(1);
    handler({ key: 'End', preventDefault });
    expect(onSelectTab).toHaveBeenLastCalledWith(EVIDENCE_TABS.length);
    handler({ key: 'Home', preventDefault });
    expect(onSelectTab).toHaveBeenLastCalledWith(-EVIDENCE_TABS.length);
    handler({ key: 'Escape', preventDefault });
    expect(onClose).toHaveBeenCalledTimes(1);
    handler({ key: 'q', preventDefault });
    expect(onSelectTab).toHaveBeenCalledTimes(3);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------- markup

describe('TargetInspector markup', () => {
  it('shows the canonical classification and the target id in the header', () => {
    const html = render();
    expect(html).toContain('data-df-inspector-classification="SAR_MATCHED_AIS"');
    expect(html).toContain('SAR matched to AIS');
    expect(html).toContain('data-df-inspector-id');
    expect(html).toContain('DF-001');
  });

  it('renders all four tabs with proper tab roles and one selected panel', () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('role="tabpanel"');
    for (const tab of EVIDENCE_TABS) {
      expect(html).toContain(`data-df-inspector-tab="${tab}"`);
      expect(html).toContain(`aria-controls="df-inspector-panel-${tab}"`);
    }
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('data-df-inspector-panel="EVIDENCE"');
  });

  it('selects the requested initial tab', () => {
    for (const tab of ['AIS', 'IMAGERY', 'TIMELINE'] as EvidenceTab[]) {
      expect(render({ initialTab: tab })).toContain(`data-df-inspector-panel="${tab}"`);
    }
  });

  it('renders OBSERVED, HYPOTHESES and UNKNOWNS as three separate labelled blocks', () => {
    const html = render();
    for (const block of ['OBSERVED', 'HYPOTHESES', 'UNKNOWNS']) {
      expect(html).toContain(`data-df-evidence-block="${block}"`);
      expect(html).toContain(`id="df-inspector-evidence-${block.toLowerCase()}-heading"`);
    }
    expect(html.indexOf('data-df-evidence-block="OBSERVED"')).toBeLessThan(
      html.indexOf('data-df-evidence-block="HYPOTHESES"'),
    );
    expect(html.indexOf('data-df-evidence-block="HYPOTHESES"')).toBeLessThan(
      html.indexOf('data-df-evidence-block="UNKNOWNS"'),
    );
  });

  it('gives every evidence row a label and a value slot', () => {
    const html = render();
    expect(html).toContain('data-df-evidence-row="Mean backscatter"');
    expect(html).toContain('data-df-evidence-row="Classification"');
    expect(html).toContain('data-df-evidence-row="Apparent width uncertainty"');
    expect(html).toMatch(/<dt[^>]*>[^<]+<\/dt><dd[^>]*>[^<]+<\/dd>/);
  });

  it('never renders a fabricated zero for missing data', () => {
    const html = render({ target: UNMATCHED_TARGET, evidence: null, scene: null });
    expect(html).toContain(NOT_ESTABLISHED);
    expect(html).not.toContain('>null<');
    expect(html).not.toContain('>undefined<');
    expect(html).not.toContain('>NaN<');
  });

  it('renders the AIS decomposition on the AIS tab', () => {
    const html = render({ initialTab: 'AIS' });
    expect(html).toContain('data-df-inspector-panel="AIS"');
    expect(html).toContain('data-df-evidence-row="Score · composite"');
    expect(html).toContain('0.880');
    expect(html).toContain('data-df-evidence-block="OBSERVED"');
    expect(html).toContain('data-df-evidence-block="UNKNOWN');
  });

  it('renders the SAR chip with an accessible description', () => {
    const html = render({ initialTab: 'IMAGERY' });
    expect(html).toContain('data-df-sar-chip');
    expect(html).toContain('role="img"');
    expect(html).toContain('SAR chip, 3 by 2 samples');
    expect(html).toContain('payload range');
    expect(html).not.toContain('data-df-imagery-no-chip');
  });

  it('says a chip is absent instead of drawing an empty grid', () => {
    const html = render({ initialTab: 'IMAGERY', evidence: { ...EVIDENCE, sar_chip: null } });
    expect(html).toContain('data-df-imagery-no-chip');
    expect(html).toContain('No SAR chip is present in this evidence record');
    expect(html).not.toContain('data-df-sar-chip');
  });

  it('marks ADV-004 wake geometry unavailable when the payload lacks it', () => {
    const html = render({ initialTab: 'IMAGERY' });
    expect(html).toContain('data-df-imagery-wake-unavailable');
    expect(html).toContain('ADV-004');
    expect(html).toContain('Wake direction');
    expect(html).toContain('Wake length');
  });

  it('renders wake direction and length when ADV-004 data is present', () => {
    const withWake: TargetEvidence = {
      ...EVIDENCE,
      observed: { ...EVIDENCE.observed, wake_direction_deg: 92, wake_length_m: 140 },
    };
    const html = render({ initialTab: 'IMAGERY', evidence: withWake });
    expect(html).not.toContain('data-df-imagery-wake-unavailable');
    expect(html).toContain('092°');
    expect(html).toContain('140 m');
  });

  it('renders the timeline on the TIMELINE tab', () => {
    const html = render({
      initialTab: 'TIMELINE',
      scan: {
        scene: { acquisition_time: '2026-02-01T12:00:00Z' },
        targets: [matchedTarget()],
      },
      aisObservations: OBSERVATIONS,
    });
    expect(html).toContain('data-df-inspector-panel="TIMELINE"');
    expect(html).toContain('data-df-timeline');
    expect(html).toContain('data-df-timeline-event="SAR_ACQUISITION"');
  });

  it('renders an explicit empty state when no target is selected', () => {
    const html = render({ target: null });
    expect(html).toContain('data-df-inspector-empty');
    expect(html).toContain('No target is selected');
    expect(html).not.toContain('data-df-inspector-panel');
    expect(html).not.toContain('data-df-evidence-row');
  });

  it('says when no evidence record was supplied, without hiding the panel', () => {
    const html = render({ evidence: null });
    expect(html).toContain('data-df-inspector-no-evidence');
    expect(html).toContain('data-df-evidence-block="OBSERVED"');
  });

  it('respects reduced motion on every animated control', () => {
    const html = render();
    expect(html).toContain('motion-reduce:transition-none');
    const animated = html.match(/class="[^"]*transition[^"]*"/g) ?? [];
    for (const cls of animated) expect(cls).toContain('motion-reduce:transition-none');
  });

  it('names the close control and every filter-free control', () => {
    expect(render()).toContain('aria-label="Close evidence for DF-001"');
  });

  it('gives every icon-only control an accessible name on every tab', () => {
    for (const tab of [...EVIDENCE_TABS, 'EMPTY'] as (EvidenceTab | 'EMPTY')[]) {
      const html = tab === 'EMPTY' ? render({ target: null }) : render({ initialTab: tab });
      expect(unnamedControls(html)).toEqual([]);
    }
  });
});

// ------------------------------------------------- neutral language (UI-022)

describe('neutral language for SAR_UNMATCHED (UI-022)', () => {
  const htmlFor = (tab: EvidenceTab, target: VesselTarget, evidence: TargetEvidence | null): string =>
    renderToStaticMarkup(
      createElement(TargetInspector, {
        target,
        evidence,
        scene: SCENE,
        initialTab: tab,
        aisObservations: OBSERVATIONS,
        scan: { scene: { acquisition_time: '2026-02-01T12:00:00Z' }, targets: [target] },
      }),
    ).toLowerCase();

  it('renders the forbidden wording nowhere, in any tab', () => {
    for (const tab of EVIDENCE_TABS) {
      const html = htmlFor(tab, UNMATCHED_TARGET, null);
      for (const term of FORBIDDEN_UNMATCHED_TERMS) {
        expect(html).not.toContain(term);
      }
    }
  });

  it('states the neutral association fact instead of an inference about the vessel', () => {
    for (const tab of EVIDENCE_TABS) {
      expect(htmlFor(tab, UNMATCHED_TARGET, null)).toContain(NO_ASSOCIATION_STATEMENT.toLowerCase());
    }
  });

  it('still describes what was actually observed, in neutral terms', () => {
    const html = htmlFor('EVIDENCE', UNMATCHED_TARGET, null);
    expect(html).toContain('wake signature detected in the return');
    expect(html).toContain('88 m ±6 m');
    expect(html).toContain('sar return, unmatched');
  });

  it('declares the forbidden list itself in the module contract', () => {
    expect(FORBIDDEN_UNMATCHED_TERMS).toEqual(
      expect.arrayContaining(['no active transponder', 'dark vessel', 'threat', 'critical', 'verified']),
    );
    expect(SHARED_NOT_ESTABLISHED).toBe('not established');
  });
});

// ------------------------------------------------------------ client loading

describe('optional evidence load', () => {
  it('renders without a client and never reaches for the network', () => {
    expect(render()).toContain('data-df-inspector-panel="EVIDENCE"');
  });

  it('accepts an injected client without rendering untrusted content', () => {
    const html = render({
      evidence: undefined,
      client: stubClient({
        scan_id: 'DF-0001',
        runtime_mode: 'REAL',
        synthetic: true,
        ambiguous: false,
        candidate_scan_ids: [],
        evidence: EVIDENCE as unknown as Record<string, unknown>,
      }),
    });
    // Effects do not run under renderToStaticMarkup: the panel still renders
    // from the scan payload and states the absence rather than inventing it.
    expect(html).toContain('data-df-inspector-no-evidence');
    expect(html).toContain('No evidence record was supplied for this target');
  });
});