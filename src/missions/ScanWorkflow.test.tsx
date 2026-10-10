import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScanWorkflow, parseBbox } from './ScanWorkflow';
import { store } from '../state/store';

afterEach(() => {
  store.set({ aoiText: '', scenes: [], scenesLoading: false, scanId: null, scanStage: 'QUEUED' });
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

    store.set({ aoiText: '0, 0, 2, 2', scanId: null });
    const valid = renderToStaticMarkup(<ScanWorkflow />);
    expect(valid).toMatch(/data-df-run-scan/);
    expect(valid).not.toMatch(/disabled=""[^>]*data-df-run-scan/);
  });
});
