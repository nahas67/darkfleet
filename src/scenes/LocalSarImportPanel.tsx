/** Operator-owned offline GeoTIFF intake. Import is evidence registration, not SAR analysis. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, ContractViolation, explain } from '../api/errors';

export type LocalSarProduct = 'RTC' | 'GRD';
export type LocalSarPolarization = 'VV' | 'VH';
export type LocalSarCalibration = 'UNKNOWN' | 'RAW_DN' | 'GAMMA0_LINEAR' | 'SIGMA0_LINEAR' | 'GAMMA0_DB' | 'SIGMA0_DB';

export interface LocalSarImportRequest {
  relative_path: string;
  product: LocalSarProduct;
  polarization?: LocalSarPolarization;
  acquisition_time?: string;
  calibration?: LocalSarCalibration;
}

export interface LocalSarStatus {
  available: boolean | null;
  inbox: string | null;
  note: string | null;
  max_file_bytes: number | null;
  max_pixels: number | null;
}

export interface LocalSarImport {
  import_id: string;
  status: 'IMPORTED_NOT_ANALYZED';
  relative_path: string | null;
  product: LocalSarProduct | null;
  polarization: LocalSarPolarization | null;
  calibration: LocalSarCalibration | null;
  acquisition_time: string | null;
  sha256: string | null;
  crs: string | null;
  width: number | null;
  height: number | null;
  source_integrity: 'VERIFIED' | 'MISSING' | 'CHANGED' | 'UNAVAILABLE';
  snapshot_integrity: 'VERIFIED' | 'MISSING' | 'CHANGED' | 'UNAVAILABLE';
  image_url: string | null;
  limitations: string[];
  pixel_center: [number, number] | null;
}

const IMPORT_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const DATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/i;

function object(input: unknown, field: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractViolation(field, 'Expected an object.');
  }
  return input as Record<string, unknown>;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ContractViolation(field, 'Expected text or null.');
  return value || null;
}

function optionalBool(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new ContractViolation(field, 'Expected a boolean or null.');
  return value;
}

function optionalNatural(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ContractViolation(field, 'Expected a nonnegative integer or null.');
  }
  return value;
}

/** Browser-side input guard; the server independently enforces the configured inbox boundary. */
export function validateLocalSarPath(input: string): string {
  const path = input.trim();
  if (!path || path.length > 132 || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error('Enter a .tif or .tiff filename in the server inbox (maximum 132 characters).');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}\.tiff?$/i.test(path) || path.includes('..')) {
    throw new Error('Use a single .tif or .tiff basename in the server inbox. Paths, URLs and parent segments are not accepted.');
  }
  return path;
}

/** FastAPI wraps safe backend refusal codes in `detail`; never echo arbitrary error bodies. */
export function explainLocalSarError(cause: unknown): string {
  if (cause instanceof ApiError) {
    const outer = cause.detail && typeof cause.detail === 'object' ? cause.detail as Record<string, unknown> : null;
    // request() already unwraps FastAPI's {detail:{...}} into ApiError.detail.
    // Also tolerate a manually constructed ApiError carrying the outer envelope.
    const detail = outer?.detail && typeof outer.detail === 'object'
      ? outer.detail as Record<string, unknown> : outer;
    if (detail && typeof detail.status === 'string' && /^[A-Z0-9_]{1,80}$/.test(detail.status)) {
      return `Local SAR request refused: ${detail.status}.`;
    }
  }
  return explain(cause);
}

function isValidDateTime(value: string): boolean {
  return DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
}

