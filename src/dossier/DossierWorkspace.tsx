/**
 * The Ghost Vessel Dossier.
 *
 * ONE TARGET, ELEVEN QUESTIONS
 *
 * Everything here is a function of a single `(scanId, targetId)` pair plus that
 * scan's stored record. The tabs are not separate applications that happen to sit
 * in a strip; they are eleven views of one investigation, and each one is a
 * different question about the same object:
 *
 *     what did the radar see?   what did AIS say?   why did they not agree?
 *     is there a wake?          what else was polarised?  has it been seen before?
 *     when can this water be seen again?  what is still unknown?
 *
 * WHY SELECTION IS CARRIED AS A PAIR
 *
 * Target ids are per-scan (`DF-{index+1:03d}` within one scan), so `DF-002` names
 * a different vessel in a different scan. The backend resolves a bare id across the
 * whole archive and answers `ambiguous: true`. Pinning the scan is what lets the
 * header and the tab bodies agree about which vessel is on screen -- otherwise one
 * vessel's heading can sit above another vessel's evidence.
 *
 * WHY EACH TAB OWNS ITS REQUEST
 *
 * Tabs load independently and each carries its own generation token, so a slow or
 * failing optional channel cannot block or blank the rest. Polarization being
 * unavailable is a normal production state and must not be allowed to hide SAR,
 * AIS, correlation or wake.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ScanScene, VesselTarget } from '../api/contract';
import { useStoreSelector, store } from '../state/store';
import {
  loadPatterns,
  loadRevisitAround,
  loadScanRecord,
  loadTargetAis,
  loadTargetSlice,
  loadTargetSummary,
  loadTracks,
  tracksForPosition,
} from './api';
import { ghostHeader, isGhostVessel, measurement, text } from './format';
import { AbsentText, Epistemics, Maybe, Pill, Row, SectionTitle } from './primitives';
import { AisTab } from './tabs/AisTab';
import { CorrelationTab } from './tabs/CorrelationTab';
import { EvidenceTab } from './tabs/EvidenceTab';
import { HistoryTab } from './tabs/HistoryTab';
import { MultipassTab } from './tabs/MultipassTab';
import { OverviewTab } from './tabs/OverviewTab';
import { PolarizationTab } from './tabs/PolarizationTab';
import { RevisitTab } from './tabs/RevisitTab';
import { SarTab } from './tabs/SarTab';
import { WakeTab } from './tabs/WakeTab';
import { targetRefOf, type TargetRef } from '../intelligence/targetRef';

const TABS = [
  { id: 'OVERVIEW', label: 'OVERVIEW' },
  { id: 'SAR', label: 'SAR' },
  { id: 'AIS', label: 'AIS' },
  { id: 'CORRELATION', label: 'CORRELATION' },
  { id: 'WAKE', label: 'WAKE' },
  { id: 'POLARIZATION', label: 'POLARIZATION' },
  { id: 'MULTIPASS', label: 'MULTIPASS' },
  { id: 'REVISIT', label: 'REVISIT' },
  { id: 'PATTERNS', label: 'PATTERNS' },
  { id: 'EVIDENCE', label: 'EVIDENCE' },
  { id: 'HISTORY', label: 'HISTORY' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function DossierWorkspace() {
  const selection = useStoreSelector((s) => s.selection);
  const scanId = useStoreSelector((s) => s.scanId);
  // The FULL contract record, not the globe projection. Every tab reads the
  // authority: the reduced `targets` array drops correlation, wake, polarization,
  // backscatter and footprint, which is most of what a dossier exists to show.
  const targets = useStoreSelector((s) => s.targetDetail);
  const scene = useStoreSelector((s) => s.scene);

  const [tab, setTab] = useState<TabId>('OVERVIEW');
  const tablist = useRef<HTMLDivElement | null>(null);

  // Fall back to the store's scan id when the selection did not carry one, so a
  // selection made from a surface that does not know the scan still resolves
  // unambiguously inside a live scan.
  const ref: TargetRef | null = useMemo(() => {
    const fromSelection = targetRefOf(selection);
    if (fromSelection === null) return null;
    return { targetId: fromSelection.targetId, scanId: fromSelection.scanId ?? scanId ?? null };
  }, [selection, scanId]);

  const target = useMemo(() => {
    if (ref === null) return null;
    return targets.find((t) => t.id === ref.targetId) ?? null;
  }, [targets, ref]);

  // A new target returns the operator to OVERVIEW. Carrying the previous tab across
  // a target change would silently re-ask the old question of the new vessel, which
  // is confusing in a way that is hard to notice.
  const lastTarget = useRef<string | null>(null);
  useEffect(() => {
    const key = ref === null ? null : `${ref.targetId}@${ref.scanId ?? '-'}`;
    if (key !== lastTarget.current) {
      lastTarget.current = key;
      setTab('OVERVIEW');
    }
  }, [ref]);

  const onTabKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = TABS[(index + delta + TABS.length) % TABS.length];
      setTab(next.id);
      const node = tablist.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`);
      node?.focus();
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setTab(TABS[0].id);
    }
    if (event.key === 'End') {
      event.preventDefault();
      setTab(TABS[TABS.length - 1].id);
    }
  }, [tab]);

  if (ref === null) {
    return (
      <div className="p-3 text-[11px] text-ink-dim">
        Select a SAR target to open its dossier. Selection is shared with the globe, the
        contact list, the analytics workspace and the timeline.
      </div>
    );
  }

  if (target === null) {
    return (
      <div className="p-3" data-df-dossier="dangling">
        <div className="df-label text-[10px] uppercase text-warn">Target not in the loaded scan</div>
        <div className="pt-1 text-[11px] text-ink-2">
          <span className="df-num">{ref.targetId}</span>
          {ref.scanId ? (
            <>
              {' '}
              in scan <span className="df-num">{ref.scanId}</span>
            </>
          ) : (
            ' with no owning scan'
          )}
          .
        </div>
        <div className="pt-1 text-[11px] text-ink-dim">
          The dossier will not substitute a nearby target. Target ids are assigned per scan, so
          the same id in another scan is a different vessel, and showing that one here would be
          showing the wrong ship.
        </div>
      </div>
    );
  }

  const ghost = ghostHeader(target.classification);

  return (
    <div className="flex h-full min-h-0 flex-col" data-df-dossier="ready" data-df-target={ref.targetId}>
      <DossierHeader target={target} scene={scene} ghost={ghost} scanId={ref.scanId} />

      <div
        ref={tablist}
        role="tablist"
        aria-label="Target dossier sections"
        onKeyDown={onTabKey}
        className="df-scroll-x flex shrink-0 gap-0 border-b border-structural bg-base/60"
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            data-tab={entry.id}
            data-df-dossier-tab={entry.id}
            aria-selected={tab === entry.id}
            tabIndex={tab === entry.id ? 0 : -1}
            onClick={() => setTab(entry.id)}
            className={`shrink-0 border-b-2 px-2.5 py-1.5 text-[10px] uppercase tracking-wider ${
              tab === entry.id
                ? 'border-info text-ink'
                : 'border-transparent text-ink-dim hover:text-ink-2'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="df-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2" role="tabpanel">
        {/*
          Each branch gets `ref` and `target`. No tab re-derives identity, so a tab
          cannot disagree with the header about which vessel it is describing.
        */}
        {tab === 'OVERVIEW' ? <OverviewTab target={target} scene={scene} /> : null}
        {tab === 'SAR' ? <SarTab target={target} scene={scene} /> : null}
        {tab === 'AIS' ? <AisTab targetRef={ref} /> : null}
        {tab === 'CORRELATION' ? <CorrelationTab target={target} targetRef={ref} /> : null}
        {tab === 'WAKE' ? <WakeTab target={target} /> : null}
        {tab === 'POLARIZATION' ? <PolarizationTab target={target} /> : null}
        {tab === 'MULTIPASS' ? <MultipassTab target={target} /> : null}
        {tab === 'REVISIT' ? <RevisitTab targetRef={ref} target={target} /> : null}
        {tab === 'PATTERNS' ? <PatternsTab /> : null}
        {tab === 'EVIDENCE' ? <EvidenceTab targetRef={ref} target={target} /> : null}
        {tab === 'HISTORY' ? <HistoryTab target={target} scene={scene} scanId={ref.scanId} /> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- header */

function DossierHeader({
  target,
  scene,
  ghost,
  scanId,
}: {
  target: VesselTarget;
  scene: ScanScene | null;
  ghost: ReturnType<typeof ghostHeader>;
  scanId: string | null;
}) {
  const focusOnGlobe = useCallback(() => {
    /*
     * Selection is already global, so the globe is already following this target --
     * there is nothing to re-select. What this does is move the operator to the
     * workspace where the globe is the subject, rather than silently changing a
     * camera nobody asked about. Camera motion is a visible side effect and must
     * be an explicit request.
     */
    store.set({ workspace: 'TACTICAL' });
  }, []);

  return (
    <div className="shrink-0 border-b border-structural px-2 py-1.5" data-df-dossier-header>
      {ghost ? (
        <div className="mb-1 border border-warn/50 px-2 py-1" role="note" data-df-ghost-warning>
          <div className="flex items-baseline gap-2">
            <span className="df-label text-[11px] uppercase text-warn">{ghost.designation}</span>
            <span className="df-num text-[11px] text-ink-2">{ghost.analytical}</span>
          </div>
          <div className="pt-0.5 text-[11px] text-ink-2">{ghost.warning}</div>
        </div>
      ) : null}

      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="df-num text-[13px]" data-df-target-id>
            {target.id}
          </h2>
          <Pill tone={isGhostVessel(target.classification) ? 'warn' : 'neutral'}>
            {target.classification}
          </Pill>
        </div>
        <button type="button" className="df-btn text-[10px]" onClick={focusOnGlobe} data-df-focus-globe>
          Focus on globe
        </button>
      </div>

      <div className="mt-1 grid grid-cols-2 gap-x-3">
        <div>
          <Row label="Position">
            <span className="df-num">
              {target.lat.toFixed(5)}, {target.lon.toFixed(5)}
            </span>
          </Row>
          <Row label="Geo uncertainty">
            {/* Length uncertainty is the geolocation authority's answer. It is not a
                positional error bar: it describes apparent length, and conflating the
                two would invent a precision the geolocation did not claim. */}
            <Maybe value={measurement(target.lenUncM, { digits: 0, unit: 'm' })} />
          </Row>
          <Row label="SAR confidence">
            <span className="df-num">{target.sarConf.toFixed(2)}</span>
          </Row>
          <Row label="Acquisition">
            <Maybe value={text(scene?.acquisition_time ?? null)} />
          </Row>
          <Row label="Scene">
            <Maybe value={text(scene?.item_id ?? null)} />
          </Row>
        </div>
        <div>
          <Row label="Platform">
            <Maybe value={text(scene?.platform ?? null)} />
          </Row>
          <Row label="Product">
            <Maybe value={text(scene?.product ?? null)} />
          </Row>
          <Row label="Polarization">
            <Maybe value={text(scene?.polarization ?? null)} />
          </Row>
          <Row label="AIS association">
            {target.classification === 'SAR_MATCHED_AIS' ? (
              <Maybe value={text(target.corr?.mmsi ?? null)} />
            ) : (
              <AbsentText reason="ZERO_CANDIDATES" />
            )}
          </Row>
          <Row label="Scan">
            <Maybe value={text(scanId)} />
          </Row>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ patterns */

function PatternsTab() {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; value: Awaited<ReturnType<ReturnType<typeof loadPatterns>>> }
    | { status: 'failed'; reason: string }
  >({ status: 'idle' });
  const generation = useRef(0);

  useEffect(() => {
    const ticket = ++generation.current;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      try {
        const value = await loadPatterns()(controller.signal);
        if (ticket !== generation.current) return;
        setState({ status: 'ready', value });
      } catch (error) {
        if (ticket !== generation.current) return;
        if ((error as Error)?.name === 'AbortError') return;
        setState({
          status: 'failed',
          reason: error instanceof Error ? error.message : 'The request failed.',
        });
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <div data-df-tab="PATTERNS">
      <SectionTitle>Longitudinal patterns</SectionTitle>
      <div className="pt-1">
        {state.status === 'loading' ? <div className="text-[11px] text-ink-dim">Loading patterns…</div> : null}
        {state.status === 'failed' ? (
          <div className="text-[11px] text-fault">This tab could not load: {state.reason}</div>
        ) : null}
        {state.status === 'ready' ? <PatternsBody state={state.value} /> : null}
      </div>
    </div>
  );
}

function PatternsBody({ state }: { state: Awaited<ReturnType<ReturnType<typeof loadPatterns>>> }) {
  const patterns = state.patterns ?? [];
  return (
    <>
      <Row label="Scans considered">
        <span className="df-num">{state.scans_considered ?? 0}</span>
      </Row>
      <Row label="Observations considered">
        <span className="df-num">{state.observations_considered ?? 0}</span>
      </Row>
      <Row label="Patterns">
        <span className="df-num">{state.pattern_count ?? 0}</span>
      </Row>
      {patterns.length === 0 ? (
        <div className="pt-2 text-[11px] text-ink-dim">
          NO PATTERNS. {state.note || 'The persisted history contains none.'}
        </div>
      ) : (
        <div className="space-y-2 pt-2">
          {patterns.map((pattern) => (
            <div key={pattern.pattern_id} className="border border-structural/50 px-2 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="df-label text-[10px] uppercase">{pattern.kind}</span>
                <span className="df-num text-[10px]">{pattern.confidence?.toFixed(2) ?? '—'}</span>
              </div>
              {/* Observed / derived pattern / hypothesis / limitations kept apart. A
                  pattern is a derived statement about observations, never a
                  restatement of them, and never a claim about conduct. */}
              <Epistemics
                observed={[pattern.observed]}
                hypotheses={[pattern.hypothesis]}
                unknowns={pattern.unknowns ?? []}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* re-exported so the workspace file owns the composition, not the routing details */
export {
  loadTargetAis,
  loadTargetSlice,
  loadScanRecord,
  loadTargetSummary,
  loadTracks,
  loadRevisitAround,
  tracksForPosition,
};