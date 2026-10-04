/**
 * LayerRegistry -- the single authority for what layers exist.
 *
 * THE DEFECT THIS FIXES
 *
 * `state.layers` was written in exactly one place and read nowhere else.
 * `LayerConsole` recomputed `visible` from `scanId`/`targets`/`rasterLoaded` on every
 * render, so a toggle wrote to the store and then snapped straight back to true. Ten of
 * eleven controls therefore did nothing -- while looking like they worked, which is
 * worse than an absent control.
 *
 * The cause was a second, parallel source of truth: availability derived from store
 * fields, visibility a control-local boolean, Cesium's `show` a third. Three places,
 * none authoritative.
 *
 * DEFINITIONS AND CAPABILITIES, NOT THE VIEWER (§30)
 *
 * This module owns what a layer IS. It holds no Viewer, ImageryLayer or entity. It
 * names which engine method drives each layer, and carries the capabilities the console
 * needs. A registered layer with no renderer must declare why, or `assertNoDrift`
 * fails -- a silent no-op is the thing this eliminates (§46).
 *
 * ONE STATE AUTHORITY (§9)
 *
 * `store.layerState[id].visible` is the only visibility truth. The console reads it,
 * the engine applies it, and Cesium's `show` is the consequence.
 */

export type LayerCategory =
  | 'SENSOR'
  | 'CONTACT'
  | 'MARITIME_BOUNDARY'
  | 'MARITIME_REFERENCE'
  | 'SEABED'
  | 'ANALYSIS'
  | 'OPERATIONAL';

export type LayerRendererKind = 'ENTITIES' | 'IMAGERY' | 'DEBUG_PANEL';

/**
 * ANALYTICAL layers are evidence produced by this product; REFERENCE layers are
 * context. Not cosmetic: the SAR raster is EVIDENCE and the reference basemap and
 * maritime data are CONTEXT, and they must never be styled as the same kind of thing.
 */
export type EvidentiaryKind = 'ANALYTICAL' | 'REFERENCE';

export type LayerProvenance = {
  readonly provider: string;
  readonly dataset: string;
  readonly version: string;
  readonly license: string;
  readonly attribution: string;
  readonly identifier?: string;
  readonly limitations?: readonly string[];
};

export type LayerDefinition = {
  readonly id: string;
  readonly label: string;
  readonly category: LayerCategory;
  readonly kind: LayerRendererKind;
  /** Engine method that drives this layer's visibility. */
  readonly renderer: string;
  readonly defaultVisibility: boolean;
  readonly supportsOpacity: boolean;
  readonly supportsSelection: boolean;
  readonly evidentiary: EvidentiaryKind;
  /** Required when a layer has no live renderer, so it is not a silent no-op. */
  readonly notImplemented?: string;
  readonly provenance?: LayerProvenance;
};

/**
 * The declared layers.
 *
 * `as const satisfies` rather than a plain annotation, and the distinction is
 * load-bearing: `satisfies` keeps the LITERAL ids, so `LayerId` below is a real
 * union of the eleven names rather than `string`. Annotating as
 * `readonly LayerDefinition[]` would widen every id to `string` and quietly delete
 * the drift protection this file exists to provide (§31, §46).
 */
