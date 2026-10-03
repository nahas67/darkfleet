/**
 * Pixel-mapping mutation tests and the non-square fixtures (DF-X6C).
 *
 * Every mapping test in pixelMapping.test.ts uses a SQUARE raster, because the
 * fixture raster is 400x400. That is the worst possible choice: in a square,
 * rows and columns are interchangeable, so a transposed raster passes all of
 * them. These tests use 200x600 and require the mapping to be wrong when
 * transposed.
 *
 * The mutation blocks name specific inversions -- swapped axes, an ignored
 * downsample, a dropped pixel-centre offset, source dimensions used where
 * rendered ones belong -- and assert the current code rejects each one. A test
 * that only pins correct behaviour does not prove the implementation could not
 * be quietly inverted.
 */

import { describe, expect, it } from 'vitest';

import {
  analyticalScale,
  analyticalToScreen,
  fitScale,
  isInsideRaster,
  readGeometry,
  screenToAnalytical,
  type AnalyticalPixel,
  type RasterGeometry,
} from './pixelMapping';

/** 200 rows by 600 cols. Non-square, so any row/col confusion is immediately wrong. */
const WIDE: RasterGeometry = {
  sourceShape: [200, 600],
  renderedShape: [100, 300],
  downsampleFactor: 2,
};

const ONE_TO_ONE: RasterGeometry = {
  sourceShape: [400, 400],
  renderedShape: [400, 400],
  downsampleFactor: 1,
};

const TWO_TO_ONE: RasterGeometry = {
  sourceShape: [400, 400],
  renderedShape: [200, 200],
  downsampleFactor: 2,
};

const VIEW = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  containerWidth: 800,
  containerHeight: 800,
};

const RECT = { left: 100, top: 50 };

/* --------------------------------------------------- non-square: axis catching */

/**
 * Every mapping test above uses a square raster, which is the worst possible
 * fixture: row and column are interchangeable in a square, so an axis swap
 * passes all of them. These use 200x600, where any confusion is immediately
 * wrong.
 */
describe('a non-square raster, where a row/col swap cannot hide', () => {
  it('maps rows to the vertical axis and cols to the horizontal one', () => {
    // Click 150px right and 40px down in a 300x100 render of a 600x200 source.
    const p = screenToAnalytical(
      { clientX: RECT.left + 150, clientY: RECT.top + 40 },
      RECT,
      VIEW,
      WIDE,
    );
    expect(p).toEqual({ row: 80, col: 300 });
    expect(p?.col).toBeGreaterThan(p?.row as number);
  });

  it('rejects a click past the right edge but inside the row range', () => {
    // 600px wide, so x=400 is outside while y=40 is comfortably inside.
    expect(
      screenToAnalytical({ clientX: RECT.left + 400, clientY: RECT.top + 40 }, RECT, VIEW, WIDE),
    ).toBeNull();
  });

  it('rejects a click past the bottom edge but inside the column range', () => {
    expect(
      screenToAnalytical({ clientX: RECT.left + 150, clientY: RECT.top + 150 }, RECT, VIEW, WIDE),
    ).toBeNull();
  });

  it('fits using both axes of a non-square image', () => {
    // 300x100 into 800x800: width binds at 800/300, height would allow 8.
    expect(fitScale(WIDE, 800, 800)).toBeCloseTo(800 / 300, 12);
    // Into a short box the height binds instead.
    expect(fitScale(WIDE, 800, 100)).toBeCloseTo(100 / 100, 12);
  });

  it('bounds with rows and cols independently', () => {
    expect(isInsideRaster({ row: 199, col: 599 }, WIDE)).toBe(true);
    expect(isInsideRaster({ row: 200, col: 599 }, WIDE)).toBe(false);
    expect(isInsideRaster({ row: 199, col: 600 }, WIDE)).toBe(false);
    // The other way round is also out of bounds, which a swapped bound would miss.
    expect(isInsideRaster({ row: 600, col: 199 }, WIDE)).toBe(false);
  });
});

/* ----------------------------------------------------------- the swap mutants */

/**
 * Each of these asserts a MUTATION fails. A mapping test that only pins correct
 * behaviour does not prove the implementation could not be quietly inverted; these
 * name the inversions and require the current code to reject them.
 */
