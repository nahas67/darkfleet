/**
 * Top command strip.
 *
 * Real state only. Every counter here is derived from loaded data; when there is
 * no scan, counters read as dashes rather than as zero, because "zero
 * detections" and "no scan has run" are different facts.
 */

import { useEffect, useState } from 'react';

import { SCAN_STAGE_ORDER } from '../api/contract';
import { SCAN_PIPELINE } from '../types/api';
import { useStore } from '../state/store';
import { fmtUtc, NOT_ESTABLISHED } from '../design/format';

function useUtcClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return `${now.toISOString().slice(11, 19)}Z`;
}

function Counter({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap px-2" data-df-counter={label}>
      <span className="df-label text-[10px] text-ink-dim">{label}</span>
      <span className="df-num" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}

export function TopStrip() {
  const state = useStore();
  const utc = useUtcClock();
  const PIPELINE_LENGTH = SCAN_PIPELINE.length;

  const hasScan = state.scanId !== null;
  const matched = state.targets.filter((t) => t.classification === 'SAR_MATCHED_AIS').length;
  const unmatched = state.targets.filter((t) => t.classification === 'SAR_UNMATCHED').length;

  // Worst-member severity: a group reports its worst member so one failing
  // provider can never hide behind a healthy sibling.
  const sar = state.providers.filter((p) => !/ais/i.test(p.provider));
  const ais = state.providers.filter((p) => /ais/i.test(p.provider));
  const worst = (list: typeof state.providers): string => {
    if (list.length === 0) return NOT_ESTABLISHED;
    const order = [
      'AVAILABLE',
      'DEGRADED',
      'STALE',
      'RATE_LIMITED',
      'AUTH_REQUIRED',
      'NO_COVERAGE',
      'UNAVAILABLE',
      'NOT_CONFIGURED',
    ];
    let best = 'AVAILABLE';
    for (const entry of list) {
      const status = String((entry as { status?: string }).status ?? 'NOT_CONFIGURED');
      if (order.indexOf(status) > order.indexOf(best)) best = status;
    }
    return best;
  };

  // Position within the PIPELINE, not the enum. FAILED is an exit from any
  // stage rather than a step, so counting it made the last stage unreachable
  // and a COMPLETE scan read 14/16.
  const stageIndex = SCAN_STAGE_ORDER.indexOf(state.scanStage as never);
  const pipelinePosition =
    stageIndex >= 0 && (state.scanStage as string) !== 'FAILED' ? stageIndex + 1 : 0;

  return (
    <header
      className="df-panel relative z-30 flex h-9 shrink-0 items-center border-x-0 border-t-0"
      data-df-top-strip
    >
      <div className="flex min-w-0 items-center gap-2 px-3">
        <span className="df-label shrink-0 text-[13px] tracking-[0.22em] text-ink">DARKFLEET</span>
        <span className="h-3 w-px shrink-0 bg-structural" />
        <span
          className="df-label min-w-0 max-w-24 truncate text-[10px] 2xl:max-w-56"
          data-df-mission
          title={state.scene?.item_id ?? 'NO MISSION'}
        >
          {state.scene?.item_id ? state.scene.item_id : 'NO MISSION'}
        </span>
      </div>

      <div className="ml-2 flex items-center gap-1">
        <Counter label="SAR" value={worst(sar)} />
        <Counter label="AIS" value={worst(ais)} />
      </div>

      <div className="mx-2 h-3 w-px bg-structural" />

      <div className="flex items-center gap-1 overflow-hidden">
        <Counter label="DET" value={hasScan ? String(state.targets.length) : NOT_ESTABLISHED} />
        <Counter label="MATCH" value={hasScan ? String(matched) : NOT_ESTABLISHED} tone="var(--df-green)" />
        <Counter
          label="UNMATCHED"
          value={hasScan ? String(unmatched) : NOT_ESTABLISHED}
          tone="var(--df-amber)"
        />
        <Counter label="AIS-ONLY" value={hasScan ? String(state.aisOnly.length) : NOT_ESTABLISHED} />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap px-3">
        <span className="df-label text-[10px]" data-df-stream-state>
          {hasScan ? `STAGE ${pipelinePosition}/${PIPELINE_LENGTH}` : 'IDLE'}
        </span>
        <span className="df-num text-ink-2">{state.streamState}</span>
        <span className="h-3 w-px bg-structural" />
        <span className="df-num text-ink" data-df-utc>
          {utc}
        </span>
      </div>
    </header>
  );
}

export { fmtUtc };