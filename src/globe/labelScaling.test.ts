import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arbitrateLabels, estimateLabelBounds, labelScaleForRangeMeters, MAX_AIS_LABELS, type LabelClaim } from './glyphGeometry';

describe('DF-X9.5 decluttering + label scaling', () => {
  it('sizes collision boxes from actual text instead of a fixed 92px slot', () => {
    const short = estimateLabelBounds('257000001');
    const long = estimateLabelBounds('257000001 · 45° · 8.0 kn');
    expect(long.widthPx).toBeGreaterThan(short.widthPx);
    expect(short.widthPx).toBeGreaterThan(0);
    expect(short.heightPx).toBeGreaterThan(0);
    // Fixed 92px slot underestimated a full label and overestimated a bare MMSI.
    expect(long.widthPx).toBeGreaterThan(92);
  });

  it('bounds production arbitration instead of leaving labels unbounded', () => {
    expect(MAX_AIS_LABELS).toBe(120);
    const claims: LabelClaim[] = [];
    for (let i = 0; i < 300; i += 1) {
      claims.push({
        id: `257000${String(i).padStart(3, '0')}`,
        priority: 'GENERIC_AIS',
        screen: { x: (i % 30) * 60, y: Math.floor(i / 30) * 40 },
        ...estimateLabelBounds('257000001 · 45° · 8.0 kn'),
      });
    }
    const decision = arbitrateLabels(claims, { maxLabels: MAX_AIS_LABELS });
    expect(decision.shown.length).toBeLessThanOrEqual(120);
    expect(decision.shown.length).toBeGreaterThan(0);
  });

  it('scales labels down with camera range, clamped at both ends', () => {
    const near = labelScaleForRangeMeters(500);
    const far = labelScaleForRangeMeters(8.0e6);
    const beyond = labelScaleForRangeMeters(2.0e7);
    expect(near).toBe(1.0);
    expect(far).toBeLessThan(1.0);
    expect(far).toBeGreaterThan(0);
    expect(beyond).toBe(far);
  });

  it('wires bounds, budget and distance scaling into the shipped renderer', () => {
    const renderer = readFileSync(resolve(__dirname, 'aisRenderer.ts'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    // Collision boxes come from measured text, not the old fixed 92x15 slot.
    expect(renderer).toContain('estimateLabelBounds(labelTextFor');
    expect(renderer).not.toContain('widthPx: 92');
    // Production arbitration is bounded by the same budget the scale test measures.
    expect(renderer).toContain('{ maxLabels: MAX_AIS_LABELS }');
    // Distance declutter is drawn by Cesium, not reimplemented per frame.
    expect(renderer).toContain('scaleByDistance: new NearFarScalar(');
    expect(renderer).toContain('translucencyByDistance: new NearFarScalar(');
    expect(renderer).toContain('pixelOffsetScaleByDistance: new NearFarScalar(');
    expect(renderer).toContain('LABEL_SCALE_NEAR_M');
  });
});
