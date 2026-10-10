/**
 * Advanced analysis workspace (ADV-007..012).
 *
 * Surfaces four capabilities the backend already computed and no operator could
 * reach. Each one is rendered with its provenance and its limits visible, because
 * all four are places where an unqualified number would mislead:
 *
 *   REVISIT      measured gaps between real acquisitions; `null` median means
 *                "not enough acquisitions to say", which is not zero
 *   MULTIPASS    hypotheses with supporting AND contradicting evidence; an
 *                unbridgeable gap reports no implied speed rather than a
 *                fabricated one
 *   PATTERNS     observed / hypothesis / confidence / unknowns as four separate
 *                fields, never merged into prose
 *   DETECTOR     the card's declared training domain, validation data and
 *                limitations, with an explicit "no learned weights" for the
 *                deterministic baseline
 *
 * A failed request shows the failure. It never shows an empty-but-successful
 * panel: "the provider could not answer" and "there is nothing there" are
 * different findings.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  loadDetectors,
  loadPatterns,
  loadRevisit,
  loadTracks,
  type Loadable,
} from '../api/advanced';
import { NOT_ESTABLISHED } from '../design/format';
import { SceneComparisonWorkbench } from '../advanced/SceneComparisonWorkbench';
import { SceneImageryWorkspace } from '../advanced/SceneImageryWorkspace';
import { LocalSarImportPanel } from '../scenes/LocalSarImportPanel';
import { AnalystWorkspace } from '../analyst/AnalystWorkspace';
import type {
  DetectorsOut,
  PatternOut,
  PatternsOut,
  RevisitPlanOut,
  TrackHypothesisOut,
  TracksOut,
} from '../api/contract';

type Tab = 'REVISIT' | 'MULTIPASS' | 'COMPARE' | 'IMAGERY' | 'LOCAL_SAR' | 'PATTERNS' | 'DETECTOR' | 'ANALYST';

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['REVISIT', 'Revisit'],
  ['MULTIPASS', 'Multipass'],
  ['COMPARE', 'SAR compare'],
  ['IMAGERY', 'SAR imagery'],
  ['LOCAL_SAR', 'Local GeoTIFF'],
  ['PATTERNS', 'Patterns'],
  ['DETECTOR', 'Detector'],
  ['ANALYST', 'Analyst'],
];

export function AdvancedWorkspace({ bbox }: { bbox: readonly number[] | null }) {
  const [tab, setTab] = useState<Tab>('REVISIT');
  const [plan, setPlan] = useState<Loadable<RevisitPlanOut>>({ state: 'idle' });
  const [tracks, setTracks] = useState<Loadable<TracksOut>>({ state: 'idle' });
  const [patterns, setPatterns] = useState<Loadable<PatternsOut>>({ state: 'idle' });
  const [detectors, setDetectors] = useState<Loadable<DetectorsOut>>({ state: 'idle' });
  const [planArea, setPlanArea] = useState('');
  const [planBusy, setPlanBusy] = useState(false);

  // Revisit is area-scoped. It plans a real window over a real place, so it is
  // requested only once there is a place to request it for.
  //
  // The area comes from this panel's own field rather than only from the store's
  // AOI. Coupling planning to the scan AOI meant an analyst could not plan
  // acquisitions without first running a scan, which is a strange precondition
  // for asking "when will this water be imaged?".
  const requestPlan = useCallback(async () => {
    const parsed = parseBBox(planArea);
    if (!parsed) {
      // An unparseable area is stated, not silently ignored.
      setPlan({ state: 'idle' });
      return;
    }
    setPlanBusy(true);
    setPlan(await loadRevisit(parsed));
    setPlanBusy(false);
  }, [planArea]);

  // Prefill from the AOI the operator already has, without forcing a scan.
  useEffect(() => {
    if (!planArea && bbox) setPlanArea(bbox.map((v) => v.toFixed(4)).join(', '));
  }, [bbox, planArea]);

  const loadHistory = useCallback(async () => {
    setTracks({ state: 'loading' });
    setPatterns({ state: 'loading' });
    const [t, p] = await Promise.all([loadTracks(), loadPatterns()]);
    setTracks(t);
    setPatterns(p);
  }, []);

  const loadRegistry = useCallback(async () => {
    setDetectors({ state: 'loading' });
    setDetectors(await loadDetectors());
  }, []);

  // Fetch on demand rather than on mount: an analyst opening ADVANCED to read
  // detector provenance should not pay for a 50-scan multipass rebuild.
  useEffect(() => {
    if (tab === 'MULTIPASS' && tracks.state === 'idle') void loadHistory();
    if (tab === 'PATTERNS' && patterns.state === 'idle') void loadHistory();
    if (tab === 'DETECTOR' && detectors.state === 'idle') void loadRegistry();
  }, [tab, tracks.state, patterns.state, detectors.state, loadHistory, loadRegistry]);

  return (
    <div className="flex h-full flex-col" data-df-advanced-workspace>
      {/* Matches the target-intel tab strip. An earlier revision used
          `.df-tabs`/`.df-tab`, which do not exist in the design system, so the
          four labels rendered as one unseparated run of text
          ("RevisitMultipassPatternsDetector"). Reusing the real pattern also
          brings the arrow-key navigation the target panel already has. */}
      <div
        className="flex shrink-0 items-center gap-1 px-2 py-1.5"
        role="tablist"
        aria-label="Advanced analysis"
      >
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`advanced-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`advanced-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className="df-btn"
            data-df-advanced-tab={id}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const index = TABS.findIndex(([tid]) => tid === tab);
              if (event.key === 'ArrowRight') setTab(TABS[(index + 1) % TABS.length][0]);
              if (event.key === 'ArrowLeft') {
                setTab(TABS[(index - 1 + TABS.length) % TABS.length][0]);
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {tab === 'REVISIT' ? (
          <RevisitPanel
            state={plan}
            area={planArea}
            busy={planBusy}
            onArea={setPlanArea}
            onPlan={() => void requestPlan()}
            invalid={planArea.trim().length > 0 && parseBBox(planArea) === null}
          />
        ) : null}
        {tab === 'MULTIPASS' ? <MultipassPanel state={tracks} /> : null}
        {tab === 'COMPARE' ? <SceneComparisonWorkbench /> : null}
        {tab === 'IMAGERY' ? <SceneImageryWorkspace /> : null}
        {tab === 'LOCAL_SAR' ? <LocalSarImportPanel /> : null}
        {tab === 'PATTERNS' ? <PatternsPanel state={patterns} /> : null}
        {tab === 'DETECTOR' ? <DetectorPanel state={detectors} /> : null}
        {tab === 'ANALYST' ? <AnalystWorkspace /> : null}
      </div>
    </div>
  );
}

