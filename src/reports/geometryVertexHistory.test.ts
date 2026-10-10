import { describe, expect, it } from 'vitest';
import { editVertices, initialVertexHistory, redoVertices, undoVertices } from './geometryVertexHistory';

describe('operator WGS84 vertex draft history', () => {
  it('reverses globe-added vertices and restores them without rounding or inference', () => {
    const a = editVertices(initialVertexHistory(), '179.9999999, 80.0000000');
    const b = editVertices(a, '179.9999999, 80.0000000\n-179.9999999, 80.0000000');
    expect(undoVertices(b).current).toBe(a.current);
    expect(redoVertices(undoVertices(b)).current).toBe(b.current);
    const atStart = undoVertices(undoVertices(undoVertices(b)));
    expect(atStart.current).toBe('');
    expect(atStart.past).toEqual([]);
    expect(atStart.future).toEqual([a.current, b.current]);
  });

  it('invalidates redo when any manual edit branches the draft and bounds history', () => {
    const undone = undoVertices(editVertices(editVertices(initialVertexHistory(), '0, 0'), '1, 1'));
    expect(undone.future).toEqual(['1, 1']);
    const changed = editVertices(undone, '2, 2');
    expect(changed.future).toEqual([]);
    expect(redoVertices(changed)).toBe(changed);
    let state = initialVertexHistory();
    for (let n = 0; n < 150; n++) state = editVertices(state, String(n));
    expect(state.past).toHaveLength(100);
    expect(state.past[0]).toBe('49');
  });

  it('preserves a deliberate clear as an undoable action and does not alter sensor records', () => {
    const before = initialVertexHistory('103.801, 1.281\n103.811, 1.292');
    const cleared = editVertices(before, '');
    expect(undoVertices(cleared).current).toBe(before.current);
    expect(redoVertices(undoVertices(cleared)).current).toBe('');
  });
});
