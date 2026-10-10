import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MissionWorkspace } from './MissionWorkspace';
import { RAIL } from '../command/OperationRail';
import { store } from '../state/store';

describe('DF-X18 navigation and usable mission workspace', () => {
  it('makes the mission/alert workflow discoverable without replacing tasking', () => {
    expect(RAIL.some((entry) => entry.id === 'MISSIONS' && entry.label === 'Missions')).toBe(true);
    expect(RAIL.some((entry) => entry.id === 'TASKING')).toBe(true);
    store.set({ scanId: null, aoi: null, workspace: 'MISSIONS' });
    const html = renderToStaticMarkup(<MissionWorkspace />);
    expect(html).toContain('data-df-workspace="MISSIONS"');
    expect(html).toContain('data-df-mission-create');
    expect(html).toContain('data-df-mission-aoi');
    expect(html).toContain('data-df-mission-select');
    expect(html).toContain('data-df-mission-reload');
    expect(html).toContain('Historical persisted REAL scans only');
    expect(html).toContain('No automatic live monitoring');
  });
});
