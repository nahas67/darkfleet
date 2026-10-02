/**
 * The 13 debug-layer descriptors served by `GET /api/debug/{scan_id}/{layer}`
 * (API-009, UI-016).
 *
 * This is a PURE registry: ids, titles, endpoint paths, whether a layer needs a
 * recompute to change, and whether the backend serves it today. The surface
 * reads it; nothing else may invent a debug layer.
 *
 * Honesty rules encoded here:
 *  - A layer the backend does not serve is `DECLARED_ONLY`. It renders as an
 *    explicit unavailable row with its reason. It is never fetched-and-faked and
 *    never silently dropped.
 *  - `normalized` is an alias: the backend answers it from the `raw_db`
 *    artifact. `debugLayerView` surfaces that alias instead of presenting the
 *    numbers as an independent normalisation product.
 *  - Statistics come from `LayerStats`. Nothing in this module computes a mean,
 *    a percentile or a count. When the endpoint sent no stats the view says so.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DebugLayerId } from '../types/api.ts';
import type { DebugLayerResponse, LayerStats } from '../app/useApi.ts';

/** Whether the backend's debug registry serves this id today. */
export type DebugLayerServerStatus = 'SERVED' | 'DECLARED_ONLY';

export interface DebugLayerDef {
  readonly id: DebugLayerId;
  readonly title: string;
  /** Id appended to `/api/debug/{scan_id}/`. */
  readonly endpoint: string;
  /** Full templated path, with `{scan_id}` left for the caller to substitute. */
  readonly path: string;
  /** `array` = 2-D raster summary, `table` = one row per target. */
  readonly kind: 'array' | 'table';
  readonly serverStatus: DebugLayerServerStatus;
  /** Pipeline artifact the backend reads this layer from, when it declares one. */
  readonly source: string;
  /** True when editing a CFAR parameter changes this layer's contents. */
  readonly requiresRecomputation: boolean;
  /** Why recomputation matters here, rendered as the tooltip/description. */
  readonly recomputeReason: string;
  readonly description: string;
  /** Server-side alias, surfaced rather than hidden. */
  readonly aliasOf?: DebugLayerId;
  /** Why a DECLARED_ONLY layer cannot be shown. */
  readonly unavailableReason?: string;
}

/**
 * Declaration order is pipeline order: preprocessing -> masking -> filtering ->
 * detection -> extraction -> AIS -> matching -> scoring.
 */
