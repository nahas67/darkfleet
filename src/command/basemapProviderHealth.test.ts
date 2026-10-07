import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('air-gapped provider failures reach SYSTEM', () => {
  it('names each attempted failed source rather than only saying no imagery', () => {
    const source = readFileSync(resolve(__dirname, 'SystemPanel.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // The controller records failed source IDs in `attempted`. The visible status needs those
    // IDs as well as the aggregate notice, or an operator cannot tell whether OSM, Esri, or both
    // failed. This source guard is paired with a blocked-network browser read of both rows.
    expect(source).toContain('new Set(status.attempted)');
    expect(source).toContain('.filter((id) => id !== status.activeId)');
    expect(source).toContain('data-df-basemap-provider={id}');
    expect(source).toContain('data-df-basemap-provider-health="UNAVAILABLE"');
  });
});
