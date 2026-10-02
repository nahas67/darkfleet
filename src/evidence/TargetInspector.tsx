/**
 * Contextual evidence inspector (UI-012, UI-021, UI-022, UI-023).
 *
 * A right-side floating panel for the selected target. Header carries the
 * canonical classification and the target id. Four tabs: EVIDENCE / AIS /
 * IMAGERY / TIMELINE.
 *
 * Rules this file encodes:
 *  - OBSERVED / HYPOTHESES / UNKNOWNS are three separate, labelled blocks.
 *    They are never merged into one list, and a block with nothing in it still
 *    renders with an explicit note so the reader can tell "empty" from "hidden".
 *  - UI-022 NEUTRAL LANGUAGE. For an unassociated target every surface says the
 *    same neutral thing — no association met the correlation threshold in the
 *    available observations. `dark vessel`, `threat`, `CRITICAL`, `verified`
 *    and `no active transponder` appear nowhere; the forbidden list is asserted
 *    absent from the rendered markup by `evidence.test.tsx`.
 *  - A missing value renders `not established`. Never a zero, a dash, or a
 *    value the backend did not send.
 *  - ADV-004 wake geometry and ADV-001 multi-pass tracks are named and marked
 *    unavailable; they are never drawn from nothing.
 *
 * Nothing here computes an analytic: every number is passed through from the
 * scan / target / evidence payload.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Anchor,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  Clock,
  Eye,
  Radio,
  Ruler,
  ScanLine,
  TriangleAlert,
  Waves,
  X,
} from 'lucide-react';
import { createApiClient } from '../app/useApi.ts';
import type { ApiClient } from '../app/useApi.ts';
import {
  MULTIPASS_UNAVAILABLE,
  NO_ASSOCIATION_STATEMENT,
  NOT_ESTABLISHED,
  WAKE_GEOMETRY_SOURCE,
  WAKE_GEOMETRY_UNAVAILABLE,
  correlationWindowLabel,
  formatConfidence,
  formatDb,
  formatDegrees,
  formatDeltaSeconds,
  formatFootprint,
  formatKnots,
  formatLatLon,
  formatMeters,
  formatUtcStamp,
} from '../timeline/Timeline.tsx';
import type { AisObservation, TimelineScanInput, TimelineTarget } from '../timeline/Timeline.tsx';
import { Timeline } from '../timeline/Timeline.tsx';
import type { TargetClassification, TargetEvidence, VesselTarget } from '../types/api.ts';
import type { ScanScene } from '../api/contract.ts';

// Re-exported so consumers have a single import for the shared vocabulary.
export {
  FORBIDDEN_UNMATCHED_TERMS,
  NO_ASSOCIATION_STATEMENT,
  NOT_ESTABLISHED,
  MULTIPASS_UNAVAILABLE,
  WAKE_GEOMETRY_UNAVAILABLE,
} from '../timeline/Timeline.tsx';
export { Timeline } from '../timeline/Timeline.tsx';
export type { AisObservation, TimelineScanInput, TimelineTarget } from '../timeline/Timeline.tsx';

// ------------------------------------------------------ classification meta

type IconComponent = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
type Tone = 'ok' | 'warn' | 'bad' | 'idle';

interface ClassificationMeta {
  /** Canonical wire value, shown verbatim so the id is never lost. */
  readonly id: TargetClassification;
  /** Neutral human label. Never editorial. */
  readonly label: string;
  readonly Icon: IconComponent;
  readonly tone: Tone;
}

/**
 * UI-024. Every classification carries a TEXT label and a distinct ICON, so
 * status is never communicated by colour alone.
 */
export const CLASSIFICATION_META: Readonly<Record<TargetClassification, ClassificationMeta>> = {
  SAR_MATCHED_AIS: { id: 'SAR_MATCHED_AIS', label: 'SAR matched to AIS', Icon: CircleCheck, tone: 'ok' },
  SAR_UNMATCHED: { id: 'SAR_UNMATCHED', label: 'SAR return, unmatched', Icon: CircleSlash, tone: 'warn' },
  AIS_ONLY: { id: 'AIS_ONLY', label: 'AIS-only contact', Icon: Radio, tone: 'idle' },
  STATIONARY_OR_INFRASTRUCTURE: {
    id: 'STATIONARY_OR_INFRASTRUCTURE',
    label: 'Stationary return or infrastructure',
    Icon: Anchor,
    tone: 'idle',
  },
  SEA_CLUTTER: { id: 'SEA_CLUTTER', label: 'Sea clutter return', Icon: Waves, tone: 'idle' },
  LOW_CONFIDENCE: { id: 'LOW_CONFIDENCE', label: 'Low confidence return', Icon: TriangleAlert, tone: 'warn' },
  UNRESOLVED: { id: 'UNRESOLVED', label: 'Unresolved association', Icon: CircleHelp, tone: 'warn' },
};

