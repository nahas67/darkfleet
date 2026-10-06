/**
 * THE SINGLE PLAYBACK AUTHORITY.
 *
 * ================================ WHY THIS EXISTS ================================
 *
 * Before DF-X9.4 the product had SEVEN distinct notions of "now" and no owner for any of them:
 *
 *   1. `MissionTimeline` local `useState` scrub -- an INDEX into a discrete event list. Not a clock,
 *      and not readable by anything else.
 *   2. `Cesium.Clock` -- entirely untouched. Verified by trace: zero references to `viewer.clock`,
 *      `ClockStep`, `ClockRange` or `shouldAnimate` anywhere in `src/`.
 *   3. `TopStrip`'s 1 s `setInterval` for the UTC readout -- cosmetic, and never read by analysis.
 *   4. `store.aisReferenceTime` -- resolved from the scan's acquisition time (DF-X9.3).
 *   5. `state.scene.acquisition_time` -- the backend's own measurement instant.
 *   6. AIS observation timestamps -- read from the Parquet archive.
 *   7. The backend's SAR-time correlation prediction -- computed once and persisted on the record.
 *
 * Adding a playback clock alongside those would have produced a seventh drifting source. So this
 * module is the one place that OWNS playback time, and everything else reads it.
 *
 * ================================ THE CESIUM CLOCK DECISION ================================
 *
 * EXPLICITLY: this product takes option **B** -- `Cesium.Clock` is a RENDERING ADAPTER driven by
 * this controller, not the canonical clock. Chosen because:
 *
 *   * Nothing in the product renders as a function of Cesium time. There is no animated imagery, no
 *     3D Tiles time-series, no per-frame simulation. Cesium's clock exists to drive time-dependent
 *     scene state, and there is none.
 *   * Making it canonical would couple the temporal model -- which needs exact millisecond seeking,
 *     deterministic replay and gap semantics -- to a rendering object's interpolation and
 *     `ClockStep` behaviour, none of which is under analytical control.
 *   * A clock owned by the scene is a clock whose lifetime is the scene's. The temporal authority
 *     must outlive viewer teardown, or every remount would reset history playback.
 *
 * If Cesium time is ever needed, it is SET from `currentMs` here. It never advances on its own.
 *
 * ================================ WHY NOT `Date.now()` ================================
 *
 * Two distinct uses of time are separated, because conflating them produces either a frozen clock
 * or a fabricated one:
 *
 *   * PACING -- how fast playback advances. This genuinely must track real elapsed time, or a
 *     "10x" speed would not mean anything. It uses a MONOTONIC source (`performance.now()` by
 *     default), never the wall clock, so a system clock change mid-session cannot make playback jump
 *     or stall.
 *
 *   * TEMPORAL TRUTH -- where in the recorded evidence "now" is. This NEVER reads a clock at all. It
 *     is only ever set by `seek`, by `play` advancing from an explicit base, or from a range derived
 *     from real observations. A historical reference time computed from the wall clock would age
 *     every archived vessel into STALE the moment playback paused, which is the defect DF-X9.3
 *     section 11 exists to prevent.
 */

import { useSyncExternalStore } from 'react';

/* ============================================================================================== *
 * RANGE
 * ============================================================================================== */

/** The instants a contact was actually observed, derived from its own records. */
export type TemporalRange = {
  /** Epoch ms of the FIRST observation. */
  startMs: number;
  /** Epoch ms of the LAST observation. */
  endMs: number;
  /**
   * How this range was established.
   *
   * `NONE` is a real value, not an error: a contact with no usable observation has no range, and
   * playback must not invent one. It is distinguished from `OBSERVATIONS` so the UI can say "nothing
   * to play" rather than showing a zero-width slider that silently refuses to move.
   */
  source: 'OBSERVATIONS' | 'NONE';
};

/** An unplayable range, for a contact with no usable observations. */
export const NO_RANGE: TemporalRange = { startMs: 0, endMs: 0, source: 'NONE' };

/**
 * A range from a set of observation timestamps.
 *
 * UNSORTED INPUT IS SORTED, and a single timestamp yields a ZERO-WIDTH range rather than `NONE`:
 * one observation is a real instant the operator can seek to, and calling it "no range" would hide
 * evidence rather than describe a limit.
 */
export function rangeFromTimestamps(timestamps: readonly string[]): TemporalRange {
  const valid = timestamps
    .map((t) => Date.parse(t))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  if (valid.length === 0) return NO_RANGE;
  return { startMs: valid[0], endMs: valid[valid.length - 1], source: 'OBSERVATIONS' };
}

