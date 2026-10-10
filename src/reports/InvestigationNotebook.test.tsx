import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportsWorkspace } from './ReportsWorkspace';
import { store } from '../state/store';

describe('Reports investigation entry point', () => {
  it('exposes durable investigations alongside the original export capabilities', () => {
    store.set({ scanId: 'DF-001' });
    const markup = renderToStaticMarkup(<ReportsWorkspace />);
    store.set({ scanId: null });
    expect(markup).toContain('data-df-workspace="REPORTS"');
    expect(markup).toContain('Analytical JSON');
    expect(markup).toContain('PNG evidence');
    expect(markup).toContain('data-df-investigations');
    expect(markup).toContain('Investigation notebook');
    expect(markup).toContain('data-df-investigation-create');
    expect(markup).toContain('Saved investigations');
    expect(markup).not.toContain('Held in this session only');
  });
});

describe('DF-X16 discoverability and operator provenance', () => {
  it('renders accessible WGS84 geometry controls on the persisted case workspace', async () => {
    const { InvestigationGeometryPanel } = await import('./InvestigationGeometryPanel');
    const markup = renderToStaticMarkup(
      <InvestigationGeometryPanel caseId="case-1" scanId="REAL-001" />,
    );
    expect(markup).toContain('data-df-geo-panel');
    expect(markup).toContain('data-df-geo-kind');
    expect(markup).toContain('data-df-geo-vertices');
    expect(markup).toContain('data-df-geo-save');
    expect(markup).toContain('WGS84 vertices');
    expect(markup).toContain('NOT SAR/AIS sensor evidence');
    expect(markup).toContain('Case linked to persisted scan REAL-001');
    expect(markup).toContain('Range ring / radius');
    expect(markup).not.toContain('screen-pixel distances');
  });
});
