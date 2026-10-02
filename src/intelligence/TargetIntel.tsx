/**
 * Target intelligence.
 *
 * The product's densest surface, and the one where overclaiming is most
 * damaging. Three rules are enforced structurally rather than by convention:
 *
 *  1. OBSERVED / HYPOTHESES / UNKNOWNS are separate blocks. An empty block still
 *     renders, so "we looked and found nothing" never reads as "we did not look".
 *  2. No absent measurement is shown as a number. One formatter decides that.
 *  3. No intent language. `SAR_UNMATCHED` is a statement about correlation, not
 *     about what the vessel is doing; the copy says so where the class is shown.
 */

import { useEffect, useState } from 'react';

import { loadTrack } from '../api/client';
import { engine } from '../globe/engine';
import { store, useStore } from '../state/store';
import { classificationColor } from '../design/tokens';
import {
  NOT_ESTABLISHED,
  fmt,
  fmtBearing,
  fmtConfidence,
  fmtConfidence3,
  fmtDelta,
  fmtInstant,
  fmtKnots,
  fmtLatLon,
  fmtMetres,
  fmtNauticalMiles,
  fmtRows,
  fmtText,
  fmtUtc,
} from '../design/format';

type Tab = 'OVERVIEW' | 'AIS' | 'ANALYSIS' | 'EVIDENCE';
const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['OVERVIEW', 'Overview'],
  ['AIS', 'AIS'],
  ['ANALYSIS', 'Analysis'],
  ['EVIDENCE', 'Evidence'],
];

export function TargetIntel() {
  const state = useStore();
  const [tab, setTab] = useState<Tab>('OVERVIEW');

  const selectedTargetId =
    state.selection.kind === 'target' ? state.selection.targetId : null;
  const target =
    selectedTargetId === null
      ? null
      : (state.targets.find((t) => t.id === selectedTargetId) ?? null);
  const mmsi = state.selection.kind === 'mmsi' ? state.selection.mmsi : (target?.mmsi ?? null);

  // The track is fetched when an MMSI is selected, and is keyed by MMSI so a
  // stale response for a previous vessel cannot land on the current selection.
  useEffect(() => {
    if (!mmsi) return;
    void loadTrack(mmsi);
  }, [mmsi]);

  if (state.selection.kind === 'none') {
    return (
      <section className="df-panel h-full" data-df-workspace="INTEL">
        <header className="df-panel-head">
          <span className="df-label">Intelligence</span>
        </header>
        <p className="p-4 text-[11px] text-ink-dim" data-df-inspector-empty>
          No target is selected. Select a contact on the globe or in the contact list.
        </p>
      </section>
    );
  }

  if (state.selection.kind === 'mmsi' && !target) {
    return <MmsiIntel mmsi={state.selection.mmsi} />;
  }

  if (!target) {
    return (
      <section className="df-panel h-full">
        <header className="df-panel-head">
          <span className="df-label">Intelligence</span>
        </header>
        <p className="p-4 text-[11px] text-ink-2">
          {state.selection.kind === 'target' ? state.selection.targetId : ''} is no longer
          among the loaded targets. It may belong to a scan that is no longer active.
        </p>
      </section>
    );
  }

  return (
    <section className="df-panel df-scroll flex h-full flex-col overflow-hidden" data-df-workspace="INTEL">
      <header className="df-panel-head shrink-0 justify-between">
        <span className="df-label">Target</span>
        <span className="df-num text-ink-dim">{target.id}</span>
      </header>

      <div
        className="flex shrink-0 items-center gap-1 px-2 py-1.5"
        role="tablist"
        aria-label="Target detail"
      >
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`intel-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`intel-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className="df-btn"
            data-df-intel-tab={id}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const index = TABS.findIndex(([tid]) => tid === tab);
              if (event.key === 'ArrowRight') setTab(TABS[(index + 1) % TABS.length][0]);
              if (event.key === 'ArrowLeft') setTab(TABS[(index - 1 + TABS.length) % TABS.length][0]);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        className="df-scroll flex-1 overflow-y-auto p-3"
        role="tabpanel"
        id={`intel-panel-${tab}`}
        aria-labelledby={`intel-tab-${tab}`}
      >
        {tab === 'OVERVIEW' ? <Overview target={target} /> : null}
        {tab === 'AIS' ? <AisTab target={target} /> : null}
        {tab === 'ANALYSIS' ? <AnalysisTab target={target} /> : null}
        {tab === 'EVIDENCE' ? <EvidenceTab target={target} /> : null}
      </div>
    </section>
  );
}

