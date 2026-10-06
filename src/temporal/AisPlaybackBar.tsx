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
import { fmtInstant, NOT_ESTABLISHED } from '../design/format';

/**
 * What the bar is showing. Supplied by the owner so the bar has no opinion about WHICH track.
 */
export type AisPlaybackBarProps = {
  /** Observations of the track in view, used for the count and the range label. */
  observationCount: number;
  /** `SINGLE_OBSERVATION` changes the copy: one fix is evidence, not a track. */
  trackStatus: 'NO_OBSERVATIONS' | 'SINGLE_OBSERVATION' | 'TRACK';
  /** Gaps in the current track, so the operator can see what playback will cross. */
  gapCount: number;
  /** Total gap seconds, or null when there are none. */
  gapSeconds: number | null;
  /** One-shot camera fit. Deliberately separate from playback. */
  onFrameTrack: () => void;
  /** Whether a track exists to frame. */
  canFrame: boolean;
};

export function AisPlaybackBar(props: AisPlaybackBarProps) {
  const temporalState = useTemporal();
  const { range, playing, speed, mode, endedAtRangeEnd } = temporalState;
  const nowIso = temporalNowIso(temporalState);

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
        {props.gapCount > 0 && (
          <span
            className="df-num text-[10px]"
            data-df-ais-gap-count
            title={
              props.gapSeconds === null
                ? 'One or more reporting gaps of undetermined length.'
                : `${Math.round(props.gapSeconds)} s of missing reporting across ${props.gapCount} gap(s).`
            }
          >
            {props.gapCount} GAP{props.gapCount === 1 ? '' : 'S'}
            {props.gapSeconds !== null && ` · ${Math.round(props.gapSeconds)}s`}
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
