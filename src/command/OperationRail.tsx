/**
 * Left operation rail.
 *
 * Every entry opens a workspace that does real work. There is no "more" catch-all
 * and no decorative entry: a control that cannot act is not shipped, because a
 * button that does nothing is worse than an absent one -- it implies a capability
 * the product does not have.
 */

import { store, useStore } from '../state/store';

export type WorkspaceId =
  | 'TACTICAL'
  | 'SEARCH'
  | 'INTELLIGENCE'
  | 'TASKING'
  | 'LAYERS'
  | 'ANALYTICS'
  | 'ADVANCED'
  | 'REPORTS'
  | 'SYSTEM';

type Entry = {
  id: WorkspaceId;
  label: string;
  glyph: string;
};

export const RAIL: readonly Entry[] = [
  { id: 'TACTICAL', label: 'Tactical', glyph: '◎' },
  { id: 'SEARCH', label: 'Search', glyph: '⌕' },
  { id: 'INTELLIGENCE', label: 'Intel', glyph: '◈' },
  { id: 'TASKING', label: 'Tasking', glyph: '⇄' },
  { id: 'LAYERS', label: 'Layers', glyph: '▤' },
  { id: 'ANALYTICS', label: 'Analytics', glyph: '∿' },
  // Revisit planning, multi-pass hypotheses, longitudinal patterns and detector
  // provenance. Shipped only because the backend had all four implemented and
  // unreachable; a rail entry without behaviour is a defect, and this one has a
  // real response for every state including failure.
  { id: 'ADVANCED', label: 'Advanced', glyph: '⌖' },
  { id: 'REPORTS', label: 'Reports', glyph: '⎙' },
  { id: 'SYSTEM', label: 'System', glyph: '⚙' },
];

export function OperationRail() {
  const workspace = useStore().workspace;

  return (
    <nav
      className="df-panel relative z-30 flex w-[58px] shrink-0 flex-col border-y-0 border-l-0"
      aria-label="Operation rail"
      data-df-rail
    >
      {RAIL.map((entry) => {
        const active = workspace === entry.id;
        return (
          <button
            key={entry.id}
            type="button"
            className="group relative flex h-14 w-full flex-col items-center justify-center gap-0.5 text-ink-dim transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-info"
            style={active ? { color: 'var(--df-text)' } : undefined}
            aria-current={active ? 'page' : undefined}
            aria-pressed={active}
            title={entry.label}
            data-df-rail-entry={entry.id}
            onClick={() => store.set({ workspace: active ? 'TACTICAL' : entry.id })}
          >
            {/* The active marker is a bar, not a fill: a filled block reads as a
                button state, a bar reads as a position in a sequence. */}
            <span
              aria-hidden="true"
              className="absolute left-0 top-2 h-10 w-0.5"
              style={{ background: active ? 'var(--df-cyan)' : 'transparent' }}
            />
            <span className="text-[15px] leading-none" aria-hidden="true">
              {entry.glyph}
            </span>
            <span className="df-rail-label">{entry.label}</span>
          </button>
        );
      })}
    </nav>
  );
}