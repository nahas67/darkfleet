/**
 * Maritime display-geometry loading, for the globe layers.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not an analytical path. Nothing here computes a distance, classifies a zone, or
 * feeds a number the dossier shows. It fetches SIMPLIFIED geometry for drawing, and the
 * backend's distance and zone authority reads the full installed geometry regardless.
 *
 * The rule that is not negotiable: the fetched provenance must be the SAME dataset and
 * version the dossier quotes. A layer drawing one version's coastline while the dossier
 * reports distances measured against another would put two truths on one screen, and
 * neither would be checkable. `assertSameProvenance` is what enforces it.
 *
 * WHY A HOOK AND NOT A FETCH IN THE ENGINE
 * ----------------------------------------
 * The engine owns Cesium. It must not own `fetch`, an AbortController, or React state.
 * This hook owns the request and the lifecycle; the engine receives already-validated
 * geometry and only knows how to draw it. That separation is what lets the engine be tested
 * without a network and the request be tested without a globe.
 *
 * ERROR BEHAVIOUR
 * ---------------
 * A failed or absent dataset yields a state with an EMPTY collection, never a thrown error.
 * The globe must stay usable with no reference data at all -- that is the state this product
 * ships in for ports and bathymetry, and a layer that broke the whole viewer when its data
 * was missing would make an honest absence look like a broken product.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, isAbort } from '../api/errors';
import {
  COASTLINEGEOMETRYRESPONSE_FIELDS,
  ZONEGEOMETRYRESPONSE_FIELDS,
  type CoastlineGeometryResponse,
  type DisplayLine,
  type DisplayPolygon,
  type SourceRef,
  type ZoneGeometryResponse,
} from '../api/contract';
import { contractValidator } from '../api/validateGenerated';
import { getLayer, type LayerId } from './layerRegistry';

const validateCoastline = contractValidator<CoastlineGeometryResponse>(
  COASTLINEGEOMETRYRESPONSE_FIELDS,
  'CoastlineGeometryResponse',
);
const validateZones = contractValidator<ZoneGeometryResponse>(
  ZONEGEOMETRYRESPONSE_FIELDS,
  'ZoneGeometryResponse',
);

/**
 * Install states a layer may still DRAW from.
 *
 * `CHECKSUM_UNRECORDED` is included deliberately. The data parses and answers correctly;
 * what is missing is a publisher checksum to check against, which is a weaker guarantee and
 * a disclosure, not a reason to refuse to render reference data. Treating it as unusable
 * would blank the coastline on a correct installation.
 */
const DRAWABLE = new Set(['AVAILABLE', 'CHECKSUM_UNRECORDED']);

export type CoastlineGeometry = { lines: readonly DisplayLine[] };
export type ZoneGeometry = { polygons: readonly DisplayPolygon[] };

export type MaritimeLayerState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready';
      lines: readonly DisplayLine[];
      polygons: readonly DisplayPolygon[];
      provenance: SourceRef;
      /** The backend's own statement that this drawing is simplified. Shown in the console. */
      notice: string;
      sourceVertexCount: number;
      vertexCount: number;
    }
  | { status: 'absent'; reason: string; provenance: SourceRef | null }
  | { status: 'failed'; reason: string };

/**
 * Whether a layer's declared provenance matches what the server actually returned.
 *
 * Compares dataset AND version, and treats a missing version on either side as a failure
 * rather than a match. Two records that both lack a version are not thereby the same data:
 * they are two unidentified things, and drawing one while quoting the other is exactly the
 * uncheckable situation this check exists to prevent.
 */
export function assertSameProvenance(
  declared: { dataset: string; version: string } | undefined,
  served: SourceRef | null,
): boolean {
  if (declared === undefined) return true; // nothing declared; nothing to check against
  if (served === null) return false;
  return declared.dataset === served.dataset && declared.version === served.version;
}

function sourcePathFor(layerId: LayerId): string | null {
  const definition = getLayer(layerId) as { sourcePath?: string };
  return definition.sourcePath ?? null;
}

/**
 * One loader body, shared by the coastline and both zone layers.
 *
 * Generic over the response type because the two differ only in their validator and which
 * collection they carry; duplicating the request lifecycle three times is where a stale
 * response or a missing abort would eventually survive in one of the copies.
 */