export const DEBUG_LAYER_DEFS: readonly DebugLayerDef[] = [
  {
    id: 'raw',
    title: 'Raw backscatter',
    endpoint: 'raw',
    path: '/api/debug/{scan_id}/raw',
    kind: 'array',
    serverStatus: 'SERVED',
    source: 'raw_db',
    requiresRecomputation: false,
    recomputeReason: 'Read straight off the ingested raster; parameters do not change it.',
    description: 'Calibrated dB grid as read from the scene.',
  },
  {
    id: 'normalized',
    title: 'Normalized backscatter',
    endpoint: 'normalized',
    path: '/api/debug/{scan_id}/normalized',
    kind: 'array',
    serverStatus: 'SERVED',
    source: 'raw_db',
    requiresRecomputation: false,
    recomputeReason: 'Server-side alias of the raw dB grid; parameters do not change it.',
    description: 'Requested normalisation product.',
    aliasOf: 'raw',
  },
  {
    id: 'landmask',
    title: 'Land / coastline mask',
    endpoint: 'landmask',
    path: '/api/debug/{scan_id}/landmask',
    kind: 'array',
    serverStatus: 'SERVED',
    source: 'land',
    requiresRecomputation: false,
    recomputeReason: 'The mask grid itself is unchanged by parameters; detections downstream are not.',
    description: 'Binary land mask used to suppress detections near shore.',
  },
  {
    id: 'filtered',
    title: 'Speckle-filtered backscatter',
    endpoint: 'filtered',
    path: '/api/debug/{scan_id}/filtered',
    kind: 'array',
    serverStatus: 'SERVED',
    source: 'filtered_db',
    requiresRecomputation: true,
    recomputeReason: 'Rebuilt when the speckle mode or kernel size changes.',
    description: 'Backscatter after the pre-detection speckle filter.',
  },
  {
    id: 'cfar_threshold',
    title: 'CFAR threshold',
    endpoint: 'cfar_threshold',
    path: '/api/debug/{scan_id}/cfar_threshold',
    kind: 'array',
    serverStatus: 'SERVED',
    source: 'threshold_db',
    requiresRecomputation: true,
    recomputeReason: 'Rebuilt when the training/guard window or threshold multiplier changes.',
    description: 'Per-pixel background threshold the detector compares against.',
  },
  {
    id: 'detection_mask',
    title: 'Detection mask',
    endpoint: 'detection_mask',
    path: '/api/debug/{scan_id}/detection_mask',
    kind: 'array',
    serverStatus: 'SERVED',
    source: 'cfar_mask',
    requiresRecomputation: true,
    recomputeReason: 'Rebuilt by every CFAR window, threshold, buffer or speckle change.',
    description: 'Cells that exceeded the CFAR threshold.',
  },
  {
    id: 'components',
    title: 'Connected components',
    endpoint: 'components',
    path: '/api/debug/{scan_id}/components',
    kind: 'table',
    serverStatus: 'SERVED',
    source: 'targets',
    requiresRecomputation: true,
    recomputeReason: 'Rebuilt when the min/max component size bounds change.',
    description: 'One row per detected component.',
  },
  {
    id: 'centroids',
    title: 'Component centroids',
    endpoint: 'centroids',
    path: '/api/debug/{scan_id}/centroids',
    kind: 'table',
    serverStatus: 'SERVED',
    source: 'targets',
    requiresRecomputation: true,
    recomputeReason: 'Derived from the components layer, so it moves with every recompute.',
    description: 'Lat/lon centre of each accepted component.',
  },
  {
    id: 'ais_observations',
    title: 'AIS observations',
    endpoint: 'ais_observations',
    path: '/api/debug/{scan_id}/ais_observations',
    kind: 'table',
    serverStatus: 'DECLARED_ONLY',
    source: 'ais',
    requiresRecomputation: false,
    recomputeReason: 'Independent of the SAR parameters.',
    description: 'Broadcast positions used for association.',
    unavailableReason:
      'The backend debug registry does not serve this id yet. AIS contacts are read from ' +
      'GET /api/scans/{scan_id}/targets instead.',
  },
  {
    id: 'ais_predicted',
    title: 'AIS dead-reckoned positions',
    endpoint: 'ais_predicted',
    path: '/api/debug/{scan_id}/ais_predicted',
    kind: 'table',
    serverStatus: 'DECLARED_ONLY',
    source: 'ais',
    requiresRecomputation: false,
    recomputeReason: 'Independent of the SAR parameters.',
    description: 'Predicted position at the SAR acquisition time.',
    unavailableReason:
      'The backend debug registry does not serve this id yet. Predicted positions are read ' +
      'from GET /api/scans/{scan_id}/targets instead.',
  },
  {
    id: 'match_radius',
    title: 'Match radius',
    endpoint: 'match_radius',
    path: '/api/debug/{scan_id}/match_radius',
    kind: 'table',
    serverStatus: 'DECLARED_ONLY',
    source: 'targets',
    requiresRecomputation: true,
    recomputeReason: 'Follows the detections that survived the last recompute.',
    description: 'Association search radius per candidate target.',
    unavailableReason:
      'The backend debug registry does not serve this id yet. Match radius is read from ' +
      'corr.scoreDecomposition on GET /api/scans/{scan_id}/targets instead.',
  },
  {
    id: 'correlation_lines',
    title: 'Correlation links',
    endpoint: 'correlation_lines',
    path: '/api/debug/{scan_id}/correlation_lines',
    kind: 'table',
    serverStatus: 'DECLARED_ONLY',
    source: 'targets',
    requiresRecomputation: true,
    recomputeReason: 'Follows the detections that survived the last recompute.',
    description: 'SAR detection to AIS association pairs.',
    unavailableReason:
      'The backend debug registry does not serve this id yet. Associations are read from ' +
      'GET /api/scans/{scan_id}/targets instead.',
  },
  {
    id: 'score_decomposition',
    title: 'Score decomposition',
    endpoint: 'score_decomposition',
    path: '/api/debug/{scan_id}/score_decomposition',
    kind: 'table',
    serverStatus: 'DECLARED_ONLY',
    source: 'targets',
    requiresRecomputation: true,
    recomputeReason: 'Follows the detections that survived the last recompute.',
    description: 'Per-component score contributions the backend computed.',
    unavailableReason:
      'The backend debug registry does not serve this id yet. Score components are read from ' +
      'corr.scoreDecomposition on GET /api/scans/{scan_id}/targets instead.',
  },
] as const;

