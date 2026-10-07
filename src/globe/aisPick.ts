/**
 * THE AIS PICK DECODER: what a `scene.pick` result names, in product vocabulary.
 *
 * ================================ WHY TAGS, NOT INDEXES ================================
 *
 * AIS lives in Cesium PRIMITIVE collections (`BillboardCollection`, `LabelCollection`,
 * `PolylineCollection`), not in `viewer.entities`. A collection index is invalidated by every
 * `remove`, so reverse-mapping a picked index would silently select the wrong vessel after the
 * first contact left -- which is the defect DF-X9 section 34 forbids by requiring stable
 * identity. Every pickable AIS primitive therefore carries a stable typed tag in its `id` at
 * creation (contact billboard, observation marker, track polyline, predicted marker, label),
 * and this module is the single reader of those tags.
 *
 * ================================ WHAT PICK RETURNS ================================
 *
 * Verified against the shipped Cesium build (`Build/CesiumUnminified/Cesium.js`):
 *
 *   Billboard.getPickId   -> `{ primitive: <the Billboard>, collection, id: billboard.id }`
 *   Polyline.getPickId    -> `{ primitive: <the Polyline>, collection, id: polyline.id }`
 *   Label                 -> `id` is documented as "the user-defined value returned when the
 *                            label is picked" (`Source/Cesium.d.ts`), so `picked.id` carries it.
 *   Entity                -> `{ id: <the Entity>, primitive }`, with `Entity.name` as a string
 *                            or a Property exposing `getValue()`.
 *
 * The decoder therefore reads `picked.id` FIRST and treats `picked.primitive` only as the
 * object-identity fallback for untagged billboards. Overlap is deterministic by construction:
 * `scene.pick` returns the TOPMOST primitive at the pixel, and repeated clicks re-select the
 * same contact -- there is no cycling, and none is wanted, because cycling would make two
 * identical clicks mean two different things.
 *
 * ================================ WHAT THIS MODULE MUST NOT DO ================================
 *
 * It must never guess. An unknown, malformed or foreign pick decodes to UNKNOWN, and UNKNOWN
 * clears the AIS selection rather than inheriting one. In particular a collection index, label
 * text or row position NEVER resolves to an MMSI (§4): those are display artefacts, not
 * identity, and coupling picking to them would make a reformat reselect the fleet.
 *
 * Pure: no Cesium import, no store import, no viewer. The engine supplies the fallback
 * resolver (bound to the renderer's `mmsiOf`); unit tests supply fakes.
 */

export type AisPickDomain = 'AIS_CONTACT' | 'AIS_OBSERVATION' | 'AIS_TRACK' | 'AIS_PREDICTION';

/**
 * The tag stored in a primitive's `id` at creation.
 *
 * `at` is the EXACT raw observation timestamp for observation markers -- the archive row's own
 * string, never normalised -- because the marker highlight matches on MMSI AND timestamp, and
 * any normalisation here would break that identity.
 */
export type AisPrimitiveTag =
  | { domain: 'AIS_CONTACT'; mmsi: string }
  | { domain: 'AIS_OBSERVATION'; mmsi: string; at: string }
  | { domain: 'AIS_TRACK'; mmsi: string }
  | { domain: 'AIS_PREDICTION'; mmsi: string };

/** A contact glyph. Clicking it names the vessel; no fix is singled out. */
export function aisContactTag(mmsi: string): AisPrimitiveTag {
  return { domain: 'AIS_CONTACT', mmsi };
}

/** One recorded fix. Clicking it names the vessel AND the exact observation. */
export function aisObservationTag(mmsi: string, at: string): AisPrimitiveTag {
  return { domain: 'AIS_OBSERVATION', mmsi, at };
}

/** An observed track segment, including gap connectors: they belong to the vessel's track. */
export function aisTrackTag(mmsi: string): AisPrimitiveTag {
  return { domain: 'AIS_TRACK', mmsi };
}

/** The analytical predicted marker. Selecting it names the vessel it was computed for. */
export function aisPredictionTag(mmsi: string): AisPrimitiveTag {
  return { domain: 'AIS_PREDICTION', mmsi };
}

