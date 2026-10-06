/**
 * Tests for the SINGLE PLAYBACK AUTHORITY.
 *
 * ================================ WHY THESE ASSERT WHAT THEY DO ================================
 *
 * Playback is where a truthful product most easily becomes an untruthful one, because a clock that
 * runs fast, skips a gap, or extrapolates past the last record still *looks* like a clock. So these
 * tests are mostly about what must NOT happen: no wall clock, no timer leak, no escape from the
 * range, no teleport across a pause.
 *
 * The monotonic clock is INJECTED rather than mocked through timers, so pacing is asserted in
 * simulated milliseconds and is therefore exact and machine-independent. `vi.useFakeTimers` would
 * work for the interval but makes "how far did the playhead actually move" depend on the fake
 * timer's own semantics, which is one more thing that can be wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  NO_RANGE,
  PLAYBACK_SPEEDS,
  TemporalController,
  rangeFromTimestamps,
  temporalNowIso,
} from './TemporalController';

/* ------------------------------------------------------------------ helpers */

/**
 * A controller whose monotonic clock the test advances by hand.
 *
 * THE TEST OWNS THE CLOCK. `tick(elapsed)` advances the test's own variable and then runs ONE tick,
 * which is precisely what a real interval does. Nothing in the controller invents elapsed time.
 *
 * An earlier harness passed the elapsed value INTO the controller, which swapped the clock, ticked,
 * restored the clock and cleared the pacing baseline -- so every tick saw a zero delta and three
 * tests failed against correct code. The lesson generalises: a test double that reconstructs the
 * thing it is faking will eventually fake it wrongly.
 */
function makeController(initialMonotonicMs = 0) {
  let monotonic = initialMonotonicMs;
  const controller = new TemporalController({
    monotonic: () => monotonic,
    // A long real interval so no timer can fire during a test; the timer COUNT is what matters.
    tickPeriodMs: 1_000_000,
  });
  return {
    controller,
    /** Advance simulated time WITHOUT ticking. */
    advanceClock: (ms: number) => {
      monotonic += ms;
    },
    /** Advance simulated time by `elapsedMs` AND run one tick, as a real interval would. */
    tick: (elapsedMs: number) => {
      monotonic += elapsedMs;
      controller.tickForTesting();
    },
    dispose: () => controller.dispose(),
  };
}

const MIN = 60_000;
const T = (isoBase: string) => Date.parse(isoBase);
const RANGE_START = Date.parse('2026-05-12T08:00:00Z');
const RANGE_END = Date.parse('2026-05-12T08:16:00Z');

/* ============================================================================================== *
 * RANGE DERIVATION
 * ============================================================================================== */

describe('playback range is derived from real observations', () => {
  it('takes the first and last observation as the range', () => {
    const range = rangeFromTimestamps([
      '2026-05-12T08:16:00Z',
      '2026-05-12T08:00:00Z',
      '2026-05-12T08:08:00Z',
    ]);
    expect(range.source).toBe('OBSERVATIONS');
    expect(range.startMs).toBe(RANGE_START);
    expect(range.endMs).toBe(RANGE_END);
  });

  it('sorts UNSORTED input, because API order is not guaranteed', () => {
    // DF-X9.4 section 49. An archive read in arbitrary order must not produce a negative range.
    const range = rangeFromTimestamps(['2026-05-12T08:12:00Z', '2026-05-12T08:00:00Z']);
    expect(range.startMs).toBe(RANGE_START);
    expect(range.endMs).toBe(T('2026-05-12T08:12:00Z'));
    expect(range.startMs).toBeLessThan(range.endMs);
  });

  it('one observation is a ZERO-WIDTH range, not NO_RANGE', () => {
    // A single observation is a real instant an operator can seek to. Reporting "no range" would
    // hide evidence rather than describe a limit on it.
    const range = rangeFromTimestamps(['2026-05-12T08:00:00Z']);
    expect(range.source).toBe('OBSERVATIONS');
    expect(range.startMs).toBe(range.endMs);
  });

  it('no usable timestamps is NO_RANGE, and playback then declines', () => {
    expect(rangeFromTimestamps([])).toEqual(NO_RANGE);
    expect(rangeFromTimestamps(['not-a-date'])).toEqual(NO_RANGE);

    const { controller, dispose } = makeController();
    controller.setRange(NO_RANGE);
    expect(controller.state.currentMs).toBeNull();
    // Playback against no evidence does nothing, rather than inventing an instant to play.
    controller.play();
    expect(controller.state.playing).toBe(false);
    expect(controller.state.currentMs).toBeNull();
    dispose();
  });

  it('unparseable timestamps are DISCARDED, not coerced to the epoch', () => {
    // Coercion would put a real vessel at 1970-01-01 and read as 56 years stale.
    const range = rangeFromTimestamps(['garbage', '2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']);
    expect(range.startMs).toBe(RANGE_START);
    expect(range.endMs).toBe(RANGE_END);
  });
});

