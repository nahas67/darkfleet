/**
 * CFAR request-parameter model for the specialist analysis workbench (UI-015).
 *
 * Ported from the legacy `src/components/CFARWorkbench.tsx` and EXTENDED:
 * the legacy surface offered training cells, guard cells, threshold factor,
 * coastline buffer and a speckle toggle that only rendered `median` / `none`
 * (the `lee` mode existed in the wire type but was unreachable). This module
 * carries all eight parameters, including `lee`, as plain data.
 *
 * Hard rule (API-011): NOTHING HERE DETECTS. Every value in `CfarConfig` is a
 * REQUEST parameter sent to the Python backend. This module holds a reducer, a
 * validator, a preset table and a differ — no thresholding, no connected
 * components, no statistics. `diffConfig` exists so the surface can say
 * "this change requires recomputation" instead of silently implying that a
 * browser-side edit changed a detection.
 *
 * Everything here is pure: same inputs, same outputs, no I/O, no React.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** Speckle pre-filter. `lee` is reachable here — it was dead UI in the legacy workbench. */
export type SpeckleMode = 'none' | 'median' | 'lee';

import type { CfarConfig as CfarConfigContract } from '../api/contract';

/**
 * The wire shape of one CFAR override, straight from the generated contract.
 *
 * This alias is the reason a backend rename is a compile error rather than a live
 * scan failure. `CfarConfig` below is the interface's internal model; the
 * contract is what `POST /api/scans` actually accepts. They were allowed to drift
 * once already -- the interface emitted `trainingCells` while the pipeline read
 * `training_cells`, nothing rejected the mismatch, and every CFAR control in the
 * workspace destroyed the run it touched. `toCfarRequestParams` is typed against
 * the contract so that gap cannot reopen.
 */
export type { CfarConfigContract };

/** Every speckle mode, in menu order. All three are selectable. */
export const SPECKLE_MODES: readonly SpeckleMode[] = ['none', 'median', 'lee'] as const;

/** Accessible titles for the speckle segmented control. */
export const SPECKLE_MODE_LABELS: Readonly<Record<SpeckleMode, string>> = {
  none: 'None (raw backscatter)',
  median: '3x3 median',
  lee: 'Lee (edge-preserving)',
};

/** `lee` is first-class here, not an unreachable branch. */
export function isSpeckleMode(value: unknown): value is SpeckleMode {
  return typeof value === 'string' && (SPECKLE_MODES as readonly string[]).includes(value);
}

/** The eight request parameters, in the order the surface renders them. */
export type CfarConfigKey =
  | 'trainingCells'
  | 'guardCells'
  | 'thresholdFactor'
  | 'minPixels'
  | 'maxPixels'
  | 'speckleFilter'
  | 'kernelSize'
  | 'coastlineBufferMeters';

export const CFAR_PARAM_KEYS: readonly CfarConfigKey[] = [
  'trainingCells',
  'guardCells',
  'thresholdFactor',
  'minPixels',
  'maxPixels',
  'speckleFilter',
  'kernelSize',
  'coastlineBufferMeters',
] as const;

/** A complete set of CA-CFAR request parameters. */
export interface CfarConfig {
  /** N_train: the reference ring width, in cells. */
  readonly trainingCells: number;
  /** N_guard: the inner guard ring width, in cells. */
  readonly guardCells: number;
  /** alpha: the multiplier applied to the background estimate (P_fa control). */
  readonly thresholdFactor: number;
  /** Smallest connected component kept as a candidate target, in pixels. */
  readonly minPixels: number;
  /** Largest connected component kept; anything bigger is treated as land sliver. */
  readonly maxPixels: number;
  /** Pre-detection speckle filter. */
  readonly speckleFilter: SpeckleMode;
  /** Speckle kernel side, e.g. 3 for a 3x3 median. */
  readonly kernelSize: number;
  /** Distance from the coastline kept out of the detection search, in metres. */
  readonly coastlineBufferMeters: number;
}

export interface ParamSpec {
  readonly key: CfarConfigKey;
  readonly label: string;
  /** Accessible unit suffix, e.g. "cells". */
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** True when the parameter is a whole-cell count. */
  readonly integer: boolean;
}

/**
 * Declared ranges. These mirror the legacy sliders exactly, so a value the old
 * workbench could produce is still reachable here.
 */
