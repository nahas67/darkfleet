/**
 * The dossier data composition layer.
 *
 * ONE SELECTED TARGET, TEN BRANCHES
 *
 * Everything an operator can ask about a target is a function of the same
 * `(scanId, targetId)` pair plus that scan's stored record. This module is where
 * those functions are named and where the requests are issued, so that:
 *
 *  - there is exactly one place that knows a target's identity (see `targetRef`);
 *  - every request is owned (see `useOwnedRequest`), so a slow tab cannot
 *    overwrite a fast one and a superseded response cannot land on a new target;
 *  - a branch that has not run is distinguishable from a branch that ran and found
 *    nothing. That distinction is the backbone of the whole evidence epistemics:
 *    `NOT_ANALYSED` and `NOT_AVAILABLE` are answers, and `ZERO OBSERVATIONS` is a
 *    different answer from `NO_COVERAGE`.
 *
 * NOTHING HERE INTERPRETS
 *
 * No rescoring, no re-ranking, no inference. Every value is passed through from a
 * backend contract. If a number is not in the contract, this module does not
 * produce it -- a surface that needs it is missing evidence, and the honest
 * response is to say so rather than to compute it in the browser.
 */

import { api } from '../api/errors';
import {
  AISCOVERAGEOUT_FIELDS,
  EVIDENCEDOCUMENTRESPONSE_FIELDS,
  PATTERNSOUT_FIELDS,
  REVISITPLANOUT_FIELDS,
  TARGETAISRESPONSE_FIELDS,
  TARGETEVIDENCERESPONSE_FIELDS,
  TARGETMARITIMECONTEXTRESPONSE_FIELDS,
  TARGETSUMMARYRESPONSE_FIELDS,
  TRACKSOUT_FIELDS,
} from '../api/contract';
import type {
  AisCoverageOut,
  EvidenceDocumentResponse,
  PatternsOut,
  RevisitPlanOut,
  TargetAisResponse,
  TargetEvidenceResponse,
  TargetMaritimeContextResponse,
  TargetSummaryResponse,
  TracksOut,
} from '../api/contract';
import { contractValidator, validateShape } from '../api/validateGenerated';
import { targetPath, type TargetRef } from '../intelligence/targetRef';

/* ------------------------------------------------------------------ validators */
/*
 * Each validator's key list comes from the generated contract, so a field added
 * to a Pydantic model is checked here without anyone editing this file. That is
 * the whole point: a hand-maintained mirror is a mirror that will drift.
 */
const validateTargetAis = contractValidator<TargetAisResponse>(
  TARGETAISRESPONSE_FIELDS,
  'TargetAisResponse',
);
const validateTracks = contractValidator<TracksOut>(TRACKSOUT_FIELDS, 'TracksOut');
const validatePatterns = contractValidator<PatternsOut>(PATTERNSOUT_FIELDS, 'PatternsOut');
const validateTargetEvidence = contractValidator<TargetEvidenceResponse>(
  TARGETEVIDENCERESPONSE_FIELDS,
  'TargetEvidenceResponse',
);
const validateSummary = contractValidator<TargetSummaryResponse>(
  TARGETSUMMARYRESPONSE_FIELDS,
  'TargetSummaryResponse',
);
const validateEvidenceDocument = contractValidator<EvidenceDocumentResponse>(
  EVIDENCEDOCUMENTRESPONSE_FIELDS,
  'EvidenceDocumentResponse',
);
const validateCoverage = contractValidator<AisCoverageOut>(
  AISCOVERAGEOUT_FIELDS,
  'AisCoverageOut',
);
const validateMaritimeContext = contractValidator<TargetMaritimeContextResponse>(
  TARGETMARITIMECONTEXTRESPONSE_FIELDS,
  'TargetMaritimeContextResponse',
);

/* ------------------------------------------------------------------- URL build */