type AnyTarget = NonNullable<ReturnType<typeof useStore>['targets'][number]>;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-structural/50 py-1">
      <span className="df-label text-[10px]">{label}</span>
      <span className="df-num text-right text-ink">{value}</span>
    </div>
  );
}

function Overview({ target }: { target: AnyTarget }) {
  const rows = fmtRows([
    ['Position', fmtLatLon(target.lat, target.lon, 5)],
    ['Classification', target.classification.replace(/_/g, ' ')],
    ['SAR confidence', fmtConfidence(target.sarConf)],
    [
      'Geolocation uncertainty',
      target.geolocationUncertaintyM === null
        ? NOT_ESTABLISHED
        : `${target.geolocationUncertaintyM.toFixed(1)} m`,
    ],
    ['Scene', target.sceneItemId ?? null],
    ['AIS association', target.mmsi ?? null],
  ]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-3 w-3"
          style={{ background: classificationColor[target.classification] ?? 'var(--df-text-dim)' }}
        />
        <span className="df-num text-[13px] text-ink">{target.id}</span>
      </div>
      {rows.map((row) => (
        <Row key={row.label} label={row.label} value={row.value} />
      ))}
      <p className="mt-3 text-[11px] leading-relaxed text-ink-dim">
        A radar return is a measurement of scattered energy, not of intent. This target is
        classified by how it correlates with AIS evidence, not by what it is presumed to be
        doing.
      </p>
      <button
        type="button"
        className="df-btn mt-3"
        onClick={() => engine.flyTo(target.lat, target.lon, 120_000)}
      >
        Focus on globe
      </button>
    </div>
  );
}

function AisTab({ target }: { target: AnyTarget }) {
  const state = useStore();
  const track = state.track;
  const coverage = track?.coverage ?? state.aisCoverage;

  if (!target.mmsi) {
    return (
      <div data-df-intel-ais="unassociated">
        <EvidenceBlock
          title="Observed"
          items={[
            `A vessel-like SAR return at ${fmtLatLon(target.lat, target.lon, 4)}`,
            `Acquisition ${fmtUtc(state.scanStageHistory.at(-1)?.timestamp ?? null)}`,
          ]}
        />
        <EvidenceBlock
          title="Hypotheses"
          items={[
            'No AIS candidate exceeded the association threshold in the correlation window.',
            'The vessel may be outside AIS reception, may not have been broadcasting, or the observation may be older than the window.',
          ]}
        />
        <EvidenceBlock
          title="Unknowns"
          items={['Identity', 'Destination', 'Intent', 'Whether any AIS transmission exists at all']}
        />
      </div>
    );
  }

  return (
    <div>
      {coverage ? <CoverageNote coverage={coverage} /> : null}
      <EvidenceBlock
        title="Observed"
        items={fmtRows([
          ['Candidate MMSI', target.mmsi],
          ['Distance offset', target.distanceOffsetMeters === null ? null : `${target.distanceOffsetMeters.toFixed(0)} m`],
          ['Match radius', target.matchRadiusMeters === null ? null : `${target.matchRadiusMeters.toFixed(0)} m`],
          ['AIS confidence', fmtConfidence(target.aisConf)],
          [
            'Observations in window',
            track ? String(track.observed.length) : null,
          ],
        ]).map((row) => `${row.label}: ${row.value}`)}
      />
      <EvidenceBlock
        title="Hypotheses"
        items={[
          'The observed position at acquisition time was derived by propagating the last AIS fix forward using its reported speed and course.',
          'A propagated position is arithmetic, not a measurement.',
        ]}
      />
      <EvidenceBlock title="Unknowns" items={['Identity', 'Intent', 'Destination']} />
      <button
        type="button"
        className="df-btn mt-2"
        disabled={!track || track.observed.length === 0}
        data-df-intel-focus-track
        onClick={() => {
          const first = track?.observed[0];
          if (first) engine.flyTo(first.lat, first.lon, 200_000);
        }}
      >
        Focus track
      </button>
    </div>
  );
}

function AnalysisTab({ target }: { target: AnyTarget }) {
  return (
    <div data-df-intel-analysis>
      {fmtRows([
        ['Spatial', target.distanceOffsetMeters === null ? null : fmtMetres(target.distanceOffsetMeters)],
        ['Match radius', target.matchRadiusMeters === null ? null : fmtMetres(target.matchRadiusMeters)],
        ['Composite', fmtConfidence3(target.aisConf)],
      ]).map((row) => (
        <Row key={row.label} label={row.label} value={row.value} />
      ))}
      <p className="mt-3 text-[11px] leading-relaxed text-ink-dim">
        Scores are shown to three decimals because that is the resolution at which the
        backend computes them. Additional digits would imply precision the arithmetic does
        not have.
      </p>
    </div>
  );
}

