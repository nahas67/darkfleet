/**
 * The single formatter.
 *
 * Every "this value is not established" decision in the product routes through
 * here. That centralisation is the point: when the retired UI had per-panel
 * formatters, panels drifted into rendering an absent measurement as `0`, `--`,
 * or an empty cell, and an empty cell is indistinguishable from "not looked up".
 *
 * The rule: absence renders as words. Never as a number, never as a dash, never
 * as an empty string.
 */

/** Rendered wherever a value has not been established. */
export const NOT_ESTABLISHED = 'not established';

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A measurement, or an explicit "not established". */
export function fmt(value: unknown, digits = 2): string {
  return isFiniteNumber(value) ? value.toFixed(digits) : NOT_ESTABLISHED;
}

/** Text, or "not established". An empty string is absence, not a value. */
export function fmtText(value: unknown): string {
  if (value === null || value === undefined) return NOT_ESTABLISHED;
  const text = String(value).trim();
  return text.length > 0 ? text : NOT_ESTABLISHED;
}

/** Decimal degrees with hemisphere letters, as a chart would read it. */
export function fmtLatLon(lat: unknown, lon: unknown, digits = 5): string {
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return NOT_ESTABLISHED;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}°${ns}  ${Math.abs(lon).toFixed(digits)}°${ew}`;
}

/** Metres, switching to km past 1000 so a column does not read `1283440 m`. */
export function fmtMetres(value: unknown): string {
  if (!isFiniteNumber(value)) return NOT_ESTABLISHED;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} km`;
  return `${value.toFixed(1)} m`;
}

/** Nautical miles. Speeds and small distances in this product are nautical. */
export function fmtNauticalMiles(value: unknown): string {
  if (!isFiniteNumber(value)) return NOT_ESTABLISHED;
  return `${value.toFixed(2)} NM`;
}

export function fmtKnots(value: unknown): string {
  if (!isFiniteNumber(value)) return NOT_ESTABLISHED;
  return `${value.toFixed(1)} kn`;
}

export function fmtDegrees(value: unknown): string {
  if (!isFiniteNumber(value)) return NOT_ESTABLISHED;
  return `${value.toFixed(1)}°`;
}

/** A compass bearing as a three-digit true bearing, or "not established". */
export function fmtBearing(value: unknown): string {
  if (!isFiniteNumber(value)) return NOT_ESTABLISHED;
  const wrapped = ((value % 360) + 360) % 360;
  return `${wrapped.toFixed(0).padStart(3, '0')}°`;
}

/** UTC, always. This product has no local-time mode; a timeline in two zones is worse. */
export function fmtUtc(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return NOT_ESTABLISHED;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return NOT_ESTABLISHED;
  return `${date.toISOString().slice(11, 19)}Z`;
}

export function fmtUtcDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return NOT_ESTABLISHED;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return NOT_ESTABLISHED;
  return date.toISOString().slice(0, 10);
}

/** Full ISO instant, for provenance and evidence lines. */
export function fmtInstant(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return NOT_ESTABLISHED;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return NOT_ESTABLISHED;
  return `${date.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/**
 * Relative age, for freshness. Honest wording: a source that has never reported
 * says so rather than showing "0s ago".
 */
export function fmtAge(value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined || value === '') return NOT_ESTABLISHED;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return NOT_ESTABLISHED;
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * A signed time delta, used on the timeline.
 *
 * Seconds are kept to two minutes: AIS correlation windows are +/- 15 minutes, so
 * the deltas an analyst actually compares live in the tens and hundreds of
 * seconds. Switching to minutes at 60s printed "+1.5m" where "+90s" is clearer.
 */
export function fmtDelta(seconds: unknown): string {
  if (!isFiniteNumber(seconds)) return NOT_ESTABLISHED;
  if (Math.abs(seconds) < 1) return '0s';
  const sign = seconds > 0 ? '+' : '-';
  const abs = Math.abs(seconds);
  if (abs <= 120) return `${sign}${Math.round(abs)}s`;
  if (abs < 3600) return `${sign}${(abs / 60).toFixed(1)}m`;
  return `${sign}${(abs / 3600).toFixed(2)}h`;
}

/** Confidence as a percentage. Never renders a bare 0 for an unestablished score. */
export function fmtConfidence(value: unknown): string {
  if (!isFiniteNumber(value)) return NOT_ESTABLISHED;
  return `${(value * 100).toFixed(0)}%`;
}

export function fmtConfidence3(value: unknown): string {
  if (!isFiniteNumber(value)) return NOT_ESTABLISHED;
  return value.toFixed(3);
}

/**
 * Format a table of measurements, dropping the ones that were never established.
 *
 * Returning fewer rows rather than rows of "not established" is deliberate: in
 * an evidence panel, a wall of absent values buries the two or three that were
 * actually measured.
 */
export function fmtRows(
  entries: ReadonlyArray<readonly [label: string, value: unknown, render?: (v: unknown) => string]>,
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [label, value, render] of entries) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out.push({ label, value: render ? render(value) : fmtText(value) });
  }
  return out;
}