/** Every registered debug-layer id, in declaration order. */
export const DEBUG_LAYER_IDS: readonly DebugLayerId[] = DEBUG_LAYER_DEFS.map((def) => def.id);

/** Ids the backend refuses today. Rendered as an explicit unavailable list. */
export function declaredOnlyLayers(): DebugLayerDef[] {
  return DEBUG_LAYER_DEFS.filter((def) => def.serverStatus === 'DECLARED_ONLY');
}

/** Ids whose contents move when the CFAR request parameters change. */
export function recomputeSensitiveLayers(): DebugLayerDef[] {
  return DEBUG_LAYER_DEFS.filter((def) => def.requiresRecomputation);
}

export function debugLayerById(id: string): DebugLayerDef | undefined {
  return DEBUG_LAYER_DEFS.find((def) => def.id === id);
}

/** `/api/debug/{scan_id}/{layer}` with both segments encoded. */
export function debugLayerPath(scanId: string, id: DebugLayerId): string {
  const def = debugLayerById(id);
  if (!def) throw new Error(`[darkfleet] unknown debug layer: ${id}`);
  return def.path.replace('{scan_id}', encodeURIComponent(scanId));
}

// --------------------------------------------------------------- debug gating

/**
 * `?debug=true` gate. Accepted: a bare query string, a `location.search`, or a
 * full URL. Accepted values are `true`, `1`, `yes`, `on` (case-insensitive);
 * everything else — absent, `false`, `0`, malformed — is false. The surface
 * stays hidden until the operator asks for it explicitly.
 */
export function isDebugEnabled(search: string | null | undefined): boolean {
  if (typeof search !== 'string' || search === '') return false;
  const query = search.includes('?') ? search.slice(search.indexOf('?') + 1) : search;
  for (const part of query.split(/[&;]/)) {
    const [rawKey, rawValue] = part.split('=');
    if (rawKey !== 'debug') continue;
    return ['true', '1', 'yes', 'on'].includes((rawValue ?? '').trim().toLowerCase());
  }
  return false;
}

// ------------------------------------------------------------- view modelling

export type DebugLayerState =
  /** Nothing requested yet. */
  | 'IDLE'
  /** The backend answered. */
  | 'AVAILABLE'
  /** The backend answered, but this id is not served. */
  | 'DECLARED_ONLY'
  /** The backend refused: unknown layer, unknown scan, not stored, not ready. */
  | 'UNAVAILABLE'
  /** Transport or decode failure. */
  | 'ERROR';

export interface DebugStatRow {
  readonly key: string;
  readonly label: string;
  /** Formatted backend value, or null when the backend reported none. */
  readonly value: string | null;
}

/** One row per field of the backend's `LayerStats`, in declaration order. */
const STAT_FIELDS: ReadonlyArray<readonly [keyof LayerStats, string, (v: never) => string]> = [
  ['size', 'size', (v) => String(v as unknown as number)],
  ['min', 'min', (v) => String(v as unknown as number)],
  ['max', 'max', (v) => String(v as unknown as number)],
  ['mean', 'mean', (v) => String(v as unknown as number)],
  ['std', 'std', (v) => String(v as unknown as number)],
  ['p01', 'p01', (v) => String(v as unknown as number)],
  ['p50', 'p50', (v) => String(v as unknown as number)],
  ['p99', 'p99', (v) => String(v as unknown as number)],
  ['nan_count', 'nan_count', (v) => String(v as unknown as number)],
  ['finite_fraction', 'finite_fraction', (v) => String(v as unknown as number)],
  ['true_count', 'true_count', (v) => String(v as unknown as number)],
];

/**
 * Turn backend stats into renderable rows. A field the backend sent as `null`
 * renders as "not reported" — never as 0, never as a computed substitute.
 */
