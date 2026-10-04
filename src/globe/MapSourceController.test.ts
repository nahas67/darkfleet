/**
 * The basemap fallback policy, proven.
 *
 * Every case DF-X8 §61 requires, with an injected clock and injected provider
 * factories: no network, no Cesium, no DOM. That is possible precisely because
 * `MapSourceController` takes construction as a dependency -- and it matters, because
 * a fallback policy that cannot be tested is a fallback policy nobody can claim works.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FAILURE_POLICY,
  MapSourceController,
  type MapSourceSpec,
} from './MapSourceController';

/** A clock the test drives by hand, so cooldown is exercised without waiting. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function source(id: string, over: Partial<MapSourceSpec> = {}): MapSourceSpec {
  return {
    id,
    label: id.toUpperCase(),
    attribution: `${id} attribution`,
    configured: true,
    create: () => ({ id }),
    ...over,
  };
}

/** A source that always throws when constructed. */
function broken(id: string): MapSourceSpec {
  return source(id, {
    create: () => {
      throw new Error(`${id} cannot construct`);
    },
  });
}

function controller(
  sources: MapSourceSpec[],
  clock: ReturnType<typeof fakeClock>,
  policy?: Partial<typeof DEFAULT_FAILURE_POLICY>,
) {
  return new MapSourceController({ sources, now: clock.now, policy });
}

describe('primary success', () => {
  it('activates the first usable source', () => {
    const clock = fakeClock();
    const ctl = controller([source('osm'), source('fallback')], clock);
    const status = ctl.start();
    expect(status.activeId).toBe('osm');
    expect(status.health).toBe('AVAILABLE');
    expect(status.isFallback).toBe(false);
    expect(status.notice).toBeNull();
  });

  it('exposes the provider handle for the viewer', () => {
    const ctl = controller([source('osm')], fakeClock());
    ctl.start();
    expect(ctl.activeHandle).toEqual({ id: 'osm' });
  });

  it('retains the active source attribution', () => {
    const ctl = controller([source('osm', { attribution: '(c) OpenStreetMap contributors' })], fakeClock());
    ctl.start();
    expect(ctl.attribution()).toBe('(c) OpenStreetMap contributors');
  });

  it('a single failure does not demote a working source', () => {
    // Tile-level failures are normal. Falling back on the first one would swap the
    // basemap every time one tile 404s.
    const clock = fakeClock();
    const ctl = controller([source('osm'), source('fallback')], clock);
    ctl.start();
    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold - 1; i += 1) {
      ctl.reportFailure();
      clock.advance(10);
    }
    expect(ctl.status().activeId).toBe('osm');
    expect(ctl.status().isFallback).toBe(false);
  });
});

describe('construction failure', () => {
  it('skips a provider that throws and takes the next one', () => {
    const ctl = controller([broken('primary'), source('fallback')], fakeClock());
    const status = ctl.start();
    expect(status.activeId).toBe('fallback');
    expect(status.isFallback).toBe(true);
  });

  it('names the failed source in the notice rather than showing a blank world', () => {
    // §12: fallback must not hide failure.
    const status = controller([broken('primary'), source('fallback')], fakeClock()).start();
    expect(status.notice).toContain('BASEMAP PRIMARY UNAVAILABLE');
    expect(status.notice).toContain('primary');
    expect(status.notice).toContain('FALLBACK');
  });

  it('says NOT CONFIGURED, not UNAVAILABLE, for a source with no credential', () => {
    // A provider with no token was never available to be unavailable. Calling it
    // unavailable raises a false alarm; calling the fallback a clean start hides the
    // substitution. It has to be its own sentence.
    const status = controller(
      [source('ion', { configured: false }), source('osm')],
      fakeClock(),
    ).start();
    expect(status.isFallback).toBe(true);
    expect(status.notice).toContain('NOT CONFIGURED');
    expect(status.notice).not.toContain('UNAVAILABLE');
    // Labels are uppercased by the test helper; the ACTIVE source is named so the
    // operator can see which imagery they are looking at.
    expect(status.notice).toContain('OSM');
  });

  it('skips an unconfigured source and still starts keyless', () => {
    // A commercial source with no credential must not block startup, and the keyless
    // source must be the one that ends up in use.
    const ctl = controller(
      [source('ion', { configured: false }), source('osm')],
      fakeClock(),
    );
    ctl.start();
    expect(ctl.status().activeId).toBe('osm');
    // The HANDLE is on the controller, not the status: the status is a report for the
    // UI and carries no provider object.
    expect(ctl.activeHandle).toEqual({ id: 'osm' });
  });
});

