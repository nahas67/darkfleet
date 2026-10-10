/** Bounded, reversible operator DRAFT edits, never immutable SAR/AIS evidence. */
export interface VertexHistory {
  readonly current: string;
  readonly past: readonly string[];
  readonly future: readonly string[];
}

const LIMIT = 100;

export function initialVertexHistory(current = ''): VertexHistory {
  return { current, past: [], future: [] };
}

export function editVertices(state: VertexHistory, next: string): VertexHistory {
  if (state.current === next) return state;
  return {
    current: next,
    past: [...state.past, state.current].slice(-LIMIT),
    future: [],
  };
}

export function undoVertices(state: VertexHistory): VertexHistory {
  if (!state.past.length) return state;
  return {
    current: state.past[state.past.length - 1],
    past: state.past.slice(0, -1),
    future: [state.current, ...state.future].slice(0, LIMIT),
  };
}

export function redoVertices(state: VertexHistory): VertexHistory {
  if (!state.future.length) return state;
  return {
    current: state.future[0],
    past: [...state.past, state.current].slice(-LIMIT),
    future: state.future.slice(1),
  };
}
