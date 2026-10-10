import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureSnapshot, createSavedView, deleteSavedView, listSavedViews, replaceSavedView } from './savedViews';
import { store } from '../state/store';

vi.mock('../globe/engine', () => ({
  engine: {
    getCameraPose: () => ({ position: { x: 7500000, y: 0, z: 0 }, heading: 0, pitch: -1, roll: 0 }),
    basemapStatus: () => ({ activeId: 'OSM' }),
    setLayerVisibility: vi.fn(),
    selectBasemapSource: vi.fn(),
  },
}));
vi.mock('../globe/aisCamera', () => ({ aisCamera: { setFollow: vi.fn() } }));
vi.mock('./client', () => ({
  loadScanAis: vi.fn(),
  loadScanResults: vi.fn(),
  loadRaster: vi.fn(),
  releaseStageStream: vi.fn(),
}));

function response(body: unknown, code = 200): Response {
  return new Response(code === 204 ? null : JSON.stringify(body), {
    status: code, headers: { 'Content-Type': 'application/json' },
  });
}

const fixture = {
  id: 'view-1',
  title: 'Maritime review',
  revision: 1,
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-10T00:01:00Z',
  snapshot: { schema_version: 1, workspace: 'TACTICAL', layers: {}, scan_id: null },
  status: 'OK',
  missing_resources: [],
} as const;

describe('Saved views wire API and strictly limited snapshot', () => {
  beforeEach(() => {
    store.set({
      scanId: null, selection: { kind: 'none' }, selectedAis: null,
      workspace: 'TACTICAL', aoi: null,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('captures only safe operator state without serialising archived evidence or provider credentials', () => {
    const snapshot = captureSnapshot();
    expect(snapshot.schema_version).toBe(1);
    expect(snapshot.camera?.position.x).toBe(7500000);
    expect(snapshot.map_source_id).toBe('OSM');
    expect(snapshot.scan_id).toBeNull();
    expect(snapshot.workspace).toBe('TACTICAL');
    expect(snapshot).not.toHaveProperty('providers');
    expect(snapshot).not.toHaveProperty('targetDetail');
    expect(snapshot).not.toHaveProperty('aisObservations');
    expect(snapshot).not.toHaveProperty('api_key');
  });

  it('lists, creates, updates with revision and deletes views through real endpoint signatures', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(response({ views: [fixture], count: 1 }))
      .mockResolvedValueOnce(response(fixture, 201))
      .mockResolvedValueOnce(response({ ...fixture, title: 'Renamed', revision: 2 }))
      .mockResolvedValueOnce(response(null, 204));
    vi.stubGlobal('fetch', mock);
    const found = await listSavedViews();
    expect(found).toHaveLength(1);
    const snapshot = captureSnapshot();
    await createSavedView({ title: 'Maritime review', snapshot });
    await replaceSavedView('view-1', { title: 'Renamed', expected_revision: 1, snapshot });
    await deleteSavedView('view-1');
    expect(mock.mock.calls.map((call) => call[0])).toEqual([
      '/api/views', '/api/views', '/api/views/view-1', '/api/views/view-1',
    ]);
    expect(mock.mock.calls[2][1].method).toBe('PUT');
    expect(JSON.parse(mock.mock.calls[2][1].body).expected_revision).toBe(1);
    expect(mock.mock.calls[3][1].method).toBe('DELETE');
  });

  it('rejects malformed list payloads and invalid persisted view status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ things: [] })));
    await expect(listSavedViews()).rejects.toThrow('missing required key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      views: [{ ...fixture, status: 'OK', snapshot: null }], count: 1,
    })));
    await expect(listSavedViews()).rejects.toThrow('requires its snapshot');
  });
});