export function prepareLocalSarRequest(input: {
  relative_path: string;
  product: string;
  polarization?: string;
  acquisition_time?: string;
  calibration?: string;
}): LocalSarImportRequest {
  const relative_path = validateLocalSarPath(input.relative_path);
  if (input.product !== 'RTC' && input.product !== 'GRD') {
    throw new Error('Select RTC or GRD as identified by the source documentation.');
  }
  const payload: LocalSarImportRequest = { relative_path, product: input.product };
  if (input.polarization?.trim()) {
    if (input.polarization !== 'VV' && input.polarization !== 'VH') {
      throw new Error('Polarization must be VV or VH when supplied.');
    }
    payload.polarization = input.polarization;
  }
  if (input.acquisition_time?.trim()) {
    const acquisition_time = input.acquisition_time.trim();
    if (!isValidDateTime(acquisition_time)) {
      throw new Error('Acquisition time must be a valid ISO 8601 timestamp with an explicit timezone.');
    }
    payload.acquisition_time = acquisition_time;
  }
  if (input.calibration?.trim()) {
    const calibration = input.calibration.trim();
    const supported = ['UNKNOWN', 'RAW_DN', 'GAMMA0_LINEAR', 'SIGMA0_LINEAR', 'GAMMA0_DB', 'SIGMA0_DB'];
    if (!supported.includes(calibration)) throw new Error('Select a supported source calibration type.');
    payload.calibration = calibration as LocalSarCalibration;
  }
  return payload;
}

export function readLocalSarStatus(value: unknown): LocalSarStatus {
  const v = object(value, 'LocalSarStatus');
  const enabled = optionalBool(v.enabled, 'LocalSarStatus.enabled');
  const state = optionalText(v.status, 'LocalSarStatus.status');
  const known = state === 'READY' ? true
    : state === 'UNAVAILABLE' || state === 'DISABLED' || state === 'NOT_CONFIGURED' ? false : null;
  if (enabled !== null && known !== null && enabled !== known) {
    throw new ContractViolation('LocalSarStatus', 'Contradictory backend availability signals.');
  }
  if ((v.scope !== undefined && v.scope !== 'LOOPBACK_ONLY') ||
    (v.analysis !== undefined && v.analysis !== 'IMPORT_ONLY')) {
    throw new ContractViolation('LocalSarStatus', 'Unexpected source access or analysis authority.');
  }
  return {
    available: enabled ?? known,
    inbox: optionalText(v.inbox_name, 'LocalSarStatus.inbox_name'),
    note: optionalText(v.note ?? v.reason, 'LocalSarStatus.note'),
    max_file_bytes: optionalNatural(v.max_file_bytes, 'LocalSarStatus.max_file_bytes'),
    max_pixels: optionalNatural(v.max_pixels, 'LocalSarStatus.max_pixels'),
  };
}