/** Clamp an instant into a range, tolerating either argument being unordered. */
function clampTo(range: TemporalRange, ms: number): number {
  const lo = Math.min(range.startMs, range.endMs);
  const hi = Math.max(range.startMs, range.endMs);
  if (!Number.isFinite(ms)) return lo;
  return Math.min(hi, Math.max(lo, ms));
}

/* ============================================================================================== *
 * SPEED
 * ============================================================================================== */

/**
 * Playback rates.
 *
 * CHOSEN, NOT ARBITRARY. `1x` is real time, so an operator watching a 16-minute fixture track sees
 * what a vessel would have looked like. `0.25x` and `0.5x` are for reading manoeuvres, which at real
 * speed pass in under two seconds. `2x`/`5x` are for covering a long archive.
 *
 * `10x` is deliberately the CEILING. It is included because the brief allows it and because a
 * long archive genuinely needs it -- but the fixture's 16-minute range at 10x is 96 seconds, and a
 * 24-hour archive at 10x is 144 minutes. Beyond this, scrubbing or seeking is the honest tool, and
 * the UI stops offering a "speed" that in practice produces motion the operator cannot read.
 */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 5, 10] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/* ============================================================================================== *
 * STATE
 * ============================================================================================== */

export type TemporalState = {
  /**
   * The instant under examination, epoch ms, or null when no range exists.
   *
   * Null rather than 0 or `Date.now()`: with no established range there is no defensible instant, and
   * substituting one would produce a confident "the vessel is 56 years old" style reading.
   */
  currentMs: number | null;
  range: TemporalRange;
  playing: boolean;
  speed: PlaybackSpeed;
  /**
   * Whether this is replaying recorded history or holding one instant.
   *
   * NEVER named "live". There is no live AIS source in this deployment: `/api/ais/coverage` reports
   * `NOT_CONFIGURED` and `/api/scans/{id}/events` carries only scan-stage lifecycle. Labelling
   * replayed observations "LIVE" would assert a tracking capability the product does not have.
   */
  mode: 'HISTORICAL_PLAYBACK' | 'FIXED_INSTANT';
  /**
   * Whether the last `play()` hit the end of the range.
   *
   * Recorded rather than inferred, because "play stopped" and "play was never started" are different
   * facts and a UI that cannot tell them either claims a bug or silently restarts.
   */
  endedAtRangeEnd: boolean;
};

export type TemporalListener = (state: TemporalState) => void;

/** Monotonic milliseconds. Pacing only -- NEVER temporal truth. */
export type MonotonicClock = () => number;

/* ============================================================================================== *
 * THE CONTROLLER
 * ============================================================================================== */