export function classificationMeta(value: string): ClassificationMeta {
  return CLASSIFICATION_META[value as TargetClassification] ?? CLASSIFICATION_META.UNRESOLVED;
}

/** Neutral human label for a classification. Unknown values pass through. */
export function classificationLabel(value: string): string {
  const known = CLASSIFICATION_META[value as TargetClassification];
  return known ? known.label : value;
}

export function classificationTone(value: string): Tone {
  return classificationMeta(value).tone;
}

export function classificationIcon(value: string): IconComponent {
  return classificationMeta(value).Icon;
}

// ------------------------------------------------------------ loose readers

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function num(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return finite(value) ? value : null;
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value ? value : null;
}

function firstNum(...values: unknown[]): number | null {
  for (const value of values) if (finite(value)) return value;
  return null;
}

function firstStr(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value) return value;
  return null;
}

// --------------------------------------------------------------- evidence IO

/**
 * Re-type the loose `evidence` record the API returns into `TargetEvidence`.
 * Returns null when the payload is not an evidence document at all, so the
 * inspector shows "not established" instead of rendering empty strings.
 */
export function coerceEvidence(raw: unknown): TargetEvidence | null {
  const source = record(raw);
  if (typeof source.target_id !== 'string' || !source.target_id) return null;
  if (typeof source.classification !== 'string' || !source.classification) return null;
  return {
    target_id: source.target_id,
    classification: source.classification as TargetClassification,
    observed: record(source.observed),
    uncertainty: record(source.uncertainty),
    association: record(source.association),
    summary: typeof source.summary === 'string' ? source.summary : null,
    tags: Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sar_chip: source.sar_chip && typeof source.sar_chip === 'object' ? record(source.sar_chip) : null,
    provenance: record(source.provenance) as unknown as TargetEvidence['provenance'],
  };
}

/** The AIS/SAR facts the blocks read, resolved from evidence then the target. */
export interface ObservedFacts {
  readonly lat: number | null;
  readonly lon: number | null;
  readonly lengthM: number | null;
  readonly widthM: number | null;
  readonly lengthUncertaintyM: number | null;
  readonly orientationDeg: number | null;
  readonly meanDb: number | null;
  readonly maxDb: number | null;
  readonly pixelArea: number | null;
  readonly wakeEvident: boolean | null;
  readonly sarConfidence: number | null;
  readonly matchRadiusM: number | null;
  readonly propagationNote: string | null;
}

/**
 * Merge the nested `evidence.observed` / `evidence.uncertainty` blocks with the
 * flat `VesselTarget` fields. The target is the fallback, never the source of a
 * value the evidence record contradicts with a real number.
 */
export function observedFacts(
  target: VesselTarget | null | undefined,
  evidence: TargetEvidence | null | undefined,
): ObservedFacts {
  const observed = record(evidence?.observed);
  const uncertainty = record(evidence?.uncertainty);
  const footprint = record(observed.apparent_footprint_m);
  const position = record(observed.position);
  const decomposition = target?.corr?.scoreDecomposition ?? null;

  const wakeRaw = observed.wake_evident;
  const wakeEvident = typeof wakeRaw === 'boolean' ? wakeRaw : typeof target?.wake === 'boolean' ? target.wake : null;

  return {
    lat: firstNum(position.lat, target?.lat),
    lon: firstNum(position.lon, target?.lon),
    lengthM: firstNum(footprint.length, target?.lenM),
    widthM: firstNum(footprint.width, target?.widM),
    lengthUncertaintyM: firstNum(uncertainty.length_uncertainty_m, target?.lenUncM),
    orientationDeg: firstNum(observed.orientation_deg, target?.hdg),
    meanDb: firstNum(observed.mean_backscatter_db, target?.meanDb),
    maxDb: firstNum(observed.max_backscatter_db, target?.maxDb),
    pixelArea: firstNum(observed.pixel_area, target?.area),
    wakeEvident,
    sarConfidence: firstNum(observed.sar_detection_confidence, target?.sarConf),
    matchRadiusM: firstNum(uncertainty.match_radius_m, decomposition?.matchRadiusMeters),
    propagationNote: str(uncertainty, 'propagation_note'),
  };
}

// ----------------------------------------------------------------- SAR chip

export interface SarChipGrid {
  readonly rows: number[][];
  readonly width: number;
  readonly height: number;
  /** Display range the backend supplied, when it supplied one. */
  readonly minDb: number | null;
  readonly maxDb: number | null;
}

const CHIP_MATRIX_KEYS = ['values', 'grid', 'data', 'pixels', 'samples', 'chip'] as const;

/** Largest grid rendered cell-for-cell before the caption declares subsampling. */
export const MAX_RENDERED_CHIP_CELLS = 4096;

/**
 * Read a SAR chip out of the evidence payload. Returns null unless the payload
 * really carries a rectangular matrix of finite numbers — a chip is never
 * synthesised so the imagery tab has something to show.
 */