export function readLocalSarImport(value: unknown): LocalSarImport {
  const v = object(value, 'LocalSarImport');
  if (typeof v.import_id !== 'string' || !/^[0-9a-f]{32}$/.test(v.import_id)) {
    throw new ContractViolation('LocalSarImport.import_id', 'Invalid local import identifier.');
  }
  if (v.status !== 'IMPORTED_NOT_ANALYZED') {
    throw new ContractViolation('LocalSarImport.status', 'An import may never claim completed analysis.');
  }
  const source = object(v.source, 'LocalSarImport.source');
  const metadata = object(v.metadata, 'LocalSarImport.metadata');
  const relative_path = optionalText(source.relative_path, 'LocalSarImport.source.relative_path');
  try {
    if (!relative_path) throw new Error('Source filename missing.');
    validateLocalSarPath(relative_path);
  } catch {
    throw new ContractViolation('LocalSarImport.source.relative_path', 'Invalid recorded server-inbox filename.');
  }
  if (source.origin !== undefined && source.origin !== 'OPERATOR_LOCAL_INBOX') {
    throw new ContractViolation('LocalSarImport.source.origin', 'Unexpected nonlocal import origin.');
  }
  const product = optionalText(metadata.product, 'LocalSarImport.metadata.product');
  if (product !== null && product !== 'RTC' && product !== 'GRD') {
    throw new ContractViolation('LocalSarImport.product', 'Unexpected product type.');
  }
  const polarization = optionalText(metadata.polarization, 'LocalSarImport.metadata.polarization');
  if (polarization !== null && polarization !== 'VV' && polarization !== 'VH') {
    throw new ContractViolation('LocalSarImport.polarization', 'Unexpected polarization type.');
  }
  const calibration = optionalText(metadata.calibration, 'LocalSarImport.metadata.calibration');
  if (calibration !== null && !['UNKNOWN', 'RAW_DN', 'GAMMA0_LINEAR', 'SIGMA0_LINEAR', 'GAMMA0_DB', 'SIGMA0_DB'].includes(calibration)) {
    throw new ContractViolation('LocalSarImport.calibration', 'Unexpected calibration declaration.');
  }
  if (metadata.calibration_verified !== undefined && metadata.calibration_verified !== false) {
    throw new ContractViolation('LocalSarImport.metadata.calibration_verified', 'Local intake cannot independently verify calibration.');
  }
  const sha256 = optionalText(v.sha256, 'LocalSarImport.sha256');
  if (!sha256 || !SHA256.test(sha256) || source.sha256 !== sha256) {
    throw new ContractViolation('LocalSarImport.sha256', 'Source checksum must be a consistent SHA-256 digest.');
  }
  const integrity = ['VERIFIED', 'MISSING', 'CHANGED', 'UNAVAILABLE'];
  if (!integrity.includes(String(v.source_integrity)) || !integrity.includes(String(v.snapshot_integrity))) {
    throw new ContractViolation('LocalSarImport.integrity', 'Source or immutable snapshot integrity unknown.');
  }
  const image_url = optionalText(v.image_url, 'LocalSarImport.image_url');
  if (image_url !== null && image_url !== localSarPreviewUrl(v.import_id)) {
    throw new ContractViolation('LocalSarImport.image_url', 'Expected the same-origin import image endpoint.');
  }
  if (!Array.isArray(v.limitations) || v.limitations.length > 100 ||
    v.limitations.some((warning: unknown) => typeof warning !== 'string' || warning.length > 2048)) {
    throw new ContractViolation('LocalSarImport.limitations', 'Expected bounded limitations.');
  }
  const center = metadata.pixel_center_wgs84_lon_lat;
  if (center !== null && center !== undefined && (!Array.isArray(center) || center.length !== 2 ||
    center.some((coordinate: unknown) => typeof coordinate !== 'number' || !Number.isFinite(coordinate)) ||
    center[0] < -180 || center[0] > 180 || center[1] < -90 || center[1] > 90)) {
    throw new ContractViolation('LocalSarImport.metadata.pixel_center_wgs84_lon_lat', 'Invalid geolocated center.');
  }
  const width = optionalNatural(metadata.width, 'LocalSarImport.metadata.width');
  const height = optionalNatural(metadata.height, 'LocalSarImport.metadata.height');
  return {
    import_id: v.import_id,
    status: 'IMPORTED_NOT_ANALYZED',
    relative_path,
    product: product as LocalSarProduct | null,
    polarization: polarization as LocalSarPolarization | null,
    calibration: calibration as LocalSarCalibration | null,
    acquisition_time: optionalText(metadata.acquisition_time, 'LocalSarImport.metadata.acquisition_time'),
    sha256,
    crs: optionalText(metadata.crs, 'LocalSarImport.metadata.crs'),
    width, height,
    source_integrity: v.source_integrity as LocalSarImport['source_integrity'],
    snapshot_integrity: v.snapshot_integrity as LocalSarImport['snapshot_integrity'],
    image_url,
    limitations: [...v.limitations] as string[],
    pixel_center: center ? [center[0], center[1]] : null,
  };
}

export function readLocalSarImports(value: unknown): LocalSarImport[] {
  const v = object(value, 'LocalSarImports');
  if (v.status !== 'READY') throw new ContractViolation('LocalSarImports.status', 'Source catalogue is not READY.');
  const total = optionalNatural(v.total, 'LocalSarImports.total');
  if (total === null) throw new ContractViolation('LocalSarImports.total', 'Total record count missing.');
  if (!Array.isArray(v.imports) || v.imports.length > 500) {
    throw new ContractViolation('LocalSarImports.imports', 'Expected a bounded imports array.');
  }
  const imports = v.imports.map(readLocalSarImport);
  if (imports.length > total) throw new ContractViolation('LocalSarImports.total', 'More imports than reported total.');
  if (new Set(imports.map((entry) => entry.import_id)).size !== imports.length) {
    throw new ContractViolation('LocalSarImports.imports', 'Duplicate source identifiers.');
  }
  return imports;
}