export function statRows(stats: LayerStats | null | undefined): DebugStatRow[] {
  if (!stats) return [];
  return STAT_FIELDS.map(([key, label, format]) => {
    const raw = stats[key] as unknown;
    return {
      key: String(key),
      label,
      value: typeof raw === 'number' && Number.isFinite(raw) ? format(raw as never) : null,
    };
  });
}

/** Stat fields the backend derives. The counters below are always present. */
const DERIVED_STAT_FIELDS = ['min', 'max', 'mean', 'std', 'p01', 'p50', 'p99', 'true_count'] as const;

/**
 * True when at least one DERIVED statistic carries a real number. `size`,
 * `nan_count` and `finite_fraction` are always numeric, so counting them would
 * make this answer true for a statistics block that says nothing.
 */
export function hasReportedStats(stats: LayerStats | null | undefined): boolean {
  if (!stats) return false;
  return DERIVED_STAT_FIELDS.some((key) => {
    const value = stats[key] as unknown;
    return typeof value === 'number' && Number.isFinite(value);
  });
}

export interface DebugLayerView {
  readonly id: DebugLayerId;
  readonly title: string;
  readonly path: string;
  readonly kind: 'array' | 'table';
  readonly state: DebugLayerState;
  /** One honest sentence describing what the backend did (or refused to do). */
  readonly detail: string;
  /** Populated for DECLARED_ONLY / UNAVAILABLE / ERROR. */
  readonly reason: string | null;
  readonly source: string | null;
  readonly dtype: string | null;
  readonly shape: readonly number[];
  readonly stats: LayerStats | null;
  readonly statRows: readonly DebugStatRow[];
  /** True when `stats` exists but every field is null: say so, do not infer. */
  readonly statsMissing: boolean;
  readonly columns: readonly string[];
  readonly rows: number | null;
  readonly rowLimit: number | null;
  readonly truncated: boolean;
  readonly gridSize: number | null;
  readonly hasGrid: boolean;
  /** Backend `notes` plus the alias notice. Never empty when relevant. */
  readonly notes: readonly string[];
  readonly aliasOf: DebugLayerId | null;
  readonly requiresRecomputation: boolean;
  /** True when the pending config invalidates this layer. */
  readonly stale: boolean;
  readonly serverStatus: DebugLayerServerStatus;
}

/**
 * Read the backend's `notes` array defensively. The typed client response does
 * not declare it, but the wire model does carry it, so a note such as the
 * `normalized` alias explanation must never be dropped on the floor.
 */
export function readNotes(response: DebugLayerResponse | null | undefined): string[] {
  if (!response || typeof response !== 'object') return [];
  const notes = (response as unknown as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) return [];
  return notes.filter((note): note is string => typeof note === 'string' && note.length > 0);
}

/** True when the backend answered `normalized` from the raw dB artifact. */
export function isAliasResponse(def: DebugLayerDef, response: DebugLayerResponse | null | undefined): boolean {
  if (!response) return false;
  if (def.id === 'normalized') return response.source === 'raw_db';
  return def.aliasOf !== undefined && response.source !== null;
}

/** Map a backend error into a plain reason the surface can render verbatim. */
export function debugLayerUnavailableReason(
  def: DebugLayerDef,
  error: unknown,
): string | null {
  if (!error) return null;
  const record = error as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' && record.message ? record.message : null;
  switch (code) {
    case 'UNKNOWN_DEBUG_LAYER':
      return message ?? `The backend does not recognise the debug layer "${def.endpoint}".`;
    case 'UNKNOWN_SCAN':
      return message ?? 'No completed scan carries this id; debug layers are written at COMPLETE.';
    case 'LAYERS_NOT_AVAILABLE':
      return message ?? 'This scan carries no debug layer index.';
    case 'LAYER_NOT_STORED':
      return message ?? `The backend did not store "${def.endpoint}" for this scan.`;
    case 'EMPTY_RESPONSE':
      return 'The backend returned no JSON body for this layer.';
    case 'NETWORK_ERROR':
      return message ?? 'The debug endpoint could not be reached.';
    default:
      return message ?? `The debug endpoint failed (${String(code || record.status || 'unknown error')}).`;
  }
}

