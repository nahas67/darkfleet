/**
 * Debug-layer delivery (DF-X6C).
 *
 * The workspace's only source of pipeline artifacts. Every layer here is a real
 * backend product: RAW, NORMALIZED, FILTERED, LAND MASK, CFAR THRESHOLD and
 * DETECTION MASK are server-rendered from the same cached arrays the detections
 * were computed from, and COMPONENTS / CENTROIDS carry the per-target rows the
 * correctness checkpoint restored.
 *
 * Nothing here renders an image, thresholds anything, or derives a coordinate.
 */

/** The layer identifiers the backend actually exposes. */
export const DEBUG_LAYERS = [
  'raw',
  'normalized',
  'landmask',
  'filtered',
  'cfar_threshold',
  'detection_mask',
  'components',
  'centroids',
  'ais_observations',
  'ais_predicted',
  'match_radius',
  'correlation_lines',
  'score_decomposition',
] as const;

export type DebugLayerId = (typeof DEBUG_LAYERS)[number];

/** Layers that come back as a server-rendered image. */
export const RASTER_LAYERS = [
  'raw',
  'normalized',
  'filtered',
  'landmask',
  'cfar_threshold',
  'detection_mask',
] as const satisfies readonly DebugLayerId[];

export type RasterLayerId = (typeof RASTER_LAYERS)[number];

export function isRasterLayer(layer: DebugLayerId): layer is RasterLayerId {
  return (RASTER_LAYERS as readonly DebugLayerId[]).includes(layer);
}

/**
 * Presentation labels.
 *
 * Names for the operator, not identifiers. `cfar_threshold` is the CA-CFAR
 * threshold surface; `normalized` is the calibrated dB grid (the backend states
 * it emits no separate radiometric-normalisation artifact, and the workspace
 * repeats that rather than implying a stage that does not exist).
 */
export const LAYER_LABELS: Readonly<Record<DebugLayerId, string>> = {
  raw: 'Raw SAR',
  normalized: 'Normalized',
  landmask: 'Land mask',
  filtered: 'Filtered',
  cfar_threshold: 'CFAR threshold',
  detection_mask: 'Detection mask',
  components: 'Components',
  centroids: 'Centroids',
  ais_observations: 'AIS observed',
  ais_predicted: 'AIS predicted',
  match_radius: 'Match radius',
  correlation_lines: 'Correlation lines',
  score_decomposition: 'Score decomposition',
};

/** Pipeline order, for the stage strip. Correlation layers sort after the raster. */
const PIPELINE_ORDER: readonly DebugLayerId[] = [
  'raw',
  'normalized',
  'landmask',
  'filtered',
  'cfar_threshold',
  'detection_mask',
  'components',
  'centroids',
  'ais_observations',
  'ais_predicted',
  'match_radius',
  'correlation_lines',
  'score_decomposition',
];

/** Sort into pipeline order, so the selector reads as a pipeline and not a set. */
export function inPipelineOrder(layers: readonly DebugLayerId[]): DebugLayerId[] {
  return [...layers].sort(
    (a, b) => PIPELINE_ORDER.indexOf(a) - PIPELINE_ORDER.indexOf(b),
  );
}