function EvidenceTab({ target }: { target: AnyTarget }) {
  const state = useStore();
  return (
    <div data-df-intel-evidence>
      <EvidenceBlock
        title="Observed"
        items={[
          `Vessel-like SAR return at ${fmtLatLon(target.lat, target.lon, 5)}`,
          `SAR confidence ${fmtConfidence(target.sarConf)}`,
          `Mean/max backscatter and component geometry are available in the analytics workspace`,
        ]}
      />
      <EvidenceBlock
        title="Hypotheses"
        items={[
          target.mmsi
            ? 'Association with the reported MMSI is a scored hypothesis, not a confirmed identity.'
            : 'No association exceeded the threshold. Candidate explanations are listed in the AIS tab.',
        ]}
      />
      <EvidenceBlock title="Unknowns" items={['Identity', 'Destination', 'Intent']} />
      <p className="df-num mt-3 text-[10px] text-ink-dim">
        Scan {state.scanId ?? NOT_ESTABLISHED} · provenance from the persisted record
      </p>
    </div>
  );
}

/**
 * The three evidence blocks.
 *
 * `items` empty still renders the block with an explicit note. Hiding an empty
 * block would make "nothing found" indistinguishable from "not examined".
 */
function EvidenceBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mb-4" data-df-evidence-block={title}>
      <p className="df-label mb-1 text-[10px]">{title}</p>
      {items.length === 0 ? (
        <p className="text-[11px] text-ink-dim">No items were established for this block.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item} className="flex gap-2 text-[11px] leading-relaxed text-ink-2">
              <span aria-hidden="true" className="text-ink-dim">
                ·
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Coverage is stated before any count.
 *
 * "No coverage for this region and time" and "0 AIS vessels" are different
 * claims; rendering the second where the first is true would present a gap in
 * observation as evidence of an empty sea.
 */
function CoverageNote({ coverage }: { coverage: NonNullable<ReturnType<typeof useStore>['aisCoverage']> }) {
  const tone =
    coverage.state === 'AVAILABLE'
      ? 'var(--df-green)'
      : coverage.state === 'PARTIAL'
        ? 'var(--df-amber)'
        : 'var(--df-text-dim)';
  return (
    <div
      className="mb-3 border-l-2 pl-2"
      style={{ borderColor: tone }}
      data-df-coverage={coverage.state}
    >
      <p className="df-label text-[10px]" style={{ color: tone }}>
        AIS {coverage.state.replace(/_/g, ' ')}
      </p>
      <p className="text-[11px] leading-relaxed text-ink-2">{coverage.detail}</p>
      {coverage.observationCount === null ? (
        <p className="df-num mt-1 text-[10px] text-ink-dim">
          Observation count not reported — there is nothing to count.
        </p>
      ) : (
        <p className="df-num mt-1 text-[10px] text-ink-dim">
          {coverage.observationCount} observation(s) in window
        </p>
      )}
    </div>
  );
}

function MmsiIntel({ mmsi }: { mmsi: string }) {
  const state = useStore();
  const track = state.track;
  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="INTEL">
      <header className="df-panel-head justify-between">
        <span className="df-label">Vessel</span>
        <span className="df-num text-ink-dim">{mmsi}</span>
      </header>
      <div className="p-3">
        {state.trackLoading ? (
          <p className="text-[11px] text-ink-dim" role="status">
            Loading observed track…
          </p>
        ) : null}
        {track ? <CoverageNote coverage={track.coverage} /> : null}
        <EvidenceBlock
          title="Observed"
          items={fmtRows([
            ['Name', track?.identity.shipName ?? null],
            ['Callsign', track?.identity.callsign ?? null],
            ['IMO', track?.identity.imo ?? null],
            ['Type', track?.identity.shipType ?? null],
            ['Observations', track ? String(track.observed.length) : null],
          ]).map((row) => `${row.label}: ${row.value}`)}
        />
        <EvidenceBlock
          title="Unknowns"
          items={track && track.observed.length === 0 ? ['No observation of this vessel is present in the archive for the covered period.'] : []}
        />
        <p className="text-[11px] leading-relaxed text-ink-dim">
          A vessel transmitting with no radar return beside it is an open question about
          coverage and detection threshold, not a finding about the vessel.
        </p>
      </div>
    </section>
  );
}

export { fmtText, fmtKnots, fmtBearing, fmtNauticalMiles, fmtInstant, store };