export const LAYER_DEFINITIONS = [
  {
    id: 'SAR_RASTER', label: 'SAR raster', category: 'SENSOR', kind: 'IMAGERY',
    renderer: 'setRaster', defaultVisibility: true, supportsOpacity: true,
    supportsSelection: false, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'SAR_SCENE_FOOTPRINT', label: 'Scene footprint', category: 'SENSOR', kind: 'ENTITIES',
    renderer: 'setSceneFootprint', defaultVisibility: true, supportsOpacity: true,
    supportsSelection: false, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'SAR_DETECTIONS', label: 'SAR detections', category: 'CONTACT', kind: 'ENTITIES',
    renderer: 'setTargets', defaultVisibility: true, supportsOpacity: true,
    supportsSelection: true, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'UNCERTAINTY_RADII', label: 'Detection uncertainty', category: 'ANALYSIS', kind: 'ENTITIES',
    renderer: 'setUncertainty', defaultVisibility: false, supportsOpacity: true,
    supportsSelection: false, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'AIS_CONTACTS', label: 'AIS contacts', category: 'CONTACT', kind: 'ENTITIES',
    renderer: 'setAisContacts', defaultVisibility: true, supportsOpacity: true,
    supportsSelection: true, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'AIS_TRACKS', label: 'AIS track', category: 'CONTACT', kind: 'ENTITIES',
    renderer: 'setTrack', defaultVisibility: true, supportsOpacity: true,
    supportsSelection: false, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'AIS_PREDICTED', label: 'Predicted AIS position', category: 'CONTACT', kind: 'ENTITIES',
    renderer: 'setTrack', defaultVisibility: true, supportsOpacity: true,
    supportsSelection: false, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'CORRELATION_LINKS', label: 'Correlation links', category: 'ANALYSIS', kind: 'ENTITIES',
    renderer: 'setCorrelationLinks', defaultVisibility: true, supportsOpacity: true,
    supportsSelection: false, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'LAND_MASK', label: 'Land mask', category: 'ANALYSIS', kind: 'IMAGERY',
    renderer: 'setRaster', defaultVisibility: false, supportsOpacity: true,
    supportsSelection: false, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'CFAR_DEBUG', label: 'CFAR debug layer', category: 'ANALYSIS', kind: 'DEBUG_PANEL',
    renderer: 'setRaster', defaultVisibility: false, supportsOpacity: false,
    supportsSelection: false, evidentiary: 'ANALYTICAL',
  },
  {
    id: 'GRATICULE', label: 'Graticule', category: 'OPERATIONAL', kind: 'IMAGERY',
    renderer: 'setGraticule', defaultVisibility: false, supportsOpacity: true,
    supportsSelection: false, evidentiary: 'REFERENCE',
  },
] as const satisfies readonly LayerDefinition[];

/** The literal id union, inferred from the definitions so it cannot drift. */
export type LayerId = (typeof LAYER_DEFINITIONS)[number]['id'];

/** A registry entry with its literal id and category preserved. */
export type LayerEntry = (typeof LAYER_DEFINITIONS)[number];

const BY_ID = new Map<string, LayerEntry>(LAYER_DEFINITIONS.map((d) => [d.id as string, d]));

export function getLayer(id: LayerId): LayerEntry {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown layer id: ${id}`);
  return found;
}

export function listLayers(): readonly LayerEntry[] {
  return LAYER_DEFINITIONS;
}

export function listByCategory(category: LayerCategory): readonly LayerEntry[] {
  return LAYER_DEFINITIONS.filter((d) => d.category === category);
}

export function layerIds(): readonly LayerId[] {
  return LAYER_DEFINITIONS.map((d) => d.id);
}

export function defaultLayerState(): Record<LayerId, { visible: boolean; opacity: number }> {
  const out = {} as Record<LayerId, { visible: boolean; opacity: number }>;
  for (const def of LAYER_DEFINITIONS) {
    out[def.id] = { visible: def.defaultVisibility, opacity: 1 };
  }
  return out;
}

/**
 * View an entry through the full definition shape.
 *
 * Necessary because `as const` narrows each entry to exactly the keys it writes, so
 * an optional field no entry currently declares -- `notImplemented` -- is not
 * readable off the literal type at all. One named widening point is better than a
 * cast at each use, and it keeps the reason written down instead of implied.
 */
export function asDefinition(entry: LayerEntry): LayerDefinition {
  return entry as LayerDefinition;
}

/** A layer with a real renderer, i.e. one a toggle can actually control. */
export function isControllable(entry: LayerEntry): boolean {
  return asDefinition(entry).notImplemented === undefined;
}

/**
 * Narrow an arbitrary string to a declared layer id.
 *
 * The runtime guard the store and the UI need, since a persisted or hand-edited layer
 * map can contain a name the registry no longer declares. Returning false is the
 * honest outcome: an unknown id must not reach the engine, where it would silently
 * do nothing (§46).
 */
export function isLayerId(id: string): id is LayerId {
  return BY_ID.has(id);
}

export type DriftReport = {
  /** Ids referenced by the UI that the registry does not declare. */
  unknown: string[];
  /** Registry entries with neither a renderer nor a declared reason. */
  unrendered: string[];
};

/**
 * Fail on layer-id drift in either direction (§46).
 *
 * A UI referencing an unregistered id renders a dead control -- the exact defect this
 * registry exists to remove. A registry entry with no renderer is a silent no-op
 * unless it declares why. Called from the test suite: drift is a development-time
 * failure, not a production one.
 */
export function assertNoDrift(referencedIds: readonly string[]): DriftReport {
  const known = new Set<string>(layerIds());
  return {
    unknown: referencedIds.filter((id) => !known.has(id)),
    unrendered: LAYER_DEFINITIONS.filter((d) => !isControllable(d)).map((d) => d.id),
  };
}