/* ============================================================================================== *
 * SEEK IS AUTHORITATIVE AND CLAMPED
 * ============================================================================================== */

describe('seek', () => {
  it('lands exactly on an observation instant', () => {
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    expect(controller.state.currentMs).toBe(RANGE_START);
    dispose();
  });

  it('lands exactly between two observations', () => {
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START + 8 * MIN);
    expect(controller.state.currentMs).toBe(RANGE_START + 8 * MIN);
    dispose();
  });

  it('CLAMPS past the newest observation rather than extrapolating', () => {
    /*
     * THE BOUNDARY THAT MATTERS MOST.
     *
     * A seek past the end is exactly where DF-X9.3's forward-extrapolation bug would be reintroduced
     * through a different door. The playhead must land ON the final observation, never beyond it.
     */
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_END + 3600_000);
    expect(controller.state.currentMs).toBe(RANGE_END);
    expect(controller.state.endedAtRangeEnd).toBe(true);
    dispose();
  });

  it('clamps before the first observation rather than back-extrapolating', () => {
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START - 3600_000);
    expect(controller.state.currentMs).toBe(RANGE_START);
    dispose();
  });

  it('a seek into the middle of the range does NOT stop playback', () => {
    // Scrubbing while playing is a legitimate thing to do, and must not be mistaken for a pause.
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.play();
    controller.seek(RANGE_START + 4 * MIN);
    expect(controller.state.playing).toBe(true);
    expect(controller.state.currentMs).toBe(RANGE_START + 4 * MIN);
    dispose();
  });

  it('a seek with no range is a NO-OP, not a silent write of some instant', () => {
    const { controller, dispose } = makeController();
    controller.seek(RANGE_START);
    expect(controller.state.currentMs).toBeNull();
    dispose();
  });
});

/* ============================================================================================== *
 * PLAY / PAUSE
 * ============================================================================================== */