export function sarChipGrid(chip: unknown): SarChipGrid | null {
  const source = record(chip);
  let matrix: unknown = null;
  for (const key of CHIP_MATRIX_KEYS) {
    if (Array.isArray(source[key])) {
      matrix = source[key];
      break;
    }
  }
  if (!Array.isArray(matrix) || matrix.length === 0) return null;
  const rows: number[][] = [];
  for (const row of matrix) {
    if (!Array.isArray(row) || row.length === 0) return null;
    if (!row.every((cell) => finite(cell))) return null;
    rows.push(row as number[]);
  }
  const width = rows[0].length;
  if (rows.some((row) => row.length !== width)) return null;
  return {
    rows,
    width,
    height: rows.length,
    minDb: firstNum(source.min_db, source.minDb, source.min),
    maxDb: firstNum(source.max_db, source.maxDb, source.max),
  };
}

export interface WakeGeometry {
  readonly directionDeg: number | null;
  readonly lengthM: number | null;
}

/**
 * ADV-004 wake geometry, read only when the evidence record actually carries
 * it. Returns null when it does not, so the caller can state the absence.
 */
export function readWakeGeometry(evidence: TargetEvidence | null | undefined): WakeGeometry | null {
  const observed = record(evidence?.observed);
  const nested = record(observed.wake_geometry ?? evidence?.association?.wake_geometry);
  const directionDeg = firstNum(
    observed.wake_direction_deg,
    observed.wake_heading_deg,
    nested.direction_deg,
    nested.heading_deg,
  );
  const lengthM = firstNum(observed.wake_length_m, nested.length_m, nested.length);
  if (directionDeg === null && lengthM === null) return null;
  return { directionDeg, lengthM };
}

// ------------------------------------------------------------- block models

export interface EvidenceRow {
  readonly label: string;
  readonly value: string;
  /** Optional caveat that belongs with this value. Never silently dropped. */
  readonly note?: string;
  readonly tone?: Tone;
}

export interface EvidenceBlocks {
  readonly observed: readonly EvidenceRow[];
  readonly hypotheses: readonly EvidenceRow[];
  readonly unknowns: readonly EvidenceRow[];
}

export interface InspectorInput {
  readonly target: VesselTarget;
  readonly evidence?: TargetEvidence | null;
  readonly scene?: ScanScene | null;
  readonly aisObservations?: readonly AisObservation[] | null;
}

const BLOCK_EMPTY_NOTES: Readonly<Record<'observed' | 'hypotheses' | 'unknowns', string>> = {
  observed: 'No measurement is present in this record.',
  hypotheses: 'No inference is present in this record.',
  unknowns: 'Nothing outstanding is recorded for this target.',
};

/**
 * The EVIDENCE tab content, split into the three blocks. Pure: everything comes
 * from the target plus its evidence record and the scene it was read from.
 */