function useMaritimeLayer(
  layerId: LayerId,
  validate: (raw: unknown) => CoastlineGeometryResponse | ZoneGeometryResponse,
): MaritimeLayerState & { load: () => void; reload: () => void } {
  const [state, setState] = useState<MaritimeLayerState>({ status: 'idle' });
  // Generation token rather than only an abort: a response already in flight when the
  // component unmounts must not write into a component that has gone, and an abort alone
  // does not cover a response that had already resolved.
  const generation = useRef(0);
  const path = sourcePathFor(layerId);

  const load = useCallback(() => {
    if (path === null) {
      setState({ status: 'failed', reason: `layer ${layerId} declares no source path` });
      return;
    }
    generation.current += 1;
    const ticket = generation.current;
    const controller = new AbortController();
    setState({ status: 'loading' });

    void (async () => {
      try {
        const raw = await api.get<unknown>(path, controller.signal);
        if (ticket !== generation.current) return;
        const payload = validate(raw);

        if (!DRAWABLE.has(payload.status)) {
          // Reported, not rendered as empty. "The dataset is not installed" and "the
          // dataset has nothing in this area" both give an empty array, and an operator
          // debugging a blank coastline needs the reason.
          //
          // `?? null` because the generated contract marks provenance optional; without it
          // `undefined` would leak into a state typed as `SourceRef | null` and surface as
          // a type error at the consumer rather than here.
          setState({
            status: 'absent',
            reason: payload.detail
              ? `${payload.status} — ${payload.detail}`
              : payload.status,
            provenance: payload.provenance ?? null,
          });
          return;
        }

        const declared = (getLayer(layerId) as { provenance?: { dataset: string; version: string } })
          .provenance;
        if (!assertSameProvenance(declared, payload.provenance ?? null)) {
          setState({
            status: 'failed',
            reason:
              'provenance mismatch: the layer declares ' +
              `${declared?.dataset ?? 'nothing'} ${declared?.version ?? ''} but the server ` +
              `returned ${payload.provenance?.dataset ?? 'nothing'} ` +
              `${payload.provenance?.version ?? ''}. Nothing was drawn.`,
          });
          return;
        }

        /*
         * The two payloads are told apart by LAYER, not by probing for a field.
         *
         * `'lines' in payload` was the first attempt and it is wrong: the generated
         * contract marks both collections optional, so an absent `lines` is `undefined`
         * rather than a missing key, the `in` check does not narrow, and the compiler
         * correctly refuses to read `polygons` off a coastline response. The layer id is
         * the fact that was already known, and using it removes the guess entirely.
         */
        const meta = payload.meta;
            if (layerId === 'REFERENCE_COASTLINE') {
          const coastline = payload as CoastlineGeometryResponse;
          setState({
            status: 'ready',
            lines: coastline.lines ?? [],
            polygons: [],
            provenance: coastline.provenance as SourceRef,
            notice: meta.notice ?? '',
            sourceVertexCount: meta.source_vertex_count ?? 0,
            vertexCount: meta.vertex_count ?? 0,
          });
          return;
        }

        const zones = payload as ZoneGeometryResponse;
        if (layerId === 'HIGH_SEAS') {
          /*
           * HIGH_SEAS is drawn, but ONLY its OUTLINE.
           *
           * The single Marine Regions high-seas feature is 366,469 vertices covering
           * 222,496,418 km² -- every ocean not inside an EEZ. Filling it would paint the
           * entire habitable ocean a solid colour underneath every other layer, and it
           * would read as "this water belongs to somebody", which is precisely the claim
           * the high-seas rule refuses to make. An outline says "high seas was MEASURED
           * against this geometry" without asserting anything about the water inside.
           *
           * The parts are concatenated rather than kept separate because an outline that
           * jumped between the 21 parts would draw 20 straight lines across oceans the
           * dataset says ARE high seas -- visible, and wrong.
           */
          setState({
            status: 'ready',
            lines: (zones.polygons ?? []).map((polygon) => ({
              coordinates: polygon.parts.flatMap((part) => part.coordinates),
            })),
            polygons: [],
            provenance: zones.provenance as SourceRef,
            notice: meta.notice ?? '',
            sourceVertexCount: meta.source_vertex_count ?? 0,
            vertexCount: meta.vertex_count ?? 0,
          });
          return;
        }

        setState({
          status: 'ready',
          lines: [],
          polygons: zones.polygons ?? [],
          provenance: zones.provenance as SourceRef,
          notice: meta.notice ?? '',
          sourceVertexCount: meta.source_vertex_count ?? 0,
          vertexCount: meta.vertex_count ?? 0,
        });
      } catch (error) {
        if (ticket !== generation.current) return;
        if (isAbort(error)) return;
        setState({
          status: 'failed',
          reason: error instanceof Error ? error.message : 'The layer request failed.',
        });
      }
    })();
  }, [layerId, path, validate]);

  useEffect(() => () => {
    generation.current += 1;
  }, []);

  return { ...state, load, reload: load };
}

/** Simplified Natural Earth coastline for the globe. */
export function useCoastlineGeometry(enabled: boolean) {
  const state = useMaritimeLayer('REFERENCE_COASTLINE', validateCoastline);
  useEffect(() => {
    if (enabled) state.load();
  }, [enabled, state.load]);
  return state;
}

/** Simplified Marine Regions boundaries. `layerId` selects EEZ or explicit high seas. */
export function useZoneGeometry(
  layerId: 'EEZ_BOUNDARIES' | 'HIGH_SEAS',
  enabled: boolean,
) {
  const state = useMaritimeLayer(layerId, validateZones);
  useEffect(() => {
    if (enabled) state.load();
  }, [enabled, state.load]);
  return state;
}

export type CoastlinePayload = CoastlineGeometryResponse;
export type ZonePayload = ZoneGeometryResponse;
