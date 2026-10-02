/**
 * Acquisition-time analysis timeline (UI-013) and the shared presentation
 * vocabulary for the evidence surfaces (UI-022, UI-024).
 *
 * This module is the LEAF of the three-surface feature: `TargetInspector.tsx`
 * imports from here and `Contacts.tsx` imports from `TargetInspector.tsx`, so the
 * graph stays acyclic. Everything that three surfaces must agree on — the
 * neutral "no association" sentence, the forbidden-word list, and the value
 * formatters — is therefore declared once, here.
 *
 * Hard rules encoded below:
 *  - NO fake playback and NO invented progress. There is no timer, no interval
 *    and no autoplay anywhere in this file. The scrub control steps through
 *    instants that exist in the payload; a single acquisition says so instead
 *    of animating.
 *  - Scrubbing only over real data. `timelineInstants` returns the distinct
 *    timestamps the payload actually carries.
 *  - Missing data renders `NOT_ESTABLISHED`. It is never a zero, a dash or a
 *    fabricated value.
 *  - No analytics are computed client-side. Every event time, offset and score
 *    comes from the scan / target / AIS-observation payload.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Radar, Radio, TriangleAlert } from 'lucide-react';
import { formatUtcStamp } from '../app/state.ts';

// ------------------------------------------------------------- vocabulary

/** The one string a missing value ever renders as. Never a zero. */
export const NOT_ESTABLISHED = 'not established';

/**
 * UI-022. The exact neutral sentence used whenever an AIS association was not
 * established. It states what the ANALYSIS did (nothing met the threshold in
 * the available observations) and makes no claim about the vessel.
 */
export const NO_ASSOCIATION_STATEMENT =
  'No AIS association met the correlation threshold in the available observations.';

/**
 * UI-022. Wording that must never appear for an unassociated target, in any
 * case. Asserted absent from rendered markup by the evidence tests.
 */
export const FORBIDDEN_UNMATCHED_TERMS: readonly string[] = [
  'no active transponder',
  'dark vessel',
  'threat',
  'critical',
  'verified',
];

/** Advanced layers the backend has not implemented. Named, never faked. */
export const WAKE_GEOMETRY_SOURCE = 'ADV-004 (CP15)';
export const MULTIPASS_TRACK_SOURCE = 'ADV-001 (CP15)';

/** Statement used where ADV-004 wake geometry would have to be. */
export const WAKE_GEOMETRY_UNAVAILABLE =
  `Wake geometry is not established: no wake direction or length is present in this evidence ` +
  `record, and the ${WAKE_GEOMETRY_SOURCE} wake-geometry layer is not available.`;

/** Statement used where a multi-pass track would have to be. */
export const MULTIPASS_UNAVAILABLE =
  `A multi-pass track is not established: this record covers a single acquisition and the ` +
  `${MULTIPASS_TRACK_SOURCE} multi-pass layer is not available.`;

// -------------------------------------------------------------- formatters

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `88 m`, or `not established`. */
export function formatMeters(value: unknown, digits = 0): string {
  if (!finite(value)) return NOT_ESTABLISHED;
  return `${value.toFixed(digits)} m`;
}

/**
 * Apparent dimension WITH its uncertainty, e.g. `88 m ±6 m`. The uncertainty is
 * never dropped and never invented: without it the value renders alone.
 */
export function formatFootprint(value: unknown, uncertainty: unknown, digits = 0): string {
  if (!finite(value)) return NOT_ESTABLISHED;
  const base = `${value.toFixed(digits)} m`;
  return finite(uncertainty) ? `${base} ±${uncertainty.toFixed(digits)} m` : base;
}

/** `090°`, or `not established`. */
export function formatDegrees(value: unknown, digits = 0): string {
  if (!finite(value)) return NOT_ESTABLISHED;
  const clamped = ((value % 360) + 360) % 360;
  if (digits === 0) return `${String(Math.round(clamped)).padStart(3, '0')}°`;
  return `${clamped.toFixed(digits)}°`;
}

/** `-14.2 dB`, or `not established`. */
export function formatDb(value: unknown, digits = 1): string {
  if (!finite(value)) return NOT_ESTABLISHED;
  return `${value.toFixed(digits)} dB`;
}

/** A 0..1 confidence passed through verbatim. Formatting only, no rescaling. */
export function formatConfidence(value: unknown, digits = 2): string {
  if (!finite(value)) return NOT_ESTABLISHED;
  return value.toFixed(digits);
}