export const localSarPreviewUrl = (importId: string): string => {
  if (!IMPORT_ID.test(importId)) throw new Error('Invalid local import identifier.');
  return `/api/sar/local/imports/${encodeURIComponent(importId)}/image`;
};

export const getLocalSarStatus = async (signal?: AbortSignal): Promise<LocalSarStatus> =>
  readLocalSarStatus(await api.get<unknown>('/api/sar/local/status', signal));
export const listLocalSarImports = async (signal?: AbortSignal): Promise<LocalSarImport[]> =>
  readLocalSarImports(await api.get<unknown>('/api/sar/local/imports', signal));
export const getLocalSarImport = async (importId: string, signal?: AbortSignal): Promise<LocalSarImport> => {
  if (!IMPORT_ID.test(importId)) throw new Error('Invalid local import identifier.');
  const entry = readLocalSarImport(await api.get<unknown>(`/api/sar/local/imports/${encodeURIComponent(importId)}`, signal));
  if (entry.import_id !== importId) throw new ContractViolation('LocalSarImport.import_id', 'Detail belongs to another import.');
  return entry;
};
export const submitLocalSarImport = async (payload: LocalSarImportRequest, signal?: AbortSignal): Promise<LocalSarImport> =>
  readLocalSarImport(await api.post<unknown>('/api/sar/local/import', prepareLocalSarRequest({
    ...payload,
  }), signal));

