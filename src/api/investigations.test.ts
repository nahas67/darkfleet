import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addInvestigationNote, createInvestigation, listInvestigations, removeInvestigationNote,
  renameInvestigation,
  restoreInvestigationScan, selectRestoredInvestigationTarget,
} from './investigations';
import { loadScanAis, loadScanResults, loadRaster, releaseStageStream } from './client';
import { store, type SarTarget } from '../state/store';
import type { InvestigationOut } from './contract';

vi.mock('./client', () => ({
  loadScanAis: vi.fn().mockResolvedValue(undefined),
  loadScanResults: vi.fn().mockResolvedValue(undefined),
  loadRaster: vi.fn().mockResolvedValue(null),
  releaseStageStream: vi.fn(),
}));

const caseRecord: InvestigationOut = {
  id: 'case-1',
  title: 'Satellite inquiry',
  scan_id: 'DF-001',
  aoi: [100, 1, 101, 2],
  created_at: '2026-10-10T00:00:00+00:00',
  annotations: [],
  watchlist: [],
};

function response(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('investigation API and saved scan restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.set({
      scanId: null,
      scanStage: 'QUEUED',
      targets: [],
      selection: { kind: 'none' },
      aoi: null,
      aoiText: '',
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('validates list and sends exact generated request keys', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ investigations: [caseRecord] }))
      .mockResolvedValueOnce(response(caseRecord))
      .mockResolvedValueOnce(response({
        id: 'note-1', investigation_id: 'case-1', content: 'checked radar return',
        target_id: 'DF-002', created_at: '2026-10-10T01:00:00+00:00',
      }))
      .mockResolvedValueOnce(response(null, 204));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listInvestigations()).toEqual([caseRecord]);
    await createInvestigation({ title: 'Satellite inquiry', scan_id: 'DF-001' });
    await addInvestigationNote('case-1', { content: 'checked radar return', target_id: 'DF-002' });
    await removeInvestigationNote('case-1', 'note-1');
    const calls = fetchMock.mock.calls;
    expect(calls[1][0]).toBe('/api/investigations');
    expect(JSON.parse(calls[1][1].body)).toEqual({
      title: 'Satellite inquiry', scan_id: 'DF-001',
    });
    expect(JSON.parse(calls[2][1].body)).toEqual({
      content: 'checked radar return', target_id: 'DF-002',
    });
    expect(calls[3][1].method).toBe('DELETE');
  });

  it('restores a persisted REAL scan, not an invented or unpersisted run', async () => {
    const found = {
      scan_id: 'DF-001', record_persisted: true,
      runtime_mode: 'REAL', synthetic: false,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(found)));
    await restoreInvestigationScan(caseRecord);
    expect(store.getState().scanId).toBe('DF-001');
    expect(store.getState().aoi).toEqual([100, 1, 101, 2]);
    expect(releaseStageStream).toHaveBeenCalledTimes(1);
    expect(loadScanResults).toHaveBeenCalledWith('DF-001');
    expect(loadScanAis).toHaveBeenCalledWith('DF-001');
    expect(loadRaster).toHaveBeenCalledWith('DF-001', 'raw');

    store.set({ scanId: 'DF-previous' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...found, record_persisted: false,
    })));
    await expect(restoreInvestigationScan(caseRecord)).rejects.toThrow(/no persisted REAL scan/);
    expect(store.getState().scanId).toBe('DF-previous');
  });

  it('rejects malformed list responses instead of displaying zero investigations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ wrong_key: [] })));
    await expect(listInvestigations()).rejects.toThrow(/missing required key/);
  });

  it('renames a durable case using PUT without modifying scan linkage or source evidence', async () => {
    const renamed = { ...caseRecord, title: 'Revised analyst case' };
    const mock = vi.fn().mockResolvedValue(response(renamed));
    vi.stubGlobal('fetch', mock);
    expect(await renameInvestigation(caseRecord.id, renamed.title)).toEqual(renamed);
    expect(mock.mock.calls[0][0]).toBe('/api/investigations/case-1');
    expect(mock.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({ title: renamed.title });
  });

  it('rejects watchlist targets absent from an actual restored scan rather than fabricating selection', () => {
    store.set({ scanId: 'DF-001', targets: [], selection: { kind: 'none' } });
    expect(() => selectRestoredInvestigationTarget('DF-001', 'MISSING'))
      .toThrow(/missing from the restored scan/);
    expect(store.getState().selection.kind).toBe('none');
    store.set({ targets: [{ id: 'REAL-TARGET' } as SarTarget] });
    selectRestoredInvestigationTarget('DF-001', 'REAL-TARGET');
    expect(store.getState().selection).toEqual({ kind: 'target', scanId: 'DF-001', targetId: 'REAL-TARGET' });
  });
});