export class TemporalController {
  #state: TemporalState = {
    currentMs: null,
    range: NO_RANGE,
    playing: false,
    speed: 1,
    mode: 'FIXED_INSTANT',
    endedAtRangeEnd: false,
  };

  #listeners = new Set<TemporalListener>();

  /**
   * Pacing source. Injectable so tests can advance time deterministically.
   *
   * Defaults to `performance.now`, which is monotonic and immune to wall-clock adjustment. It is
   * NEVER `Date.now()`: a system clock change mid-playback would otherwise teleport the playhead.
   */
  #monotonic: MonotonicClock;

  /**
   * The SINGLE interval id, or null when not playing.
   *
   * ONE timer for the whole product. This is the check DF-X9.4 section 64 requires: playback must
   * not have one timer per component, because two timers advancing the same playhead produce a
   * clock that runs at double speed depending on which mounted last.
   */
  #timer: ReturnType<typeof setInterval> | null = null;
  /** Monotonic reading at the last tick, for the pacing delta. */
  #lastTickMs: number | null = null;
  #tickPeriodMs: number;

  constructor(options?: { monotonic?: MonotonicClock; tickPeriodMs?: number }) {
    this.#monotonic = options?.monotonic ?? (() => performance.now());
    /*
     * 100 ms, not 16.
     *
     * A 60 Hz tick would sample the playhead 60 times a second to move a vessel that takes four
     * minutes to cross its own track. It would also re-run label arbitration and re-project every
     * glyph 60 times a second for a 0.0002x-per-tick position change.
     *
     * At `1x` a 100 ms tick advances 100 ms, which is smooth for a glyph and 10x cheaper than a
     * frame-rate tick. At `10x` it advances 1 s per tick, which is coarse -- and that is deliberate,
     * because at 10x the operator is surveying, not tracking, and should scrub rather than read
     * intermediate positions as meaningful. Below roughly `0.25x` the tick is finer than the eye
     * resolves and smoothness is free.
     */
    this.#tickPeriodMs = options?.tickPeriodMs ?? 100;
  }

  get state(): TemporalState {
    return this.#state;
  }

  subscribe = (listener: TemporalListener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#state);
  }

  #patch(next: Partial<TemporalState>): void {
    this.#state = { ...this.#state, ...next };
    this.#emit();
  }

  /**
   * Establish the range, and place the playhead inside it.
   *
   * DETERMINISTIC SEMANTICS FOR A RANGE CHANGE (DF-X9.4 section 39), chosen so that switching
   * vessels can never leave a stale time showing:
   *
   *   * A playhead already inside the new range is KEPT, clamped. The operator is mid-analysis of
   *     absolute time and has earned the right to keep it.
   *   * A playhead outside the new range is CLAMPED to the nearest end. It is never carried over
   *     unchanged, which would show vessel B at vessel A's timestamp -- and never reset to the
   *     start unconditionally, which would silently discard an operator's seek.
   *   * Entering a `NONE` range stops playback and nulls the playhead, because with no evidence
   *     there is nothing to be at.
   *
   * Playback does not restart on a range change. Restarting would move the playhead under the
   * operator while they are dragging.
   */
  setRange(range: TemporalRange): void {
    const next: Partial<TemporalState> = { range };

    if (range.source === 'NONE') {
      this.#stopTimer();
      next.currentMs = null;
      next.playing = false;
      next.mode = 'FIXED_INSTANT';
      next.endedAtRangeEnd = false;
      this.#patch(next);
      return;
    }

    const current = this.#state.currentMs;
    next.currentMs = current === null ? range.endMs : clampTo(range, current);
    next.endedAtRangeEnd = next.currentMs === Math.max(range.startMs, range.endMs);
    this.#patch(next);
  }

  /**
   * Move the playhead. THE AUTHORITATIVE WRITE.
   *
   * Clamped, never extrapolating past the newest observation: reaching beyond `endMs` is the
   * interpolation bug DF-X9.3 found, and a `seek` is exactly where it would be reintroduced.
   */
  seek(ms: number): void {
    const { range } = this.#state;
    if (range.source === 'NONE') return;
    const target = clampTo(range, ms);
    this.#patch({
      currentMs: target,
      endedAtRangeEnd: target === Math.max(range.startMs, range.endMs),
      // Seeking is a deliberate act, so it leaves HISTORICAL_PLAYBACK mode. A paused playhead
      // being examined is one instant under examination, not a replay in progress.
      mode: this.#state.playing ? 'HISTORICAL_PLAYBACK' : 'FIXED_INSTANT',
    });
  }

  /**
   * Start playback from the current playhead.
   *
   * FROM THE END RESTARTS. If the operator is sitting on the last observation and presses play, the
   * only useful answer is to run again from the start. Doing nothing because "it is already at the
   * end" reads as a broken button.
   */
  play(): void {
    const { range, currentMs } = this.#state;
    if (range.source === 'NONE') return;
    const endMs = Math.max(range.startMs, range.endMs);
    const startMs = Math.min(range.startMs, range.endMs);

    let from = currentMs ?? endMs;
    if (from >= endMs) from = startMs;
    // A ZERO-WIDTH range has nothing to advance through, so playing is meaningless.
    if (startMs === endMs) {
      this.#patch({ currentMs: endMs, mode: 'HISTORICAL_PLAYBACK' });
      return;
    }

    this.#patch({
      currentMs: from,
      playing: true,
      mode: 'HISTORICAL_PLAYBACK',
      endedAtRangeEnd: false,
    });
    this.#lastTickMs = this.#monotonic();
    this.#startTimer();
  }

  /**
   * Stop playback. The playhead STAYS where it is.
   *
   * Pausing is not seeking: the operator wants to keep looking at that instant. Resetting to the
   * start would discard the position they paused at, which is the one thing they asked to hold.
   */
  pause(): void {
    this.#stopTimer();
    this.#patch({ playing: false, mode: 'FIXED_INSTANT' });
  }

  toggle(): void {
    if (this.#state.playing) this.pause();
    else this.play();
  }

  /**
   * Set the rate, clamped into the supported set.
   *
   * An unsupported rate is REJECTED, not rounded to the nearest. Silently turning a request for
   * `64x` into `10x` would report a playback speed the operator never chose.
   */
  setSpeed(speed: PlaybackSpeed): void {
    if (!PLAYBACK_SPEEDS.includes(speed)) return;
    // Changing rate mid-play must not retroactively apply the new rate to time already elapsed, so
    // the pacing baseline is re-taken here.
    this.#lastTickMs = this.#monotonic();
    this.#patch({ speed });
  }

  /**
   * Advance the playhead by a monotonic delta. THE ONLY PLACE THE PLAYHEAD MOVES ON ITS OWN.
   *
   * Delta-based rather than `now - startedAt` so that a paused interval, a slow frame, or a rate
   * change cannot cause a jump. A `now - startedAt` formulation accumulates the whole wall-clock
   * duration including time spent paused, which would teleport the playhead forward on resume.
   */
  #tick(): void {
    const { playing, range, speed, currentMs } = this.#state;
    if (!playing || range.source === 'NONE' || currentMs === null) return;

    const now = this.#monotonic();
    const last = this.#lastTickMs ?? now;
    this.#lastTickMs = now;
    const elapsed = now - last;
    // A negative or absurd delta means the monotonic source misbehaved. Holding the playhead is the
    // honest response; advancing by a nonsense interval would move the vessel somewhere untrue.
    if (!Number.isFinite(elapsed) || elapsed < 0) return;

    const endMs = Math.max(range.startMs, range.endMs);
    const next = currentMs + elapsed * speed;

    if (next >= endMs) {
      /*
       * END OF RANGE: STOP, DO NOT EXTRAPOLATE, DO NOT LOOP.
       *
       * Looping is not implemented (DF-X9.4 section 55). A loop would require the operator to have
       * asked for one, and silently repeating an archive reads as a live feed -- the exact confusion
       * section 8 forbids.
       *
       * The playhead lands EXACTLY on the final observation, not past it. Landing past it would make
       * the vessel's displayed position derive from a time with no measurement behind it.
       */
      this.#stopTimer();
      this.#patch({
        currentMs: endMs,
        playing: false,
        mode: 'FIXED_INSTANT',
        endedAtRangeEnd: true,
      });
      return;
    }

    this.#patch({ currentMs: next });
  }

  #startTimer(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.#tick(), this.#tickPeriodMs);
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#lastTickMs = null;
  }

  /**
   * How many playback timers exist. Exposed for DF-X9.4 section 64.
   *
   * The assertion is `=== 1` while playing and `=== 0` while paused, which is the whole point: a
   * per-component timer would make this number equal the number of mounted components.
   */
  get timerCount(): number {
    return this.#timer === null ? 0 : 1;
  }

  /** Subscriber count, so a leak is observable rather than inferred. */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Stop and release. Required on unmount, and the only way to guarantee zero timers. */
  dispose(): void {
    this.#stopTimer();
    this.#listeners.clear();
  }

  /**
   * Run one tick against the injected monotonic clock. For tests.
   *
   * Takes NO elapsed parameter, deliberately. An earlier version accepted one and internally
   * swapped the clock out, ticked, then restored it and cleared the pacing baseline -- so every
   * simulated tick saw a ZERO delta and the playhead never moved. Three tests failed on that and the
   * product was innocent in all three.
   *
   * The test owns the clock: it advances its own variable, then calls this. Nothing here invents
   * elapsed time, so what the test asserts is exactly what a real interval would do.
   *
   * Does nothing unless playing.
   */
  tickForTesting(): void {
    this.#tick();
  }
}

/**
 * The product's single instance.
 *
 * A module singleton rather than a React context: the globe engine, the timeline and the dossier all
 * read it, and three separate instances would be three clocks -- which is the entire problem this
 * module exists to solve.
 */
export const temporal = new TemporalController();

/* ============================================================================================== *
 * REACT BINDING
 * ============================================================================================== */

/**
 * Subscribe a component to the controller.
 *
 * Uses `useSyncExternalStore` so a playhead change cannot render against a stale snapshot -- the
 * requirement DF-X9.4 section 11 makes about seek, applied to React's own tearing.
 */
export function useTemporal(): TemporalState {
  return useSyncExternalStore(temporal.subscribe, () => temporal.state, () => temporal.state);
}

/** The controller's current instant as an ISO string, or null when unplayable. */
export function temporalNowIso(state: TemporalState): string | null {
  return state.currentMs === null ? null : new Date(state.currentMs).toISOString();
}
