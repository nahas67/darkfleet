/**
 * Dense presentation primitives for the dossier.
 *
 * These exist because the repo had no shared component layer: `Row` was
 * duplicated between `TargetIntel` and `GhostVesselPanel`, and the tables were
 * hand-built per panel. A dossier with eleven tabs that each invent their own row
 * markup will not read as one surface, and the duplication is where the key/value
 * alignment drifts.
 *
 * Style follows the existing conventions rather than inventing new ones: `.df-*`
 * structural classes from `design/tokens.css` for typography and rules, Tailwind
 * utilities for one-off layout. Dark theme only, which is the only theme.
 *
 * DENSE ON PURPOSE
 *
 * This is an investigation surface, not a consumer product. Rows are tight,
 * numbers are monospaced and right-aligned, and there is no card padding between
 * every field. An operator reading eleven tabs wants more facts per screen, not
 * more whitespace between them.
 */

import type { ReactNode } from 'react';

import { ABSENT_LABEL, isAbsent, type Absent } from './format';

/* ------------------------------------------------------------------ key/value */

export function Row({
  label,
  children,
  tone = 'default',
}: {
  label: string;
  children: ReactNode;
  tone?: 'default' | 'ghost' | 'warn' | 'fault';
}) {
  const toneClass =
    tone === 'warn'
      ? 'text-warn'
      : tone === 'fault'
        ? 'text-fault'
        : tone === 'ghost'
          ? 'text-ink-dim'
          : 'text-ink-2';
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-structural/40 py-[3px] last:border-b-0">
      <span className={`df-label text-[10px] uppercase ${toneClass} shrink-0`}>{label}</span>
      <span className="df-num text-right text-[11px] min-w-0 break-words">{children}</span>
    </div>
  );
}

/**
 * Render a value that may be an absence.
 *
 * The reason string is shown verbatim and never coerced, which is the single rule
 * that keeps this surface honest. An absent value is styled dim so it reads as
 * absent at a glance without needing to be parsed.
 */
export function Maybe({ value }: { value: string | Absent | null | undefined }) {
  if (value === null || value === undefined) {
    return <AbsentText reason="NOT_ESTABLISHED" />;
  }
  if (isAbsent(value)) return <AbsentText reason={value.reason} />;
  return <>{value}</>;
}

export function AbsentText({ reason }: { reason: keyof typeof ABSENT_LABEL }) {
  return (
    <span className="text-ink-dim" title={`This field is ${ABSENT_LABEL[reason].toLowerCase()}`}>
      {ABSENT_LABEL[reason]}
    </span>
  );
}

/* ----------------------------------------------------------------- headings */

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="df-panel-head flex items-center justify-between gap-2">
      <span className="df-label text-[10px] uppercase tracking-wider">{children}</span>
      {right}
    </div>
  );
}

export function SubTitle({ children }: { children: ReactNode }) {
  return <div className="df-label pt-2 text-[10px] uppercase text-ink-dim">{children}</div>;
}

/* --------------------------------------------------------------------- pill */

export type PillTone = 'neutral' | 'info' | 'warn' | 'fault' | 'assoc' | 'ok';

/**
 * A status pill.
 *
 * Tone is passed explicitly rather than inferred from the label text. Inference
 * from text is how a warning colour ends up on "NOT AVAILABLE" because it contains
 * the substring "ABLE".
 */
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: PillTone }) {
  const toneClass =
    tone === 'info'
      ? 'border-info/60 text-info'
      : tone === 'warn'
        ? 'border-warn/60 text-warn'
        : tone === 'fault'
          ? 'border-fault/60 text-fault'
          : tone === 'assoc'
            ? 'border-assoc/60 text-assoc'
            : tone === 'ok'
              ? 'border-ok/60 text-ok'
              : 'border-structural text-ink-2';
  return (
    <span className={`inline-block border px-1.5 py-[1px] text-[10px] uppercase tracking-wide ${toneClass}`}>
      {children}
    </span>
  );
}

/**
 * The mandated product-status banner.
 *
 * A distinct component because these strings are fixed product copy with a
 * regulatory reason behind them, and a tab edit should not be able to quietly
 * drop one. They are asserted in `format.test.ts`.
 */