describe('play and pause', () => {
  it('play advances the playhead by elapsed time at 1x', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    controller.play();
    expect(controller.state.currentMs).toBe(RANGE_START);

    tick(4_000);
    expect(controller.state.currentMs).toBe(RANGE_START + 4_000);
    dispose();
  });

  it('play scales by rate', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    controller.setSpeed(5);
    controller.play();
    tick(2_000);
    // 2 s of real time at 5x is 10 s of record time.
    expect(controller.state.currentMs).toBe(RANGE_START + 10_000);
    dispose();
  });

  it('play from the END RESTARTS from the beginning', () => {
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_END);
    controller.play();
    // The only useful answer. Doing nothing reads as a broken button.
    expect(controller.state.currentMs).toBe(RANGE_START);
    expect(controller.state.playing).toBe(true);
    dispose();
  });

  it('pause HOLDS the playhead', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    controller.play();
    tick(4_000);
    const held = controller.state.currentMs as number;

    controller.pause();
    expect(controller.state.playing).toBe(false);
    expect(controller.state.currentMs).toBe(held);

    // And it STAYS held: further elapsed time must not advance a paused playhead. This is
    // DF-X9.4 section 53 -- pausing freezes the temporal reference, so nothing ages behind it.
    tick(60_000);
    expect(controller.state.currentMs).toBe(held);
    dispose();
  });

  it('resuming does NOT teleport by the paused duration', () => {
    /*
     * THE CLASSIC PLAYBACK BUG, AND THE ONE THAT NEEDS DELTA-BASED PACING TO AVOID.
     *
     * A formulation like `playhead = startedAt + (now - startedAt) * speed` includes paused time in
     * its elapsed total, so a ten-second pause then resume jumps the playhead ten seconds forward.
     * That puts the vessel at a time it was never observed at.
     */
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    controller.play();
    tick(4_000);
    controller.pause();

    tick(600_000); // ten seconds of wall time while paused

    controller.play();
    expect(controller.state.currentMs).toBe(RANGE_START + 4_000);
    tick(1_000);
    // One more second of playback moves exactly one second. The pause contributed nothing.
    expect(controller.state.currentMs).toBe(RANGE_START + 5_000);
    dispose();
  });

  it('changing rate mid-play does not apply retroactively', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    controller.play();
    tick(4_000);
    const before = controller.state.currentMs as number;

    controller.setSpeed(10);
    expect(controller.state.currentMs).toBe(before);
    dispose();
  });
});

/* ============================================================================================== *
 * END OF RANGE
 * ============================================================================================== */

describe('end of range', () => {
  it('stops EXACTLY on the final observation and does not loop', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:10:00Z']));
    controller.seek(RANGE_START);
    controller.play();

    /*
     * 900 s across a 600 s range, so the tick genuinely OVERSHOOTS.
     *
     * An earlier version of this test ticked 60 s across the same 600 s range and then asserted the
     * playhead had reached the end. It had not, and correctly had not -- 60 s is not an overshoot.
     * Three tests failed for that one arithmetic error, which is worth recording because the
     * failures looked like three distinct product defects.
     */
    tick(900_000);

    expect(controller.state.currentMs).toBe(T('2026-05-12T08:10:00Z'));
    expect(controller.state.playing).toBe(false);
    expect(controller.state.endedAtRangeEnd).toBe(true);
    dispose();
  });

  it('a tick that lands exactly ON the end also stops', () => {
    // Boundary, not just overshoot: `<=` vs `<` at the exact end is where a loop would hide.
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:10:00Z']));
    controller.seek(RANGE_START);
    controller.play();
    tick(600_000);
    expect(controller.state.currentMs).toBe(T('2026-05-12T08:10:00Z'));
    expect(controller.state.playing).toBe(false);
    dispose();
  });

  it('does not continue advancing after stopping', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:10:00Z']));
    controller.seek(RANGE_START);
    controller.play();
    tick(900_000);
    const atEnd = controller.state.currentMs as number;
    expect(controller.state.playing).toBe(false);

    tick(600_000);
    expect(controller.state.currentMs).toBe(atEnd);
    dispose();
  });

  it('a zero-width range plays nothing rather than spinning', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z']));
    controller.play();
    expect(controller.state.currentMs).toBe(RANGE_START);
    tick(10_000);
    expect(controller.state.currentMs).toBe(RANGE_START);
    expect(controller.state.playing).toBe(false);
    dispose();
  });
});

/* ============================================================================================== *
 * RANGE CHANGES -- DETERMINISTIC SEMANTICS
 * ============================================================================================== */

