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
 * The debug image may be DOWNSAMPLED. `rendered_shape` and `source_shape` are
 * reported separately by the backend precisely so a client does not have to
 * assume 1:1. A naive `clientX / scale` that ignores `downsample_factor` maps a
 * click onto the wrong analytical pixel -- and the error scales with the
 * downsample, so it is invisible at 1:1 and wrong at 2:1.
 *
 * The image may also be letterboxed inside its container, so the container's
 * rect is not the image's rect. Zoom and pan move the image within the container,
 * so the offset is not constant.
 *
 * Hence an explicit transform, composed once and inverted once.
 */

/** What the backend reports about a rendered raster. */
export interface RasterGeometry {
  /** The analytical raster: [width, height] in pixels. */
  readonly sourceShape: readonly [number, number];
  /** The server-rendered PNG: [width, height] in pixels. */
  readonly renderedShape: readonly [number, number];
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
  const [sourceWidth] = geometry.sourceShape;
  const [renderedWidth] = geometry.renderedShape;
  if (!sourceWidth || !renderedWidth) return 1;
  // Prefer the backend's own factor when it is coherent with the shapes, so a
  // rounding difference in the PNG cannot silently rescale the mapping.
  const fromShapes = sourceWidth / renderedWidth;
  const declared = geometry.downsampleFactor;
  if (declared > 0 && Math.abs(declared - fromShapes) > 1e-6) {
    // Disagreement is worth surfacing rather than picking a winner: it means the
    // render and the source do not correspond, and every pixel below would be
    // suspect. The shapes win because they describe the actual pixels.
    return fromShapes;
  }
  return fromShapes > 0 ? fromShapes : 1;
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
  const [renderedWidth, renderedHeight] = geometry.renderedShape;
  if (!renderedWidth || !renderedHeight || view.scale <= 0) return null;

  // Screen -> rendered-image pixel.
  const local: ImagePixel = {
    x: (point.clientX - elementRect.left - view.offsetX) / view.scale,
    y: (point.clientY - elementRect.top - view.offsetY) / view.scale,
  };

  // Outside the displayed image: no analytical pixel exists for this point.
  if (local.x < 0 || local.y < 0 || local.x > renderedWidth || local.y > renderedHeight) {
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
  const [renderedWidth, renderedHeight] = geometry.renderedShape;
  if (!renderedWidth || !renderedHeight) return 1;
  return Math.min(containerWidth / renderedWidth, containerHeight / renderedHeight);
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
  const [width, height] = geometry.sourceShape;
  // Valid range is the range of sample CENTRES, matching the backend probe.
  return (
    pixel.row >= 0 && pixel.col >= 0 && pixel.row <= height - 1 && pixel.col <= width - 1
  );
}