export function StatusBanner({ lines, tone = 'warn' }: { lines: readonly string[]; tone?: PillTone }) {
  return (
    <div
      className={`mb-2 border px-2 py-1.5 ${tone === 'fault' ? 'border-fault/50' : 'border-warn/50'}`}
      role="note"
    >
      {lines.map((line, index) => (
        <div
          key={line}
          className={`text-[10px] uppercase tracking-wider ${
            index === 0 ? 'text-ink font-semibold' : tone === 'fault' ? 'text-fault' : 'text-warn'
          }`}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- tables */

export type Column<T> = {
  key: string;
  header: string;
  /** Right-align numeric columns so magnitudes compare down the column. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
};

/**
 * A dense table.
 *
 * `numeric` right-aligns, which sounds cosmetic and is not: an analyst comparing
 * score components across candidate rows needs decimal points to line up, and
 * left-aligned numbers make that comparison a manual task.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  empty,
  caption,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T, index: number) => string;
  empty: ReactNode;
  caption?: string;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="df-scroll-x">
      <table className="w-full border-collapse text-[11px]">
        {caption ? <caption className="df-label text-left text-[10px] text-ink-dim">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`df-label border-b border-structural px-1.5 py-1 text-[10px] font-normal uppercase ${
                  column.numeric ? 'text-right' : 'text-left'
                }`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)} className="border-b border-structural/30 last:border-b-0">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`df-num px-1.5 py-1 align-baseline ${column.numeric ? 'text-right' : 'text-left'}`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------- empty states */

export function Empty({ heading, detail }: { heading: string; detail?: ReactNode }) {
  return (
    <div className="border border-structural/50 px-2 py-3">
      <div className="df-label text-[10px] uppercase text-ink-2">{heading}</div>
      {detail ? <div className="pt-1 text-[11px] text-ink-dim">{detail}</div> : null}
    </div>
  );
}

/**
 * A tab-level error.
 *
 * Scoped to the tab that owns it. An optional evidence channel failing must not
 * hide the rest of the dossier, so this never replaces the workspace and never
 * sits above the other tabs.
 */
export function TabError({ reason }: { reason: string }) {
  return (
    <div className="border border-fault/50 px-2 py-2" role="alert">
      <div className="df-label text-[10px] uppercase text-fault">This tab could not load</div>
      <div className="pt-1 text-[11px] text-ink-2">{reason}</div>
      <div className="pt-1 text-[10px] text-ink-dim">
        The rest of the dossier is unaffected. Every value on this tab is absent rather than
        wrong.
      </div>
    </div>
  );
}

export function TabLoading({ label }: { label: string }) {
  return (
    <div className="px-2 py-3 text-[11px] text-ink-dim" aria-busy="true" aria-live="polite">
      Loading {label}…
    </div>
  );
}

/* ----------------------------------------------------------------- bar chart */

/**
 * A horizontal magnitude bar.
 *
 * Used for score decomposition. The numeric value is always printed beside the
 * bar: a bar alone cannot be compared precisely, and a score an operator has to
 * eyeball is a score they will misread.
 */
export function MagnitudeBar({
  label,
  value,
  max,
  digits = 3,
}: {
  label: string;
  value: number | null | undefined;
  max: number;
  digits?: number;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return (
      <div className="flex items-baseline justify-between gap-2 py-[2px]">
        <span className="df-label text-[10px] uppercase text-ink-dim">{label}</span>
        <AbsentText reason="NOT_ESTABLISHED" />
      </div>
    );
  }
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div className="py-[2px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="df-label text-[10px] uppercase text-ink-2">{label}</span>
        <span className="df-num text-[11px]">{value.toFixed(digits)}</span>
      </div>
      <div className="mt-[2px] h-[3px] w-full bg-structural/60" role="presentation">
        <div className="h-full bg-info" style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- evidence */

/**
 * Observed / Hypotheses / Unknowns.
 *
 * The three-block structure is the semantic core of the whole product and is
 * centralised here so no tab can invent its own version. The ordering matters:
 * what was measured, what might explain it, and what remains unknown are three
 * different epistemic registers and must never be merged into prose.
 */
export function Epistemics({
  observed,
  hypotheses,
  unknowns,
}: {
  observed: readonly string[];
  hypotheses: readonly string[];
  unknowns: readonly string[];
}) {
  return (
    <div className="space-y-2">
      <EpistemicBlock
        heading="Observed"
        tone="info"
        items={observed}
        empty="Nothing was observed for this target."
      />
      <EpistemicBlock
        heading="Hypotheses"
        tone="neutral"
        items={hypotheses}
        empty="No hypothesis has been formed."
      />
      <EpistemicBlock
        heading="Unknowns"
        tone="warn"
        items={unknowns}
        empty="Nothing further is recorded as unknown."
      />
    </div>
  );
}

function EpistemicBlock({
  heading,
  items,
  empty,
  tone,
}: {
  heading: string;
  items: readonly string[];
  empty: string;
  tone: 'info' | 'neutral' | 'warn';
}) {
  const toneClass = tone === 'info' ? 'text-info' : tone === 'warn' ? 'text-warn' : 'text-ink-2';
  return (
    <div>
      <div className={`df-label text-[10px] uppercase ${toneClass}`}>{heading}</div>
      {items.length === 0 ? (
        <div className="pt-0.5 text-[11px] text-ink-dim">{empty}</div>
      ) : (
        <ul className="list-inside list-disc pt-0.5 text-[11px] text-ink-2">
          {items.map((item, index) => (
            <li key={`${heading}-${index}`}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ details */

/** A provenance drawer. Collapsed by default; provenance is not a reading surface. */
export function Provenance({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="border border-structural/50">
      <summary className="df-label cursor-pointer px-2 py-1 text-[10px] uppercase text-ink-2">
        {label}
      </summary>
      <div className="border-t border-structural/40 px-2 py-1.5">{children}</div>
    </details>
  );
}