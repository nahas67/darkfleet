import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { engine } from './engine';

const engineSource = () =>
  readFileSync(resolve(__dirname, 'engine.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tacticalSource = () =>
  readFileSync(resolve(__dirname, '..', 'tactical', 'TacticalWorld.tsx'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

describe('deterministic canvas coordinate projection (DF-X9.6 S53)', () => {
  it('engine exposes projectToCanvas returning null when uninitialised', () => {
    expect(typeof (engine as unknown as { projectToCanvas?: unknown }).projectToCanvas).toBe(
      'function',
    );
    expect(
      (
        engine as unknown as {
          projectToCanvas: (lat: number, lon: number) => { x: number; y: number } | null;
        }
      ).projectToCanvas(1.3, 103.8),
    ).toBeNull();
  });

  it('engine implementation uses scene.cartesianToCanvasCoordinates and horizon culling', () => {
    const code = engineSource();
    expect(code).toContain('projectToCanvas(lat: number, lon: number)');
    expect(code).toContain('cartesianToCanvasCoordinates(');
    expect(code).toContain('geodeticSurfaceNormal(');
  });

  it('engine.init binds projectCoordinates to the globe container element', () => {
    const code = engineSource();
    expect(code).toMatch(/\.projectCoordinates\s*=\s*\(lat,\s*lon\)\s*=>\s*this\.projectToCanvas\(lat,\s*lon\)/);
  });
});
