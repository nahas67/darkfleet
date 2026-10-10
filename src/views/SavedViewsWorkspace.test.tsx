import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedViewsWorkspace, focusViewNameInput } from './SavedViewsWorkspace';
import { RAIL } from '../command/OperationRail';

describe('Durable saved views operator access', () => {
  it('keeps save and update discoverable in the globally reachable Views workspace', () => {
    const html = renderToStaticMarkup(<SavedViewsWorkspace />);
    expect(RAIL.some((entry) => entry.id === 'VIEWS')).toBe(true);
    expect(html).toContain('data-df-workspace="VIEWS"');
    expect(html).toContain('data-df-view-save');
    expect(html).toContain('data-df-view-update');
    expect(html).toContain('data-df-view-refresh');
    expect(html).toContain('Loading saved views');
    expect(html).toContain('Original satellite and AIS');
  });
  it('EDIT NAME focuses and selects the editable input rather than silently resetting its text', () => {
    const focus = vi.fn();
    const select = vi.fn();
    expect(focusViewNameInput({ focus, select })).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(focusViewNameInput(null)).toBe(false);
  });
});