/** Signed offset from the SAR acquisition, e.g. `+90 s` / `-300 s` / `0 s`. */
export function formatDeltaSeconds(value: unknown): string {
  if (!finite(value)) return NOT_ESTABLISHED;
  const rounded = Math.round(value);
  if (rounded === 0) return '0 s';
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded)} s`;
}

/** `1.2644° N, 103.8400° E`. Neither half is ever invented. */
export function formatLatLon(lat: unknown, lon: unknown): string {
  if (!finite(lat) || !finite(lon)) return NOT_ESTABLISHED;
  const latHemisphere = lat < 0 ? 'S' : 'N';
  const lonHemisphere = lon < 0 ? 'W' : 'E';
  return `${Math.abs(lat).toFixed(4)}° ${latHemisphere}, ${Math.abs(lon).toFixed(4)}° ${lonHemisphere}`;
}

/** Speed over ground in knots, or `not established`. */
export function formatKnots(value: unknown, digits = 1): string {
  if (!finite(value)) return NOT_ESTABLISHED;
  return `${value.toFixed(digits)} kn`;
}

export { formatUtcStamp };

// ---------------------------------------------------------------- payloads

/**
 * One canonical AIS observation. Declared here (not in `src/types/api.ts`,
 * which this lane must not edit) and shaped after the backend's
 * `AisObservation`: `timestamp`/`mmsi`/`lat`/`lon` required, the rest optional
 * because a provider may omit a field.
 */
export interface AisObservation {
  readonly mmsi: string;
  readonly timestamp: string;
  readonly lat: number;
  readonly lon: number;
  /** Speed over ground, knots. */
  readonly sog?: number | null;
  /** Course over ground, degrees. */
  readonly cog?: number | null;
  readonly heading?: number | null;
  readonly source?: string | null;
  readonly vesselName?: string | null;
}

/**
 * The subset of a target's correlation block the timeline reads. Structurally
 * satisfied by `VesselTarget` from `src/types/api.ts`, so a real `ScanResult`
 * can be passed straight in.
 */
export interface TimelineTarget {
  readonly id: string;
  readonly classification?: string;
  readonly corr?:
    | {
        readonly matched?: boolean;
        readonly mmsi?: string | null;
        readonly vesselName?: string | null;
        readonly distanceOffsetMeters?: number | null;
        readonly timeDeltaSeconds?: number | null;
        readonly predictedLat?: number | null;
        readonly predictedLon?: number | null;
        readonly scoreDecomposition?: { readonly matchRadiusMeters?: number | null } | null;
      }
    | null;
}

/**
 * The subset of a scan the timeline reads. Structurally satisfied by
 * `ScanResult`; `ais_observations` is supplied by the caller because the
 * evidence endpoints return them per candidate rather than per scan.
 */
export interface TimelineScanInput {
  readonly scan_id?: string | null;
  readonly acquisition_time?: string | null;
  readonly scene?:
    | {
        readonly acquisition_time?: string | null;
        readonly item_id?: string | null;
        readonly platform?: string | null;
        readonly product?: string | null;
        readonly polarization?: string | null;
      }
    | null;
  readonly targets?: readonly TimelineTarget[] | null;
  readonly ais_observations?: readonly AisObservation[] | null;
}

// ------------------------------------------------------------------ events

export type TimelineEventKind = 'SAR_ACQUISITION' | 'PROJECTED_POSITION' | 'AIS_OBSERVATION';

export interface TimelineEvent {
  /** Stable, deterministic key for lists. */
  readonly key: string;
  readonly kind: TimelineEventKind;
  /** Epoch ms, or null when the payload carried no parseable timestamp. */
  readonly atMs: number | null;
  /** Human stamp for `atMs`; falls back to the raw payload string. */
  readonly atLabel: string;
  /** Signed seconds from the SAR acquisition tick. */
  readonly deltaSeconds: number | null;
  /** Signed offset, pre-formatted, for display and for tests. */
  readonly deltaLabel: string;
  readonly label: string;
  readonly detail: string;
  readonly mmsi: string | null;
}

const KIND_RANK: Readonly<Record<TimelineEventKind, number>> = {
  SAR_ACQUISITION: 0,
  PROJECTED_POSITION: 1,
  AIS_OBSERVATION: 2,
};

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function acquisitionTimeOf(scan: TimelineScanInput | null | undefined): string | null {
  if (!scan) return null;
  return scan.scene?.acquisition_time ?? scan.acquisition_time ?? null;
}

/** The SAR acquisition instant in epoch ms, or null when unknown. */
export function acquisitionMs(scan: TimelineScanInput | null | undefined): number | null {
  return parseMs(acquisitionTimeOf(scan));
}

/**
 * Build the ordered analysis events for one target.
 *
 * The event list is derived ONLY from the payload: the SAR acquisition tick, the
 * AIS observations whose MMSI equals the target's associated MMSI, and the
 * projected position when the backend supplied one. A target with no association
 * yields no AIS events at all — the absence is reported as the neutral
 * statement, never as a fabricated observation.
 *
 * Ordering: ascending by instant; an instant-less event sorts last; ties break
 * on `KIND_RANK` then key, so the ordering is total and deterministic.
 */
export function buildTimelineEvents(
  scan: TimelineScanInput | null | undefined,
  targetId: string | null | undefined,
): TimelineEvent[] {
  const rawAcquisition = acquisitionTimeOf(scan);
  const acqMs = parseMs(rawAcquisition);

  const target =
    targetId && scan?.targets ? scan.targets.find((candidate) => candidate.id === targetId) : undefined;

  const events: TimelineEvent[] = [];

  if (rawAcquisition) {
    events.push({
      key: 'SAR_ACQUISITION',
      kind: 'SAR_ACQUISITION',
      atMs: acqMs,
      atLabel: formatUtcStamp(rawAcquisition),
      deltaSeconds: 0,
      deltaLabel: '0 s',
      label: 'SAR acquisition',
      detail: scan?.scene?.item_id
        ? `Scene ${scan.scene.item_id}${scan.scene.polarization ? ` · ${scan.scene.polarization}` : ''}`
        : 'Scene identifier not established',
      mmsi: null,
    });
  }

  const mmsi = target?.corr?.mmsi ?? null;
  const observations = scan?.ais_observations ?? [];

  if (mmsi) {
    for (const observation of observations) {
      if (observation.mmsi !== mmsi) continue;
      const obsMs = parseMs(observation.timestamp);
      const deltaSeconds = acqMs !== null && obsMs !== null ? (obsMs - acqMs) / 1000 : null;
      events.push({
        key: `AIS_OBSERVATION:${observation.mmsi}:${observation.timestamp}`,
        kind: 'AIS_OBSERVATION',
        atMs: obsMs,
        atLabel: formatUtcStamp(observation.timestamp ?? null),
        deltaSeconds,
        deltaLabel: formatDeltaSeconds(deltaSeconds),
        label: 'AIS observation',
        detail: [
          `MMSI ${observation.mmsi}`,
          finite(observation.heading) ? `hdg ${formatDegrees(observation.heading)}` : null,
          finite(observation.sog) ? formatKnots(observation.sog) : null,
          observation.source ? `source ${observation.source}` : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' · '),
        mmsi: observation.mmsi,
      });
    }

    // The projection lands ON the acquisition instant, which is exactly why it
    // is drawn as its own marker rather than folded into the SAR tick.
    if (finite(target?.corr?.predictedLat) && finite(target?.corr?.predictedLon)) {
      const deltaSeconds = finite(target?.corr?.timeDeltaSeconds)
        ? (target?.corr?.timeDeltaSeconds as number)
        : null;
      events.push({
        key: 'PROJECTED_POSITION',
        kind: 'PROJECTED_POSITION',
        atMs: acqMs,
        atLabel: formatUtcStamp(rawAcquisition),
        deltaSeconds: 0,
        deltaLabel: '0 s',
        label: 'Projected AIS position',
        detail: [
          formatLatLon(target?.corr?.predictedLat, target?.corr?.predictedLon),
          'propagated to the acquisition instant by dead reckoning',
          deltaSeconds === null ? null : `from an observation ${formatDeltaSeconds(deltaSeconds)}`,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' · '),
        mmsi,
      });
    }
  }

  return sortEvents(events);
}

/** Total, deterministic ordering for a timeline event list. */
export function sortEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    if (a.atMs !== b.atMs) {
      if (a.atMs === null) return 1;
      if (b.atMs === null) return -1;
      return a.atMs - b.atMs;
    }
    const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (rank !== 0) return rank;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** The distinct instants the scrub control may step through, ascending. */
export function timelineInstants(events: readonly TimelineEvent[]): number[] {
  const seen = new Set<number>();
  for (const event of events) {
    if (typeof event.atMs === 'number' && Number.isFinite(event.atMs)) seen.add(event.atMs);
  }
  return [...seen].sort((a, b) => a - b);
}

export interface TimelineSpan {
  readonly startMs: number | null;
  readonly endMs: number | null;
  /** Distinct instants available for scrubbing. 0 means "nothing to scrub". */
  readonly stepCount: number;
  /** True when at most one instant exists, so playback cannot be simulated. */
  readonly singleInstant: boolean;
}

/** The extent of the real instants in an event list. Never extrapolated. */
export function timelineSpan(events: readonly TimelineEvent[]): TimelineSpan {
  const instants = timelineInstants(events);
  if (instants.length === 0) {
    return { startMs: null, endMs: null, stepCount: 0, singleInstant: true };
  }
  return {
    startMs: instants[0],
    endMs: instants[instants.length - 1],
    stepCount: instants.length,
    singleInstant: instants.length <= 1,
  };
}

/** Horizontal position of an instant on the track, as a percentage. */
export function timelinePosition(atMs: number | null, span: TimelineSpan): number | null {
  if (typeof atMs !== 'number' || span.startMs === null || span.endMs === null) return null;
  if (span.startMs === span.endMs) return 50;
  const ratio = (atMs - span.startMs) / (span.endMs - span.startMs);
  return Math.max(0, Math.min(100, ratio * 100));
}

/** Clamp a raw control value onto the instants that actually exist. */
export function clampScrubIndex(raw: string | number, stepCount: number): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || stepCount <= 0) return 0;
  return Math.max(0, Math.min(stepCount - 1, Math.round(parsed)));
}

/**
 * The correlation window, described only from what the payload carries.
 *
 * An associated target reports the offset it actually achieved and the match
 * radius the backend applied. A target with no association gets the neutral
 * sentence (UI-022) — never a guess at the window the backend would have used.
 */
export function correlationWindowLabel(
  target: TimelineTarget | null | undefined,
): string {
  const corr = target?.corr ?? null;
  const mmsi = corr?.mmsi ?? null;
  if (!mmsi) return NO_ASSOCIATION_STATEMENT;

  const parts: string[] = [];
  if (finite(corr?.timeDeltaSeconds)) {
    parts.push(`achieved Δt ${formatDeltaSeconds(corr?.timeDeltaSeconds)}`);
  }
  const radius = corr?.scoreDecomposition?.matchRadiusMeters;
  if (finite(radius)) parts.push(`match radius ${formatMeters(radius)}`);
  if (parts.length === 0) return NOT_ESTABLISHED;
  return `Correlation window: ${parts.join(' within a ')}.`;
}

// ---------------------------------------------------------------- component

export interface TimelineProps {
  /** The active scan payload, or null when no scan has been loaded. */
  readonly scan?: TimelineScanInput | null;
  /** Target to build the timeline for. Null renders the acquisition-only state. */
  readonly targetId?: string | null;
  /** AIS observations around the acquisition, supplied by the caller. */
  readonly aisObservations?: readonly AisObservation[] | null;
  /** Escape closes the surrounding surface when provided. */
  readonly onClose?: () => void;
}

const TRACK_LABEL: Readonly<Record<TimelineEventKind, string>> = {
  SAR_ACQUISITION: 'SAR acquisition',
  PROJECTED_POSITION: 'Projected AIS position',
  AIS_OBSERVATION: 'AIS observation',
};

/**
 * The real acquisition-time timeline. It renders the instants the payload
 * carries and nothing else: no timer, no autoplay, no interpolated frame.
 */
export function Timeline({
  scan = null,
  targetId = null,
  aisObservations = null,
  onClose,
}: TimelineProps): React.ReactElement {
  const resolvedScan = useMemo<TimelineScanInput | null>(
    () => (scan ? { ...scan, ais_observations: aisObservations ?? scan.ais_observations ?? [] } : scan),
    [scan, aisObservations],
  );

  const events = useMemo(() => buildTimelineEvents(resolvedScan, targetId), [resolvedScan, targetId]);
  const span = useMemo(() => timelineSpan(events), [events]);
  const instants = useMemo(() => timelineInstants(events), [events]);

  const target = useMemo(
    () => resolvedScan?.targets?.find((candidate) => candidate.id === targetId) ?? null,
    [resolvedScan, targetId],
  );
  const windowLabel = correlationWindowLabel(target);

  const acquisitionInstant = useMemo(
    () => events.find((event) => event.kind === 'SAR_ACQUISITION')?.atMs ?? null,
    [events],
  );
  const defaultIndex = useMemo(() => {
    if (typeof acquisitionInstant !== 'number') return Math.max(0, instants.length - 1);
    const index = instants.indexOf(acquisitionInstant);
    return index === -1 ? Math.max(0, instants.length - 1) : index;
  }, [instants, acquisitionInstant]);

  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const activeIndex = clampScrubIndex(
    scrubIndex === null ? defaultIndex : scrubIndex,
    Math.max(span.stepCount, 1),
  );
  const activeMs = instants[activeIndex] ?? null;

  // Escape closes the timeline surface when it owns one. Inside the inspector
  // the panel's own handler runs, so nothing is bound here.
  useEffect(() => {
    if (typeof window === 'undefined' || !onClose) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (events.length === 0) {
    return (
      <div data-df-timeline className="space-y-2">
        <p className="flex items-start gap-1.5 text-[10px] text-[var(--df-text-dim)]">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          No acquisition time is established for this record, so no timeline can be drawn.
        </p>
      </div>
    );
  }

  const observations = events.filter((event) => event.kind === 'AIS_OBSERVATION');

  // The correlation window band spans ONLY the AIS observations that exist. When
  // none exist there is no band, because the backend window constant is not in
  // the payload and must not be guessed at.
  const observationSpan = timelineSpan(observations);
  const bandStart = timelinePosition(observationSpan.startMs, span);
  const bandEnd = timelinePosition(observationSpan.endMs, span);

  return (
    <div data-df-timeline className="space-y-3">
      <div className="flex items-center gap-2">
        <Clock className="h-3.5 w-3.5 shrink-0 text-[var(--df-accent)]" aria-hidden />
        <p className="font-mono text-[10px] text-[var(--df-text-secondary)]">
          Acquisition {events[0].atLabel}
        </p>
      </div>

      {/* Track: one marker per real instant, positioned from the payload. */}
      <div
        data-df-timeline-track
        className="relative h-8 rounded-[6px] border border-[var(--df-border)] bg-[var(--df-accent-soft)]"
      >
        {bandStart !== null && bandEnd !== null && (
          <span
            data-df-timeline-window
            aria-hidden
            className="absolute inset-y-1 rounded-[4px] bg-[var(--df-accent-soft)]"
            style={{ left: `${bandStart}%`, width: `${Math.max(4, bandEnd - bandStart)}%` }}
          />
        )}
        {events.map((event) => {
          const left = timelinePosition(event.atMs, span);
          const Icon = event.kind === 'SAR_ACQUISITION' ? Radar : Radio;
          return (
            <span
              key={event.key}
              data-df-timeline-event={event.kind}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${left ?? 0}%` }}
            >
              <Icon className="h-3 w-3 text-[var(--df-accent)]" aria-hidden />
              <span className="sr-only">
                {TRACK_LABEL[event.kind]} at {event.atLabel}, {event.deltaLabel} from acquisition.
              </span>
            </span>
          );
        })}
      </div>

      {/* Δt labels: the offsets the payload actually produced. */}
      <ol className="space-y-1">
        {events.map((event) => (
          <li
            key={`delta-${event.key}`}
            data-df-timeline-delta={event.deltaLabel}
            className="flex items-center justify-between gap-2 text-[10px]"
          >
            <span className="text-[var(--df-text-secondary)]">{event.label}</span>
            <span className="font-mono tabular-nums text-[var(--df-text)]">{event.deltaLabel}</span>
          </li>
        ))}
      </ol>

      <p className="text-[10px] leading-snug text-[var(--df-text-secondary)]">{windowLabel}</p>

      {observations.length === 0 && (
        <p
          data-df-timeline-no-observations
          className="text-[10px] leading-snug text-[var(--df-text-dim)]"
        >
          {NO_ASSOCIATION_STATEMENT} No surrounding AIS observation is available to place on this
          track.
        </p>
      )}

      {/* Scrubbing. Discrete, over real instants only, never auto-advancing. */}
      {span.singleInstant ? (
        <div data-df-timeline-single className="space-y-1">
          <p className="font-mono text-[10px] text-[var(--df-text-dim)]">
            Single acquisition — nothing to scrub.
          </p>
          <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
            This record covers one instant, so no playback is offered. Nothing is interpolated or
            animated.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <label
            htmlFor="df-timeline-scrub"
            className="block font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--df-text-dim)]"
          >
            Scrub available instants
          </label>
          <input
            id="df-timeline-scrub"
            data-df-timeline-scrub
            type="range"
            min={0}
            max={span.stepCount - 1}
            step={1}
            value={activeIndex}
            onChange={(event) => setScrubIndex(clampScrubIndex(event.target.value, span.stepCount))}
            className="w-full accent-[var(--df-accent)]"
          />
          <p className="font-mono text-[10px] tabular-nums text-[var(--df-text-secondary)]">
            {activeMs === null ? NOT_ESTABLISHED : formatUtcStamp(new Date(activeMs).toISOString())}
          </p>
        </div>
      )}

      <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
        Every instant above is read from the scan payload. The timeline never advances on its own.
      </p>
    </div>
  );
}

export default Timeline;