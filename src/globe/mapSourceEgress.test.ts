import { describe, expect, it } from 'vitest';
import { buildMapSources } from './mapSources';
import { classifyMapEgress } from './mapSourceEgress';

const sources = buildMapSources(() => ({}));

describe('registered map-source egress policy', () => {
  it('attributes only OSM tile paths under the registered OSM URL, not the entire host', () => {
    expect(classifyMapEgress('https://tile.openstreetmap.org/3/5/7.png', sources)).toMatchObject({
      classification: 'DECLARED_PROVIDER', provider: 'OSM', purpose: 'BASEMAP',
      configured: true, statusSurface: 'SYSTEM',
    });
    expect(classifyMapEgress('https://tile.openstreetmap.org/other-api', sources).classification)
      .toBe('UNDECLARED_DEPENDENCY');
    expect(classifyMapEgress('https://tile.openstreetmap.org:8443/3/5/7.png', sources).classification)
      .toBe('UNDECLARED_DEPENDENCY');
  });

  it('attributes Esri imagery tile paths to the registered fallback, not the whole host', () => {
    expect(classifyMapEgress('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/2/3/4', sources))
      .toMatchObject({ classification: 'DECLARED_PROVIDER', provider: 'ESRI', purpose: 'BASEMAP' });
    expect(classifyMapEgress('https://server.arcgisonline.com/another-service', sources).classification)
      .toBe('UNDECLARED_DEPENDENCY');
  });

  it('does not declare Google Fonts, even though it is a plausible font CDN', () => {
    expect(classifyMapEgress('https://fonts.googleapis.com/css2?family=Inter', sources).classification)
      .toBe('UNDECLARED_DEPENDENCY');
    expect(classifyMapEgress('https://fonts.gstatic.com/s/font.woff2', sources).classification)
      .toBe('UNDECLARED_DEPENDENCY');
  });

  it('treats insecure provider transport as FORBIDDEN, never a declared tile request', () => {
    expect(classifyMapEgress('http://tile.openstreetmap.org/3/5/7.png', sources).classification)
      .toBe('FORBIDDEN');
  });

  it('will not declare an optional provider unless configured', () => {
    const actualProviderUrl = 'https://assets.cesium.com/us/rest/1.0/assets/2/imagery/2023_07_28';
    expect(classifyMapEgress(actualProviderUrl, sources))
      .toMatchObject({ classification: 'UNDECLARED_DEPENDENCY', configured: false });
    const configured = sources.map((source) => source.id === 'ION' ? { ...source, configured: true } : source);
    expect(classifyMapEgress(actualProviderUrl, configured))
      .toMatchObject({ classification: 'OPTIONAL_CONFIGURED_PROVIDER', provider: 'ION', purpose: 'BASEMAP' });
    // The old classifier guessed an SDK endpoint that the shipped product never constructs.
    expect(classifyMapEgress('https://api.cesium.com/v1/assets/1/endpoint', configured).classification)
      .toBe('UNDECLARED_DEPENDENCY');
  });

  it('reports provider failure only when the controller recorded it', () => {
    const status = {
      activeId: null, activeLabel: null, health: 'UNAVAILABLE' as const, isFallback: true,
      notice: 'No configured basemap source could be constructed.',
      reason: 'ALL_SOURCES_EXHAUSTED' as const, attempted: ['OSM', 'ESRI'],
    };
    expect(classifyMapEgress('https://tile.openstreetmap.org/3/5/7.png', sources, status))
      .toMatchObject({ failureState: 'UNAVAILABLE', statusSurface: 'SYSTEM' });
    expect(classifyMapEgress('https://tile.openstreetmap.org/3/5/7.png', sources))
      .toMatchObject({ failureState: 'NOT_MEASURED' });
  });

  it('unknown external requests are undeclared rather than silently trusted', () => {
    expect(classifyMapEgress('https://unlisted.example/tiles/1/2/3', sources).classification)
      .toBe('UNDECLARED_DEPENDENCY');
  });
});
