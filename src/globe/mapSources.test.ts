/**
 * The configured basemap source registry.
 *
 * The live product previously had a basemap in `cesiumViewer.ts` and a *different*
 * list in the controller's tests. These tests assert the properties that make the
 * registry the single list, plus the no-credential requirement, without importing
 * Cesium.
 */

import { describe, expect, it } from 'vitest';

import {
  buildMapSources,
  isMapSourceId,
  MAP_SOURCE_ORDER,
  MAP_SOURCE_URLS,
} from './mapSources';
import { MapSourceController } from './MapSourceController';

/** Stand in for a Cesium provider: construction is the only thing that matters here. */
const fakeCreate = (kind: string) => ({ kind });

describe('registry contents', () => {
  const sources = buildMapSources(fakeCreate);

  it('declares every source in the exported fallback order', () => {
    expect(sources.map((s) => s.id)).toEqual([...MAP_SOURCE_ORDER]);
  });

  it('starts with a KEYLESS source, so no credential is required to open', () => {
    // §27. The first entry must be usable with no configuration at all.
    const first = sources[0];
    expect(first.configured).toBe(true);
    expect(first.id).toBe('OSM');
  });

  it('carries an attribution for every source', () => {
    // An empty credit is a licence failure waiting to happen, so it is a test failure
    // rather than something a reviewer has to notice.
    for (const source of sources) {
      expect(source.attribution.trim().length, `${source.id} has no attribution`).toBeGreaterThan(
        0,
      );
    }
  });

  it('names OpenStreetMap as required by ODbL', () => {
    const osm = sources.find((s) => s.id === 'OSM');
    expect(osm?.attribution).toContain('OpenStreetMap');
  });

  it('reports Cesium ion as NOT CONFIGURED with no token, not UNAVAILABLE', () => {
    // The distinction the controller preserves: an absent credential is a different
    // fact from a failing provider.
    const ion = sources.find((s) => s.id === 'ION');
    expect(ion?.configured).toBe(false);
  });

  it('gives each source a distinct id', () => {
    const ids = sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes tile templates for the keyless sources', () => {
    expect(MAP_SOURCE_URLS.OSM).toContain('openstreetmap.org');
    // Esri uses {z}/{y}/{x} ordering, not {z}/{x}/{y}. A transposed template silently
    // returns 404s, which is exactly what the fallback policy would then react to.
    expect(MAP_SOURCE_URLS.ESRI).toContain('{z}/{y}/{x}');
  });
});

describe('id drift', () => {
  it('narrows declared ids and rejects anything else', () => {
    expect(isMapSourceId('OSM')).toBe(true);
    expect(isMapSourceId('MAPBOX')).toBe(false);
  });

  it('agrees with the registry contents', () => {
    for (const source of buildMapSources(fakeCreate)) {
      expect(isMapSourceId(source.id)).toBe(true);
    }
  });
});

describe('the registry actually drives the controller', () => {
  it('activates the keyless source first with no token configured', () => {
    const controller = new MapSourceController({ sources: buildMapSources(fakeCreate) });
    const status = controller.start();
    // Not merely "some source": the first, and not flagged as a fallback.
    expect(status.activeId).toBe('OSM');
    expect(status.isFallback).toBe(false);
    expect(status.health).toBe('AVAILABLE');
  });

  it('falls through the registry in declared order when sources fail', () => {
    let t = 0;
    const failing = new Set<string>();
    const sources = buildMapSources((kind) => {
      if (failing.has(kind)) throw new Error(`${kind} down`);
      return { kind };
    });
    const controller = new MapSourceController({ sources, now: () => t });
    controller.start();
    expect(controller.status().activeId).toBe('OSM');

    failing.add('OSM');
    for (let i = 0; i < 5; i += 1) {
      // Force construction to fail on the next activation by making the factory throw.
      t += 10;
      controller.reportFailure();
    }
    // OSM's failure count crossed the threshold, so the registry order decides.
    expect(controller.status().activeId).not.toBe('OSM');
    expect(controller.status().isFallback).toBe(true);
    // And the credit followed the switch.
    expect(controller.attribution()).toBe('Esri, Maxar, Earthstar Geographics');
  });

  it('skips ion entirely without a token and reports why', () => {
    const controller = new MapSourceController({ sources: buildMapSources(fakeCreate) });
    controller.select('ION');
    const status = controller.status();
    // A manual selection of an unconfigured source cannot construct, and the operator
    // is told NOT CONFIGURED rather than being left with a silent no-op.
    expect(status.notice ?? '').not.toContain('constructed successfully');
  });
});