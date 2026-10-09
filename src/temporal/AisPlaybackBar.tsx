/**
 * AIS PLAYBACK CONTROLS.
 *
 * ================================ ONE CONTROLLER, CONSUMED ================================
 *
 * This component owns NO time. It reads `TemporalController` and writes to it. That is the whole
 * point of DF-X9.4 section 38: `isPlaying`, `playbackTime` and `speed` buried inside a dossier
 * component would be readable only by that component, so the globe would keep showing the old
 * instant while the panel showed a new one.
 *
 * It is deliberately NOT a second AIS timeline. It has a scrub bar because that is the minimum
 * required control set (DF-X9.4 section 10), and it consumes the same authority the mission timeline
 * reads.
 *
 * ================================ WHAT IT IS NOT ALLOWED TO SAY ================================
 *
 * There is no `LIVE` label anywhere. `/api/ais/coverage` reports `NOT_CONFIGURED` and
 * `/api/scans/{id}/events` carries only scan-stage lifecycle: this deployment has no live AIS source.
 * Labelling replayed observations as live would assert a tracking capability the product does not
 * have, which is the specific confusion DF-X9.4 section 8 forbids.
 */

import { useCallback, useMemo } from 'react';

import {
  PLAYBACK_SPEEDS,
  temporal,
  temporalNowIso,
  useTemporal,
  type PlaybackSpeed,
} from './TemporalController';
import { aisCamera } from '../globe/aisCamera';
import { fmtDegrees, fmtInstant, fmtKnots, fmtLatLon, fmtText, NOT_ESTABLISHED } from '../design/format';
import { describeAisFailure, type AisDiagnostics } from '../diagnostics/aisDiagnostics';
import {
  courseOverGround,
  displayStateOf,
  inTimeOrder,
  speedKnots,
  trueHeading,
  type ContactDisplayState,
} from '../ais/displayState';
import type { AisObservationOut } from '../api/contract';
import { useStore } from '../state/store';

/**
 * The RAW observation singled out by `selectedAis.observationAt`, verbatim.
 *
 * Archive numbers, unrounded and unsmoothed: what the source reported is what is shown. Any
 * null is a field the source did not report, and the bar renders the shared absence wording
 * for it -- never a zero, which would invent a measurement.
 */
export type SelectedAisObservationSummary = {
  at: string;
  lat: number | null;
  lon: number | null;
  positionStatus?: string;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  source: string | null;
};

/**
 * The selected contact as the bar describes it (§48-49).
 *
 * Identity and kinematics come from the contact's LATEST archive row; `observation` is present
 * only when `selectedAis.observationAt` names a real row, and is then that row -- never a
 * neighbour, never an interpolation. `displayState` is the `displayStateOf` vocabulary at the
 * reference instant, so the words here match the glyph on the globe.
 */
export type SelectedAisSummary = {
  mmsi: string;
  name: string | null;
  imo: string | null;
  callsign: string | null;
  displayState: ContactDisplayState;
  latestAt: string | null;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  source: string | null;
  observation: SelectedAisObservationSummary | null;
};

/**
 * Describe the selected AIS contact from the verbatim archive.
 *
 * Pure: selected authority + archive rows + reference instant in, typed summary out. The bar
 * renders it; nothing else computes it, so the readout cannot disagree with the globe's
 * selection the way two derivations of one fact could.
 */