/**
 * What a pick names, in product vocabulary.
 *
 * AIS kinds carry the MMSI (and the raw timestamp for observations); SAR_TARGET carries the
 * existing target id through the unchanged name-prefix path; UNKNOWN carries nothing and must
 * never be read as a selection.
 */
export type AisPickResult =
  | { kind: 'AIS_CONTACT'; mmsi: string }
  | { kind: 'AIS_OBSERVATION'; mmsi: string; at: string }
  | { kind: 'AIS_TRACK'; mmsi: string }
  | { kind: 'AIS_PREDICTION'; mmsi: string }
  | { kind: 'SAR_TARGET'; targetId: string }
  | { kind: 'UNKNOWN' };

function isMmsi(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * An entity name, read defensively.
 *
 * Cesium stores `Entity.name` as a string when added with one, but the type allows a Property,
 * and the engine's own `#entityName` already reads both. The decoder matches that rather than
 * assuming the convenient shape.
 */
function entityNameOf(id: unknown): string | null {
  if (id === null || id === undefined || typeof id !== 'object') return null;
  const raw = (id as { name?: unknown }).name;
  if (typeof raw === 'string') return raw;
  const getter = (raw as { getValue?: unknown } | undefined)?.getValue;
  if (typeof getter !== 'function') return null;
  const value = (getter as () => unknown).call(raw);
  return typeof value === 'string' ? value : null;
}

/**
 * Decode one `scene.pick` result.
 *
 * ORDER IS MEANING, not convenience:
 *
 *   1. typed AIS tags -- the renderer's own primitives, validated strictly. A tag that CLAIMS
 *      an AIS domain but carries no usable MMSI (or no timestamp for an observation) is
 *      UNKNOWN, full stop: it never falls through to the entity path or the fallback.
 *   2. SAR target entities -- the pre-existing `target:` name-prefix path, unchanged.
 *   3. untagged billboards -- the object-identity fallback (`mmsiOf`), for primitives no
 *      renderer tagged. Gated on `id === undefined` so a present-but-foreign id can never
 *      resolve to a vessel by accident.
 *   4. everything else -- UNKNOWN.
 */
export function decodeAisPick(
  picked: unknown,
  resolveUntaggedBillboard?: (primitive: unknown) => string | null,
): AisPickResult {
  if (picked === null || picked === undefined || typeof picked !== 'object') {
    return { kind: 'UNKNOWN' };
  }
  const record = picked as { id?: unknown; primitive?: unknown };
  const id = record.id;

  if (id !== null && typeof id === 'object' && 'domain' in id) {
    const tag = id as { domain?: unknown; mmsi?: unknown; at?: unknown };
    switch (tag.domain) {
      case 'AIS_CONTACT':
        return isMmsi(tag.mmsi) ? { kind: 'AIS_CONTACT', mmsi: tag.mmsi } : { kind: 'UNKNOWN' };
      case 'AIS_TRACK':
        return isMmsi(tag.mmsi) ? { kind: 'AIS_TRACK', mmsi: tag.mmsi } : { kind: 'UNKNOWN' };
      case 'AIS_PREDICTION':
        return isMmsi(tag.mmsi)
          ? { kind: 'AIS_PREDICTION', mmsi: tag.mmsi }
          : { kind: 'UNKNOWN' };
      case 'AIS_OBSERVATION':
        return isMmsi(tag.mmsi) && isMmsi(tag.at)
          ? { kind: 'AIS_OBSERVATION', mmsi: tag.mmsi, at: tag.at }
          : { kind: 'UNKNOWN' };
      default:
        return { kind: 'UNKNOWN' };
    }
  }

  const name = entityNameOf(id);
  if (name !== null && name.startsWith('target:')) {
    const targetId = name.slice('target:'.length);
    return targetId.length > 0 ? { kind: 'SAR_TARGET', targetId } : { kind: 'UNKNOWN' };
  }

  if (id === undefined && typeof resolveUntaggedBillboard === 'function') {
    const primitive = record.primitive;
    if (primitive !== null && primitive !== undefined) {
      const mmsi = resolveUntaggedBillboard(primitive);
      if (isMmsi(mmsi)) return { kind: 'AIS_CONTACT', mmsi };
    }
  }

  return { kind: 'UNKNOWN' };
}