/** Show source integrity independently from the immutable snapshot integrity. */
export function LocalSarImportDetail({ entry }: { entry: LocalSarImport }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => { setImageFailed(false); }, [entry.snapshot_integrity, entry.sha256]);
  const sourceChanged = entry.source_integrity === 'CHANGED';
  const sourceMissing = entry.source_integrity === 'MISSING' || entry.source_integrity === 'UNAVAILABLE';
  const preview = entry.snapshot_integrity === 'VERIFIED' && entry.image_url !== null;
  return (
    <article className="space-y-2 border border-structural p-3" data-df-local-sar-detail={entry.import_id}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="df-label">Source record · {entry.import_id}</h3>
        <span className="df-num text-[10px]" data-df-local-sar-import-state>{entry.status}</span>
      </header>
      <p className="text-[11px] text-ink-dim">IMPORTED_NOT_ANALYZED means this GeoTIFF was registered locally. No detection, scan completion, vessel identity or calibration inference is established by the import.</p>
      {sourceChanged ? <p className="text-fault text-[11px]" role="alert">SOURCE CHANGED — inbox file no longer matches the imported SHA-256. Any available preview shows the independently verified saved snapshot only.</p> : null}
      {sourceMissing ? <p className="text-fault text-[11px]" role="alert">SOURCE MISSING OR UNAVAILABLE — original inbox file cannot be reverified; any available preview is from the saved snapshot.</p> : null}
      {entry.snapshot_integrity !== 'VERIFIED' ? <p className="text-fault text-[11px]" role="alert">SNAPSHOT {entry.snapshot_integrity} — saved preview cannot be trusted or displayed.</p> : null}
      <dl className="grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-2" data-df-local-sar-provenance>
        <div><dt className="df-label">Server-inbox relative path</dt><dd className="df-num break-all">{entry.relative_path ?? 'Not recorded'}</dd></div>
        <div><dt className="df-label">Product · polarization</dt><dd className="df-num">{entry.product ?? 'Unknown'} · {entry.polarization ?? 'Unknown'}</dd></div>
        <div><dt className="df-label">Calibration declaration</dt><dd className="df-num">{entry.calibration ?? 'Not established'} · NOT VERIFIED</dd></div>
        <div><dt className="df-label">Acquisition time</dt><dd className="df-num">{entry.acquisition_time ?? 'Not established'}</dd></div>
        <div><dt className="df-label">CRS</dt><dd className="df-num">{entry.crs ?? 'MISSING — geolocation unavailable'}</dd></div>
        <div><dt className="df-label">Raster size</dt><dd className="df-num">{entry.width !== null && entry.height !== null ? `${entry.width} × ${entry.height} pixels` : 'Not recorded'}</dd></div>
        <div><dt className="df-label">Source integrity</dt><dd className="df-num">{entry.source_integrity}</dd></div>
        <div><dt className="df-label">Snapshot integrity</dt><dd className="df-num">{entry.snapshot_integrity}</dd></div>
        <div><dt className="df-label">First pixel-center coordinates</dt><dd className="df-num">{entry.pixel_center ? `${entry.pixel_center[0]}, ${entry.pixel_center[1]} (WGS84 lon, lat)` : 'NOT ESTABLISHED'}</dd></div>
        <div className="sm:col-span-2"><dt className="df-label">Recorded SHA-256</dt><dd className="df-num break-all">{entry.sha256 ?? 'Not recorded'}</dd></div>
      </dl>
      {entry.limitations.length ? <div className="space-y-1" data-df-local-sar-limitations>
        <h4 className="df-label">Documented limitations</h4>
        <ul className="list-inside list-disc text-[11px] text-warn">
          {entry.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
        </ul>
      </div> : null}
      {preview && !imageFailed ? <figure className="space-y-1" data-df-local-sar-preview>
        <img key={entry.import_id} src={entry.image_url!}
          alt="Checksum-verified immutable local GeoTIFF snapshot preview; display is not calibrated analysis"
          className="max-h-80 w-full bg-black object-contain" onError={() => setImageFailed(true)} />
        <figcaption className="text-[10px] text-ink-dim">Checksum-verified immutable import snapshot. Display only; no synthetic geolocation, VH or 10-metre resolution. GRD and RTC are not interchangeable calibrated measurements.</figcaption>
      </figure> : <p role="status" className="text-[11px] text-ink-dim">
        {imageFailed ? 'Image preview request failed; recorded snapshot integrity may have changed.' :
          'Preview unavailable because no verified saved snapshot was returned.'}
      </p>}
      {imageFailed && preview ? <button type="button" className="df-btn" onClick={() => setImageFailed(false)}>
        Retry saved snapshot preview
      </button> : null}
    </article>
  );
}