export function buildSelectedAisSummary(
  selectedAis: { mmsi: string; observationAt: string | null } | null,
  observations: readonly AisObservationOut[],
  referenceTimeIso: string | null,
): SelectedAisSummary | null {
  if (selectedAis === null) return null;
  const rows = observations.filter((o) => o.mmsi === selectedAis.mmsi);
  if (rows.length === 0) {
    // Selected but nothing in the archive -- reachable after a reload clears the rows while a
    // selection persists. The MMSI still shows, every field NOT ESTABLISHED, rather than the
    // bar forgetting what was selected.
    return {
      mmsi: selectedAis.mmsi,
      name: null,
      imo: null,
      callsign: null,
      displayState: 'LOST',
      latestAt: null,
      sog: null,
      cog: null,
      heading: null,
      source: null,
      observation: null,
    };
  }
  // Latest by TIMESTAMP, not by array order: the archive's read order is not guaranteed.
  const ordered = inTimeOrder(rows);
  const latest = ordered[ordered.length - 1];
  const display = displayStateOf(rows, referenceTimeIso ?? latest.timestamp);
  const rawRow =
    selectedAis.observationAt === null
      ? null
      : (rows.find((o) => o.timestamp === selectedAis.observationAt) ?? null);
  return {
    mmsi: selectedAis.mmsi,
    name: latest.ship_name ?? null,
    imo: latest.imo ?? null,
    callsign: latest.callsign ?? null,
    displayState: display.state,
    latestAt: latest.timestamp,
    sog: speedKnots(latest),
    cog: courseOverGround(latest),
    heading: trueHeading(latest),
    source: latest.source ?? null,
    observation:
      rawRow === null
        ? null
        : {
            at: rawRow.timestamp,
            lat: rawRow.lat ?? null,
            lon: rawRow.lon ?? null,
            positionStatus: rawRow.position_status,
            sog: speedKnots(rawRow),
            cog: courseOverGround(rawRow),
            heading: trueHeading(rawRow),
            source: rawRow.source ?? null,
          },
  };
}

/**
 * What the bar is showing. Supplied by the owner so the bar has no opinion about WHICH track.
 */
export type AisPlaybackBarProps = {
  /** Observations of the track in view, used for the count and the range label. */
  observationCount: number;
  /** `SINGLE_OBSERVATION` changes the copy: one fix is evidence, not a track. */
  trackStatus: 'NO_OBSERVATIONS' | 'SINGLE_OBSERVATION' | 'TRACK';
  /**
   * The RENDERER'S OWN diagnostic record.
   *
   * Passed in rather than recomputed, and that is the point. The bar used to derive its own gap count
   * from the archive, so the number on screen and the geometry on the globe were two answers to one
   * question computed in two places -- and a disagreement between them would have been invisible.
   */
  diagnostics: AisDiagnostics;
  /** One-shot camera fit. Deliberately separate from playback. */
  onFrameTrack: () => void;
  /** Whether a track exists to frame. */
  canFrame: boolean;
};

