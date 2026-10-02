/**
 * Global keyboard shortcuts.
 *
 * Bound at the window so they work regardless of focus, and skipped when the
 * operator is typing -- a shortcut that fires inside a text field is worse than
 * no shortcut at all.
 */

import { useEffect } from 'react';

import { engine } from '../globe/engine';
import { store, useStore } from '../state/store';

export const SHORTCUTS = [
  { keys: 'Esc', action: 'Close workspace or clear selection' },
  { keys: '/', action: 'Focus search' },
  { keys: 'N', action: 'Next target' },
  { keys: 'P', action: 'Previous target' },
  { keys: 'H', action: 'Reset camera to global view' },
  { keys: 'L', action: 'Toggle layer console' },
  { keys: '?', action: 'Show this list' },
] as const;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useGlobalKeys(): void {
  const state = useStore();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape') {
        // Escape closes the workspace, or clears the selection if none is open.
        if (state.workspace !== 'TACTICAL') store.set({ workspace: 'TACTICAL' });
        else if (state.selection.kind !== 'none') store.select({ kind: 'none' });
        return;
      }

      if (isTyping(event.target)) return;

      const step = (delta: 1 | -1) => {
        if (state.targets.length === 0) return;
        const selectedId =
          state.selection.kind === 'target' ? state.selection.targetId : null;
        const index =
          selectedId === null ? -1 : state.targets.findIndex((t) => t.id === selectedId);
        const next = (index + delta + state.targets.length) % state.targets.length;
        const target = state.targets[next];
        store.select({ kind: 'target', targetId: target.id });
        engine.flyTo(target.lat, target.lon);
      };

      switch (event.key) {
        case '/':
          event.preventDefault();
          store.set({ workspace: 'SEARCH' });
          break;
        case 'n':
        case 'N':
          event.preventDefault();
          step(1);
          break;
        case 'p':
        case 'P':
          event.preventDefault();
          step(-1);
          break;
        case 'h':
        case 'H':
          event.preventDefault();
          engine.resetCamera();
          store.set({ followingMmsi: null });
          break;
        case 'l':
        case 'L':
          event.preventDefault();
          store.set({ workspace: state.workspace === 'LAYERS' ? 'TACTICAL' : 'LAYERS' });
          break;
        case '?':
          event.preventDefault();
          store.set({ workspace: state.workspace === 'SYSTEM' ? 'TACTICAL' : 'SYSTEM' });
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.workspace, state.selection, state.targets]);
}