export function buildEvidenceBlocks(input: InspectorInput): EvidenceBlocks {
  const facts = observedFacts(input.target, input.evidence);
  const scene = input.scene ?? null;
  const target = input.target;
  const corr = target.corr ?? null;
  const chip = sarChipGrid(input.evidence?.sar_chip ?? null);
  const wake = readWakeGeometry(input.evidence);

  const observed: EvidenceRow[] = [
    {
      label: 'SAR chip',
      value: chip ? `${chip.width} × ${chip.height} samples` : NOT_ESTABLISHED,
    },
    { label: 'Location', value: formatLatLon(facts.lat, facts.lon) },
    {
      label: 'Acquisition',
      // `formatUtcStamp` falls back to '--' for a null input; a missing stamp is
      // an explicit unknown here, never a dash that could read as a value.
      value: scene?.acquisition_time ? formatUtcStamp(scene.acquisition_time) : NOT_ESTABLISHED,
    },
    {
      label: 'Source',
      value: firstStr(scene?.provider, scene?.platform) ?? NOT_ESTABLISHED,
      note:
        firstStr(scene?.platform, scene?.collection, scene?.item_id) ??
        undefined,
    },
    { label: 'Product', value: firstStr(scene?.product) ?? NOT_ESTABLISHED },
    { label: 'Polarization', value: firstStr(scene?.polarization) ?? NOT_ESTABLISHED },
    {
      label: 'Pixel spacing',
      value: finite(scene?.resolution_m) ? formatMeters(scene?.resolution_m, 2) : NOT_ESTABLISHED,
    },
    {
      label: 'Apparent length',
      value: formatFootprint(facts.lengthM, facts.lengthUncertaintyM),
    },
    { label: 'Apparent width', value: formatMeters(facts.widthM) },
    { label: 'Orientation', value: formatDegrees(facts.orientationDeg) },
    { label: 'Mean backscatter', value: formatDb(facts.meanDb) },
    { label: 'Max backscatter', value: formatDb(facts.maxDb) },
    {
      label: 'Wake evidence',
      value:
        facts.wakeEvident === null
          ? NOT_ESTABLISHED
          : facts.wakeEvident
            ? 'wake signature detected in the return'
            : 'no wake signature detected in the return',
    },
    { label: 'Detection confidence', value: formatConfidence(facts.sarConfidence) },
  ];

  const hypotheses: EvidenceRow[] = [
    { label: 'Classification', value: `${classificationLabel(target.classification)} (${target.classification})` },
    { label: 'Assessment', value: firstStr(target.assessment, input.evidence?.summary) ?? NOT_ESTABLISHED },
    {
      label: 'Tags',
      value: target.tags.length > 0 ? target.tags.join(', ') : NOT_ESTABLISHED,
    },
    {
      label: 'Footprint interpretation',
      value: 'Apparent SAR footprint',
      note: 'The apparent extent is the radar-return footprint. It is not a measured hull length.',
    },
    {
      label: 'AIS association',
      value: corr?.mmsi
        ? `MMSI ${corr.mmsi}${corr.vesselName ? ` · ${corr.vesselName}` : ''}`
        : NO_ASSOCIATION_STATEMENT,
      tone: corr?.mmsi ? 'ok' : 'warn',
    },
  ];

  const unknowns: EvidenceRow[] = [
    {
      label: 'Apparent width uncertainty',
      value: NOT_ESTABLISHED,
      note: 'This record carries a length uncertainty only.',
    },
    {
      label: 'Association match radius',
      value: facts.matchRadiusM === null ? NOT_ESTABLISHED : formatMeters(facts.matchRadiusM),
    },
    { label: 'Correlation window', value: correlationWindowLabel(target as TimelineTarget) },
    {
      label: 'Wake geometry',
      value: wake
        ? `direction ${formatDegrees(wake.directionDeg)} · length ${formatMeters(wake.lengthM)}`
        : WAKE_GEOMETRY_UNAVAILABLE,
      note: WAKE_GEOMETRY_SOURCE,
    },
    {
      label: 'Multi-pass track',
      value: MULTIPASS_UNAVAILABLE,
      note: facts.propagationNote ?? undefined,
    },
  ];

  return { observed, hypotheses, unknowns };
}

/** Observations of one AIS candidate, newest last, straight from the payload. */
export function candidateObservations(
  input: InspectorInput,
): readonly AisObservation[] {
  const mmsi = input.target.corr?.mmsi ?? null;
  if (!mmsi) return [];
  return (input.aisObservations ?? []).filter((observation) => observation.mmsi === mmsi);
}

/**
 * The AIS tab content, split into the same three blocks: what the AIS source
 * reported (observed), what the backend concluded from it (hypotheses), and what
 * is not established (unknowns).
 */