export function AisPlaybackBar(props: AisPlaybackBarProps) {
  const temporalState = useTemporal();
  const { range, playing, speed, mode, endedAtRangeEnd } = temporalState;
  const { diagnostics } = props;
  const nowIso = temporalNowIso(temporalState);
  const failureText = describeAisFailure(diagnostics.failure);

  /*
   * THE SELECTED CONTACT, read from the store authorities.
   *
   * `selectedAis` names the contact, `aisObservations` is the verbatim archive, and the
   * reference instant is the same authority the globe reads (playhead when a range is
   * established, else the acquisition reference). Reading them here -- rather than threading
   * copies through props -- is what keeps this readout from disagreeing with the selection
   * the globe just made.
   */
  const state = useStore();
  const referenceTimeIso =
    (temporalState.range.source === 'OBSERVATIONS' ? temporalNowIso(temporalState) : null)
    ?? state.aisReferenceTime;
  const selected = useMemo(
    () => buildSelectedAisSummary(state.selectedAis, state.aisObservations, referenceTimeIso),
    [state.selectedAis, state.aisObservations, referenceTimeIso],
  );

  const hasRange = range.source === 'OBSERVATIONS' && range.endMs > range.startMs;

  /*
   * THE SCRUB VALUE IS A FRACTION OF THE RANGE, NOT AN INDEX.
   *
   * An index into a list of events -- what `MissionTimeline` uses for discrete instants -- cannot
   * represent "two minutes into a four-minute interval", which is most of what playback is. The
   * fraction is continuous, so every reachable instant is addressable.
   */
  const fraction = useMemo(() => {
    if (!hasRange || temporalState.currentMs === null) return 0;
    const span = range.endMs - range.startMs;
    if (span <= 0) return 0;
    return Math.min(1, Math.max(0, (temporalState.currentMs - range.startMs) / span));
  }, [hasRange, range.startMs, range.endMs, temporalState.currentMs]);

  const onScrub = useCallback((value: number) => {
    if (!hasRange) return;
    // SEEK IS AUTHORITATIVE: one call, and every consumer re-reads the same instant. There is no
    // local optimistic value here, because a scrubber that shows one time while the globe shows
    // another is the exact defect section 11 describes.
    temporal.seek(range.startMs + value * (range.endMs - range.startMs));
  }, [hasRange, range.startMs, range.endMs]);

  /*
   * FRAME CONTACT + FOLLOW, on this same surface.
   *
   * This bar is the ONE camera surface for AIS: it already owns FRAME TRACK, the gap/MMSI
   * readout and the selected-contact summary, so follow controls anywhere else would be a
   * second answer to one question. Both buttons drive the single camera owner
   * (`globe/aisCamera.ts`), which is the ONLY writer of `aisFollowMode` -- selecting a
   * contact never implies follow, and no other surface writes the mode.
   *
   * Availability is read off the RENDERER's drawn set (`drawnMmsis`), not the archive: a
   * selected contact with no glyph (NOT_YET_OBSERVED) has nothing to frame or follow, and
   * the buttons say so rather than flying nowhere.
   */
  const followMode = state.aisFollowMode;
  const followMmsi = state.selectedAis?.mmsi ?? null;
  const followDrawable = followMmsi !== null && diagnostics.drawnMmsis.includes(followMmsi);
  const followActive = followMode === 'FOLLOW';
  const followStatus = aisCamera.status;

  return (
    <div
      className="df-panel flex items-center gap-3 px-3 py-1.5"
      data-df-ais-playback={mode}
      data-df-ais-playing={playing ? 'true' : 'false'}
    >
      {/* ---- transport ---- */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="df-btn px-2 py-0.5 text-[11px]"
          disabled={!hasRange}
          aria-pressed={playing}
          aria-label={playing ? 'Pause AIS track playback' : 'Play AIS track playback'}
          data-df-ais-play
          onClick={() => temporal.toggle()}
        >
          {playing ? 'PAUSE' : 'PLAY'}
        </button>
        <button
          type="button"
          className="df-btn px-2 py-0.5 text-[11px]"
          disabled={!hasRange}
          aria-label="Return to the newest observation"
          data-df-ais-latest
          onClick={() => temporal.seek(range.endMs)}
        >
          LATEST
        </button>
        <button
          type="button"
          className="df-btn px-2 py-0.5 text-[11px]"
          disabled={!props.canFrame}
          aria-label="Frame the selected AIS track"
          data-df-ais-frame-track
          onClick={props.onFrameTrack}
        >
          FRAME TRACK
        </button>
        <button
          type="button"
          className="df-btn px-2 py-0.5 text-[11px]"
          disabled={!followDrawable}
          aria-label={followDrawable
            ? `Frame the selected AIS contact ${followMmsi}`
            : 'Frame the selected AIS contact (unavailable: no drawn position)'}
          title={followDrawable
            ? `Centre the camera on ${followMmsi} once`
            : 'Unavailable: the selected contact has no drawn position.'}
          data-df-ais-frame-contact
          onClick={() => aisCamera.frameContact()}
        >
          FRAME CONTACT
        </button>
        <button
          type="button"
          className="df-btn px-2 py-0.5 text-[11px]"
          disabled={!followActive && !followDrawable}
          aria-pressed={followActive}
          aria-label={followActive ? 'Stop following the selected AIS contact' : 'Follow the selected AIS contact'}
          title={followActive
            ? 'Following. Drag, rotate, zoom or tilt the globe to release.'
            : followDrawable
              ? `Follow ${followMmsi}: the camera rides with its displayed position`
              : 'Unavailable: the selected contact has no drawn position.'}
          data-df-ais-follow={followActive ? 'ON' : 'OFF'}
          onClick={() => aisCamera.setFollow(!followActive)}
        >
          FOLLOW {followActive ? 'ON' : 'OFF'}
        </button>
        {/*
         * THE FOLLOW STATE, AS THE CAMERA OWNER REPORTS IT.
         *
         * Read per render from the controller, which this bar already re-renders alongside:
         * every temporal tick and every store change re-reads it. TRACKING while riding the
         * display position, HOLD_GAP through a reporting gap, HOLD_FINAL past the last fix,
         * SUSPENDED before the first observation, CENTERED after a one-shot frame.
         */}
        <span
          className="df-num text-[10px] text-ink-dim"
          data-df-ais-follow-status={followStatus.label}
          data-df-ais-follow-status-mmsi={followStatus.mmsi ?? ''}
          title={followStatus.reason}
        >
          {followStatus.label}
        </span>
      </div>

      {/* ---- scrub ---- */}
      <input
        type="range"
        min={0}
        max={1000}
        step={1}
        value={Math.round(fraction * 1000)}
        disabled={!hasRange}
        aria-label="Seek the AIS track playback time"
        className="w-40 accent-[var(--df-cyan)]"
        data-df-ais-seek
        onChange={(event) => onScrub(Number(event.target.value) / 1000)}
      />

      {/* ---- the instant, and what kind of instant it is ---- */}
      <div className="min-w-0 shrink-0">
        <p className="df-num text-[11px] leading-tight" data-df-ais-now>
          {nowIso === null ? NOT_ESTABLISHED : fmtInstant(nowIso)}
        </p>
        <p className="df-num text-[10px] leading-tight text-ink-dim" data-df-ais-mode>
          {/*
           * THE MODE IS ALWAYS NAMED. `HISTORICAL_PLAYBACK` while playing, and `FIXED INSTANT` when
           * paused -- never `LIVE`, which would be a claim about a source that does not exist.
           */}
          {mode === 'HISTORICAL_PLAYBACK' ? 'HISTORICAL PLAYBACK' : 'FIXED INSTANT'}
          {endedAtRangeEnd ? ' · END OF RANGE' : ''}
        </p>
      </div>

      {/* ---- speed ---- */}
      <label className="flex shrink-0 items-center gap-1">
        <span className="df-label text-[10px]">Speed</span>
        <select
          className="df-num bg-transparent text-[11px]"
          value={speed}
          aria-label="Playback speed"
          data-df-ais-speed
          onChange={(event) => temporal.setSpeed(Number(event.target.value) as PlaybackSpeed)}
        >
          {PLAYBACK_SPEEDS.map((value) => (
            <option key={value} value={value}>
              {value}&times;
            </option>
          ))}
        </select>
      </label>

      {/* ---- what the track actually contains ---- */}
      {/*
        * THE SELECTED CONTACT (§48-49), AND THE RAW FIX WHEN ONE IS SINGLED OUT.
        *
        * This bar is the ONE surface for it: it already shows AIS state (diagnostics, FRAME
        * TRACK, gap/MMSI readout), and a second surface would be a second answer to one
        * question. Contact fields come from the latest archive row; the observation block is
        * the RAW row at `observationAt` -- archive numbers verbatim, never smoothed values
        * presented as raw. Missing renders the shared absence wording, never zero.
        */}
      {selected !== null && (
        <div
          className="min-w-0 shrink-0 border-l border-structural pl-3"
          data-df-ais-selected={selected.mmsi}
        >
          <p className="df-num text-[11px] leading-tight">
            <span data-df-ais-selected-mmsi>{selected.mmsi}</span>
            {' · '}
            <span data-df-ais-selected-name>{selected.name ?? NOT_ESTABLISHED}</span>
          </p>
          <p className="df-num text-[10px] leading-tight text-ink-dim">
            <span data-df-ais-selected-state>{selected.displayState}</span>
            {' · '}
            <span data-df-ais-selected-latest>
              {selected.latestAt === null ? NOT_ESTABLISHED : fmtInstant(selected.latestAt)}
            </span>
            {' · '}
            <span data-df-ais-selected-kinematics>
              {fmtKnots(selected.sog)} / {fmtDegrees(selected.cog)} / {fmtDegrees(selected.heading)}
            </span>
            {' · '}
            <span data-df-ais-selected-identity>
              IMO {selected.imo ?? NOT_ESTABLISHED} · {selected.callsign ?? NOT_ESTABLISHED}
            </span>
            {' · '}
            <span data-df-ais-selected-source>{fmtText(selected.source)}</span>
          </p>
          {selected.observation !== null && (
            <p
              className="df-num mt-0.5 text-[10px] leading-tight text-ink-2"
              data-df-ais-selected-observation={selected.observation.at}
              title="Raw observation as reported. Never smoothed or interpolated."
            >
              FIX {fmtInstant(selected.observation.at)}
              {' · '}
              {fmtLatLon(selected.observation.lat, selected.observation.lon, 4)}
              {' · '}
              {fmtKnots(selected.observation.sog)} / {fmtDegrees(selected.observation.cog)} /{' '}
              {fmtDegrees(selected.observation.heading)}
              {' · '}
              {fmtText(selected.observation.source)}
            </p>
          )}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {/*
         * THE OBSERVATION COUNT, ALWAYS VISIBLE.
         *
         * "1 OBSERVATION" rather than a scrubber implying a track. One recorded fix is real evidence
         * and its marker draws, but it is not a trajectory, and a control strip that implied
         * otherwise would be the DF-X7 semantics lost.
         */}
        <span className="df-num text-[10px] text-ink-dim" data-df-ais-observation-count>
          {props.observationCount} OBSERVATION{props.observationCount === 1 ? '' : 'S'}
        </span>
        {/*
         * GAPS, ATTRIBUTED TO A VESSEL.
         *
         * The attribution is the part that matters. An unattributed break tells an operator that
         * something is missing somewhere; "257009003 · 3120 s" tells them whether the break is the one
         * they seeked into. DF-X9.3E's escalated gap finding could not be settled by measurement
         * precisely because this attribution was unreachable from outside.
         */}
        {diagnostics.gaps.length > 0 && (
          <span
            className="df-num text-[10px]"
            data-df-ais-gap-count={diagnostics.gaps.length}
            data-df-ais-gap-mssis={diagnostics.gaps.map((g) => g.mmsi).join(',')}
            title={
              diagnostics.gaps
                .map((g) => (
                  g.spanSeconds === null
                    ? `${g.mmsi}: reporting gap of undetermined length`
                    : `${g.mmsi}: ${Math.round(g.spanSeconds)} s of unreported movement `
                      + `(DATA GAP — the vessel was not observed here)`
                ))
                .join('\n')
            }
          >
            {diagnostics.gaps.length} GAP{diagnostics.gaps.length === 1 ? '' : 'S'}
          </span>
        )}

        {/*
         * WHAT IS ACTUALLY DRAWN, as primitive counts.
         *
         * These are the renderer's own numbers, so a disagreement between the count here and the
         * geometry on screen is impossible rather than merely unlikely. Reported rather than asserted:
         * no budget has been set, so no threshold is implied.
         */}
        <span
          className="df-num text-[10px] text-ink-dim"
          data-df-ais-drawn-counts={JSON.stringify(diagnostics.counts)}
          /*
           * THE DRAWN CONTACT SET, EXPLICITLY.
           *
           * The glyph count is read from `drawnMmsis` rather than from `counts.contacts` even though
           * the two should agree, because the MMSI LIST is the thing that makes the DF-X9.4G defect
           * observable without a browser probe: a vessel that is `NOT_YET_OBSERVED` contributes no
           * glyph and therefore must not appear here.
           *
           * It also means the reachability gate has a real consumer to find. The first version of this
           * commit registered `drawnMmsis` as PRODUCT_REACHABLE without rendering it, and the gate
           * failed on its first run -- the same "exposed is not reachable" defect the gate exists to
           * catch, introduced while fixing the previous two instances of it.
           */
          data-df-ais-drawn-mmsis={diagnostics.drawnMmsis.join(',')}
          title={diagnostics.drawnMmsis.length === 0
            ? 'No vessel currently has a glyph.'
            : `Vessels with a glyph: ${diagnostics.drawnMmsis.join(', ')}`}
        >
          {diagnostics.drawnMmsis.length} CONTACT{diagnostics.drawnMmsis.length === 1 ? '' : 'S'}
          {' · '}
          {diagnostics.counts.observationMarkers} FIX
          {' · '}
          {diagnostics.counts.trackPrimitives} TRACK
          {' · '}
          {diagnostics.counts.labels} LABEL
        </span>

        {/*
         * THE RENDERER'S OWN FAILURE, VERBATIM.
         *
         * This is the surface that makes `aisRenderFailureReason` reachable for the first time. A
         * layer that silently draws nothing is indistinguishable from an archive with no vessels, and
         * that ambiguity is exactly what the DF-X9.3 audit flagged and this checkpoint closes.
         */}
        {failureText !== null && (
          <span className="df-num text-[10px]" data-df-ais-render-failure={diagnostics.failure}>
            {failureText}
          </span>
        )}
        {props.trackStatus === 'SINGLE_OBSERVATION' && (
          <span className="df-num text-[10px] text-ink-dim" data-df-ais-insufficient>
            INSUFFICIENT OBSERVATIONS FOR A TRACK
          </span>
        )}
      </div>
    </div>
  );
}
