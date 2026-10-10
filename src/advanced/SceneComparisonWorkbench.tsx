/** Scientific-safe read-only real-scene comparison, independently mountable.
 *
 * This does not claim pixel co-registration for arbitrary scenes, does not
 * modify the existing visual-only Analytics ScanComparePane, and has no
 * dependency on the Cesium renderer.
 */
import { useEffect, useState } from 'react';
import { api, ContractViolation, explain } from '../api/errors';

export interface Candidate {
  scan_id: string;
  item_id: string | null;
  acquisition_time: string | null;
  product: string | null;
  polarization: string | null;
  available_normalized_raster: boolean;
  georeference_present: boolean;
}
export interface SceneIdentity {
  scan_id: string;
  item_id: string | null;
  acquisition_time: string | null;
  product: string | null;
  polarization: string | null;
  crs: string | null;
  window_transform: number[] | null;
  raster_shape: number[] | null;
  processing_version: string | null;
  source: 'PERSISTED_REAL_SCAN_CALIBRATED_CACHE';
}
export interface DifferenceMetrics {
  overlap_shape: number[];
  offset_b_in_a_pixels: number[];
  overlap_pixels: number;
  valid_pair_pixels: number;
  valid_pair_fraction: number;
  mean_b_minus_a_db: number;
  mean_absolute_difference_db: number;
  root_mean_square_difference_db: number;
  median_b_minus_a_db: number;
  p05_b_minus_a_db: number;
  p95_b_minus_a_db: number;
  brighter_b_pixels: number;
  darker_b_pixels: number;
  equal_pixels: number;
  metric: 'SAME_PIXEL_RTC_GAMMA0_DB_DIFFERENCE';
}
export interface SceneComparison {
  status: 'MEASURED' | 'NOT_COMPARABLE';
  reason: string;
  first: SceneIdentity;
  second: SceneIdentity;
  metrics: DifferenceMetrics | null;
  acquisition_interval_hours: number | null;
  caveat: string;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractViolation(field, `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}
function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ContractViolation(field, `${field} must be text.`);
  return value;
}
function optStr(value: unknown, field: string): string | null {
  return value === null ? null : str(value, field);
}
function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractViolation(field, `${field} must be finite.`);
  }
  return value;
}
function arr(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ContractViolation(field, `${field} must be an array.`);
  return value;
}
function shape(value: unknown, field: string, expectedLength: number): number[] {
  const items = arr(value, field);
  if (items.length !== expectedLength) {
    throw new ContractViolation(field, `${field} has the wrong number of elements.`);
  }
  return items.map((n) => num(n, field));
}
function identity(value: unknown): SceneIdentity {
  const v = object(value, 'SceneIdentity');
  str(v.scan_id, 'SceneIdentity.scan_id');
  if (v.source !== 'PERSISTED_REAL_SCAN_CALIBRATED_CACHE') {
    throw new ContractViolation('SceneIdentity.source', 'Real persisted source assertion missing.');
  }
  for (const field of [
    'item_id', 'acquisition_time', 'product', 'polarization', 'crs', 'processing_version',
  ]) optStr(v[field], `SceneIdentity.${field}`);
  if (v.window_transform !== null) shape(v.window_transform, 'SceneIdentity.window_transform', 6);
  if (v.raster_shape !== null) shape(v.raster_shape, 'SceneIdentity.raster_shape', 2);
  return v as unknown as SceneIdentity;
}
function metrics(value: unknown): DifferenceMetrics {
  const v = object(value, 'DifferenceMetrics');
  shape(v.overlap_shape, 'DifferenceMetrics.overlap_shape', 2);
  shape(v.offset_b_in_a_pixels, 'DifferenceMetrics.offset_b_in_a_pixels', 2);
  for (const key of [
    'overlap_pixels', 'valid_pair_pixels', 'valid_pair_fraction',
    'mean_b_minus_a_db', 'mean_absolute_difference_db',
    'root_mean_square_difference_db', 'median_b_minus_a_db',
    'p05_b_minus_a_db', 'p95_b_minus_a_db', 'brighter_b_pixels',
    'darker_b_pixels', 'equal_pixels',
  ]) num(v[key], `DifferenceMetrics.${key}`);
  if (v.metric !== 'SAME_PIXEL_RTC_GAMMA0_DB_DIFFERENCE') {
    throw new ContractViolation('DifferenceMetrics.metric', 'Unrecognized measurement authority.');
  }
  if (num(v.overlap_pixels, 'DifferenceMetrics.overlap_pixels') <= 0 ||
      num(v.valid_pair_pixels, 'DifferenceMetrics.valid_pair_pixels') <= 0 ||
      num(v.valid_pair_pixels, 'DifferenceMetrics.valid_pair_pixels') >
      num(v.overlap_pixels, 'DifferenceMetrics.overlap_pixels')) {
    throw new ContractViolation('DifferenceMetrics.valid_pair_pixels', 'Impossible overlap counts.');
  }
  return v as unknown as DifferenceMetrics;
}

export function readSceneCandidates(value: unknown): Candidate[] {
  const v = object(value, 'SceneCandidatesOut');
  const total = num(v.total_real_scans, 'SceneCandidatesOut.total_real_scans');
  if (!Number.isInteger(total) || total < 0) {
    throw new ContractViolation('SceneCandidatesOut.total_real_scans', 'Invalid count.');
  }
  str(v.note, 'SceneCandidatesOut.note');
  const entries = arr(v.scenes, 'SceneCandidatesOut.scenes');
  if (entries.length > 200 || entries.length > total) {
    throw new ContractViolation('SceneCandidatesOut.scenes', 'Invalid scene count.');
  }
  return entries.map((entry) => {
    const scene = object(entry, 'SceneCandidateOut');
    str(scene.scan_id, 'SceneCandidateOut.scan_id');
    for (const key of ['item_id', 'acquisition_time', 'product', 'polarization']) {
      optStr(scene[key], `SceneCandidateOut.${key}`);
    }
    for (const key of ['available_normalized_raster', 'georeference_present']) {
      if (typeof scene[key] !== 'boolean') {
        throw new ContractViolation(
          `SceneCandidateOut.${key}`, `SceneCandidateOut.${key}: expected a boolean.`,
        );
      }
    }
    return scene as unknown as Candidate;
  });
}

export function readSceneComparison(value: unknown): SceneComparison {
  const v = object(value, 'SceneComparisonOut');
  if (v.status !== 'MEASURED' && v.status !== 'NOT_COMPARABLE') {
    throw new ContractViolation('SceneComparisonOut.status', 'Unknown status.');
  }
  str(v.reason, 'SceneComparisonOut.reason');
  str(v.caveat, 'SceneComparisonOut.caveat');
  identity(v.first);
  identity(v.second);
  if (v.acquisition_interval_hours !== null) {
    num(v.acquisition_interval_hours, 'SceneComparisonOut.acquisition_interval_hours');
  }
  if (v.status === 'MEASURED') {
    if (v.metrics === null) {
      throw new ContractViolation('SceneComparisonOut.metrics', 'Cannot claim MEASURED without samples.');
    }
    metrics(v.metrics);
  } else if (v.metrics !== null) {
    throw new ContractViolation('SceneComparisonOut.metrics', 'Unsupported grids cannot have a measurement.');
  }
  return v as unknown as SceneComparison;
}

export async function listPersistedSceneCandidates(): Promise<Candidate[]> {
  return readSceneCandidates(await api.get<unknown>('/api/sar/compare/scans?limit=100'));
}
export async function comparePersistedScenes(first: string, second: string): Promise<SceneComparison> {
  if (!first || !second || first === second) {
    throw new Error('Select two different persisted REAL scan IDs.');
  }
  const raw = await api.post<unknown>('/api/sar/compare', {
    first_scan_id: first, second_scan_id: second,
  });
  const result = readSceneComparison(raw);
  if (result.first.scan_id !== first || result.second.scan_id !== second) {
    throw new ContractViolation('SceneComparisonOut.identity', 'Response belongs to different scans.');
  }
  return result;
}

const print = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

export function SceneComparisonWorkbench() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [result, setResult] = useState<SceneComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    void listPersistedSceneCandidates()
      .then((scenes) => {
        setCandidates(scenes);
        setFirst((old) => scenes.some((s) => s.scan_id === old) ? old : scenes[0]?.scan_id ?? '');
        setSecond((old) => scenes.some((s) => s.scan_id === old) ? old
          : scenes.find((s) => s.scan_id !== scenes[0]?.scan_id)?.scan_id ?? '');
        setResult(null);
      })
      .catch((reason: unknown) => setError(explain(reason)))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    let cancelled = false;
    void listPersistedSceneCandidates()
      .then((scenes) => {
        if (cancelled) return;
        setCandidates(scenes);
        setFirst(scenes[0]?.scan_id ?? '');
        setSecond(scenes[1]?.scan_id ?? '');
      })
      .catch((reason: unknown) => { if (!cancelled) setError(explain(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const run = () => {
    setBusy(true);
    setError(null);
    setResult(null);
    void comparePersistedScenes(first, second)
      .then(setResult)
      .catch((reason: unknown) => setError(explain(reason)))
      .finally(() => setBusy(false));
  };
  const selectedA = candidates.find((s) => s.scan_id === first);
  const selectedB = candidates.find((s) => s.scan_id === second);
  return (
    <section className="df-panel min-h-0 space-y-3 overflow-y-auto p-3"
      data-df-scene-comparison-workbench>
      <h2 className="df-label text-xs">SAR stored-scene comparison · DF-X10/X11</h2>
      <p className="text-[11px] text-ink-dim">
        Read-only historical REAL acquisitions. Numerical results require two
        separately acquired RTC gamma0 scenes, identical CRS, polarization,
        processing domain, and exactly matching georeferenced pixel lattice.
        No automatic warping, synthetic data or unverified co-registration.
      </p>
      <button className="df-btn" type="button" data-df-sar-refresh
        disabled={busy || loading} onClick={refresh}>Refresh persisted scenes</button>
      {loading ? <p role="status" className="df-note">Reading local scan catalogue…</p> : null}
      {!loading && candidates.length < 2 ? <p className="df-note" role="status">
        {candidates.length === 0 ? 'No persisted REAL scan records are available.' :
          'Only one persisted REAL scan is available; a second acquisition is required.'}
      </p> : null}
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-[11px]" htmlFor="df-sar-first">
          <span className="df-label">Earlier/first scan</span>
          <select id="df-sar-first" className="df-input w-full" data-df-sar-first
            disabled={busy || loading} value={first}
            onChange={(event) => { setFirst(event.target.value); setResult(null); }}>
            <option value="">Select a saved scan</option>
            {candidates.map((c) => <option value={c.scan_id} key={c.scan_id}>
              {c.scan_id} · {c.acquisition_time ?? 'acquisition time unavailable'}
            </option>)}
          </select>
        </label>
        <label className="space-y-1 text-[11px]" htmlFor="df-sar-second">
          <span className="df-label">Later/second scan</span>
          <select id="df-sar-second" className="df-input w-full" data-df-sar-second
            disabled={busy || loading} value={second}
            onChange={(event) => { setSecond(event.target.value); setResult(null); }}>
            <option value="">Select a saved scan</option>
            {candidates.map((c) => <option value={c.scan_id} key={c.scan_id}>
              {c.scan_id} · {c.acquisition_time ?? 'acquisition time unavailable'}
            </option>)}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        {[selectedA, selectedB].map((c, i) => <div key={i} className="border border-structural p-2">
          {c ? <>
            <p className="df-num break-all text-ink">{c.item_id ?? 'Scene ID unavailable'}</p>
            <p className="text-ink-dim">{c.product ?? 'product unavailable'} · {c.polarization ?? 'polarization unavailable'}</p>
            <p className="text-ink-dim">
              {c.georeference_present ? 'Geo metadata recorded' : 'Geo metadata unavailable'}
              {' · '}{c.available_normalized_raster ? 'Cache indexed' : 'Calibrated cache unavailable'}
            </p>
          </> : <p className="text-ink-dim">No selected source</p>}
        </div>)}
      </div>
      <button className="df-btn" type="button" data-df-sar-compare
        disabled={busy || loading || !first || !second || first === second}
        onClick={run}>Compare measured overlap (read-only)</button>
      {busy ? <p role="status" className="df-note">Checking persisted grids and valid samples…</p> : null}
      {error ? <p className="text-[11px] text-fault" role="alert" data-df-sar-error>{error}</p> : null}
      {result ? <div className="space-y-2 border-t border-structural pt-2"
        data-df-sar-result data-df-sar-status={result.status}>
        <p className="df-label">
          {result.status === 'MEASURED' ? 'Measured exact-grid pixel differences' :
            'NOT COMPARABLE — no pixel differences calculated'}
        </p>
        <p className="df-num text-[11px] text-ink">{result.reason}</p>
        <p className="text-[11px] text-ink-dim">
          Acquisition interval: {result.acquisition_interval_hours === null
            ? 'NOT ESTABLISHED' : `${print(result.acquisition_interval_hours)} hours`}
        </p>
        {result.metrics ? <div className="grid grid-cols-2 gap-2 text-[11px]"
          data-df-sar-metrics>
          <p>Overlap: {result.metrics.overlap_shape.join(' × ')} pixels</p>
          <p>Valid pairs: {result.metrics.valid_pair_pixels} / {result.metrics.overlap_pixels}
            {' '}({print(result.metrics.valid_pair_fraction * 100)}%)</p>
          <p>Mean second − first: {print(result.metrics.mean_b_minus_a_db)} dB</p>
          <p>Mean absolute difference: {print(result.metrics.mean_absolute_difference_db)} dB</p>
          <p>RMS difference: {print(result.metrics.root_mean_square_difference_db)} dB</p>
          <p>Median difference: {print(result.metrics.median_b_minus_a_db)} dB</p>
          <p>P05 / P95: {print(result.metrics.p05_b_minus_a_db)} / {print(result.metrics.p95_b_minus_a_db)} dB</p>
          <p>Brighter / darker / unchanged: {result.metrics.brighter_b_pixels} /
            {' '}{result.metrics.darker_b_pixels} / {result.metrics.equal_pixels}</p>
          <p>Right in left pixel grid: row {result.metrics.offset_b_in_a_pixels[0]},
            {' '}column {result.metrics.offset_b_in_a_pixels[1]}</p>
        </div> : null}
        <p className="text-[11px] text-ink-dim">{result.caveat}</p>
        <p className="text-[10px] text-ink-dim">
          Source scans {result.first.scan_id} and {result.second.scan_id},
          {' '}saved RTC pixel caches. No vessel or other change classification.
        </p>
      </div> : null}
    </section>
  );
}