describe('axis-swap mutations are rejected', () => {
  it('swapping rendered rows and cols changes the answer on a non-square raster', () => {
    const correct = screenToAnalytical(
      { clientX: RECT.left + 150, clientY: RECT.top + 40 },
      RECT,
      VIEW,
      WIDE,
    );
    const swapped: RasterGeometry = {
      ...WIDE,
      renderedShape: [WIDE.renderedShape[1], WIDE.renderedShape[0]],
    };
    const wrong = screenToAnalytical(
      { clientX: RECT.left + 150, clientY: RECT.top + 40 },
      RECT,
      VIEW,
      swapped,
    );
    expect(wrong).not.toEqual(correct);
    expect(correct).toEqual({ row: 80, col: 300 });
  });

  it('deriving the scale from rows instead of cols would break a non-square raster', () => {
    // The scale must be cols-to-cols. If it were rows-to-rows it would still be 2
    // here, which is why the geometry below uses asymmetric factors.
    const asymmetric: RasterGeometry = {
      sourceShape: [200, 600],
      renderedShape: [100, 200], // rows halved, cols tripled
      downsampleFactor: 3,
    };
    // cols-to-cols: 600 / 200 = 3.
    expect(analyticalScale(asymmetric)).toBe(3);
    // rows-to-rows would have given 200 / 100 = 2.
    expect(analyticalScale(asymmetric)).not.toBe(2);
  });

  it('ignoring the downsample places the click on the wrong pixel', () => {
    const naive = screenToAnalytical(
      { clientX: RECT.left + 100, clientY: RECT.top + 100 },
      RECT,
      VIEW,
      TWO_TO_ONE,
    );
    // The naive answer is local * 1; the correct one is local * 2.
    expect(naive).toEqual({ row: 200, col: 200 });
    expect(naive?.row).not.toBe(100);
  });

  it('omitting the pixel-centre offset would round every centroid', () => {
    // A real sub-pixel centroid, which is what makes rounding detectable.
    const centroid: AnalyticalPixel = { row: 119.97797657674496, col: 199.9895914555838 };
    const rounded = Math.round(centroid.row) + Math.round(centroid.col);
    expect(rounded).not.toBe(Math.floor(centroid.row) + Math.floor(centroid.col));
    // The mapping preserves both fractional parts. Not with `toBe`: the round
    // trip through divide-then-multiply costs about one unit in the last place
    // (199.9895914555838 -> 199.98959145558376). That is a float artefact, not a
    // rounding of the centroid, and it is 14 orders of magnitude below the
    // half-pixel error that dropping the offset would cause.
    const screen = analyticalToScreen(centroid, { ...VIEW, scale: 1 }, ONE_TO_ONE);
    const back = screenToAnalytical(
      { clientX: RECT.left + screen.x, clientY: RECT.top + screen.y },
      RECT,
      { ...VIEW, scale: 1 },
      ONE_TO_ONE,
    );
    expect(back?.row).toBeCloseTo(centroid.row, 9);
    expect(back?.col).toBeCloseTo(centroid.col, 9);
    // And it is still not a whole number, which is the property that matters.
    expect(back!.row % 1).not.toBe(0);
    expect(back!.col % 1).not.toBe(0);
  });

  it('using source dimensions where rendered ones belong would break FIT', () => {
    const fitsRendered = fitScale(TWO_TO_ONE, 800, 800);
    const fitsSource = Math.min(800 / 400, 800 / 400);
    expect(fitsRendered).toBe(4);
    expect(fitsSource).toBe(2);
    expect(fitsRendered).not.toBe(fitsSource);
  });
});

/* --------------------------------------------------- reading the real payload */

describe('readGeometry', () => {
  it('reads the shapes the backend actually sends', () => {
    // Captured verbatim from GET /api/scans/{id}/raster/raw. An earlier version
    // read a top-level `shape`, which does not exist, so the geometry stayed null
    // and the workspace had no click-to-probe at all -- with nothing failing.
    const payload = {
      scan_id: 'DF-0023',
      layer: 'raw',
      crs: 'EPSG:32648',
      render: {
        binary: false,
        mode: 'L',
        downsample_factor: 1,
        source_shape: [400, 400],
        rendered_shape: [400, 400],
        display_window: { lo: -90, hi: -89, basis: 'percentile window was degenerate' },
        stats: { min: -90, max: 3.8044, mean: -89.9843, p01: -90, p99: -89, std: 1.205, finite_fraction: 1 },
      },
      scene: { item_id: 'S1A_FIXTURE_20240101T000000', polarization: 'VV' },
    };
    const geometry = readGeometry(payload);
    expect(geometry).toEqual({
      sourceShape: [400, 400],
      renderedShape: [400, 400],
      downsampleFactor: 1,
    });
  });

  it('reads a real downsample', () => {
    const geometry = readGeometry({
      render: { source_shape: [400, 400], rendered_shape: [200, 200], downsample_factor: 2 },
    });
    expect(geometry?.downsampleFactor).toBe(2);
    expect(analyticalScale(geometry!)).toBe(2);
  });

  it('returns null rather than a wrong geometry for an unusable payload', () => {
    // Each of these once produced a plausible-looking but wrong transform.
    expect(readGeometry(null)).toBeNull();
    expect(readGeometry({})).toBeNull();
    expect(readGeometry({ render: null })).toBeNull();
    // The field this function originally looked for: a top-level `shape`.
    expect(readGeometry({ shape: [400, 400] })).toBeNull();
    expect(readGeometry({ render: { rendered_shape: [200, 200] } })).toBeNull();
    expect(readGeometry({ render: { source_shape: [400, 400] } })).toBeNull();
    expect(readGeometry({ render: { source_shape: [0, 0], rendered_shape: [0, 0] } })).toBeNull();
    expect(
      readGeometry({ render: { source_shape: ['a', 'b'], rendered_shape: [1, 1] } }),
    ).toBeNull();
  });
});
