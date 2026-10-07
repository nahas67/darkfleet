/**
 * Mission timeline.
 *
 * Built from real persisted events only. Two rules carried over from the retired
 * UI, both of which were correct:
 *
 *  1. There is no playback. A timeline that animates implies data that does not
 *     exist; DarkFleet has discrete observations, not a continuous world.
 *  2. An unassociated target yields no AIS events. Showing an AIS timeline for a
 *     contact with no association would imply a relationship the correlation
 *     did not find.
 */

import { useMemo, useState } from 'react';

import { engine } from '../globe/engine';
import { store, useStore } from '../state/store';
import { temporal } from '../temporal/TemporalController';
import { fmtDelta, fmtInstant, fmtUtc, NOT_ESTABLISHED } from '../design/format';

type Event = {
  key: string;
  at: string;
  kind: 'SAR_ACQUISITION' | 'AIS_OBSERVATION' | 'ASSOCIATION' | 'NOTE';
  label: string;
  detail: string;
  targetId?: string;
  /**
   * Stable identity for an AIS event: the vessel AND the observation's own timestamp.
   *
   * These were previously baked into `key` as a string and never read as fields, so the timeline could
   * display an observation it could not act on. Carrying them as data is what makes the event
   * addressable -- and an INDEX is explicitly not used, because the archive's read order is not
   * guaranteed and an index would silently point at a different observation.
   */
  mmsi?: string;
};

const KIND_COLOR: Readonly<Record<Event['kind'], string>> = {
  SAR_ACQUISITION: 'var(--df-cyan)',
  AIS_OBSERVATION: 'var(--df-green)',
  ASSOCIATION: 'var(--df-violet)',
  NOTE: 'var(--df-text-dim)',
};