export function buildAssociationBlocks(input: InspectorInput): EvidenceBlocks {
  const corr = input.target.corr ?? null;
  const decomposition = corr?.scoreDecomposition ?? null;
  const observations = candidateObservations(input);
  const latest = observations.length > 0 ? observations[observations.length - 1] : null;
  const heading = firstNum(latest?.heading, latest?.cog);
  const speed = firstNum(latest?.sog);

  const observed: EvidenceRow[] = [
    { label: 'Candidate MMSI', value: firstStr(corr?.mmsi) ?? NOT_ESTABLISHED },
    { label: 'Vessel name', value: firstStr(corr?.vesselName, latest?.vesselName) ?? NOT_ESTABLISHED },
    {
      label: 'Source observations',
      value: observations.length > 0 ? `${observations.length}` : NOT_ESTABLISHED,
      ...(observations.length > 0 ? { note: observations.map((o) => formatUtcStamp(o.timestamp)).join(' · ') } : {}),
    },
    { label: 'Heading', value: formatDegrees(heading) },
    { label: 'Speed over ground', value: formatKnots(speed) },
  ];

  for (const observation of observations) {
    observed.push({
      label: `Observation ${formatUtcStamp(observation.timestamp)}`,
      value: formatLatLon(observation.lat, observation.lon),
      note: [
        `hdg ${formatDegrees(observation.heading ?? observation.cog)}`,
        formatKnots(observation.sog),
        observation.source ? `source ${observation.source}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }

  const hypotheses: EvidenceRow[] = [
    {
      label: 'Association state',
      value: corr?.matched ? 'association established by the backend' : NO_ASSOCIATION_STATEMENT,
      tone: corr?.matched ? 'ok' : 'warn',
    },
    {
      label: 'Predicted position',
      value: formatLatLon(corr?.predictedLat, corr?.predictedLon),
    },
    {
      label: 'Spatial distance',
      value: finite(corr?.distanceOffsetMeters) ? formatMeters(corr?.distanceOffsetMeters) : NOT_ESTABLISHED,
    },
    {
      label: 'Time delta',
      value: finite(corr?.timeDeltaSeconds)
        ? formatDeltaSeconds(corr?.timeDeltaSeconds)
        : NOT_ESTABLISHED,
    },
    {
      label: 'Match radius',
      value: finite(decomposition?.matchRadiusMeters)
        ? formatMeters(decomposition?.matchRadiusMeters)
        : NOT_ESTABLISHED,
    },
    { label: 'Association confidence', value: formatConfidence(input.target.aisConf) },
    { label: 'Score · spatial', value: formatConfidence(decomposition?.spatialScore, 3) },
    { label: 'Score · temporal', value: formatConfidence(decomposition?.temporalScore, 3) },
    { label: 'Score · heading', value: formatConfidence(decomposition?.headingScore, 3) },
    { label: 'Score · size', value: formatConfidence(decomposition?.sizeScore, 3) },
    { label: 'Score · composite', value: formatConfidence(decomposition?.compositeScore, 3) },
  ];

  const unknowns: EvidenceRow[] = [
    { label: 'Correlation window', value: correlationWindowLabel(input.target as TimelineTarget) },
    {
      label: 'Multi-pass track',
      value: MULTIPASS_UNAVAILABLE,
    },
    {
      label: 'Observation coverage',
      value: observations.length > 0 ? 'covered by the supplied records' : NOT_ESTABLISHED,
      note:
        observations.length > 0
          ? undefined
          : 'No AIS observation for this candidate was supplied with this record.',
    },
  ];

  return { observed, hypotheses, unknowns };
}

// ------------------------------------------------------------------- tabs

export type EvidenceTab = 'EVIDENCE' | 'AIS' | 'IMAGERY' | 'TIMELINE';

export const EVIDENCE_TABS: readonly EvidenceTab[] = ['EVIDENCE', 'AIS', 'IMAGERY', 'TIMELINE'];

export const EVIDENCE_TAB_LABELS: Readonly<Record<EvidenceTab, string>> = {
  EVIDENCE: 'Evidence',
  AIS: 'AIS',
  IMAGERY: 'Imagery',
  TIMELINE: 'Timeline',
};

/**
 * Wrapping tab movement. With no tab active, ArrowRight lands on the FIRST tab
 * and ArrowLeft on the LAST — the same rule `moveActiveRow` uses in
 * `src/search/SpatialSearch.tsx`. `count <= 0` yields -1.
 */
export function nextTabIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  const base = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return ((base + delta) % count + count) % count;
}

export type TabKeyAction =
  | { readonly type: 'MOVE'; readonly delta: number }
  | { readonly type: 'EDGE'; readonly edge: 'FIRST' | 'LAST' }
  | { readonly type: 'CLOSE' }
  | { readonly type: 'NONE' };

/** Arrow keys move, Home/End jump to an edge, Escape closes. */
export function tabKeyAction(key: string): TabKeyAction {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return { type: 'MOVE', delta: 1 };
    case 'ArrowLeft':
    case 'ArrowUp':
      return { type: 'MOVE', delta: -1 };
    case 'Home':
      return { type: 'EDGE', edge: 'FIRST' };
    case 'End':
      return { type: 'EDGE', edge: 'LAST' };
    case 'Escape':
      return { type: 'CLOSE' };
    default:
      return { type: 'NONE' };
  }
}

/** The exact handler bound to the tablist's `onKeyDown`. */
export function makeInspectorKeyHandler(handlers: {
  onSelectTab: (index: number) => void;
  onClose: () => void;
}): (event: { key: string; preventDefault?: () => void }) => void {
  return (event) => {
    const action = tabKeyAction(event.key);
    switch (action.type) {
      case 'MOVE':
        event.preventDefault?.();
        handlers.onSelectTab(action.delta);
        return;
      case 'EDGE':
        event.preventDefault?.();
        handlers.onSelectTab(action.edge === 'FIRST' ? -EVIDENCE_TABS.length : EVIDENCE_TABS.length);
        return;
      case 'CLOSE':
        handlers.onClose();
        return;
      default:
        return;
    }
  };
}

// -------------------------------------------------------------- block views

const TONE_TEXT: Readonly<Record<Tone, string>> = {
  ok: 'text-[var(--df-success)]',
  warn: 'text-[var(--df-warning)]',
  bad: 'text-[var(--df-danger)]',
  idle: 'text-[var(--df-text-secondary)]',
};

const BLOCK_STYLE: Readonly<Record<'observed' | 'hypotheses' | 'unknowns', string>> = {
  observed: 'border-l-2 border-l-[var(--df-success)] bg-[var(--df-accent-soft)]',
  hypotheses: 'border-l-2 border-dashed border-l-[var(--df-warning)]',
  unknowns: 'border-l-2 border-dotted border-l-[var(--df-text-dim)] bg-[var(--df-glass)]',
};

const BLOCK_ICON: Readonly<Record<'observed' | 'hypotheses' | 'unknowns', IconComponent>> = {
  observed: Eye,
  hypotheses: CircleHelp,
  unknowns: TriangleAlert,
};

const BLOCK_TITLE: Readonly<Record<'observed' | 'hypotheses' | 'unknowns', string>> = {
  observed: 'Observed',
  hypotheses: 'Hypotheses',
  unknowns: 'Unknowns',
};

/**
 * One labelled block. Always rendered — an empty block states that nothing is
 * recorded, so a reader can never mistake "nothing here" for "not shown".
 */
function EvidenceBlock({
  kind,
  rows,
  idPrefix,
}: {
  kind: 'observed' | 'hypotheses' | 'unknowns';
  rows: readonly EvidenceRow[];
  idPrefix: string;
}) {
  const Icon = BLOCK_ICON[kind];
  const headingId = `${idPrefix}-${kind}-heading`;
  return (
    <section
      data-df-evidence-block={kind.toUpperCase()}
      aria-labelledby={headingId}
      className={`rounded-[6px] border border-[var(--df-border)] p-2 ${BLOCK_STYLE[kind]}`}
    >
      <h4
        id={headingId}
        className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--df-text-secondary)]"
      >
        <Icon className="h-3 w-3" aria-hidden />
        {BLOCK_TITLE[kind]}
      </h4>
      {rows.length === 0 ? (
        <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">{BLOCK_EMPTY_NOTES[kind]}</p>
      ) : (
        <dl className="space-y-0.5">
          {rows.map((row) => (
            <div key={row.label} data-df-evidence-row={row.label} className="space-y-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-[10px] text-[var(--df-text-secondary)]">{row.label}</dt>
                <dd
                  className={`shrink-0 text-right font-mono text-[10px] tabular-nums ${
                    row.tone ? TONE_TEXT[row.tone] : 'text-[var(--df-text)]'
                  }`}
                >
                  {row.value}
                </dd>
              </div>
              {row.note && (
                <p className="text-[9px] leading-snug text-[var(--df-text-dim)]">{row.note}</p>
              )}
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function Blocks({ blocks, idPrefix }: { blocks: EvidenceBlocks; idPrefix: string }) {
  return (
    <div className="space-y-2">
      <EvidenceBlock kind="observed" rows={blocks.observed} idPrefix={idPrefix} />
      <EvidenceBlock kind="hypotheses" rows={blocks.hypotheses} idPrefix={idPrefix} />
      <EvidenceBlock kind="unknowns" rows={blocks.unknowns} idPrefix={idPrefix} />
    </div>
  );
}

// ------------------------------------------------------------- chip drawing

function ChipPreview({ grid }: { grid: SarChipGrid }) {
  const cells = grid.width * grid.height;
  const stride = Math.max(1, Math.ceil(cells / MAX_RENDERED_CHIP_CELLS));
  const sampleLo = finite(grid.minDb) ? (grid.minDb as number) : null;
  const sampleHi = finite(grid.maxDb) ? (grid.maxDb as number) : null;
  const lo = sampleLo ?? Math.min(...grid.rows.flat());
  const hi = sampleHi ?? Math.max(...grid.rows.flat());
  const range = hi - lo;

  return (
    <figure data-df-sar-chip className="space-y-1">
      <svg
        role="img"
        aria-label={`SAR chip, ${grid.width} by ${grid.height} samples`}
        viewBox={`0 0 ${grid.width} ${grid.height}`}
        className="h-24 w-24 rounded-[4px] border border-[var(--df-border)]"
      >
        {grid.rows.map((row, y) =>
          row.map((cell, x) => {
            if (x % stride !== 0 || y % stride !== 0) return null;
            const shade = range === 0 ? 0.5 : (cell - lo) / range;
            return (
              <rect
                key={`${x}-${y}`}
                x={x}
                y={y}
                width={stride}
                height={stride}
                fill={`rgb(${Math.round(255 * shade)},${Math.round(255 * shade)},${Math.round(255 * shade)})`}
              />
            );
          }),
        )}
      </svg>
      <figcaption className="text-[9px] leading-snug text-[var(--df-text-dim)]">
        {grid.width} × {grid.height} samples
        {sampleLo !== null && sampleHi !== null
          ? ` · payload range ${formatDb(sampleLo)} to ${formatDb(sampleHi)}`
          : ' · display ramp derived from the chip samples; no backend statistics are implied'}
        {stride > 1 ? ` · every ${stride}th sample drawn` : ''}
      </figcaption>
    </figure>
  );
}

// --------------------------------------------------------------- component

export interface TargetInspectorProps {
  /** The selected target. Null renders an explicit empty state. */
  readonly target?: VesselTarget | null;
  /**
   * Evidence record. Left `undefined` WITH a `client`, it is loaded from
   * `GET /api/targets/{id}`. An explicit `null` means "known absent": nothing is
   * fetched and the panel says so.
   */
  readonly evidence?: TargetEvidence | null;
  /** Scene the target was read from, for source/product/polarisation. */
  readonly scene?: ScanScene | null;
  /** The active scan, used by the TIMELINE tab. */
  readonly scan?: TimelineScanInput | null;
  /** AIS observations around the acquisition. */
  readonly aisObservations?: readonly AisObservation[] | null;
  readonly initialTab?: EvidenceTab;
  readonly client?: ApiClient;
  readonly onClose?: () => void;
}

export function TargetInspector({
  target = null,
  evidence,
  scene = null,
  scan = null,
  aisObservations = null,
  initialTab = 'EVIDENCE',
  client,
  onClose,
}: TargetInspectorProps): React.ReactElement {
  const initialIndex = Math.max(0, EVIDENCE_TABS.indexOf(initialTab));
  const [tabIndex, setTabIndex] = useState(initialIndex);
  const [loaded, setLoaded] = useState<TargetEvidence | null>(null);

  const shouldLoad = client !== undefined && evidence === undefined;
  const resolvedClient = useMemo(() => client ?? createApiClient(), [client]);
  const targetId = target?.id ?? null;

  useEffect(() => {
    if (!shouldLoad || !targetId) return undefined;
    let cancelled = false;
    resolvedClient
      .getTargetEvidence(targetId)
      .then((response) => {
        if (cancelled) return;
        setLoaded(coerceEvidence(response?.evidence));
      })
      .catch(() => {
        // A failed lookup is an unknown state, never a fallback to "no data".
        if (!cancelled) setLoaded(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shouldLoad, resolvedClient, targetId]);

  const activeEvidence = evidence === undefined ? loaded : evidence;

  const close = useCallback(() => {
    onClose?.();
  }, [onClose]);

  const keyHandler = useMemo(
    () =>
      makeInspectorKeyHandler({
        onSelectTab: (delta) => {
          setTabIndex((current) =>
            delta >= EVIDENCE_TABS.length
              ? 0
              : delta <= -EVIDENCE_TABS.length
                ? EVIDENCE_TABS.length - 1
                : nextTabIndex(current, delta, EVIDENCE_TABS.length),
          );
        },
        onClose: close,
      }),
    [close],
  );

  // Escape closes the panel from anywhere, matching the shell root handler.
  useEffect(() => {
    if (typeof window === 'undefined' || !onClose) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, onClose]);

  if (!target) {
    return (
      <aside
        data-df-inspector
        data-df-inspector-empty
        role="complementary"
        aria-label="Target evidence"
        className="df-glass-strong w-[24rem] rounded-[var(--df-panel-radius)] p-4"
      >
        <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
          No target is selected. Open the inspector from a contact row; nothing is shown until the
          backend has returned a target.
        </p>
      </aside>
    );
  }

  const tab = EVIDENCE_TABS[tabIndex];
  const input: InspectorInput = { target, evidence: activeEvidence, scene, aisObservations };
  const meta = classificationMeta(target.classification);

  return (
    <aside
      data-df-inspector
      data-df-inspector-classification={target.classification}
      role="complementary"
      aria-label={`Evidence for ${target.id}`}
      className="df-glass-strong max-h-[calc(100vh-6rem)] w-[26rem] overflow-y-auto rounded-[var(--df-panel-radius)] p-3"
    >
      <header className="mb-2 flex items-start justify-between gap-2 border-b border-[var(--df-border)] pb-2">
        <div className="min-w-0">
          <p
            data-df-inspector-classification-label
            className={`flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] ${TONE_TEXT[meta.tone]}`}
          >
            <meta.Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {meta.label}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--df-text)]" data-df-inspector-id>
            {target.id}
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label={`Close evidence for ${target.id}`}
          className="rounded-[6px] p-1 text-[var(--df-text-dim)] transition hover:text-[var(--df-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)] motion-reduce:transition-none"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>

      <div role="tablist" aria-label="Evidence sections" onKeyDown={keyHandler} className="mb-2 flex gap-1">
        {EVIDENCE_TABS.map((entry, index) => {
          const selected = index === tabIndex;
          return (
            <button
              key={entry}
              type="button"
              role="tab"
              id={`df-inspector-tab-${entry}`}
              aria-selected={selected}
              aria-controls={`df-inspector-panel-${entry}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTabIndex(index)}
              data-df-inspector-tab={entry}
              className={[
                'flex-1 rounded-[6px] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] transition',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]',
                'motion-reduce:transition-none',
                selected
                  ? 'bg-[var(--df-accent-soft)] text-[var(--df-accent)]'
                  : 'text-[var(--df-text-dim)] hover:text-[var(--df-text-secondary)]',
              ].join(' ')}
            >
              {EVIDENCE_TAB_LABELS[entry]}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`df-inspector-panel-${tab}`}
        aria-labelledby={`df-inspector-tab-${tab}`}
        tabIndex={0}
        data-df-inspector-panel={tab}
        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-accent)]"
      >
        {tab === 'EVIDENCE' && (
          <>
            {activeEvidence === null && (
              <p data-df-inspector-no-evidence className="mb-2 text-[10px] text-[var(--df-text-dim)]">
                No evidence record was supplied for this target. Values below come from the scan
                payload only.
              </p>
            )}
            <Blocks blocks={buildEvidenceBlocks(input)} idPrefix="df-inspector-evidence" />
          </>
        )}

        {tab === 'AIS' && <Blocks blocks={buildAssociationBlocks(input)} idPrefix="df-inspector-ais" />}

        {tab === 'IMAGERY' && <ImageryTab input={input} />}

        {tab === 'TIMELINE' && (
          <Timeline scan={scan} targetId={target.id} aisObservations={aisObservations ?? []} />
        )}
      </div>
    </aside>
  );
}