describe('changing range', () => {
  it('KEEPS a playhead that is already inside the new range', () => {
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    const mid = RANGE_START + 8 * MIN;
    controller.seek(mid);
    // A different vessel with a range that also contains `mid`.
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T09:00:00Z']));
    expect(controller.state.currentMs).toBe(mid);
    dispose();
  });

  it('CLAMPS a playhead outside the new range, so no stale time leaks across', () => {
    /*
     * DF-X9.4 section 39. The important half.
     *
     * Without the clamp, selecting a vessel whose track is entirely earlier would leave the
     * playhead at the previous vessel's instant -- showing vessel B at a time when only A existed.
     */
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T09:00:00Z']));
    controller.seek(RANGE_START + 59 * MIN);
    expect(controller.state.currentMs).toBe(RANGE_START + 59 * MIN);

    // A vessel observed only in a five-minute window much earlier.
    controller.setRange(rangeFromTimestamps(['2026-05-12T06:00:00Z', '2026-05-12T06:05:00Z']));
    expect(controller.state.currentMs).toBe(T('2026-05-12T06:05:00Z'));
    dispose();
  });

  it('does NOT restart playback on a range change', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    controller.play();
    tick(2_000);
    const at = controller.state.currentMs as number;

    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:20:00Z']));
    // Restarting would move the playhead under an operator who is mid-drag.
    expect(controller.state.playing).toBe(true);
    expect(controller.state.currentMs).toBe(at);
    dispose();
  });

  it('entering NO_RANGE stops playback and clears the playhead', () => {
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.play();
    expect(controller.state.playing).toBe(true);

    controller.setRange(NO_RANGE);
    expect(controller.state.playing).toBe(false);
    expect(controller.state.currentMs).toBeNull();
    expect(controller.state.endedAtRangeEnd).toBe(false);
    dispose();
  });

  it('a fresh range with no prior playhead starts at the NEWEST observation', () => {
    // The most recent observation is the natural resting place: it is what the analysis is about.
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    expect(controller.state.currentMs).toBe(RANGE_END);
    dispose();
  });
});

/* ============================================================================================== *
 * SPEED
 * ============================================================================================== */

describe('speed', () => {
  it('offers exactly the documented set, bounded', () => {
    // The brief allows a measured set. 10x is the ceiling; the fixture's 16-minute range at 10x is
    // 96 seconds, and beyond this, scrubbing is the honest tool rather than an unreadable speed.
    expect([...PLAYBACK_SPEEDS]).toEqual([0.25, 0.5, 1, 2, 5, 10]);
    expect(Math.max(...PLAYBACK_SPEEDS)).toBe(10);
  });

  it('REJECTS an unsupported rate rather than rounding it', () => {
    // Silently turning a request for 64x into 10x would report a speed the operator never chose.
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.setSpeed(5);
    controller.setSpeed(64 as never);
    expect(controller.state.speed).toBe(5);
    dispose();
  });

  it('0.25x advances a quarter of elapsed time', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    controller.setSpeed(0.25);
    controller.play();
    tick(4_000);
    expect(controller.state.currentMs).toBe(RANGE_START + 1_000);
    dispose();
  });
});

/* ============================================================================================== *
 * TIMER OWNERSHIP -- DF-X9.4 SECTION 64
 * ============================================================================================== */

describe('timer ownership', () => {
  it('has NO timer while paused and exactly ONE while playing', () => {
    /*
     * THE CHECK DF-X9.4 SECTION 64 EXISTS FOR.
     *
     * A per-component timer makes this number equal the number of mounted components, and two timers
     * advancing one playhead produce a clock that runs at double speed depending on which mounted
     * last -- a bug that looks exactly like a data problem.
     */
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));

    expect(controller.timerCount).toBe(0);
    controller.play();
    expect(controller.timerCount).toBe(1);
    // Calling play twice must not create a second timer.
    controller.play();
    expect(controller.timerCount).toBe(1);
    controller.pause();
    expect(controller.timerCount).toBe(0);
    dispose();
  });

  it('releases the timer when playback ends at the range end', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:10:00Z']));
    controller.seek(RANGE_START);
    controller.play();
    expect(controller.timerCount).toBe(1);
    tick(900_000); // overshoots the 600 s range, so playback genuinely ends
    // A leaked interval would keep ticking a stopped clock forever.
    expect(controller.state.playing).toBe(false);
    expect(controller.timerCount).toBe(0);
    dispose();
  });

  it('repeated play/pause cycles do not accumulate timers', () => {
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    for (let i = 0; i < 50; i += 1) {
      controller.play();
      controller.pause();
    }
    expect(controller.timerCount).toBe(0);
    dispose();
  });

  it('releases every listener on dispose', () => {
    // A listener leak is invisible until the page has been open for an hour, at which point it
    // looks like a memory problem rather than a missing unsubscribe.
    const { controller, dispose } = makeController();
    for (let i = 0; i < 20; i += 1) controller.subscribe(() => {});
    expect(controller.listenerCount).toBe(20);
    dispose();
    expect(controller.listenerCount).toBe(0);
  });

  it('an unsubscribed listener stops receiving updates', () => {
    const { controller, dispose } = makeController();
    let calls = 0;
    const off = controller.subscribe(() => {
      calls += 1;
    });
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    const afterFirst = calls;
    off();
    controller.seek(RANGE_START + 4 * MIN);
    expect(calls).toBe(afterFirst);
    dispose();
  });
});

