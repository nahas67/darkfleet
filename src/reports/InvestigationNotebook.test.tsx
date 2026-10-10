import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportsWorkspace } from './ReportsWorkspace';
import { store } from '../state/store';

describe('Reports investigation entry point', () => {
  it('exposes durable investigations alongside the original export capabilities', () => {
    store.set({ scanId: 'DF-001' });
    const markup = renderToStaticMarkup(<ReportsWorkspace />);
    store.set({ scanId: null });
    expect(markup).toContain('data-df-workspace="REPORTS"');
    expect(markup).toContain('Analytical JSON');
    expect(markup).toContain('PNG evidence');
    expect(markup).toContain('data-df-investigations');
    expect(markup).toContain('Investigation notebook');
    expect(markup).toContain('data-df-investigation-create');
    expect(markup).toContain('Saved investigations');
    expect(markup).not.toContain('Held in this session only');
  });
});