/**
 * The `scan_id` query parameter VALUE for a target-scoped call, or an empty string.
 *
 * The backend resolves a bare target id across every stored scan. With an archive
 * of dozens of scans that id is ambiguous almost every time, and the response says
 * so with `ambiguous: true`. Pinning the scan is what turns "DF-002, somewhere" into
 * "DF-002, in this acquisition", and it is what lets the dossier header and the tab
 * bodies agree about which vessel is on screen.
 *
 * The caller writes the `?` itself rather than receiving it here. That looks
 * fussy and is not: the reachability gate splits a literal at its first literal `?`
 * in order to drop the query, so a path whose query is glued onto the final segment
 * (`/ais-observations${q}`) is read as one segment called
 * `ais-observations${q}` and the route appears to have no caller at all. Writing the
 * `?` in the literal keeps the final segment clean. A trailing `?` with no
 * parameter is harmless and is what an unpinned selection produces.
 */
function scanParam(ref: TargetRef): string {
  if (!ref.scanId) return '';
  return `scan_id=${encodeURIComponent(ref.scanId)}`;
}

/* -------------------------------------------------------------------- branches */

export type Branch<T> = (signal: AbortSignal) => Promise<T>;

export function loadTargetAis(ref: TargetRef): Branch<TargetAisResponse> {
  return async (signal) =>
    validateTargetAis(
      await api.get<unknown>(
        `/api/targets/${targetPath(ref)}/ais-observations?${scanParam(ref)}`,
        signal,
      ),
    );
}

export function loadTargetSummary(ref: TargetRef): Branch<TargetSummaryResponse> {
  return async (signal) =>
    validateSummary(
      await api.get<unknown>(`/api/targets/${targetPath(ref)}/summary?${scanParam(ref)}`, signal),
    );
}

/**
 * Maritime context: where this vessel sits in reference geography.
 *
 * SCAN-SCOPED BY CONSTRUCTION. The path carries BOTH halves of the target identity,
 * because `DF-002` exists in many scans and a target-id-only URL would resolve to
 * whichever scan was read last. There is deliberately no `/targets/{id}/maritime-context`
 * form.
 *
 * This is CONTEXT, not evidence. It arrives on its own branch so a failure here cannot
 * disturb the evidence tabs, and it is rendered separately from OBSERVED evidence so a
 * reader never takes "inside Malaysia's EEZ" for a measurement about the vessel.
 */
export function loadMaritimeContext(ref: TargetRef): Branch<TargetMaritimeContextResponse> {
  return async (signal) => {
    // `scanId` is nullable because a bare selection may name a target with no scan. The
    // maritime route REQUIRES both halves of the identity -- `DF-002` exists in many
    // scans -- so a ref without a scan cannot address it, and the loader refuses rather
    // than building a URL that would resolve to the wrong vessel.
    if (ref.scanId === null) {
      throw new Error(
        'maritime context requires a scan-scoped target: this selection has no scan id',
      );
    }
    return validateMaritimeContext(
      await api.get<unknown>(
        `/api/scans/${encodeURIComponent(ref.scanId)}/targets/${encodeURIComponent(ref.targetId)}/maritime-context`,
        signal,
      ),
    );
  };
}

/**
 * The per-target evidence slice: OBSERVED / HYPOTHESES / UNKNOWNS.
 *
 * Served by `/targets/{id}`, which returns the target's own evidence document.
 */
export function loadTargetSlice(ref: TargetRef): Branch<TargetEvidenceResponse> {
  return async (signal) =>
    validateTargetEvidence(
      await api.get<unknown>(`/api/targets/${targetPath(ref)}?${scanParam(ref)}`, signal),
    );
}

/**
 * The owning scan's whole record: provenance, scene, and every target in it.
 *
 * Served by `/evidence/{id}`. This is a DIFFERENT document from the per-target
 * slice: it is the scan, not the target. Conflating them would put one target's
 * epistemics beside another target's provenance, so both are fetched and rendered
 * as what they are.
 */
export function loadScanRecord(ref: TargetRef): Branch<EvidenceDocumentResponse> {
  return async (signal) =>
    validateEvidenceDocument(
      await api.get<unknown>(`/api/evidence/${targetPath(ref)}?${scanParam(ref)}`, signal),
    );
}