/* ============================================================================================== *
 * NO WALL CLOCK -- DF-X9.4 SECTION 12
 * ============================================================================================== */

describe('no wall-clock dependency', () => {
  it('the controller never reads the wall clock', () => {
    /*
     * A SOURCE-LEVEL ASSERTION, and deliberately so.
     *
     * Every behavioural test above INJECTS a monotonic clock, which means they would all still pass
     * if some path quietly called `Date.now()`. This is the backstop for that gap: the module must
     * contain no wall-clock read at all.
     *
     * ASSERTED AGAINST COMMENT-STRIPPED SOURCE. The module's own documentation explains at length
     * that it never calls `Date.now()`, so a raw match fails on the file explaining itself. The
     * first version of this test did exactly that and failed for the right reason.
     *
     * `Date.parse` is permitted and is wall-clock-free -- it reads a string, it does not consult the
     * clock -- so only the two forms that DO consult it are checked.
     *
     * IT WAS ALSO VACUOUS WHEN FIRST WRITTEN: it read `globalThis.__temporalSource`, which nothing
     * sets, so the assertion was skipped behind an `if`. A conditional assertion that never
     * evaluates reports coverage it does not have.
     */
    expect(TEMPORAL_CODE.length).toBeGreaterThan(500);
    expect(TEMPORAL_CODE).not.toMatch(/Date\.now\(\)/);
    expect(TEMPORAL_CODE).not.toMatch(/new Date\(\s*\)/);
  });

  it('the monotonic source defaults to performance.now, which is not the wall clock', () => {
    // Belt and braces on the default: an injected clock in tests must not have hidden a wall-clock
    // default in the constructor.
    expect(TEMPORAL_CODE).toMatch(/performance\.now\(\)/);
  });

  it('the injected clock is monotonic, so a wall-clock jump cannot teleport playback', () => {
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    controller.play();
    tick(3_000);
    expect(controller.state.currentMs).toBe(RANGE_START + 3_000);
    dispose();
  });

  it('a BACKWARDS monotonic reading holds the playhead rather than rewinding it', () => {
    /*
     * Defensive, and it matters. If the pacing source regresses, a naive delta would move the vessel
     * BACKWARDS in record time -- to a time it may or may not have been observed at. Holding is the
     * honest response to an impossible input.
     *
     * The controller is given a monotonic source the test controls directly, so the regression is
     * produced honestly rather than by reaching into private state. An earlier version of this test
     * used `Object.defineProperty` and a private-field cast to force a negative reading, which tested
     * the cast rather than the behaviour.
     */
    let reading = 0;
    const controller = new TemporalController({
      monotonic: () => reading,
      tickPeriodMs: 1_000_000,
    });
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    controller.play();

    reading = -5_000; // the monotonic source regressed
    controller.tickForTesting();

    expect(controller.state.currentMs).toBe(RANGE_START);
    expect(controller.state.playing).toBe(true);
    controller.dispose();
  });

  it('a paused playhead does not age, so nothing drifts while the operator reads', () => {
    /*
     * DF-X9.4 section 53, asserted over simulated minutes.
     *
     * A background timer that continued aging historical contacts while paused would make a paused
     * screen drift from STALE to LOST on its own, so the frozen instant the operator chose would
     * silently expire.
     *
     * `frozen` is captured AFTER the pause. An earlier version captured it before `play()`, then
     * advanced a second while playing and asserted against the pre-play value -- so it compared a
     * mid-playback position with a pre-playback one and failed for a reason that had nothing to do
     * with ageing.
     */
    const { controller, tick, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START + 4 * MIN);
    controller.play();
    tick(1_000);
    controller.pause();

    const frozen = controller.state.currentMs as number;
    expect(controller.state.playing).toBe(false);

    for (let i = 0; i < 20; i += 1) {
      tick(60_000); // twenty minutes of elapsed wall time while paused
      controller.tickForTesting();
    }

    expect(controller.state.currentMs).toBe(frozen);
    dispose();
  });
});