export function MissionTimeline() {
  const state = useStore();
  const [scrub, setScrub] = useState<number | null>(null);

  const events = useMemo<Event[]>(() => {
    const out: Event[] = [];

    /**
     * The acquisition instant is the SCENE's, not the moment the job finished.
     *
     * Using the run timestamp placed a 2026 "acquisition" next to a 2024 scene —
     * a factual error about when the radar actually looked. An association is
     * stamped at acquisition time for the same reason: it is a statement about
     * that instant, not about when an analyst happened to open the page.
     */
    const acquiredAt = state.scene?.acquisition_time ?? null;
    const completedAt =
      state.scanStageHistory.find((stage) => stage.stage === 'COMPLETE')?.timestamp ?? null;

    if (acquiredAt) {
      out.push({
        key: `acq-${acquiredAt}`,
        at: acquiredAt,
        kind: 'SAR_ACQUISITION',
        label: 'SAR acquisition',
        detail: completedAt
          ? `analysed ${fmtInstant(completedAt)}`
          : 'acquisition time from the scene record',
      });
    } else if (completedAt) {
      // No scene time recorded. The run time is stated as what it is rather than
      // presented as an acquisition instant.
      out.push({
        key: `run-${completedAt}`,
        at: completedAt,
        kind: 'SAR_ACQUISITION',
        label: 'Analysis completed',
        detail: 'acquisition time not established from the scene record',
      });
    }

    for (const target of state.targets) {
      if (target.mmsi && acquiredAt) {
        out.push({
          key: `assoc-${target.id}`,
          at: acquiredAt,
          kind: 'ASSOCIATION',
          label: `${target.id} associated`,
          detail: `Reported MMSI ${target.mmsi}`,
          targetId: target.id,
        });
      }
    }
    const observed = state.track?.observed ?? [];
    for (const fix of observed) {
      out.push({
        key: `ais-${fix.mmsi}-${fix.timestamp}`,
        at: fix.timestamp,
        kind: 'AIS_OBSERVATION',
        label: `AIS fix ${fix.mmsi}`,
        detail: fix.ship_name ?? 'no name reported',
        /*
         * STABLE IDENTITY, AS DATA.
         *
         * This line was MISSING for one commit, and the omission was invisible: an earlier edit script
         * used `str.replace(old, new)` with no assertion, the anchor did not match the file's real
         * indentation, and the write succeeded having changed NOTHING. The `mmsi?: string` field landed
         * on the type, so the code compiled, and `event.mmsi` was silently `undefined` for every event
         * -- which would have made the whole timeline-synchronisation feature a no-op that looked
         * finished, and would have passed `tsc`.
         *
         * Every textual edit in this checkpoint now asserts that it applied. A replace that matches
         * nothing is not a no-op; it is an unannounced failure to make the change that was asked for.
         */
        mmsi: fix.mmsi,
      });
    }
    return out
      .filter((event) => event.at !== '')
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [state.scanStageHistory, state.targets, state.track, state.scene]);

  const instants = useMemo(
    () => Array.from(new Set(events.map((e) => e.at))).sort(),
    [events],
  );

  if (instants.length === 0) {
    return (
      <div
        className="df-panel flex h-[74px] shrink-0 items-center px-3"
        data-df-timeline="empty"
      >
        <p className="text-[11px] text-ink-dim">
          {state.scanId
            ? 'This scan produced no time-stamped events to place on a timeline.'
            : 'No mission events. Run an analysis to build a timeline from real observations.'}
        </p>
      </div>
    );
  }

  const currentIndex = scrub ?? instants.length - 1;
  const acquisition = instants.find((at) => events.some((e) => e.at === at && e.kind === 'SAR_ACQUISITION'));

  return (
    <div className="df-panel relative z-30 flex h-[74px] shrink-0 flex-col border-x-0 border-b-0" data-df-timeline>
      <div className="flex h-9 shrink-0 items-center gap-3 px-3">
        <div className="shrink-0">
          <p className="df-label text-[10px]">Mission timeline</p>
          <p className="df-num text-[10px] text-ink-dim">
            {instants.length} event{instants.length === 1 ? '' : 's'}
          </p>
        </div>

        {/* Scrub over real instants only. A slider with no data is worse than
            none, so it only appears when there is something to scrub. */}
        {instants.length > 1 ? (
          <input
            type="range"
            min={0}
            max={instants.length - 1}
            step={1}
            value={currentIndex}
            aria-label="Scrub mission timeline"
            className="flex-1 accent-[var(--df-cyan)]"
            data-df-timeline-scrub
            onChange={(event) => setScrub(Number(event.target.value))}
          />
        ) : (
          <p className="flex-1 text-[11px] text-ink-dim">
            Single acquisition — nothing to scrub, and no playback is offered.
          </p>
        )}

        <div className="df-num shrink-0 text-right text-[10px]">
          <p className="text-ink">{fmtInstant(instants[currentIndex])}</p>
          {acquisition ? (
            <p className="text-ink-dim">Δt {fmtDelta(deltaSeconds(instants[currentIndex], acquisition))}</p>
          ) : (
            <p className="text-ink-dim">{fmtUtc(null)}</p>
          )}
        </div>
      </div>

      <div className="df-scroll-x flex min-h-0 flex-1 gap-1 overflow-x-auto px-3 pb-1">
        {events.map((event) => (
          <button
            key={event.key}
            type="button"
            className="df-num flex shrink-0 items-center gap-1.5 border px-1.5 py-0.5 text-[10px]"
            style={{
              borderColor: KIND_COLOR[event.kind],
              color: 'var(--df-text-2)',
              background: 'transparent',
            }}
            title={`${event.label} — ${event.detail}`}
            data-df-timeline-event={event.kind}
            onClick={() => {
              /*
               * AN AIS EVENT SYNCHRONISES THE PLAYBACK AUTHORITY (DF-X9.4H sections 21-24).
               *
               * Selecting an AIS observation on the mission timeline does three things, in order:
               * selects the VESSEL, highlights that exact OBSERVATION, and SEEKS the shared
               * `TemporalController` to its timestamp. The mission timeline does not become a clock --
               * it remains discrete event navigation, and it drives the AIS playhead rather than
               * keeping one of its own.
               *
               * Without the seek, the panel would name an instant while the globe kept drawing the
               * previous one, which is exactly the stale-UI-after-a-seek defect DF-X9.4 section 11
               * forbids.
               */
              if (event.mmsi) {
                // AIS authority, beside -- not instead of -- the SAR target (DF-X9.6 §7).
                // The observation timestamp travels with the pick: it is the exact
                // fix under examination, not a derived value.
                store.selectAis({ mmsi: event.mmsi, observationAt: event.at });
                store.set({ highlightedObservation: { mmsi: event.mmsi, at: event.at } });
                /*
                 * `seek` takes epoch MILLISECONDS. The conversion is guarded rather than passed
                 * through, because `Date.parse` of an unparseable string is `NaN` and a `NaN` into
                 * `clampTo` is a playhead at a position nothing was ever observed at.
                 */
                const atMs = Date.parse(event.at);
                if (Number.isFinite(atMs)) temporal.seek(atMs);
                return;
              }
              if (event.targetId)
      // The timeline event carries no scan of its own; the currently loaded scan is
      // the one whose event this is, so the store is the authority here.
      store.select({ kind: 'target', targetId: event.targetId, scanId: store.getState().scanId });
              const target = state.targets.find((t) => t.id === event.targetId);
              if (target) engine.flyTo(target.lat, target.lon);
            }}
          >
            <span aria-hidden="true" className="h-1.5 w-1.5" style={{ background: KIND_COLOR[event.kind] }} />
            {event.label}
            <span className="text-ink-dim">{fmtInstant(event.at).slice(11)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function deltaSeconds(a: string, b: string): number {
  const first = new Date(a).getTime();
  const second = new Date(b).getTime();
  if (Number.isNaN(first) || Number.isNaN(second)) return Number.NaN;
  return (first - second) / 1000;
}

export { NOT_ESTABLISHED };