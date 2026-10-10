import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScanWorkflow, parseBbox } from './ScanWorkflow';
import { store } from '../state/store';

afterEach(() => {
  store.set({ aoiText: '', scenes: [], scenesLoading: false, sceneError: null,
    scenesChecked: false, scanId: null, scanStage: 'QUEUED' });
});

describe('Operator-selected scan AOI', () => {
  it('matches the server WGS84 boundaries for both southwest and northeast corners', () => {
    expect(parseBbox('103.72, 1.10, 104.05, 1.40')).toEqual([103.72, 1.1, 104.05, 1.4]);
    expect(parseBbox('-180, -90, 180, 90')).toEqual([-180, -90, 180, 90]);
    for (const invalid of [
      '0, 0, 181, 10', '0, 0, 1, 91', '-181, 0, 1, 1',
      '0, -91, 1, 1', '1, 0, 1, 10', '0, 10, 1, 0',
      '0, 0, Infinity, 10', 'NaN, 0, 1, 1', '0, 0, 1',
    ]) expect(parseBbox(invalid), invalid).toBeNull();
  });

  it('disables the scan action for an AOI the backend would reject', () => {
    store.set({ aoiText: '0, 0, 200, 100', scanId: null });
    const invalid = renderToStaticMarkup(<ScanWorkflow />);
    expect(invalid).toMatch(/disabled=""[^>]*data-df-run-scan/);
    expect(invalid).toContain('longitude');

    store.set({ aoiText: '0, 0, 2, 2', scanId: null, scenesChecked: true, scenes: [{
      id: 'VALID', provider: 'planetary-computer', platform: 'sentinel-1a',
      product: 'RTC', polarization: 'VV', acquisition_time: '2026-10-01T00:00:00Z',
      bbox: [0, 0, 2, 2], runtime_mode: 'REAL', synthetic: false,
    }] });
    const valid = renderToStaticMarkup(<ScanWorkflow />);
    expect(valid).toMatch(/data-df-run-scan/);
    expect(valid).not.toMatch(/disabled=""[^>]*data-df-run-scan/);
  });

  it('retains scene discovery, footprint framing and source metadata in the reachable Tasking workflow', () => {
    store.set({
      aoiText: '100, 0, 101, 1',
      scenes: [{
        id: 'S1', provider: 'planetary-computer', platform: 'sentinel-1a',
        product: 'RTC', polarization: 'VH', acquisition_time: '2026-10-01T00:00:00Z',
        bbox: [100, 0, 101, 1], runtime_mode: 'REAL', synthetic: false,
      }],
    });
    const html = renderToStaticMarkup(<ScanWorkflow />);
    expect(html).toContain('data-df-scene-extent="S1"');
    expect(html).toContain('RTC');
    expect(html).toContain('VH');
    expect(html).toContain('sentinel-1a');
  });

  it('shows unavailable alert and disables the scan/selector after a provider failure', () => {
    store.set({
      aoiText: '100, 0, 101, 1', scenes: [], scenesLoading: false,
      scenesChecked: false,
      sceneError: 'Scene catalogue unavailable. Provider search failed; retry.',
    });
    const html = renderToStaticMarkup(<ScanWorkflow />);
    expect(html).toContain('data-df-scene-error');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/disabled=""[^>]*data-df-run-scan/);
    expect(html).toMatch(/id="df-scan-scene"[^>]*disabled=""/);
    expect(html).toContain('data-df-scene-retry');
    expect(html).not.toContain('No Sentinel-1 acquisition');
  });

  it('shows a verified empty-catalogue explanation, not an unavailable alert', () => {
    store.set({
      aoiText: '100, 0, 101, 1', scenes: [], scenesLoading: false,
      scenesChecked: true, sceneError: null,
    });
    const html = renderToStaticMarkup(<ScanWorkflow />);
    expect(html).toContain('data-df-scene-empty');
    expect(html).not.toContain('data-df-scene-error');
    expect(html).toMatch(/disabled=""[^>]*data-df-run-scan/);
  });
});