export interface DebugLayerViewInput {
  readonly response?: DebugLayerResponse | null;
  readonly error?: unknown;
  /** True when a pending parameter change invalidates a recompute-sensitive layer. */
  readonly stale?: boolean;
}

/**
 * Build the honest view model for one layer. `state` is the only thing the
 * surface branches on; every branch has a stated reason.
 */
export function debugLayerView(def: DebugLayerDef, input: DebugLayerViewInput = {}): DebugLayerView {
  const { response = null, error = null, stale = false } = input;
  const base = {
    id: def.id,
    title: def.title,
    path: def.path,
    kind: def.kind,
    aliasOf: def.aliasOf ?? null,
    requiresRecomputation: def.requiresRecomputation,
    stale: def.requiresRecomputation && stale,
    serverStatus: def.serverStatus,
  } as const;

  if (def.serverStatus === 'DECLARED_ONLY') {
    return {
      ...base,
      state: 'DECLARED_ONLY',
      detail: 'Not served by the backend debug registry. No data is rendered for it.',
      reason: def.unavailableReason ?? 'The backend does not serve this debug layer.',
      source: def.source,
      dtype: null,
      shape: [],
      stats: null,
      statRows: [],
      statsMissing: false,
      columns: [],
      rows: null,
      rowLimit: null,
      truncated: false,
      gridSize: null,
      hasGrid: false,
      notes: [],
    };
  }

  if (error) {
    return {
      ...base,
      state: 'UNAVAILABLE',
      detail: 'The backend refused or failed to return this layer.',
      reason: debugLayerUnavailableReason(def, error),
      source: null,
      dtype: null,
      shape: [],
      stats: null,
      statRows: [],
      statsMissing: false,
      columns: [],
      rows: null,
      rowLimit: null,
      truncated: false,
      gridSize: null,
      hasGrid: false,
      notes: [],
    };
  }

  if (!response) {
    return {
      ...base,
      state: 'IDLE',
      detail: 'Not requested yet.',
      reason: null,
      source: def.source,
      dtype: null,
      shape: [],
      stats: null,
      statRows: [],
      statsMissing: false,
      columns: [],
      rows: null,
      rowLimit: null,
      truncated: false,
      gridSize: null,
      hasGrid: false,
      notes: [],
    };
  }

  const alias = isAliasResponse(def, response);
  const rows = statRows(response.stats);
  const statsMissing = response.stats !== null && !hasReportedStats(response.stats);
  const shape = Array.isArray(response.shape) ? response.shape : [];
  const detailParts: string[] = [`kind ${response.kind}`];
  if (shape.length > 0) detailParts.push(`shape ${shape.join(' x ')}`);
  if (response.dtype) detailParts.push(`dtype ${response.dtype}`);
  if (typeof response.rows === 'number') {
    detailParts.push(
      response.truncated
        ? `${response.rows} rows (${response.row_limit ?? 0} returned)`
        : `${response.rows} rows`,
    );
  }
  if (response.stats === null) detailParts.push('no statistics reported');
  else if (statsMissing) detailParts.push('no distributional statistics reported');

  return {
    ...base,
    state: 'AVAILABLE',
    detail: detailParts.join(' · '),
    reason: null,
    // The backend OMITS source/dtype/stats rather than sending null, so the
    // generated contract marks them optional. DebugLayerView uses `null` as
    // its single absent marker, so omitted and explicitly-null collapse here --
    // once, at the boundary, instead of at every consumer.
    source: response.source ?? null,
    dtype: response.dtype ?? null,
    shape,
    stats: response.stats ?? null,
    statRows: rows,
    statsMissing,
    columns: Array.isArray(response.columns) ? response.columns : [],
    rows: typeof response.rows === 'number' ? response.rows : null,
    rowLimit: typeof response.row_limit === 'number' ? response.row_limit : null,
    truncated: Boolean(response.truncated),
    gridSize: typeof response.grid_size === 'number' ? response.grid_size : null,
    hasGrid: Array.isArray(response.grid) && response.grid.length > 0,
    notes: [
      ...readNotes(response),
      ...(alias && def.aliasOf
        ? [`Served from the "${response.source}" artifact: this is an alias of "${def.aliasOf}", not a separate product.`]
        : []),
    ],
  };
}
