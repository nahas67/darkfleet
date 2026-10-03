/**
 * Pixel-mapping tests (DF-X6C).
 *
 * The mapping is the boundary where a display convenience becomes an analytical
 * error: a click at (x, y) must resolve to the same analytical pixel no matter
 * how the image was scaled, zoomed, panned or letterboxed. Getting this wrong
 * places a detection marker on the wrong water.
 *
 * The cases here are the ones a naive `clientX / scale` gets wrong: a downsample,
 * a letterbox, a zoom, a pan, and a fractional centroid.
 */

import { describe, expect, it } from 'vitest';

import {
  analyticalScale,
  analyticalToImage,
  analyticalToScreen,
  fitScale,
  isInsideRaster,
  onePixelTolerance,
  screenToAnalytical,
  type AnalyticalPixel,
  type RasterGeometry,
} from './pixelMapping';

// Shapes are [rows, cols], in NumPy order, exactly as the backend reports them.
// Written with the comment because that convention is the whole risk: a field
// called width holding a row count is an axis swap that a square fixture
// cannot catch.
const ONE_TO_ONE: RasterGeometry = {
  sourceShape: [400, 400],
  renderedShape: [400, 400],
  downsampleFactor: 1,
};

/** 2:1 downsample: the server rendered 200x200 from a 400x400 raster. */
const TWO_TO_ONE: RasterGeometry = {
  sourceShape: [400, 400],
  renderedShape: [200, 200],
  downsampleFactor: 2,
};

/** An awkward non-integer scale: 400 -> 300. */
const NON_INTEGER: RasterGeometry = {
  sourceShape: [400, 400],
  renderedShape: [300, 300],
  downsampleFactor: 400 / 300,
};

