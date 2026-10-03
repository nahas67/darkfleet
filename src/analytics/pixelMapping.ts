/**
 * Display-to-analytical pixel mapping (DF-X6C).
 *
 * This module converts a pointer position into an ANALYTICAL row/col. It does
 * not, and must not, convert a pixel into a coordinate: that is the backend's,
 * through `POST /api/scans/{id}/debug/probe`. The distinction matters because the
 * two directions are easy to confuse and only one of them is allowed here.
 *
 * ALLOWED: screen -> rendered image -> analytical raster.
 * FORBIDDEN: analytical raster -> Earth. (See `noBrowserGeolocation.test.ts`.)
 *
 * WHY THIS IS NOT A ONE-LINE DIVISION
 *
 * The debug image may be DOWNSAMPLED. `render.source_shape` and
 * `render.rendered_shape` are reported separately by the backend precisely so a
 * client does not have to assume 1:1. A naive `clientX / scale` that ignores
 * `downsample_factor` maps a click onto the wrong analytical pixel -- and the
 * error scales with the downsample, so it is invisible at 1:1 and wrong at 2:1.
 *
 * The image may also be letterboxed inside its container, so the container's
 * rect is not the image's rect. Zoom and pan move the image within the container,
 * so the offset is not constant.
 *
 * Hence an explicit transform, composed once and inverted once.
 *
 * WHY THE FIELDS ARE NAMED RowCol AND NOT width/height
 *
 * The backend reports shapes in NumPy order: `source_shape` is `[rows, cols]`,
 * because that is `array.shape`. A field called `width` next to a backend value
 * that is actually a row count is an axis swap waiting to happen, and it fails
 * silently on a square raster -- which the fixture is. The names here state the
 * order, so `renderedShapeCols[0] === renderedShapeRows[1]` cannot be true by
 * accident.
 */

/** What the backend reports about a rendered raster. NumPy order: [rows, cols]. */
export interface RasterGeometry {
  /** The analytical raster, as [rows, cols]. */
  readonly sourceShape: readonly [rows: number, cols: number];
  /** The server-rendered PNG, as [rows, cols]. */
  readonly renderedShape: readonly [rows: number, cols: number];
  /** Server-side decimation. 1 means 1:1. */
  readonly downsampleFactor: number;
}

/** The on-screen placement of the rendered image inside its container. */
export interface ViewTransform {
  /** Device pixels per rendered-image pixel. */
  readonly scale: number;
  /** Image origin within the container, in CSS pixels. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Container size, for bounds checks and for FIT. */
  readonly containerWidth: number;
  readonly containerHeight: number;
}

/** A position in the analytical raster's own pixel space. */
export interface AnalyticalPixel {
  readonly row: number;
  readonly col: number;
}

/** A position in the displayed image's local space, before the raster scale. */
export interface ImagePixel {
  readonly x: number;
  readonly y: number;
}

/**
 * The full chain, composed.
 *
 * `source -> rendered` is the backend's downsample; `rendered -> screen` is the
 * user's zoom and pan. Both are needed, and conflating them is the defect this
 * type exists to prevent.
 */
export function analyticalScale(geometry: RasterGeometry): number {
  const sourceCols = geometry.sourceShape[1];
  const renderedCols = geometry.renderedShape[1];
  if (!sourceCols || !renderedCols) return 1;
  // Derived from the COLUMNS, in both shapes, so the two are the same axis. A
  // row-derived ratio would be identical on a square raster and wrong on any
  // other, which is the worst possible failure shape.
  const fromShapes = sourceCols / renderedCols;
  if (!(fromShapes > 0) || !Number.isFinite(fromShapes)) return 1;
  return fromShapes;
}

/**
 * Screen point -> analytical pixel.
 *
 * Returns `null` when the point is outside the image, because a click on the
 * letterbox area has no analytical pixel and must not be snapped to the nearest
 * one. Snapping would put a mark where the operator did not click, which is the
 * same refusal the backend applies to an out-of-bounds probe.
 */