/**
 * Parse `min_lon, min_lat, max_lon, max_lat`.
 *
 * Returns null rather than a partially-correct value: a bbox with the wrong
 * number of parts, a non-finite part, or min greater than max is not an area,
 * and planning over a misread area would report coverage for the wrong water.
 */
function parseBBox(text: string): number[] | null {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = nums;
  if (minLon! >= maxLon! || minLat! >= maxLat!) return null;
  return nums;
}

/* ------------------------------------------------------------------ revisit */

function RevisitPanel({
  state,
  area,
  busy,
  invalid,
  onArea,
  onPlan,
}: {
  state: Loadable<RevisitPlanOut>;
  area: string;
  busy: boolean;
  invalid: boolean;
  onArea: (value: string) => void;
  onPlan: () => void;
}) {
  return (
    <div className="space-y-3">
      <form
        className="space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          onPlan();
        }}
      >
        <label className="df-label block text-[10px]" htmlFor="df-revisit-bbox">
          Area to plan (min_lon, min_lat, max_lon, max_lat)
        </label>
        <div className="flex gap-1">
          <input
            id="df-revisit-bbox"
            className="df-input flex-1"
            value={area}
            placeholder="103.72, 1.10, 104.05, 1.40"
            onChange={(e) => onArea(e.target.value)}
            aria-invalid={invalid}
          />
          <button type="submit" className="df-btn" disabled={busy || invalid} data-df-revisit-plan>
            {busy ? 'Planning…' : 'Plan'}
          </button>
        </div>
        {invalid ? (
          <p className="df-note" style={{ color: 'var(--df-amber)' }} data-df-revisit-invalid>
            Four numbers, min below max. Planning over a misread area would report coverage for
            the wrong water.
          </p>
        ) : null}
      </form>

      {state.state === 'idle' ? (
        <p className="df-note">
          Enter an area to plan acquisitions from the catalogue.
        </p>
      ) : null}
      {state.state === 'loading' ? <p className="df-note">Reading the catalogue…</p> : null}
      {state.state === 'failed' ? (
        <Failure
          detail={state.detail}
          note="The catalogue could not be reached. No plan is shown, because a simulated one would be indistinguishable from a real answer."
        />
      ) : null}
      {state.state === 'ready' ? <RevisitResult data={state.data} /> : null}
    </div>
  );
}