/** Not square: 200 rows by 600 cols. Catches any row/col mix-up. */
const WIDE: RasterGeometry = {
  sourceShape: [200, 600],
  renderedShape: [100, 300],
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

describe('the analytical scale is read from the shapes', () => {
  it('is 1 for a 1:1 render', () => {
    expect(analyticalScale(ONE_TO_ONE)).toBe(1);
  });

  it('is 2 for a 2:1 downsample', () => {
    // This is the step a naive client omits, and the error it introduces grows
    // with the downsample -- invisible at 1:1, half a raster wrong at 2:1.
    expect(analyticalScale(TWO_TO_ONE)).toBe(2);
  });

  it('handles a non-integer scale exactly', () => {
    expect(analyticalScale(NON_INTEGER)).toBeCloseTo(400 / 300, 12);
  });

  it('prefers the shapes when they disagree with the declared factor', () => {
    // The shapes describe actual pixels; a declared factor that disagrees means
    // the render and the source do not correspond.
    const lying: RasterGeometry = {
      sourceShape: [400, 400],
      renderedShape: [200, 200],
      downsampleFactor: 1,
    };
    expect(analyticalScale(lying)).toBe(2);
  });
});

describe('screen to analytical, 1:1', () => {
  it('maps the top-left pixel centre', () => {
    const p = screenToAnalytical({ clientX: 100, clientY: 50 }, RECT, VIEW, ONE_TO_ONE);
    expect(p).toEqual({ row: 0, col: 0 });
  });

  it('maps the bottom-right valid pixel', () => {
    const p = screenToAnalytical({ clientX: 100 + 400, clientY: 50 + 400 }, RECT, VIEW, ONE_TO_ONE);
    expect(p).toEqual({ row: 400, col: 400 });
  });

  it('round-trips through the image transform', () => {
    const original: AnalyticalPixel = { row: 137.25, col: 249.5 };
    const image = analyticalToImage(original, ONE_TO_ONE);
    expect(image).toEqual({ x: 249.5, y: 137.25 });
  });
});

describe('screen to analytical across a downsample', () => {
  it('maps the same analytical pixel at both scales', () => {
    // The same underlying pixel, addressed in a 200px image and a 400px one.
    const small = screenToAnalytical(
      { clientX: 100 + 50.5, clientY: 50 + 60.5 },
      RECT,
      VIEW,
      TWO_TO_ONE,
    );
    const large = screenToAnalytical(
      { clientX: 100 + 101, clientY: 50 + 121 },
      RECT,
      VIEW,
      ONE_TO_ONE,
    );
    expect(small).toEqual({ row: 121, col: 101 });
    expect(large).toEqual({ row: 121, col: 101 });
  });

  it('a naive 1:1 division on a downsample would be wrong by the factor', () => {
    const p = screenToAnalytical(
      { clientX: 100 + 100, clientY: 50 + 100 },
      RECT,
      VIEW,
      TWO_TO_ONE,
    );
    // Correct answer is 200,200. A client ignoring the downsample gets 100,100.
    expect(p).toEqual({ row: 200, col: 200 });
  });
});

describe('letterboxing', () => {
  const letterboxed = {
    scale: 1,
    offsetX: 120,
    offsetY: 40,
    containerWidth: 800,
    containerHeight: 800,
  };

  it('uses the image origin, not the container origin', () => {
    const p = screenToAnalytical(
      { clientX: RECT.left + 120, clientY: RECT.top + 40 },
      RECT,
      letterboxed,
      ONE_TO_ONE,
    );
    expect(p).toEqual({ row: 0, col: 0 });
  });

  it('returns null for a click in the letterbox', () => {
    // No analytical pixel exists there, and snapping to the nearest one would
    // put a marker where the operator did not click.
    expect(
      screenToAnalytical({ clientX: RECT.left + 10, clientY: RECT.top + 10 }, RECT, letterboxed, ONE_TO_ONE),
    ).toBeNull();
    expect(
      screenToAnalytical({ clientX: RECT.left + 700, clientY: RECT.top + 700 }, RECT, letterboxed, ONE_TO_ONE),
    ).toBeNull();
  });
});

describe('zoom', () => {
  it('scales the inverse mapping by the zoom', () => {
    const zoomed = { ...VIEW, scale: 4 };
    const p = screenToAnalytical(
      { clientX: RECT.left + 400, clientY: RECT.top + 400 },
      RECT,
      zoomed,
      ONE_TO_ONE,
    );
    expect(p).toEqual({ row: 100, col: 100 });
  });

  it('the same analytical pixel resolves to the same place at any zoom', () => {
    const pixel: AnalyticalPixel = { row: 88.5, col: 210.25 };
    for (const scale of [0.5, 1, 2, 4, 8]) {
      const view = { ...VIEW, scale };
      const screen = analyticalToScreen(pixel, view, ONE_TO_ONE);
      const back = screenToAnalytical(
        { clientX: RECT.left + screen.x, clientY: RECT.top + screen.y },
        RECT,
        view,
        ONE_TO_ONE,
      );
      expect(back?.col).toBeCloseTo(pixel.col, 9);
      expect(back?.row).toBeCloseTo(pixel.row, 9);
    }
  });
});

describe('pan', () => {
  it('offsets by the pan without changing the scale', () => {
    const panned = { ...VIEW, offsetX: -250, offsetY: 130 };
    const p = screenToAnalytical(
      { clientX: RECT.left - 250 + 60, clientY: RECT.top + 130 + 70 },
      RECT,
      panned,
      ONE_TO_ONE,
    );
    expect(p).toEqual({ row: 70, col: 60 });
  });

  it('panning by exactly one analytical pixel moves the result by one', () => {
    const base = { ...VIEW, offsetX: 0 };
    const panned = { ...VIEW, offsetX: 1 };
    const a = screenToAnalytical({ clientX: RECT.left + 50, clientY: RECT.top + 50 }, RECT, base, ONE_TO_ONE);
    const b = screenToAnalytical({ clientX: RECT.left + 50, clientY: RECT.top + 50 }, RECT, panned, ONE_TO_ONE);
    expect((a?.col ?? 0) - (b?.col ?? 0)).toBeCloseTo(1, 9);
  });
});

describe('fractional centroids', () => {
  it('preserves sub-pixel position through the whole chain', () => {
    const centroid: AnalyticalPixel = { row: 119.97797657674496, col: 199.9895914555838 };
    const view = { ...VIEW, scale: 2.5 };
    const screen = analyticalToScreen(centroid, view, TWO_TO_ONE);
    const back = screenToAnalytical(
      { clientX: RECT.left + screen.x, clientY: RECT.top + screen.y },
      RECT,
      view,
      TWO_TO_ONE,
    );
    // The value a real detector produces. Rounding it anywhere in this chain
    // would move the answer by up to half a pixel, which is 5 m at 10 m GSD.
    expect(back?.col).toBeCloseTo(centroid.col, 9);
    expect(back?.row).toBeCloseTo(centroid.row, 9);
  });
});

describe('edge pixels', () => {
  it('accepts the exact centre of the last pixel', () => {
    const p = screenToAnalytical(
      { clientX: RECT.left + 400, clientY: RECT.top + 400 },
      RECT,
      VIEW,
      ONE_TO_ONE,
    );
    expect(p).toEqual({ row: 400, col: 400 });
    // The backend's valid range is 0..399, so 400 is one past the last CENTRE.
    expect(isInsideRaster(p as AnalyticalPixel, ONE_TO_ONE)).toBe(false);
  });

  it('rejects a point beyond the image rather than clamping', () => {
    expect(
      screenToAnalytical({ clientX: RECT.left + 401, clientY: RECT.top + 10 }, RECT, VIEW, ONE_TO_ONE),
    ).toBeNull();
  });

  it('rejects negative coordinates', () => {
    expect(isInsideRaster({ row: -0.5, col: 10 }, ONE_TO_ONE)).toBe(false);
    expect(isInsideRaster({ row: 10, col: -1 }, ONE_TO_ONE)).toBe(false);
  });

  it('accepts the last valid centre and refuses the boundary beyond it', () => {
    expect(isInsideRaster({ row: 399, col: 399 }, ONE_TO_ONE)).toBe(true);
    // 399.5 is the EDGE between row 399 and row 400, not a sample centre. The
    // backend's valid range is 0..H-1 and this agrees with it exactly.
    expect(isInsideRaster({ row: 399.5, col: 399.5 }, ONE_TO_ONE)).toBe(false);
  });
});

describe('fit and tolerance', () => {
  it('fit uses the RENDERED shape, not the source', () => {
    // Fitting the 400px source into an 800px box would scale 2x, but only 200px
    // is on screen, so the image would render at half the container.
    expect(fitScale(TWO_TO_ONE, 800, 800)).toBe(4);
    expect(fitScale(ONE_TO_ONE, 800, 800)).toBe(2);
  });

  it('fit honours the container aspect', () => {
    expect(fitScale(ONE_TO_ONE, 400, 800)).toBe(1);
  });

  it('tolerance grows with downsample and shrinks with zoom', () => {
    const zoomedOut = onePixelTolerance({ ...VIEW, scale: 1 }, TWO_TO_ONE);
    const zoomedIn = onePixelTolerance({ ...VIEW, scale: 4 }, TWO_TO_ONE);
    expect(zoomedOut).toBeCloseTo(2, 9);
    expect(zoomedIn).toBeCloseTo(0.5, 9);
  });
});

describe('degenerate input', () => {
  it('returns null rather than dividing by zero', () => {
    const empty: RasterGeometry = { sourceShape: [0, 0], renderedShape: [0, 0], downsampleFactor: 1 };
    expect(screenToAnalytical({ clientX: 10, clientY: 10 }, RECT, VIEW, empty)).toBeNull();
  });

  it('returns null for a zero view scale', () => {
    const broken = { ...VIEW, scale: 0 };
    expect(screenToAnalytical({ clientX: 10, clientY: 10 }, RECT, broken, ONE_TO_ONE)).toBeNull();
  });
});