import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
vi.mock('./errors', () => ({
  api: { get: (...args: unknown[]) => getMock(...args) },
  ApiError: class ApiError extends Error {},
  ContractViolation: class ContractViolation extends Error {},
}));

import { invalidateSceneCatalogue, loadScenes } from './client';
import { store, type BBox } from '../state/store';

const A: BBox = [100, 0, 101, 1];
const B: BBox = [110, 2, 111, 3];
const scene = (id: string) => ({
  id, provider: 'planetary-computer', platform: 'sentinel-1a',
  product: 'RTC', polarization: 'VV', acquisition_time: '2026-10-01T00:00:00Z',
  bbox: A, runtime_mode: 'REAL', synthetic: false,
});
const response = (id: string) => ({
  runtime_mode: 'REAL', synthetic: false, provider: 'planetary-computer',
  status: 'AVAILABLE', count: 1, scenes: [scene(id)],
});
const verifiedEmpty = () => ({
  runtime_mode: 'REAL', synthetic: false, provider: 'planetary-computer',
  status: 'UNAVAILABLE', note: 'no scene coverage for the requested area/time',
  count: 0, scenes: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  getMock.mockReset();
  store.set({
    scenes: [], scenesLoading: false, sceneError: null, scenesChecked: false,
    scanError: 'prior scan failure',
  });
  // End any request from an earlier test without clearing scan state.
  await loadScenes(null);
});

describe('shared Sentinel catalogue request ownership', () => {
  it('keeps latest AOI when an older request resolves last, even after abort', async () => {
    const old = deferred<ReturnType<typeof response>>();
    const latest = deferred<ReturnType<typeof response>>();
    getMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const first = loadScenes(A);
    const firstSignal = getMock.mock.calls[0][1] as AbortSignal;
    const second = loadScenes(B);
    expect(store.getState().scenesLoading).toBe(true);
    latest.resolve(response('B-SCENE'));
    await second;
    expect(store.getState().scenes.map((item) => item.id)).toEqual(['B-SCENE']);
    old.resolve(response('A-SCENE')); // Some network clients resolve despite abort.
    await first;
    expect(firstSignal.aborted).toBe(true);
    expect(store.getState().scenes.map((item) => item.id)).toEqual(['B-SCENE']);
    expect(store.getState().scenesLoading).toBe(false);
    expect(store.getState().scanError).toBe('prior scan failure');
  });

  it('does not let a prior failure clear a successful newer catalogue', async () => {
    const old = deferred<ReturnType<typeof response>>();
    getMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response('B-SCENE'));
    const first = loadScenes(A);
    await loadScenes(B);
    old.reject(new Error('older provider failed'));
    await first;
    expect(store.getState().scenes.map((item) => item.id)).toEqual(['B-SCENE']);
    expect(store.getState().scenesLoading).toBe(false);
    expect(store.getState().sceneError).toBeNull();
    expect(store.getState().scenesChecked).toBe(true);
  });

  it('invalidates outstanding results when the operator clears the AOI', async () => {
    const old = deferred<ReturnType<typeof response>>();
    getMock.mockReturnValueOnce(old.promise);
    const first = loadScenes(A);
    await loadScenes(null);
    old.resolve(response('STALE-SCENE'));
    await first;
    expect(store.getState().scenes).toEqual([]);
    expect(store.getState().scenesLoading).toBe(false);
  });

  it('invalidates immediately when an AOI is edited, before the next debounced fetch', async () => {
    const old = deferred<ReturnType<typeof response>>();
    getMock.mockReturnValueOnce(old.promise);
    const first = loadScenes(A);
    invalidateSceneCatalogue();
    expect(store.getState().scenesLoading).toBe(false);
    old.resolve(response('PREVIOUS-AOI'));
    await first;
    expect(store.getState().scenes).toEqual([]);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a verified zero-scene provider response from a provider failure', async () => {
    getMock.mockResolvedValueOnce(verifiedEmpty()).mockRejectedValueOnce(new Error('provider offline'));
    await loadScenes(A);
    expect(store.getState().scenes).toEqual([]);
    expect(store.getState().scenesChecked).toBe(true);
    expect(store.getState().sceneError).toBeNull();

    await loadScenes(A);
    expect(store.getState().scenes).toEqual([]);
    expect(store.getState().scenesChecked).toBe(false);
    expect(store.getState().sceneError).toMatch(/unavailable|failed/i);
    expect(store.getState().scanError).toBe('prior scan failure');
  });

  it('fails closed when a 200 response has missing or inconsistent catalogue data', async () => {
    for (const invalid of [
      { ...verifiedEmpty(), scenes: undefined },
      { ...response('ONE'), count: 2 },
      { ...response('ONE'), synthetic: true },
      { ...response('ONE'), scenes: [{ ...scene('ONE'), synthetic: true }] },
      { ...response('ONE'), scenes: [{ ...scene('ONE'), bbox: [101, 1, 100, 0] }] },
      { ...response('ONE'), status: 'NOT_CONFIGURED' },
      { ...verifiedEmpty(), note: 'provider request was unsuccessful' },
    ]) {
      getMock.mockResolvedValueOnce(invalid);
      await loadScenes(A);
      expect(store.getState().scenes, JSON.stringify(invalid)).toEqual([]);
      expect(store.getState().scenesChecked).toBe(false);
      expect(store.getState().sceneError).toMatch(/verification|unavailable|invalid/i);
    }
  });

  it('recovers after failure and ignores superseded failures without setting a stale alert', async () => {
    const old = deferred<ReturnType<typeof response>>();
    getMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response('LATEST'));
    const pending = loadScenes(A);
    await loadScenes(B);
    old.reject(new Error('old failure'));
    await pending;
    expect(store.getState().scenes.map((entry) => entry.id)).toEqual(['LATEST']);
    expect(store.getState().sceneError).toBeNull();
    expect(store.getState().scenesChecked).toBe(true);

    getMock.mockRejectedValueOnce(new Error('real failure')).mockResolvedValueOnce(response('RECOVERED'));
    await loadScenes(A);
    expect(store.getState().sceneError).not.toBeNull();
    await loadScenes(A);
    expect(store.getState().sceneError).toBeNull();
    expect(store.getState().scenesChecked).toBe(true);
    expect(store.getState().scenes.map((entry) => entry.id)).toEqual(['RECOVERED']);
  });
});