function RevisitResult({ data }: { data: RevisitPlanOut }) {
  const stats = data.statistics;

  return (
    <>
      <Section title="Measured revisit">
        <Row label="Acquisitions found" value={String(data.acquisition_count)} />
        <Row label="Platforms" value={String(stats.platform_count ?? NOT_ESTABLISHED)} />
        {/* `null` here means there were not enough acquisitions to compute a
            median. Rendering it as 0 days would assert the water is imaged
            continuously, which is the opposite of the truth. */}
        <Row label="Median revisit" value={days(stats.median_revisit_days)} />
        <Row label="Shortest gap" value={days(stats.min_revisit_days)} />
        <Row label="Longest gap" value={days(stats.max_revisit_days)} />
        <Row label="Nominal repeat" value={days(stats.nominal_repeat_days)} />
        <Row
          label="Gaps over nominal"
          value={
            stats.flagged_gap_count === undefined || stats.flagged_gap_count === null
              ? NOT_ESTABLISHED
              : String(stats.flagged_gap_count)
          }
        />
      </Section>

      {stats.acquisitions_per_platform ? (
        <Section title="Acquisitions per platform">
          {Object.entries(stats.acquisitions_per_platform).map(([platform, count]) => (
            <Row key={platform} label={platform} value={String(count)} />
          ))}
        </Section>
      ) : null}

      {data.next_after ? (
        <Section title="Next catalogue acquisition">
          <Row label="Platform" value={data.next_after.platform} />
          <Row label="Time" value={data.next_after.acquisition_time} />
          <Row
            label="Polarisation"
            value={data.next_after.polarizations?.join(', ') || 'not reported'}
          />
          <Row label="Scene" value={data.next_after.item_id} />
        </Section>
      ) : (
        <p className="df-note">
          No further catalogue acquisition in the requested horizon. That is what the catalogue
          reports for this window, not a prediction of when the sensor will next look.
        </p>
      )}

      <GapList gaps={data.gaps} />
      <Limitations items={data.limitations} source={`${data.provider} · ${data.collection}`} />
    </>
  );
}

function GapList({ gaps }: { gaps: RevisitPlanOut['gaps'] }) {
  if (!gaps?.length) return null;
  return (
    <Section title={`Gaps (${gaps.length})`}>
      {gaps.map((gap) => (
        <div key={`${gap.start}-${gap.end}`} className="border-b border-structural/40 py-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="df-num text-[10px] text-ink">
              {String(gap.start).slice(0, 10)} → {String(gap.end).slice(0, 10)}
            </span>
            <span
              className="df-num text-[10px]"
              style={{ color: gap.exceeds_nominal ? 'var(--df-amber)' : 'var(--df-ink-2)' }}
            >
              {gap.days?.toFixed(1) ?? NOT_ESTABLISHED} d
              {gap.exceeds_nominal ? ' ▲' : ''}
            </span>
          </div>
          {gap.window_edge ? (
            <p className="df-note">
              Truncated by the query window, not by coverage. Not a real hole.
            </p>
          ) : null}
        </div>
      ))}
    </Section>
  );
}

/* --------------------------------------------------------------- multipass */

