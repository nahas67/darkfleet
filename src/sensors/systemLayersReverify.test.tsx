import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DatasetHealthResponse, ProviderHealthEntry } from '../api/contract';
import { resetStore, store } from '../state/store';
import { SystemPanel, worstProviderHealth } from '../command/SystemPanel';
import { deriveLayers, LayerConsole } from './LayerConsole';

const datasets: DatasetHealthResponse = {
  generated_at: '2026-10-11T00:00:00Z', usable_count: 1, verified_count: 1,
  datasets: [
    { id: 'natural_earth_coastline', label: 'Natural Earth coastline', install_status: 'READY', usable: true,
      provider: 'Natural Earth', dataset: 'ne_10m_coastline', version: '5', license: 'public domain', attribution: 'Natural Earth' },
    { id: 'marine_regions_eez_wfs', label: 'EEZ', install_status: 'NOT_INSTALLED', usable: false, optional: true,
      provider: 'Marine Regions', dataset: 'eez', version: '', license: 'CC BY', attribution: 'Marine Regions' },
    { id: 'marine_regions_high_seas_wfs', label: 'High Seas', install_status: 'NOT_INSTALLED', usable: false, optional: true,
      provider: 'Marine Regions', dataset: 'high_seas', version: '', license: 'CC BY', attribution: 'Marine Regions' },
  ],
};

function row(id: string) {
  return deriveLayers(store.getState(), store.getState().datasetHealth, store.getState().maritimeLayerRefusals)
    .find((entry) => entry.id === id);
}

describe('system and layer control contract', () => {
  it('reflects live usable and unavailable maritime datasets independently', () => {
    resetStore();
    store.set({ datasetHealth: datasets });
    expect(row('REFERENCE_COASTLINE')?.controlState).toBe('OFF');
    expect(row('EEZ_BOUNDARIES')?.controlState).toBe('UNAVAILABLE');
    expect(row('EEZ_BOUNDARIES')?.unavailableReason).toMatch(/not installed/i);
    expect(row('HIGH_SEAS')?.controlState).toBe('UNAVAILABLE');
  });

  it('reports the least healthy member and never upgrades an absent/invalid provider status', () => {
    const health = (provider: string, status: string) => ({ provider, status,
      detail: '', last_check: '2026-10-11T00:00:00Z' }) as ProviderHealthEntry;
    expect(worstProviderHealth([health('AIS', 'AVAILABLE'), health('SAR', 'UNAVAILABLE')])).toBe('UNAVAILABLE');
    expect(worstProviderHealth([health('AIS', 'AVAILABLE'), health('SAR', 'AUTH_REQUIRED')])).toBe('AUTH_REQUIRED');
    expect(worstProviderHealth([health('AIS', 'AVAILABLE'), health('SAR', 'UNRECOGNIZED')])).toBeNull();
    expect(worstProviderHealth([])).toBeNull();
    resetStore();
    store.set({ providers: [health('unknown', undefined as unknown as string)] });
    const system = renderToStaticMarkup(createElement(SystemPanel));
    const providerList = system.split('data-df-provider-list="true"')[1]?.split('</ul>')[0];
    expect(providerList).toContain('NOT ESTABLISHED');
    expect(providerList).not.toContain('NOT CONFIGURED');
  });
  it('a failed re-check cannot present cached maritime availability as current or enable its switch', () => {
    resetStore();
    store.set({ datasetHealth: datasets, datasetHealthError: 'connection refused' });
    expect(row('REFERENCE_COASTLINE')?.controlState).toBe('UNAVAILABLE');
    const system = renderToStaticMarkup(createElement(SystemPanel));
    expect(system).toContain('connection refused');
    expect(system).toContain('data-df-dataset-health="stale-error"');
  });

  it('an ongoing re-check is identified and does not enable unverified controls', () => {
    resetStore();
    store.set({ datasetHealth: datasets, datasetHealthLoading: true });
    expect(row('REFERENCE_COASTLINE')?.controlState).toBe('UNAVAILABLE');
    expect(renderToStaticMarkup(createElement(SystemPanel))).toContain('data-df-dataset-health="refreshing"');
  });

  it('the only available exposed controls affect real renderers and missing overlays explain themselves', () => {
    resetStore();
    store.set({ scanId: 'scan-1', scanStage: 'COMPLETE', rasterLoaded: true,
      targets: [], aisOnly: [], aisObservations: [], track: null, datasetHealth: datasets });
    expect(row('SAR_SCENE_FOOTPRINT')?.controlState).toBe('ON');
    expect(row('SAR_DETECTIONS')?.controlState).toBe('UNAVAILABLE');
    expect(row('UNCERTAINTY_RADII')?.controlState).toBe('UNAVAILABLE');
    expect(row('AIS_TRACKS')?.controlState).toBe('UNAVAILABLE');
    expect(row('CORRELATION_LINKS')?.controlState).toBe('UNAVAILABLE');
    const html = renderToStaticMarkup(createElement(LayerConsole));
    expect(html).not.toMatch(/type="range"/);
    expect(html).toContain('data-df-layer="CORRELATION_LINKS"');
  });
});
