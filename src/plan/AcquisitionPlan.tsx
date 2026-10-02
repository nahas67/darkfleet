/**
 * SAR acquisition plan — GEO-002.
 *
 * Answers "when can this water actually be imaged, and where are the gaps?" from
 * real catalogue acquisitions. This surface renders the backend's measured
 * numbers verbatim and derives nothing (API-011). Data fetching is the caller's
 * job, so this component is purely presentational and testable without a client.
 *
 * Honesty rules enforced here:
 *  - No predicted pass is ever shown. An absent plan is an explicit state, not
 *    an invented schedule.
 *  - `median_revisit_days: null` renders as "insufficient data", never 0 and
 *    never a substituted figure.
 *  - The query window is always displayed next to the statistics, because a
 *    median without its bounds is not a measurement.
 */

import type { RevisitGap, RevisitPlan, RevisitStatistics } from '../app/useApi.ts';

export type { RevisitAcquisition, RevisitGap, RevisitPlan, RevisitStatistics } from '../app/useApi.ts';

/** `null` is a real answer from the backend; it must never become 0. */
export function formatDays(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'insufficient data';
  return `${value.toFixed(1)} d`;
}

export function formatAcquisitionTime(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso.trim() === '') return 'not established';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 'not established';
  return new Date(parsed).toISOString().replace('.000Z', 'Z').slice(0, 19) + 'Z';
}

/** Gaps are ordered longest-first: an operator cares about the holes. */
export function sortGapsBySeverity(gaps: readonly RevisitGap[]): RevisitGap[] {
  return [...gaps].sort((a, b) => {
    if (a.exceeds_nominal !== b.exceeds_nominal) return a.exceeds_nominal ? -1 : 1;
    return b.days - a.days;
  });
}

export function platformSummary(stats: RevisitStatistics): string {
  const entries = Object.entries(stats.acquisitions_per_platform);
  if (entries.length === 0) return 'no platform reported';
  return entries.map(([name, count]) => `${name} (${count})`).join(', ');
}

export interface AcquisitionPlanProps {
  readonly plan: RevisitPlan | null;
  readonly error?: string | null;
  readonly loading?: boolean;
}

export function AcquisitionPlan({
  plan,
  error = null,
  loading = false,
}: AcquisitionPlanProps) {
  return (
    <div data-df-acquisition-plan className="space-y-3">
      <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
        Every acquisition below is one the provider catalogue actually holds. No pass is predicted.
      </p>

      {error && (
        <p className="flex items-start gap-1.5 text-[10px] text-[var(--df-danger)]">{error}</p>
      )}
      {loading && <p className="font-mono text-[10px] text-[var(--df-text-dim)]">Querying catalogue...</p>}

      {!loading && !error && !plan && (
        <p className="font-mono text-[10px] text-[var(--df-text-dim)]">
          No acquisition plan requested yet.
        </p>
      )}

      {plan && plan.acquisition_count === 0 && (
        <p className="text-[10px] leading-snug text-[var(--df-text-dim)]">
          The catalogue holds no acquisition for this area in the queried window. That is not
          evidence that the area is never covered.
        </p>
      )}

      {plan && plan.acquisition_count > 0 && (
        <>
          <dl className="space-y-0.5">
            <Row label="Acquisitions" value={String(plan.acquisition_count)} />
            <Row label="Platforms" value={platformSummary(plan.statistics)} />
            <Row label="Median revisit" value={formatDays(plan.statistics.median_revisit_days)} />
            <Row
              label="Fastest / slowest"
              value={`${formatDays(plan.statistics.min_revisit_days)} / ${formatDays(
                plan.statistics.max_revisit_days,
              )}`}
            />
            <Row
              label={`Gaps over ${plan.statistics.nominal_repeat_days} d cycle`}
              value={String(plan.statistics.flagged_gap_count)}
              tone={plan.statistics.flagged_gap_count > 0 ? 'warn' : 'ok'}
            />
            <Row
              label="Next acquisition"
              value={formatAcquisitionTime(plan.next_after?.acquisition_time)}
            />
            <Row
              label="Window"
              value={`${formatAcquisitionTime(plan.window.start)} to ${formatAcquisitionTime(
                plan.window.end,
              )}`}
            />
          </dl>

          <div>
            <h3 className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">
              Gaps, longest first
            </h3>
            <ul className="space-y-0.5">
              {sortGapsBySeverity(plan.gaps).slice(0, 12).map((gap) => (
                <li
                  key={`${gap.start}-${gap.end}`}
                  className="flex justify-between gap-2 text-[10px]"
                >
                  <span className="text-[var(--df-text-secondary)]">
                    {formatAcquisitionTime(gap.start).slice(0, 10)} to{' '}
                    {formatAcquisitionTime(gap.end).slice(0, 10)}
                  </span>
                  <span
                    className={[
                      'font-mono tabular-nums',
                      gap.exceeds_nominal ? 'text-[var(--df-warning)]' : 'text-[var(--df-text-dim)]',
                    ].join(' ')}
                  >
                    {gap.days.toFixed(1)} d
                    {gap.exceeds_nominal ? ' !' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">
              Acquisitions
            </h3>
            <ul className="space-y-0.5">
              {plan.acquisitions.slice(-8).map((acq) => (
                <li key={acq.item_id} className="text-[10px] text-[var(--df-text-secondary)]">
                  <span className="font-mono">{formatAcquisitionTime(acq.acquisition_time)}</span>
                  <span className="ml-1.5 text-[var(--df-text-dim)]">
                    {acq.polarizations.join('/') || 'polarization not reported'}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {plan.limitations.length > 0 && (
            <div className="border-t border-[var(--df-border)] pt-2">
              <h3 className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--df-text-dim)]">
                What this does not say
              </h3>
              <ul className="space-y-0.5">
                {plan.limitations.map((lim) => (
                  <li key={lim} className="text-[10px] leading-snug text-[var(--df-text-dim)]">
                    {lim}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  tone = 'idle',
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'ok' | 'warn' | 'idle';
}) {
  const toneClass =
    tone === 'warn' ? 'text-[var(--df-warning)]' : tone === 'ok' ? 'text-[var(--df-success)]' : '';
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <dt className="text-[var(--df-text-secondary)]">{label}</dt>
      <dd className={`font-mono tabular-nums ${toneClass}`}>{value}</dd>
    </div>
  );
}