/* ============================================================================================== *
 * MODE LABELING -- DF-X9.4 SECTION 8
 * ============================================================================================== */

describe('mode is never labelled LIVE', () => {
  it('reports HISTORICAL_PLAYBACK while playing and FIXED_INSTANT while paused', () => {
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    expect(controller.state.mode).toBe('FIXED_INSTANT');
    controller.play();
    expect(controller.state.mode).toBe('HISTORICAL_PLAYBACK');
    controller.pause();
    expect(controller.state.mode).toBe('FIXED_INSTANT');
    dispose();
  });

  it('the mode union contains no LIVE member', () => {
    // There is no live AIS source: coverage reports NOT_CONFIGURED. A LIVE label would assert a
    // tracking capability the product does not have.
    expect(TEMPORAL_CODE).toMatch(/HISTORICAL_PLAYBACK/);
    expect(TEMPORAL_CODE).toMatch(/FIXED_INSTANT/);
    expect(TEMPORAL_CODE).not.toMatch(/mode:\s*'LIVE'/);
  });

  it('the module never uses LIVE as a string literal', () => {
    // Belt and braces on the union member: the claim is about what an operator can SEE, so it is
    // checked against the source that produces the labels.
    expect(TEMPORAL_CODE).not.toMatch(/'LIVE'|"LIVE"/);
  });
});

/**
 * The module's own source, read at test time, with comments REMOVED.
 *
 * Read with `?raw` rather than through a global. An earlier version of these assertions read
 * `globalThis.__temporalSource`, which nothing sets, so they were skipped behind an `if` and
 * reported coverage they did not have.
 *
 * Comments are stripped because the module's documentation names both `Date.now()` and `'LIVE'` in
 * order to explain why neither appears in the code. Matching the raw source therefore fails on the
 * file explaining itself -- which is the opposite of the intent, and is exactly what happened.
 */
const TEMPORAL_SOURCE = (await import('./TemporalController?raw')).default as string;
const TEMPORAL_CODE = TEMPORAL_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ============================================================================================== *
 * ISO CONVERSION
 * ============================================================================================== */

describe('temporalNowIso', () => {
  it('formats the playhead as an ISO instant', () => {
    const { controller, dispose } = makeController();
    controller.setRange(rangeFromTimestamps(['2026-05-12T08:00:00Z', '2026-05-12T08:16:00Z']));
    controller.seek(RANGE_START);
    expect(temporalNowIso(controller.state)).toBe('2026-05-12T08:00:00.000Z');
    dispose();
  });

  it('is null with no range, rather than formatting the epoch', () => {
    const { controller, dispose } = makeController();
    controller.setRange(NO_RANGE);
    // Formatting `new Date(0)` would read as 1970 and look like a real, very old observation.
    expect(temporalNowIso(controller.state)).toBeNull();
    dispose();
  });
});
