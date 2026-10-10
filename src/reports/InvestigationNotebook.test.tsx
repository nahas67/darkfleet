import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportsWorkspace, isExportableScan } from './ReportsWorkspace';
import type { ScanStateResponse } from '../api/contract';
import { store } from '../state/store';
import { InvestigationNotebook } from './InvestigationNotebook';

describe('Reports investigation entry point', () => {
  it('exposes durable investigations alongside the original export capabilities', () => {
    store.set({ scanId: 'DF-001' });
    const markup = renderToStaticMarkup(<ReportsWorkspace />);
    store.set({ scanId: null });
    expect(markup).toContain('data-df-workspace="REPORTS"');
    expect(markup).toContain('Download links are disabled until the source is verified');
    expect(markup).not.toContain('data-df-export="pdf"');
    expect(markup).toContain('data-df-investigations');
    expect(markup).toContain('Investigation notebook');
    expect(markup).toContain('data-df-investigation-create');
    expect(markup).toContain('Saved investigations');
    expect(markup).not.toContain('Held in this session only');
  });
});

describe('Reports export requires a persisted verified REAL source', () => {
  const candidate = {
    scan_id: 'DF-001', stage: 'COMPLETE', record_persisted: true,
    runtime_mode: 'REAL', synthetic: false,
  } as ScanStateResponse;

  it('rejects in-flight, missing, and unverified sources before rendering download URLs', () => {
    expect(isExportableScan(candidate)).toBe(true);
    expect(isExportableScan({ ...candidate, stage: 'SEARCHING_SCENE' })).toBe(false);
    expect(isExportableScan({ ...candidate, record_persisted: false })).toBe(false);
    expect(isExportableScan({ ...candidate, runtime_mode: 'DEMO' })).toBe(false);
    expect(isExportableScan({ ...candidate, synthetic: true })).toBe(false);
    store.set({ scanId: 'DF-001', scanStage: 'COMPLETE' });
    const markup = renderToStaticMarkup(<ReportsWorkspace />);
    expect(markup).toContain('data-df-report-export-unavailable');
    expect(markup).not.toContain('href="/api/scans/DF-001/export/pdf"');
    store.set({ scanId: null, scanStage: 'QUEUED' });
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
    expect(markup).toContain('data-df-geo-redo-point');
    expect(markup).toContain('WGS84 vertices');
    expect(markup).toContain('NOT SAR/AIS sensor evidence');
    expect(markup).toContain('Case references scan REAL-001');
    expect(markup).toContain('Range ring / radius');
    expect(markup).not.toContain('screen-pixel distances');
    expect(markup).toContain('Loading saved geometry');
    expect(markup).not.toContain('No operator geometry recorded');
    expect(markup).toMatch(/data-df-geo-save[^>]*disabled=""/);
  });

  it('does not claim the case library is empty before the first persisted list response', () => {
    const markup = renderToStaticMarkup(<InvestigationNotebook />);
    expect(markup).toContain('Investigation list unverified');
    expect(markup).toContain('Loading saved investigations');
    expect(markup).not.toContain('No saved investigations');
    expect(markup).toMatch(/data-df-investigation-create[^>]*disabled=""/);
  });
});