/**
 * Multi-pass track hypotheses.
 *
 * `/tracks` is a cross-scan projection, not a target-scoped route: it answers
 * "which multi-pass hypotheses exist over the persisted history". The dossier
 * narrows its own display to hypotheses that actually contain the selected
 * target's coordinates rather than asking the server a question it cannot answer,
 * because narrowing a returned list is inspection and inventing a parameter the
 * backend does not support would be a silent contract change.
 */
export function loadTracks(): Branch<TracksOut> {
  return async (signal) => validateTracks(await api.get<unknown>('/api/tracks', signal));
}

export function loadPatterns(): Branch<PatternsOut> {
  return async (signal) => validatePatterns(await api.get<unknown>('/api/patterns', signal));
}

/**
 * Revisit planning for the target's own location.
 *
 * The target's coordinates stand in for an AOI rather than the operator retyping
 * one, which is the point of asking from inside a dossier. A revisit interval
 * between two acquisitions is a property of the AREA, not of a vessel, so the
 * result is labelled as area context and never as target history.
 */
export function loadRevisitAround(
  ref: TargetRef,
  target: { lat: number; lon: number },
): Branch<RevisitPlanOut> {
  return async (signal) => {
    // A small box around the target. The extent is a fixed operational choice, not
    // a claim: revisit statistics describe whatever area is queried, so the query
    // is stated and the answer is not presented as vessel-specific.
    const pad = 0.01;
    const bbox = [
      wrapLongitude(target.lon - pad),
      target.lat - pad,
      wrapLongitude(target.lon + pad),
      target.lat + pad,
    ].join(',');
    const raw = await api.get<unknown>(
      `/api/revisit?bbox=${encodeURIComponent(bbox)}`,
      signal,
    );
    return validateRevisit(raw);
  };
}

function validateRevisit(value: unknown): RevisitPlanOut {
  return validateShape<RevisitPlanOut>(value, REVISITPLANOUT_FIELDS, 'RevisitPlanOut');
}

/* ------------------------------------------------------------------ narrowing */

/**
 * Keep only the track hypotheses that actually involve this target's position.
 *
 * A hypothesis is a line between two observations in different scenes. Matching on
 * the target's own coordinates means the dossier shows tracks that pass through
 * where this vessel was seen, rather than every track in the archive. The match is
 * on a distance in metres and the radius is named below so the tolerance is
 * visible rather than buried.
 */
export function tracksForPosition(
  tracks: TracksOut,
  position: { lat: number; lon: number },
  radiusMeters = 400,
): NonNullable<TracksOut['tracks']> {
  // `?? []` rather than a bare access: the generated contract marks defaulted
  // fields optional. Measured against the backend, FastAPI DOES serialise those
  // defaults (`jsonable_encoder(TracksOut())` yields `tracks: []`), so the key is
  // present in practice -- but the type says otherwise, and reading through the
  // type's uncertainty costs nothing while a crash here would take the multipass
  // tab down.
  return (tracks.tracks ?? []).filter((track) =>
    (track.points ?? []).some((point) =>
      withinMeters(point.lat, point.lon, position.lat, position.lon, radiusMeters),
    ),
  );
}

function withinMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  radius: number,
): boolean {
  const metresPerDegLat = 111_320;
  const midLat = (lat1 + lat2) / 2;
  const metresPerDegLon = metresPerDegLat * Math.cos((midLat * Math.PI) / 180);
  const dy = (lat1 - lat2) * metresPerDegLat;
  // Longitude is circular. A separation across +180/-180 can be metres
  // rather than nearly 360 degrees; using raw subtraction drops real nearby
  // hypotheses for targets on the antimeridian.
  const dx = wrapLongitude(lon1 - lon2) * metresPerDegLon;
  return Math.hypot(dx, dy) <= radius;
}

function wrapLongitude(degrees: number): number {
  const wrapped = ((degrees + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && degrees > 0 ? 180 : wrapped;
}

export { validateCoverage };