function MultipassPanel({ state }: { state: Loadable<TracksOut> }) {
  if (state.state === 'idle' || state.state === 'loading') {
    return <p className="df-note">Building track hypotheses from stored observations…</p>;
  }
  if (state.state === 'failed') {
    return <Failure detail={state.detail} note="No hypotheses are shown." />;
  }

  const { data } = state;
  if (data.track_count === 0) {
    // Zero tracks is a real result. What was examined travels with it, so the
    // reader can tell "nothing to link" from "nothing was examined".
    return (
      <div className="space-y-2">
        <p className="df-note">
          No track hypotheses from {data.observations_considered ?? 0} observation(s) across{' '}
          {data.scans_considered ?? 0} stored scan(s).
        </p>
        <p className="df-note">{data.note}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="df-note">
        {data.track_count} hypothesis(es) from {data.observations_considered} observation(s)
        across {data.scans_considered} scan(s). {data.note}
      </p>
      {data.tracks?.map((track) => (
        <article key={track.track_id} className="border-l-2 border-structural-bright pl-2">
          <header className="flex items-baseline justify-between gap-2">
            <span className="df-mono text-[10px] text-ink">{track.track_id}</span>
            <span className="df-num text-[10px] text-ink-2">
              strength {(track.identity_strength ?? 0).toFixed(2)}
            </span>
          </header>
          <p className="df-note mt-0.5">{track.confidence_statement}</p>

          <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5">
            {(track.points ?? []).map((point) => (
              <Row
                key={`${point.scan_id}-${point.item_id}`}
                label={String(point.acquisition_time).slice(0, 10)}
                value={`${point.lat?.toFixed(4)}, ${point.lon?.toFixed(4)}`}
              />
            ))}
          </div>

          {gapsOf(track).length ? (
            <div className="mt-1.5">
              <p className="df-label text-[10px]">Intervals</p>
              {gapsOf(track).map((gap, i) => (
                <Row
                  key={`${gap.seconds}-${i}`}
                  label={`${(gap.seconds / 3600).toFixed(1)} h`}
                  value={
                    gap.implied_speed_knots === null || gap.implied_speed_knots === undefined
                      ? // No implied speed is the honest answer for a gap too
                        // long to bridge. Interpolating one would fabricate a
                        // kinematic fact about a vessel nobody observed moving.
                        'not bridgeable'
                      : `${gap.implied_speed_knots.toFixed(1)} kn${gap.plausible ? '' : ' ⚠'}`
                  }
                />
              ))}
            </div>
          ) : null}

          {/* Both lists render. A hypothesis shown only with the evidence that
              flatters it is a sales pitch, not an analysis. */}
          <EvidencePair
            supporting={track.supporting_evidence}
            contradicting={track.contradicting_evidence}
          />
        </article>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- patterns */

function PatternsPanel({ state }: { state: Loadable<PatternsOut> }) {
  if (state.state === 'idle' || state.state === 'loading') {
    return <p className="df-note">Analysing observation history…</p>;
  }
  if (state.state === 'failed') return <Failure detail={state.detail} note="No patterns shown." />;

  const { data } = state;
  if (data.pattern_count === 0) {
    return (
      <div className="space-y-2">
        <p className="df-note">
          No patterns from {data.observations_considered ?? 0} observation(s) across{' '}
          {data.scans_considered ?? 0} stored scan(s).
        </p>
        <p className="df-note">{data.note}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="df-note">{data.note}</p>
      {data.patterns?.map((pattern) => (
        <article key={pattern.pattern_id} className="border-l-2 border-structural-bright pl-2">
          <header className="flex items-baseline justify-between gap-2">
            <span className="df-mono text-[10px] text-ink">{pattern.kind}</span>
            <span className="df-num text-[10px] text-ink-2">
              confidence {(pattern.confidence ?? 0).toFixed(2)}
            </span>
          </header>

          {/* Observed and hypothesis are different epistemic kinds and get
              different visual weight. The hypothesis is never styled as a
              measurement. */}
          <p className="mt-1 text-[11px] leading-relaxed text-ink">{pattern.observed}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-2 italic">
            hypothesis: {pattern.hypothesis}
          </p>

          {unknownsOf(pattern).length ? (
            <div className="mt-1.5">
              <p className="df-label text-[10px]">Unknowns</p>
              <ul className="space-y-0.5">
                {unknownsOf(pattern).map((item) => (
                  <li key={item} className="text-[10px] text-ink-dim">
                    · {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- detector */

function DetectorPanel({ state }: { state: Loadable<DetectorsOut> }) {
  if (state.state === 'idle' || state.state === 'loading') {
    return <p className="df-note">Reading the detector registry…</p>;
  }
  if (state.state === 'failed') {
    return <Failure detail={state.detail} note="No detector provenance is shown." />;
  }

  const { data } = state;
  return (
    <div className="space-y-3">
      {/* One card per registered detector, with the resolved one marked in the
          header. A separate "Resolved" row above the list printed the same name
          twice and read as a duplicate rather than as a label. */}
      {data.detectors?.map((card) => {
        const active = card.name === data.default;
        return (
          <article
            key={card.name}
            className="border-l-2 pl-2"
            style={{ borderColor: active ? 'var(--df-cyan)' : 'var(--df-structural-bright)' }}
            data-df-detector={card.name}
            data-df-detector-active={active}
          >
            <header className="flex items-baseline justify-between gap-2">
              <span className="df-mono text-[10px] text-ink">
                {card.name}
                {active ? (
                  <span className="ml-1" style={{ color: 'var(--df-cyan)' }}>
                    · active
                  </span>
                ) : null}
              </span>
              <span className="df-num text-[10px] text-ink-2">{card.kind}</span>
            </header>
          <Row label="Training domain" value={card.training_domain || NOT_ESTABLISHED} />
          <Row label="Input product" value={card.input_product || NOT_ESTABLISHED} />
          <Row label="Validation data" value={card.validation_data || NOT_ESTABLISHED} />
          <Row
            label="Weights digest"
            value={
              // None is a real answer for a deterministic detector: there are no
              // learned weights. Rendering it as "missing" would suggest a
              // provenance gap that does not exist.
              card.weights_digest === null || card.weights_digest === undefined
                ? 'none — deterministic'
                : card.weights_digest
            }
          />
          {card.limitations ? (
            <p className="df-note mt-1 text-[10px]">{card.limitations}</p>
          ) : null}
          </article>
        );
      })}

      <Limitations items={[data.note]} source="detector registry" />
    </div>
  );
}

/* ------------------------------------------------------------------ shared */

/**
 * Narrow once, use twice.
 *
 * The contract marks these lists optional, so the guard is written here rather
 * than repeated at each use site where a missed guard would become a runtime
 * crash instead of a compile error.
 */
function gapsOf(track: TrackHypothesisOut): NonNullable<TrackHypothesisOut['gaps']> {
  return track.gaps ?? [];
}

function unknownsOf(pattern: PatternOut): NonNullable<PatternOut['unknowns']> {
  return pattern.unknowns ?? [];
}

function days(value: number | null | undefined): string {
  return value === null || value === undefined ? NOT_ESTABLISHED : `${value.toFixed(1)} d`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section data-df-advanced-section={title}>
      <h3 className="df-label mb-1 text-[10px]">{title}</h3>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-structural/40 py-0.5">
      <span className="df-label truncate text-[10px] text-ink-dim">{label}</span>
      <span className="df-num text-right text-[10px] text-ink">{value}</span>
    </div>
  );
}

function EvidencePair({
  supporting,
  contradicting,
}: {
  supporting?: string[] | null;
  contradicting?: string[] | null;
}) {
  const yes = supporting ?? [];
  const no = contradicting ?? [];
  return (
    <div className="mt-1.5 grid grid-cols-2 gap-2">
      <div>
        <p className="df-label text-[10px]">Supporting</p>
        {yes.length ? (
          <ul className="space-y-0.5">
            {yes.map((item) => (
              <li key={item} className="text-[10px] text-ink-2">
                · {item}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] text-ink-dim">none recorded</p>
        )}
      </div>
      <div>
        <p className="df-label text-[10px]">Contradicting</p>
        {no.length ? (
          <ul className="space-y-0.5">
            {no.map((item) => (
              <li key={item} className="text-[10px]" style={{ color: 'var(--df-amber)' }}>
                · {item}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[10px] text-ink-dim">none recorded</p>
        )}
      </div>
    </div>
  );
}

function Limitations({ items, source }: { items?: Array<string | undefined> | null; source: string }) {
  const rows = (items ?? []).filter((item): item is string => Boolean(item));
  if (!rows.length) return null;
  return (
    <section data-df-advanced-section="Limitations">
      <h3 className="df-label mb-1 text-[10px]">Limitations · {source}</h3>
      <ul className="space-y-0.5">
        {rows.map((item) => (
          <li key={item} className="text-[10px] leading-relaxed text-ink-dim">
            · {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A failure is displayed, never rendered as an empty success. */
function Failure({ detail, note }: { detail: string; note: string }) {
  return (
    <div
      className="border-l-2 pl-2"
      style={{ borderColor: 'var(--df-red)' }}
      data-df-advanced-failure
      role="alert"
    >
      <p className="df-label text-[10px]" style={{ color: 'var(--df-red)' }}>
        Request failed
      </p>
      <p className="df-num mt-0.5 break-words text-[10px] text-ink-2">{detail}</p>
      <p className="df-note mt-1">{note}</p>
    </div>
  );
}