export function screenToAnalytical(
  point: { readonly clientX: number; readonly clientY: number },
  elementRect: { readonly left: number; readonly top: number },
  view: ViewTransform,
  geometry: RasterGeometry,
): AnalyticalPixel | null {
  const renderedRows = geometry.renderedShape[0];
  const renderedCols = geometry.renderedShape[1];
  if (!renderedRows || !renderedCols || view.scale <= 0) return null;

  // Screen -> rendered-image pixel.
  const local: ImagePixel = {
    x: (point.clientX - elementRect.left - view.offsetX) / view.scale,
    y: (point.clientY - elementRect.top - view.offsetY) / view.scale,
  };

  // Outside the displayed image: no analytical pixel exists for this point.
  if (local.x < 0 || local.y < 0 || local.x > renderedCols || local.y > renderedRows) {
    return null;
  }

  // Rendered -> analytical. This is the downsample, and it is the step a naive
  // implementation omits.
  const factor = analyticalScale(geometry);
  return {
    col: local.x * factor,
    row: local.y * factor,
  };
}

/** Analytical pixel -> rendered-image pixel. The inverse, for drawing overlays. */
export function analyticalToImage(
  pixel: AnalyticalPixel,
  geometry: RasterGeometry,
): ImagePixel {
  const factor = analyticalScale(geometry);
  return { x: pixel.col / factor, y: pixel.row / factor };
}

/** Analytical pixel -> container offset, for absolutely positioned markers. */
export function analyticalToScreen(
  pixel: AnalyticalPixel,
  view: ViewTransform,
  geometry: RasterGeometry,
): ImagePixel {
  const image = analyticalToImage(pixel, geometry);
  return {
    x: view.offsetX + image.x * view.scale,
    y: view.offsetY + image.y * view.scale,
  };
}

/**
 * FIT: the scale at which the whole analytical raster is visible.
 *
 * Derived from the RENDERED shape, because that is what is on screen. Using the
 * source shape here would fit the pre-downsample raster and leave the image
 * smaller than the container by exactly the downsample factor.
 */
export function fitScale(
  geometry: RasterGeometry,
  containerWidth: number,
  containerHeight: number,
): number {
  const renderedRows = geometry.renderedShape[0];
  const renderedCols = geometry.renderedShape[1];
  if (!renderedRows || !renderedCols) return 1;
  return Math.min(containerWidth / renderedCols, containerHeight / renderedRows);
}

/**
 * The expected one-pixel error of a click, in analytical pixels.
 *
 * Derived rather than assumed, and used as the alignment tolerance: a pointer
 * cannot be placed more precisely than the display resolution allows, so this is
 * the honest bound on "did the click land on the pixel I think it did".
 */
export function onePixelTolerance(view: ViewTransform, geometry: RasterGeometry): number {
  // One screen pixel, expressed in analytical pixels.
  return analyticalScale(geometry) / Math.max(view.scale, 1e-6);
}

/** Whether an analytical pixel is inside the raster. Never clamps. */
export function isInsideRaster(
  pixel: AnalyticalPixel,
  geometry: RasterGeometry,
): boolean {
  const [rows, cols] = geometry.sourceShape;
  // Valid range is the range of sample CENTRES, matching the backend probe: a
  // centroid is the centre of a sample, and the centre of sample N-1 is N-1. A
  // value of H-0.5 is the boundary BETWEEN samples, not a sample.
  return (
    pixel.row >= 0 && pixel.col >= 0 && pixel.row <= rows - 1 && pixel.col <= cols - 1
  );
}

/**
 * Read the geometry out of the raster metadata payload.
 *
 * Lives here rather than in the component because the field names are the whole
 * risk: `source_shape` is nested under `render`, is in NumPy order, and an
 * earlier version of this read a top-level `shape` that does not exist -- so the
 * geometry silently stayed null and the workspace had no click-to-probe at all,
 * with no error anywhere.
 */
export function readGeometry(payload: unknown): RasterGeometry | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const render = (payload as { render?: unknown }).render;
  if (typeof render !== 'object' || render === null) return null;
  const source = (render as { source_shape?: unknown }).source_shape;
  const rendered = (render as { rendered_shape?: unknown }).rendered_shape;
  if (!Array.isArray(source) || !Array.isArray(rendered)) return null;
  const rows = Number(source[0]);
  const cols = Number(source[1]);
  const renderedRows = Number(rendered[0]);
  const renderedCols = Number(rendered[1]);
  if (![rows, cols, renderedRows, renderedCols].every((n) => Number.isFinite(n) && n > 0)) {
    return null;
  }
  const factor = Number((render as { downsample_factor?: unknown }).downsample_factor);
  return {
    sourceShape: [rows, cols],
    renderedShape: [renderedRows, renderedCols],
    downsampleFactor: Number.isFinite(factor) && factor > 0 ? factor : 1,
  };
}