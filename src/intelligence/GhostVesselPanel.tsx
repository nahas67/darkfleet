/**
 * Ghost Vessel workspace (GFST).
 *
 * The analytical class is `SAR_UNMATCHED`. This surface renders the product
 * designation ABOVE it and never instead of it, and it never merges OBSERVED,
 * HYPOTHESES and UNKNOWNS — the risk in this feature is entirely in how the
 * words are arranged, so the arrangement is structural rather than editorial.
 *
 * The semantic warning is not dismissible and not styled as a minor note. An
 * analyst who reads only this panel must still leave knowing that no
 * association was found and that this establishes nothing about why.
 */

import { useEffect, useState } from 'react';

import { loadTrack } from '../api/client';
import { NOT_ESTABLISHED, fmt, fmtConfidence, fmtMetres } from '../design/format';
import {
  HYPOTHESES,
  UNKNOWNS,
  GHOST_LABEL,
  GHOST_WARNING,
  isGhostVessel,
} from '../ghost_vessel';
import { store, useStore } from '../state/store';
import type { SarTarget } from '../state/store';

export function GhostVesselPanel({ target }: { target: SarTarget }) {
  const state = useStore();
  const [details, setDetails] = useState<GhostDetails | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/targets/${target.id}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { evidence?: GhostDetails };
        if (!cancelled) setDetails(body.evidence ?? null);
      } catch {
        // A failed lookup is an UNKNOWN state, distinct from "there is nothing
        // here". The panel says so rather than showing an empty dossier.
        if (!cancelled) setDetails(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.id]);

  const ghost = isGhostVessel(target.classification);
  const decision = details?.ghost_vessel?.decision;
  const rejected = decision?.closestRejectedCandidate ?? null;
  const coverage = state.aisCoverage;

  return (
    <div className="space-y-3" data-df-ghost-vessel={ghost ? 'true' : 'false'}>
      {ghost ? (
        <>
          {/* The designation. Rendered above the analytical class, which is
              always visible beneath it. */}
          <header className="df-clipped border-l-2 border-warn bg-raised/40 px-3 py-2">
            <p
              className="df-label text-[13px]"
              style={{ color: 'var(--df-amber)' }}
              data-df-ghost-label
            >
              {GHOST_LABEL}
            </p>
            <p className="df-mono mt-0.5 text-[10px] text-ink-2">
              {target.classification} · analytical classification
            </p>
          </header>

          {/* Not dismissible, not a footnote. */}
          <p
            className="border-l-2 border-warn pl-2 text-[11px] leading-relaxed text-ink-2"
            style={{ borderColor: 'var(--df-amber)' }}
            role="note"
            data-df-ghost-warning
          >
            {GHOST_WARNING}
          </p>
        </>
      ) : null}

      <Block title="Observed">
        <Row label="Target" value={target.id} />
        <Row label="Position" value={`${target.lat.toFixed(5)}, ${target.lon.toFixed(5)}`} />
        <Row label="SAR confidence" value={fmtConfidence(target.sarConf)} />
        <Row
          label="Geolocation uncertainty"
          value={
            target.geolocationUncertaintyM === null
              ? NOT_ESTABLISHED
              : fmtMetres(target.geolocationUncertaintyM)
          }
        />
        <Row label="AIS association" value="none accepted" />
      </Block>

      {/* Why no association was accepted — arithmetic, not assertion. */}
      <Block title="Decision">
        {loading ? (
          <p className="text-[11px] text-ink-dim">Reading the association record…</p>
        ) : (
          <>
            <Row
              label="AIS candidates considered"
              value={
                decision?.candidatesConsidered === undefined
                  ? NOT_ESTABLISHED
                  : String(decision.candidatesConsidered)
              }
            />
            <Row
              label="Acceptance threshold"
              value={
                decision?.acceptanceThreshold == null
                  ? NOT_ESTABLISHED
                  : decision.acceptanceThreshold?.toFixed(2) ?? NOT_ESTABLISHED
              }
            />
            <Row
              label="AIS coverage"
              value={coverage ? coverage.state.replace(/_/g, ' ') : NOT_ESTABLISHED}
            />
            {rejected ? (
              <div className="mt-2 border-l-2 border-structural-bright pl-2">
                <p className="df-label text-[10px]">Closest rejected candidate</p>
                <Row label="MMSI" value={rejected.mmsi} />
                <Row label="Name" value={rejected.vesselName ?? 'not reported'} />
                <Row label="Score" value={rejected.score.toFixed(2)} />
                <Row
                  label="Short by"
                  value={rejected.shortfall.toFixed(2)}
                />
                <Row label="Separation" value={fmtMetres(rejected.distanceMeters)} />
                <Row
                  label="Time offset"
                  value={`${rejected.timeDeltaSeconds.toFixed(0)} s`}
                />
              </div>
            ) : (
              <p className="mt-2 text-[11px] leading-relaxed text-ink-2">
                No AIS candidate was available to correlate in the search window. That is a
                different finding from a near miss, and the two are not merged.
              </p>
            )}
          </>
        )}
      </Block>

      {ghost ? (
        <>
          <HypothesisBlock items={details?.ghost_vessel?.hypotheses ?? details?.hypotheses} />
          <UnknownBlock items={details?.ghost_vessel?.unknowns ?? details?.unknowns} />
        </>
      ) : null}

      {target.mmsi ? (
        <button
          type="button"
          className="df-btn w-full justify-center"
          onClick={() => {
            store.select({ kind: 'mmsi', mmsi: target.mmsi as string });
            void loadTrack(target.mmsi as string);
          }}
        >
          Inspect reported MMSI
        </button>
      ) : null}
    </div>
  );
}

