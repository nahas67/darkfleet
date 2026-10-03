/**
 * Detector provenance (DF-X6C).
 *
 * Every detection in this product came from a named detector, and the operator is
 * entitled to know which one and what it is and is not good for. The registry is
 * served by `GET /api/detectors`; this panel reads it and shows the fields the
 * backend actually provides.
 *
 * WHY IT IS COLLAPSED BY DEFAULT
 *
 * Provenance is not the question an analyst opens with. "What is this bright
 * thing?" is. So the panel states the active detector in one line and keeps the
 * detail behind a disclosure, rather than filling half the screen with metadata
 * before any image has been looked at.
 *
 * DETERMINISM IS STATED, NOT IMPLIED
 *
 * `weights_digest` is null for a deterministic detector and populated for a
 * trained one. That is the field that separates them, so it is read rather than
 * inferred from the detector's name -- a detector called "learned-cfar" with a
 * null digest is telling you something, and paraphrasing it would lose that.
 */

import { useEffect, useState } from 'react';

import { api } from '../api/errors';
import type { DetectorsOut, DetectorCardOut } from '../api/contract';

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly payload: DetectorsOut }
  | { readonly status: 'failed'; readonly detail: string };

export function DetectorProvenance() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void api
      .get<DetectorsOut>('/api/detectors')
      .then((payload) => {
        if (!cancelled) setState({ status: 'ready', payload });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = state.status === 'ready' ? findActive(state.payload) : null;

  return (
    <aside
      className="df-scroll h-full min-w-0 flex-1 overflow-y-auto"
      data-df-detector
      aria-label="Detector provenance"
    >
      <header className="df-panel-head">
        <span className="df-label">Detector</span>
      </header>

      <div className="px-2 py-1">
        {state.status === 'loading' ? (
          <p className="df-mono text-[10px] text-ink-dim">READING REGISTRY…</p>
        ) : null}

        {state.status === 'failed' ? (
          <p className="df-mono text-[10px]" style={{ color: 'var(--df-red)' }} role="alert">
            REGISTRY UNAVAILABLE — {state.detail}
          </p>
        ) : null}

        {state.status === 'ready' ? (
          <>
            <p className="df-mono text-[11px] text-ink-2" data-df-detector-active>
              {active ? `${active.name} · ${active.kind.toUpperCase()}` : state.payload.default}
            </p>
            {active ? (
              <p
                className="df-mono text-[10px]"
                style={{ color: 'var(--df-ink-dim)' }}
                data-df-detector-determinism
              >
                {active.weights_digest == null
                  ? 'DETERMINISTIC — NO LEARNED WEIGHTS'
                  : `WEIGHTS ${active.weights_digest}`}
              </p>
            ) : null}

            <details className="mt-1" data-df-detector-details>
              <summary className="df-label cursor-pointer text-[10px]">
                PROVENANCE ({(state.payload.detectors ?? []).length})
              </summary>
              <div className="mt-1 space-y-2">
                {(state.payload.detectors ?? []).map((d) => (
                  <DetectorCard key={d.name} card={d} />
                ))}
                {state.payload.note ? (
                  <p className="text-[10px] leading-relaxed text-ink-dim">· {state.payload.note}</p>
                ) : null}
              </div>
            </details>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function findActive(payload: DetectorsOut): DetectorCardOut | null {
  const cards = payload.detectors ?? [];
  return cards.find((d) => d.name === payload.default) ?? cards[0] ?? null;
}

function DetectorCard({ card }: { card: DetectorCardOut }) {
  const rows: Array<[string, string | null | undefined]> = [
    ['NAME', card.name],
    ['KIND', card.kind],
    ['TRAINING DOMAIN', card.training_domain],
    ['INPUT PRODUCT', card.input_product],
    ['VALIDATION DATA', card.validation_data],
    ['WEIGHTS DIGEST', card.weights_digest],
    ['LIMITATIONS', card.limitations],
  ];
  return (
    <dl className="border-t border-structural/20 pt-1" data-df-detector-card={card.name}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-1 text-[10px] leading-relaxed">
          <dt className="shrink-0 text-ink-dim">{k}</dt>
          <dd className="text-ink-2">{v == null || v === '' ? '—' : v}</dd>
        </div>
      ))}
    </dl>
  );
}