/** IMAGERY tab: the SAR chip the payload carries, plus ADV-004 wake geometry. */
function ImageryTab({ input }: { input: InspectorInput }) {
  const facts = observedFacts(input.target, input.evidence);
  const chip = sarChipGrid(input.evidence?.sar_chip ?? null);
  const wake = readWakeGeometry(input.evidence);

  return (
    <div data-df-inspector-imagery className="space-y-2">
      <section
        data-df-evidence-block="IMAGERY"
        aria-label="SAR chip"
        className="rounded-[6px] border border-[var(--df-border)] p-2"
      >
        <h4 className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--df-text-secondary)]">
          <ScanLine className="h-3 w-3" aria-hidden />
          SAR chip
        </h4>
        {chip ? (
          <ChipPreview grid={chip} />
        ) : (
          <p data-df-imagery-no-chip className="text-[10px] leading-snug text-[var(--df-text-dim)]">
            No SAR chip is present in this evidence record. Nothing is synthesised in its place.
          </p>
        )}
      </section>

      <section
        data-df-evidence-block="WAKE"
        aria-label="Wake geometry"
        className="rounded-[6px] border border-[var(--df-border)] p-2"
      >
        <h4 className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--df-text-secondary)]">
          <Waves className="h-3 w-3" aria-hidden />
          Wake
        </h4>
        <dl className="space-y-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[10px] text-[var(--df-text-secondary)]">Wake in the return</dt>
            <dd className="font-mono text-[10px] tabular-nums text-[var(--df-text)]">
              {facts.wakeEvident === null
                ? NOT_ESTABLISHED
                : facts.wakeEvident
                  ? 'detected'
                  : 'not detected'}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[10px] text-[var(--df-text-secondary)]">Wake direction</dt>
            <dd className="font-mono text-[10px] tabular-nums text-[var(--df-text)]">
              {wake ? formatDegrees(wake.directionDeg) : NOT_ESTABLISHED}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[10px] text-[var(--df-text-secondary)]">Wake length</dt>
            <dd className="font-mono text-[10px] tabular-nums text-[var(--df-text)]">
              {wake ? formatMeters(wake.lengthM) : NOT_ESTABLISHED}
            </dd>
          </div>
        </dl>
        {!wake && (
          <p data-df-imagery-wake-unavailable className="mt-1 text-[9px] leading-snug text-[var(--df-text-dim)]">
            {WAKE_GEOMETRY_UNAVAILABLE}
          </p>
        )}
      </section>

      <section
        data-df-evidence-block="ASSOCIATION"
        aria-label="AIS association state"
        className="rounded-[6px] border border-[var(--df-border)] p-2"
      >
        <h4 className="mb-1 flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--df-text-secondary)]">
          <Radio className="h-3 w-3" aria-hidden />
          Association
        </h4>
        <dl className="space-y-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[10px] text-[var(--df-text-secondary)]">AIS association</dt>
            <dd
              data-df-imagery-association
              className={`text-right font-mono text-[10px] ${
                input.target.corr?.mmsi ? TONE_TEXT.ok : TONE_TEXT.warn
              }`}
            >
              {input.target.corr?.mmsi
                ? `MMSI ${input.target.corr.mmsi}`
                : NO_ASSOCIATION_STATEMENT}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[10px] text-[var(--df-text-secondary)]">Correlation window</dt>
            <dd className="text-right font-mono text-[10px] text-[var(--df-text)]">
              {correlationWindowLabel(input.target as TimelineTarget)}
            </dd>
          </div>
        </dl>
        <p className="mt-1 text-[9px] leading-snug text-[var(--df-text-dim)]">
          Imagery is shown whether or not an association exists. The association state is reported
          here so no tab can be read as confirming one.
        </p>
      </section>

      <p className="flex items-start gap-1.5 text-[9px] leading-snug text-[var(--df-text-dim)]">
        <Ruler className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        Apparent dimensions and wake geometry describe the radar return. They are not measured hull
        dimensions.
      </p>
      <p className="flex items-start gap-1.5 text-[9px] leading-snug text-[var(--df-text-dim)]">
        <Clock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        This panel shows one acquisition. Nothing here is interpolated between passes.
      </p>
    </div>
  );
}

export default TargetInspector;