describe('repeated tile failure activates the fallback', () => {
  it('falls back only at the threshold', () => {
    const clock = fakeClock();
    const ctl = controller([source('osm'), source('fallback')], clock);
    ctl.start();

    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold; i += 1) {
      ctl.reportFailure();
      clock.advance(10);
    }
    expect(ctl.status().activeId).toBe('fallback');
    expect(ctl.status().isFallback).toBe(true);
    expect(ctl.status().health).toBe('DEGRADED');
  });

  it('reports DEGRADED, not AVAILABLE, while on a fallback', () => {
    const clock = fakeClock();
    const ctl = controller([source('osm'), source('fallback')], clock);
    ctl.start();
    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold; i += 1) ctl.reportFailure();
    // A working fallback is still a working source; claiming AVAILABLE would hide
    // that the preferred one is gone.
    expect(ctl.status().health).toBe('DEGRADED');
  });

  it('switches attribution with the source', () => {
    const clock = fakeClock();
    const ctl = controller(
      [source('osm', { attribution: 'OSM credit' }), source('alt', { attribution: 'ALT credit' })],
      clock,
    );
    ctl.start();
    expect(ctl.attribution()).toBe('OSM credit');
    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold; i += 1) ctl.reportFailure();
    expect(ctl.attribution()).toBe('ALT credit');
  });

  it('forgets failures that fall outside the window', () => {
    // A slow trickle of failures is not a failure.
    const clock = fakeClock();
    const ctl = controller([source('osm'), source('fallback')], clock);
    ctl.start();
    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold * 2; i += 1) {
      ctl.reportFailure();
      clock.advance(DEFAULT_FAILURE_POLICY.windowMs + 1_000);
    }
    expect(ctl.status().activeId).toBe('osm');
  });

  it('reports ALL_SOURCES_EXHAUSTED when nothing can be constructed', () => {
    const ctl = controller([broken('a'), broken('b')], fakeClock());
    const status = ctl.start();
    expect(status.activeId).toBeNull();
    expect(status.health).toBe('UNAVAILABLE');
    expect(status.reason).toBe('ALL_SOURCES_EXHAUSTED');
    expect(status.notice).toContain('No configured basemap source');
  });

  it('does not loop on the source that just failed', () => {
    const clock = fakeClock();
    const ctl = controller([source('osm'), broken('alt')], clock);
    ctl.start();
    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold; i += 1) ctl.reportFailure();
    // `alt` throws, and `osm` is on the attempted list, so nothing is active rather
    // than re-selecting the provider that just failed.
    expect(ctl.status().activeId).toBeNull();
  });
});

describe('primary recovery is stable, not thrashing', () => {
  it('does not retry before the cooldown elapses', () => {
    const clock = fakeClock();
    const ctl = controller([source('osm'), source('fallback')], clock);
    ctl.start();
    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold; i += 1) ctl.reportFailure();
    expect(ctl.status().activeId).toBe('fallback');

    clock.advance(DEFAULT_FAILURE_POLICY.cooldownMs - 1_000);
    ctl.maybeRecover();
    expect(ctl.status().activeId).toBe('fallback');
  });

  it('returns to the primary once the cooldown has passed', () => {
    const clock = fakeClock();
    const ctl = controller([source('osm'), source('fallback')], clock);
    ctl.start();
    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold; i += 1) ctl.reportFailure();

    clock.advance(DEFAULT_FAILURE_POLICY.cooldownMs + 1);
    const status = ctl.maybeRecover();
    expect(status.activeId).toBe('osm');
    expect(status.isFallback).toBe(false);
    expect(status.health).toBe('AVAILABLE');
  });

  it('restarts the cooldown when the primary is still broken', () => {
    // Otherwise a persistently broken primary is retried every tick, which is the
    // thrash the cooldown exists to prevent.
    const clock = fakeClock();
    let osmHealthy = true;
    const ctl = controller(
      [
        source('osm', {
          create: () => {
            if (!osmHealthy) throw new Error('still down');
            return { id: 'osm' };
          },
        }),
        source('fallback'),
      ],
      clock,
    );
    ctl.start();
    for (let i = 0; i < DEFAULT_FAILURE_POLICY.threshold; i += 1) ctl.reportFailure();
    expect(ctl.status().activeId).toBe('fallback');

    osmHealthy = false;
    clock.advance(DEFAULT_FAILURE_POLICY.cooldownMs + 1);
    ctl.maybeRecover();
    expect(ctl.status().activeId).toBe('fallback');

    clock.advance(DEFAULT_FAILURE_POLICY.cooldownMs + 1);
    ctl.maybeRecover();
    expect(ctl.status().activeId).toBe('fallback');
  });

  it('does not override a manual choice', () => {
    // An operator who chose a source should not have it swapped by a background probe.
    const clock = fakeClock();
    const ctl = controller([source('osm'), source('fallback')], clock);
    ctl.select('fallback');
    expect(ctl.status().activeId).toBe('fallback');
    expect(ctl.status().reason).toBe('MANUAL');

    clock.advance(DEFAULT_FAILURE_POLICY.cooldownMs * 5);
    ctl.maybeRecover();
    expect(ctl.status().activeId).toBe('fallback');
    expect(ctl.status().reason).toBe('MANUAL');
  });
});

describe('no provider configured', () => {
  it('reports unavailable rather than pretending to be fine', () => {
    const status = controller([], fakeClock()).start();
    expect(status.activeId).toBeNull();
    expect(status.health).toBe('UNAVAILABLE');
    expect(ctl0(status)).toBe(true);
  });

  it('has no attribution to give', () => {
    const ctl = controller([], fakeClock());
    ctl.start();
    expect(ctl.attribution()).toBeNull();
  });
});

function ctl0(status: { activeId: string | null }): boolean {
  return status.activeId === null;
}

describe('cleanup', () => {
  it('releases the handle and clears the failure run', () => {
    const clock = fakeClock();
    const ctl = controller([source('osm'), source('fallback')], clock);
    ctl.start();
    ctl.reportFailure();
    ctl.dispose();
    expect(ctl.activeHandle).toBeNull();
    expect(ctl.active).toBeNull();
    expect(ctl.status().attempted).toEqual([]);
  });

  it('can be restarted after disposal', () => {
    const ctl = controller([source('osm')], fakeClock());
    ctl.start();
    ctl.dispose();
    const status = ctl.start();
    expect(status.activeId).toBe('osm');
    // `attempted` lists sources that FAILED, not ones that worked, so a clean start
    // leaves it empty.
    expect(status.attempted).toEqual([]);
  });
});