/**
 * The evidence document, narrowed to what this panel reads.
 *
 * Typed from the generated contract rather than `Record<string, unknown>`: an
 * untyped record silently turns every field into `{}`, which is how a renamed
 * backend field becomes a runtime crash rather than a compile error.
 */
type Rejected = {
  mmsi: string;
  vesselName?: string | null;
  score: number;
  distanceMeters: number;
  timeDeltaSeconds: number;
  shortfall: number;
};

type Decision = {
  candidatesConsidered?: number;
  acceptanceThreshold?: number | null;
  closestRejectedCandidate?: Rejected | null;
  reasonNoAssociation?: string;
  aisCoverageState?: string;
};

type GhostBlock = {
  designation?: string | null;
  semanticWarning?: string;
  decision?: Decision | null;
  hypotheses?: Array<{ text: string }>;
  unknowns?: Array<{ text: string }>;
};

type GhostDetails = {
  ghost_vessel?: GhostBlock;
  hypotheses?: Array<{ text: string }>;
  unknowns?: Array<{ text: string }>;
};

/** An evidence block always renders, even when empty. */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section data-df-evidence-block={title}>
      <h3 className="df-label mb-1 text-[10px]">{title}</h3>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-structural/40 py-0.5">
      <span className="df-label text-[10px] text-ink-dim">{label}</span>
      <span className="df-num text-right text-[10px] text-ink">{value}</span>
    </div>
  );
}

/**
 * Hypotheses and unknowns are separate components, not one list with a heading.
 * A reader who skims must not be able to take a hypothesis for a measurement.
 */
function HypothesisBlock({ items }: { items?: Array<{ text: string }> }) {
  const rows = items?.length ? items : HYPOTHESES.map((text) => ({ text }));
  return (
    <section data-df-evidence-block="Hypotheses">
      <h3 className="df-label mb-1 text-[10px]">Hypotheses</h3>
      <ul className="space-y-1">
        {rows.map((item) => (
          <li key={item.text} className="flex gap-2 text-[11px] leading-relaxed text-ink-2">
            <span aria-hidden="true" className="text-ink-dim">·</span>
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
      <p className="df-num mt-1 text-[10px] text-ink-dim">
        Explanations for the observation. None is established.
      </p>
    </section>
  );
}

function UnknownBlock({ items }: { items?: Array<{ text: string }> }) {
  const rows = items?.length ? items : UNKNOWNS.map((text) => ({ text }));
  return (
    <section data-df-evidence-block="Unknowns">
      <h3 className="df-label mb-1 text-[10px]">Unknowns</h3>
      <ul className="space-y-1">
        {rows.map((item) => (
          <li key={item.text} className="flex gap-2 text-[11px] leading-relaxed text-ink-dim">
            <span aria-hidden="true" className="text-ink-dim">·</span>
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export { fmt };