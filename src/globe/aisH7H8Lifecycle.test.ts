/** DF-X9.8 H7/H8 local invariants: real Cesium collections, no GPU frame assertions. */
import { describe, expect, it } from 'vitest';
import { PolylineCollection, PrimitiveCollection, type Viewer } from 'cesium';
import { AisContactRenderer } from './aisRenderer';
import { arbitrateLabels, type LabelClaim } from './glyphGeometry';

function ownerFixture() {
  // These are the actual Cesium collection classes. They can be constructed and
  // destroyed without WebGL; doing so cannot verify GPU allocations or draw FPS.
  const primitives = new PrimitiveCollection();
  const scene = { primitives };
  return { primitives, viewer: { scene } as unknown as Viewer };
}

describe('H8 Cesium resource ownership without a hardware browser', () => {
  it('removes the five renderer-owned primitives from their parent for 25 cycles', () => {
    const { primitives, viewer } = ownerFixture();
    const unrelated = primitives.add(new PolylineCollection());
    const baseline = primitives.length;
    expect(baseline).toBe(1);
    for (let cycle = 0; cycle < 25; cycle++) {
      const renderer = new AisContactRenderer(viewer);
      expect(primitives.length).toBe(baseline + 5);
      renderer.destroy();
      expect(primitives.length).toBe(baseline);
      expect(primitives.contains(unrelated)).toBe(true);
      // Calls during engine cleanup may happen twice; they must not resurrect
      // or leave destroyed child entries in the still-owned parent collection.
      renderer.destroy();
      expect(primitives.length).toBe(baseline);
    }
    primitives.destroy();
  });

  it('tolerates parent destruction before renderer cleanup', () => {
    const { primitives, viewer } = ownerFixture();
    const renderer = new AisContactRenderer(viewer);
    expect(primitives.length).toBe(5);
    primitives.destroy();
    expect(() => renderer.destroy()).not.toThrow();
  });

  it('tolerates a parent removing all children before renderer cleanup', () => {
    const { primitives, viewer } = ownerFixture();
    const renderer = new AisContactRenderer(viewer);
    primitives.removeAll();
    expect(primitives.length).toBe(0);
    expect(() => renderer.destroy()).not.toThrow();
    expect(primitives.length).toBe(0);
    primitives.destroy();
  });
});

function oldArbitration(claims: readonly LabelClaim[], budget: number) {
  const rank = (priority: LabelClaim['priority']) => [
    'SELECTED_TARGET', 'SELECTED_AIS', 'ASSOCIATED_AIS', 'WATCHLISTED',
    'INVESTIGATION', 'GENERIC_AIS',
  ].indexOf(priority);
  const ordered = [...claims].sort((a, b) =>
    rank(a.priority) - rank(b.priority) || a.id.localeCompare(b.id));
  const shown: LabelClaim[] = [];
  const suppressed: Array<{ id: string; reason: 'BUDGET' | 'COLLISION' }> = [];
  let maxOverlap = 0;
  function overlap(a: LabelClaim, b: LabelClaim) {
    const dx = Math.abs(a.screen.x - b.screen.x);
    const dy = Math.abs(a.screen.y - b.screen.y);
    const ox = (a.widthPx + b.widthPx) / 2 - dx;
    const oy = (a.heightPx + b.heightPx) / 2 - dy;
    if (ox <= 0 || oy <= 0) return 0;
    const area = a.widthPx * a.heightPx;
    const smaller = Math.min(area, b.widthPx * b.heightPx);
    return smaller > 0 ? ox * oy / smaller : 0;
  }
  for (const claim of ordered) {
    if (shown.length >= budget) {
      suppressed.push({ id: claim.id, reason: 'BUDGET' });
      continue;
    }
    if (claim.priority === 'SELECTED_TARGET' || claim.priority === 'SELECTED_AIS') {
      for (const existing of shown) maxOverlap = Math.max(maxOverlap, overlap(claim, existing));
      shown.push(claim);
      continue;
    }
    const worst = shown.reduce((m, existing) => Math.max(m, overlap(claim, existing)), 0);
    if (worst > 0) suppressed.push({ id: claim.id, reason: 'COLLISION' });
    else shown.push(claim);
  }
  return { shown, suppressed, maxOverlap };
}

describe('H7 label short-circuit preserves the prior collision decisions', () => {
  it('matches the exhaustive previous algorithm in 10,000 dense and dispersed claims', () => {
    const priorities: LabelClaim['priority'][] = [
      'SELECTED_AIS', 'ASSOCIATED_AIS', 'INVESTIGATION', 'GENERIC_AIS',
    ];
    for (const dense of [true, false]) {
      const claims: LabelClaim[] = Array.from({ length: 10_000 }, (_, i) => ({
        id: String(257000000 + i), priority: i < 4 ? priorities[i] : 'GENERIC_AIS',
        screen: dense ? { x: 500 + i % 5, y: 500 + i % 7 } : {
          x: ((i * 23) % 2048), y: ((i * 79) % 1200),
        },
        widthPx: 70 + i % 35, heightPx: 16 + i % 8,
      }));
      const old = oldArbitration(claims, 120);
      const current = arbitrateLabels(claims, { maxLabels: 120 });
      expect(current.shown.map((item) => item.id)).toEqual(old.shown.map((item) => item.id));
      expect(current.suppressed).toEqual(old.suppressed);
      expect(current.maxOverlap).toBe(old.maxOverlap);
      expect(current.shown.length).toBeLessThanOrEqual(120);
    }
  });
});