export const CFAR_PARAM_SPECS: Readonly<Record<CfarConfigKey, ParamSpec>> = {
  trainingCells: {
    key: 'trainingCells',
    label: 'Training window',
    unit: 'cells',
    min: 8,
    max: 32,
    step: 2,
    integer: true,
  },
  guardCells: {
    key: 'guardCells',
    label: 'Guard window',
    unit: 'cells',
    min: 2,
    max: 8,
    step: 2,
    integer: true,
  },
  thresholdFactor: {
    key: 'thresholdFactor',
    label: 'Threshold multiplier',
    unit: 'x',
    min: 2,
    max: 5.5,
    step: 0.1,
    integer: false,
  },
  minPixels: {
    key: 'minPixels',
    label: 'Min component size',
    unit: 'px',
    min: 1,
    max: 50,
    step: 1,
    integer: true,
  },
  maxPixels: {
    key: 'maxPixels',
    label: 'Max component size',
    unit: 'px',
    min: 100,
    max: 5000,
    step: 50,
    integer: true,
  },
  speckleFilter: {
    key: 'speckleFilter',
    label: 'Speckle filter',
    unit: '',
    min: 0,
    max: 0,
    step: 1,
    integer: true,
  },
  kernelSize: {
    key: 'kernelSize',
    label: 'Speckle kernel',
    unit: 'x',
    min: 3,
    max: 7,
    step: 2,
    integer: true,
  },
  coastlineBufferMeters: {
    key: 'coastlineBufferMeters',
    label: 'Coastline buffer',
    unit: 'm',
    min: 50,
    max: 500,
    step: 25,
    integer: true,
  },
};

// ------------------------------------------------------------------- presets

export interface CfarPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly config: CfarConfig;
}

/** Standard Sentinel-1 IW parameters. The workbench default. */
export const STANDARD_SENTINEL_1: CfarConfig = {
  trainingCells: 16,
  guardCells: 4,
  thresholdFactor: 3.5,
  minPixels: 3,
  maxPixels: 1000,
  speckleFilter: 'median',
  kernelSize: 3,
  coastlineBufferMeters: 150,
};

export const CFAR_PRESETS: readonly CfarPreset[] = [
  {
    id: 'standard',
    name: 'Standard Sentinel-1',
    description: 'Balanced IW parameters for general maritime surveillance.',
    config: STANDARD_SENTINEL_1,
  },
  {
    id: 'high-sensitivity',
    name: 'High Sensitivity',
    description: 'Lower threshold and a narrower guard ring for small craft in calm seas.',
    config: {
      trainingCells: 12,
      guardCells: 2,
      thresholdFactor: 2.7,
      minPixels: 2,
      maxPixels: 1200,
      speckleFilter: 'median',
      kernelSize: 3,
      coastlineBufferMeters: 100,
    },
  },
  {
    id: 'high-clutter',
    name: 'High Clutter',
    description: 'Elevated threshold and a wider guard ring to suppress breaking wave crests.',
    config: {
      trainingCells: 24,
      guardCells: 6,
      thresholdFactor: 4.5,
      minPixels: 4,
      maxPixels: 800,
      speckleFilter: 'median',
      kernelSize: 3,
      coastlineBufferMeters: 200,
    },
  },
] as const;

export const DEFAULT_CFAR_CONFIG: CfarConfig = STANDARD_SENTINEL_1;

export function presetById(id: string): CfarPreset | undefined {
  return CFAR_PRESETS.find((preset) => preset.id === id);
}

// --------------------------------------------------------------- validation

function clampNumber(value: unknown, spec: ParamSpec): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return clamp(value, spec);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    return clamp(parsed, spec);
  }
  return null;
}

function clamp(value: number, spec: ParamSpec): number {
  const bounded = Math.min(spec.max, Math.max(spec.min, value));
  return spec.integer ? Math.round(bounded) : bounded;
}

/**
 * Coerce anything into a valid `CfarConfig`. Invalid or missing values fall
 * back to the standard preset rather than being passed through, so a malformed
 * payload can never become a nonsense request.
 */