export function LocalSarImportPanel() {
  const [relativePath, setRelativePath] = useState('');
  const [product, setProduct] = useState<LocalSarProduct>('RTC');
  const [polarization, setPolarization] = useState('');
  const [acquisitionTime, setAcquisitionTime] = useState('');
  const [calibration, setCalibration] = useState('');
  const [status, setStatus] = useState<LocalSarStatus | null>(null);
  const [imports, setImports] = useState<LocalSarImport[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<LocalSarImport | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const selectionRequest = useRef<AbortController | null>(null);
  const reloadRequest = useRef<AbortController | null>(null);
  const submitRequest = useRef<AbortController | null>(null);

  const reload = async (signal: AbortSignal, newlyImported?: LocalSarImport) => {
    const [health, records] = await Promise.allSettled([
      getLocalSarStatus(signal), listLocalSarImports(signal),
    ]);
    if (signal.aborted) return;
    if (health.status === 'fulfilled') setStatus(health.value);
    else setStatus({ available: false, inbox: null, note: null, max_file_bytes: null, max_pixels: null });
    if (records.status === 'fulfilled') {
      const entries = newlyImported && !records.value.some((v) => v.import_id === newlyImported.import_id)
        ? [newlyImported, ...records.value] : records.value;
      setImports(entries);
      setSelectedId((previous) => previous && entries.some((v) => v.import_id === previous)
        ? previous : entries[0]?.import_id ?? '');
    }
    const failures = [health, records].filter((result) => result.status === 'rejected');
    setError(failures.length > 0 ? failures.map((result) => explainLocalSarError((result as PromiseRejectedResult).reason)).join(' ') : null);
  };

  useEffect(() => {
    const controller = new AbortController();
    reloadRequest.current = controller;
    void reload(controller.signal).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); selectionRequest.current?.abort(); submitRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    selectionRequest.current?.abort();
    setDetail(null);
    setDetailError(null);
    if (!selectedId) { setDetailLoading(false); return; }
    const controller = new AbortController();
    selectionRequest.current = controller;
    setDetailLoading(true);
    void getLocalSarImport(selectedId, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setDetail(result); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setDetailError(explainLocalSarError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId, detailRefresh]);

  const refresh = () => {
    reloadRequest.current?.abort();
    // Revalidate the selected snapshot as well as the catalogue. The same
    // import ID may now have changed source/snapshot integrity on disk.
    setDetailRefresh((version) => version + 1);
    const controller = new AbortController();
    reloadRequest.current = controller;
    setLoading(true); setError(null);
    void reload(controller.signal).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  };

  const importFile = async (event: FormEvent) => {
    event.preventDefault();
    if (working || loading || status?.available !== true) return;
    let payload: LocalSarImportRequest;
    try {
      payload = prepareLocalSarRequest({
        relative_path: relativePath, product, polarization,
        acquisition_time: acquisitionTime, calibration,
      });
    } catch (cause) { setError(explainLocalSarError(cause)); return; }
    const controller = new AbortController();
    submitRequest.current?.abort();
    submitRequest.current = controller;
    setWorking(true); setError(null);
    try {
      const created = await submitLocalSarImport(payload, controller.signal);
      if (controller.signal.aborted) return;
      setSelectedId(created.import_id);
      setDetail(created);
      reloadRequest.current?.abort();
      const refreshController = new AbortController();
      reloadRequest.current = refreshController;
      await reload(refreshController.signal, created);
      if (!refreshController.signal.aborted) {
        setSelectedId(created.import_id);
      }
    } catch (cause) { if (!controller.signal.aborted) setError(explainLocalSarError(cause)); }
    finally { if (!controller.signal.aborted) setWorking(false); }
  };

  return (
    <section className="df-panel min-h-0 space-y-3 overflow-y-auto p-3" data-df-local-sar-import-panel>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="df-label text-xs">Local GeoTIFF intake</h2>
          <p className="text-[11px] text-ink-dim">Offline source registration from the server inbox. A verified local snapshot is retained. Import creates an IMPORTED_NOT_ANALYZED record; no scan or detection is executed here.</p>
        </div>
        <button type="button" className="df-btn" data-df-local-sar-refresh onClick={refresh} disabled={loading || working}>Refresh sources</button>
      </header>
      <div className="border border-structural p-2 text-[11px]" data-df-local-sar-service-state>
        {loading ? <p role="status">Checking local source service…</p>
          : status?.available === true ? <p className="text-tac">Server inbox configured</p>
            : status?.available === false ? <p className="text-fault" role="alert">Local source service unavailable or inbox not configured.</p>
              : <p className="text-warn">Local source service has not confirmed a configured inbox.</p>}
        {status?.inbox ? <p className="df-num mt-1 break-all">Server inbox: {status.inbox}</p> : null}
        {status?.max_file_bytes !== null && status?.max_file_bytes !== undefined ?
          <p className="text-ink-dim">Maximum file size: {(status.max_file_bytes / 1048576).toFixed(0)} MiB</p> : null}
        {status?.max_pixels !== null && status?.max_pixels !== undefined ?
          <p className="text-ink-dim">Maximum source raster: {status.max_pixels.toLocaleString()} pixels</p> : null}
        {status?.note ? <p className="mt-1 text-ink-dim">{status.note}</p> : null}
      </div>
      <form className="space-y-2 border border-structural p-3" onSubmit={(event) => { void importFile(event); }} data-df-local-sar-form>
        <p className="text-[11px] text-ink-2">Place a .tif or .tiff directly in the backend's configured local inbox and enter its filename. Subdirectories, remote URLs, browser uploads and arbitrary filesystem paths are not accepted.</p>
        <label className="block space-y-1 text-[11px]">
          <span className="df-label">GeoTIFF filename in server inbox</span>
          <input aria-label="Relative GeoTIFF path" data-df-local-sar-path className="df-input w-full"
            autoComplete="off" spellCheck={false} maxLength={132} required
            placeholder="recorded-scene.tif" value={relativePath}
            onChange={(event) => setRelativePath(event.target.value)} />
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block space-y-1 text-[11px]">
            <span className="df-label">Source product (operator supplied)</span>
            <select className="df-input w-full" aria-label="Source product" data-df-local-sar-product
              value={product} onChange={(event) => setProduct(event.target.value as LocalSarProduct)}>
              <option value="RTC">RTC — terrain-corrected source</option>
              <option value="GRD">GRD — ground-range detected source</option>
            </select>
          </label>
          <label className="block space-y-1 text-[11px]">
            <span className="df-label">Polarization (optional)</span>
            <select className="df-input w-full" aria-label="Polarization" data-df-local-sar-polarization
              value={polarization} onChange={(event) => setPolarization(event.target.value)}>
              <option value="">Not established</option><option value="VV">VV</option><option value="VH">VH</option>
            </select>
          </label>
        </div>
        <label className="block space-y-1 text-[11px]">
          <span className="df-label">Acquisition time (optional, timezone required)</span>
          <input type="text" className="df-input w-full" aria-label="Acquisition time" data-df-local-sar-acquired
            value={acquisitionTime} placeholder="2026-10-10T13:45:00Z"
            onChange={(event) => setAcquisitionTime(event.target.value)} />
        </label>
        <label className="block space-y-1 text-[11px]">
          <span className="df-label">Source calibration (optional, operator supplied)</span>
          <select aria-label="Source calibration" data-df-local-sar-calibration
            className="df-input w-full" value={calibration} onChange={(event) => setCalibration(event.target.value)}>
            <option value="">Not established</option>
            <option value="UNKNOWN">UNKNOWN</option><option value="RAW_DN">RAW_DN</option>
            <option value="GAMMA0_LINEAR">GAMMA0_LINEAR</option><option value="SIGMA0_LINEAR">SIGMA0_LINEAR</option>
            <option value="GAMMA0_DB">GAMMA0_DB</option><option value="SIGMA0_DB">SIGMA0_DB</option>
          </select>
          <span className="text-ink-dim">Use the source's documented calibration. Selecting a value does not calibrate or verify the raster.</span>
        </label>
        <button className="df-btn" data-df-local-sar-submit type="submit"
          disabled={working || loading || status?.available !== true || !relativePath.trim()}>
          {working ? 'Registering source…' : 'Register local source'}
        </button>
      </form>
      {error ? <p className="text-[11px] text-fault" role="alert" data-df-local-sar-error>{error}</p> : null}
      <div className="space-y-2 border-t border-structural pt-3">
        <h3 className="df-label">Saved local imports · {imports.length}</h3>
        {!loading && imports.length === 0 ? <p className="text-[11px] text-ink-dim">No persisted local GeoTIFF imports were returned. This is not evidence that local files are absent.</p> : null}
        <label className="block space-y-1 text-[11px]">
          <span className="df-label">Inspect saved source</span>
          <select className="df-input w-full" aria-label="Inspect saved source" data-df-local-sar-select
            value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">Select a source record</option>
            {imports.map((entry) => <option key={entry.import_id} value={entry.import_id}>
              {entry.import_id} · {entry.relative_path ?? 'path not recorded'} · {entry.status}
            </option>)}
          </select>
        </label>
        {detailLoading ? <p role="status" className="text-[11px] text-ink-dim">Verifying persisted source metadata…</p> : null}
        {detailError ? <p role="alert" className="text-[11px] text-fault" data-df-local-sar-detail-error>{detailError}</p> : null}
        {detail && !detailLoading && detail.import_id === selectedId ? <LocalSarImportDetail key={detail.import_id} entry={detail} /> : null}
      </div>
    </section>
  );
}
