import { describe, expect, it } from 'vitest';

const ENGINE = (await import('./engine?raw')).default as string;
const SYSTEM = (await import('../command/SystemPanel?raw')).default as string;

/** Source-binding floor; a blocked-network browser run asserts actual nonzero counts. */
describe('local maritime geometry is observable as geometry, not just attribution', () => {
  it('counts the actual Cesium entities for all three maritime layers', () => {
    const code = ENGINE.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toContain('maritimeEntityCounts()');
    expect(code).toContain('this.#coastlineEntities.length');
    expect(code).toContain('this.#eezEntities.length');
    expect(code).toContain('this.#highSeasEntities.length');
  });
  it('makes those counts visible to the operator in SYSTEM', () => {
    const code = SYSTEM.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toContain('engine.maritimeEntityCounts()');
    expect(code).toContain('data-df-maritime-entity-count={id}');
  });
});