export function normalizeCfarConfig(input: unknown, fallback: CfarConfig = DEFAULT_CFAR_CONFIG): CfarConfig {
  if (!isRecord(input)) return fallback;
  const out: Record<string, unknown> = { ...fallback };
  for (const key of CFAR_PARAM_KEYS) {
    if (key === 'speckleFilter') {
      if (isSpeckleMode(input.speckleFilter)) out.speckleFilter = input.speckleFilter;
      continue;
    }
    const parsed = clampNumber(input[key], CFAR_PARAM_SPECS[key]);
    if (parsed !== null) out[key] = parsed;
  }
  return out as unknown as CfarConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------ reducers

/**
 * Replace the whole config with a named preset. Returns the SAME object when the
 * preset already matches, so a React consumer keyed on identity never re-renders
 * for a no-op. An unknown id is ignored entirely.
 */
export function applyPreset(current: CfarConfig, presetId: string): CfarConfig {
  const preset = presetById(presetId);
  if (!preset) return current;
  if (diffConfig(current, preset.config).length === 0) return current;
  return normalizeCfarConfig(preset.config, current);
}

/**
 * Set one parameter. Returns the SAME object when the value is unusable or
 * already in effect, so a React consumer keyed on identity never re-renders for
 * a no-op. A rejected value (NaN, empty string) is dropped rather than passed
 * through; an out-of-range number is clamped to the declared range.
 */
export function updateParam(
  current: CfarConfig,
  key: CfarConfigKey,
  value: number | string,
): CfarConfig {
  if (key === 'speckleFilter') {
    if (!isSpeckleMode(value)) return current;
    return current.speckleFilter === value ? current : { ...current, speckleFilter: value };
  }
  const parsed = clampNumber(value, CFAR_PARAM_SPECS[key]);
  if (parsed === null) return current;
  if (current[key] === parsed) return current;
  return { ...current, [key]: parsed } as CfarConfig;
}

/** Reset to the standard Sentinel-1 preset. */
export function resetConfig(current: CfarConfig): CfarConfig {
  return applyPreset(current, 'standard');
}

// ------------------------------------------------------- recompute signalling

/**
 * Keys whose values differ between two configs, in canonical render order.
 *
 * Stable contract: returns `[]` for two structurally identical configs (even
 * when they are different objects, or when a preset re-applied the same values),
 * and returns exactly the changed keys otherwise. This single function drives
 * the "requires recomputation" flag on the surface.
 */
export function diffConfig(oldConfig: CfarConfig, newConfig: CfarConfig): CfarConfigKey[] {
  const before = normalizeCfarConfig(oldConfig);
  const after = normalizeCfarConfig(newConfig);
  const changed: CfarConfigKey[] = [];
  for (const key of CFAR_PARAM_KEYS) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed;
}

/** True when anything in the request changed. Recompute is a backend job. */
export function requiresRecomputation(oldConfig: CfarConfig, newConfig: CfarConfig): boolean {
  return diffConfig(oldConfig, newConfig).length > 0;
}

export interface RecomputeEntry {
  readonly key: CfarConfigKey;
  readonly label: string;
  readonly unit: string;
  readonly before: string;
  readonly after: string;
}

export interface RecomputeDiff {
  readonly changedKeys: readonly CfarConfigKey[];
  readonly entries: readonly RecomputeEntry[];
  /** False only when the pending config equals the baseline. */
  readonly requiresRecomputation: boolean;
  /** Human sentence rendered verbatim by the surface. */
  readonly summary: string;
}

/** Before/after diagnostics for the pending config, plus the recompute flag. */
export function recomputeDiff(baseline: CfarConfig, pending: CfarConfig): RecomputeDiff {
  const before = normalizeCfarConfig(baseline);
  const after = normalizeCfarConfig(pending);
  const changedKeys = diffConfig(before, after);
  const entries = changedKeys.map((key) => ({
    key,
    label: CFAR_PARAM_SPECS[key].label,
    unit: CFAR_PARAM_SPECS[key].unit,
    before: formatParam(key, before[key]),
    after: formatParam(key, after[key]),
  }));
  const requires = entries.length > 0;
  const summary = requires
    ? `${entries.length} parameter${entries.length === 1 ? '' : 's'} changed. ` +
      'The backend must recompute detections before these values take effect.'
    : 'No parameter change. The last backend result still matches these parameters.';
  return { changedKeys, entries, requiresRecomputation: requires, summary };
}

// ------------------------------------------------------------------ wire form

/**
 * The `cfar_config` payload for `POST /api/scans`, typed as the generated
 * contract. It carries parameters only: the backend re-derives every statistic
 * and every detection.
 *
 * Written as a literal rather than a loop over `CFAR_PARAM_KEYS` on purpose. A
 * loop would type-check against `Record<string, number | string>` whatever the
 * backend called its fields, which is exactly the hole that let casing drift. A
 * literal is checked against `CfarConfigContract`, so renaming a field on either
 * side becomes a compile error here.
 */
export function toCfarRequestParams(config: CfarConfig): CfarConfigContract {
  const n = normalizeCfarConfig(config);
  return {
    trainingCells: n.trainingCells,
    guardCells: n.guardCells,
    thresholdFactor: n.thresholdFactor,
    minPixels: n.minPixels,
    maxPixels: n.maxPixels,
    speckleFilter: n.speckleFilter,
    kernelSize: n.kernelSize,
    coastlineBufferMeters: n.coastlineBufferMeters,
  };
}

/** `3.5x`, `16 cells`, `lee`. Locale independent. */
export function formatParam(key: CfarConfigKey, value: number | string): string {
  if (typeof value === 'string') return SPECKLE_MODE_LABELS[value as SpeckleMode] ?? value;
  const spec = CFAR_PARAM_SPECS[key];
  const text = spec.integer ? String(Math.round(value)) : value.toFixed(1);
  return spec.unit ? `${text} ${spec.unit}` : text;
}

/** Parse a slider string. Returns null when the input is not a usable number. */
export function parseParamInput(raw: string): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
