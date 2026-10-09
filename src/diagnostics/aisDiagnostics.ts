/**
 * PRODUCT-FACING DIAGNOSTIC STATE, AND THE DISCIPLINE THAT GOVERNS IT.
 *
 * ================================ WHY THIS MODULE EXISTS ================================
 *
 * "Exposed" is not "reachable", and this codebase has now learned that twice:
 *
 *   * `aisRenderFailureReason` -- implemented in DF-X9.3, flagged by its own audit, still read by
 *     nothing outside `engine.ts` three checkpoints later.
 *   * `get gaps()` on `AisContactRenderer` -- DF-X9.4E committed that it made the gap "provable by
 *     COUNT rather than by looking at a screenshot", and the browser E2E immediately reported it
 *     unreachable, which is correct.
 *
 * In both cases the type signature said `boolean` or `array`, the commit message described a
 * capability, and an operator could observe nothing. Both times the defect was only caught because
 * something outside the codebase eventually went looking.
 *
 * So the discipline is explicit and mechanical: every product-facing diagnostic is REGISTERED, and
 * every registration DECLARES a consumer. A registration whose declared consumer does not actually
 * read it is a failing test, not a surprise at the next browser run.
 *
 * ================================ THE FOUR CLASSES ================================
 *
 *   PRODUCT_REACHABLE  a product component reads it. An operator can observe it.
 *   TEST_ONLY          only tests and the browser E2E read it. Legitimate for build counters.
 *   INTERNAL           read only inside the engine or renderer. Never part of the public surface.
 *   DEAD               written, never read by anything. Always a defect, whatever the intent.
 *
 * The rule that closes the gap: a field may only be claimed `PRODUCT_REACHABLE` if the declared
 * consumer file contains a read of it. Absence of a consumer is not an excuse to reclassify -- it is
 * the finding.
 */

/* ============================================================================================== *
 * THE DOMAIN TYPES
 * ============================================================================================== */

/**
 * One reporting gap, as the renderer actually drew it.
 *
 * `mmsi` IS NOT OPTIONAL. Without it a gap cannot be attributed to a vessel, and "did the track break
 * where I seeked?" is unanswerable -- which is precisely the ambiguity that made DF-X9.3E's escalated
 * finding impossible to settle by measurement.
 */
export type AisGapRecord = {
  mmsi: string;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  /** Seconds of missing reporting, or null when the timestamps could not be parsed. */
  spanSeconds: number | null;
};

/**
 * Why the AIS renderer is not drawing.
 *
 * ONLY REASONS THE PRODUCT CAN ACTUALLY PRODUCE. An earlier draft of this file speculated a wider
 * enum -- `NO_POSITION`, `INVALID_COORDINATE`, `PREDICTED_POSITION_UNAVAILABLE` -- none of which the
 * renderer can currently emit. A speculative enum is a promise the code does not keep, and it teaches
 * readers to expect states that never occur.
 */
export type AisRenderFailure =
  /** The renderer could not be constructed at all -- no WebGL context, most likely. */
  | 'RENDERER_UNAVAILABLE';

/** What the renderer is holding, as one typed object rather than four loose getters. */
export type AisDiagnostics = {
  /** Every reporting gap currently DRAWN, attributed to a vessel. */
  gaps: readonly AisGapRecord[];
  /** Why the layer is not drawing, or null when it is. */
  failure: AisRenderFailure | null;
  /** Primitive counts, as drawn. */
  counts: {
    contacts: number;
    observationMarkers: number;
    trackPrimitives: number;
    predictedMarkers: number;
    labels: number;
  };
  /** MMSI of every contact with a glyph. Absent means no glyph. */
  drawnMmsis: readonly string[];
};

export const EMPTY_AIS_DIAGNOSTICS: AisDiagnostics = {
  gaps: [],
  failure: null,
  counts: {
    contacts: 0,
    observationMarkers: 0,
    trackPrimitives: 0,
    predictedMarkers: 0,
    labels: 0,
  },
  drawnMmsis: [],
};

export function sameAisDiagnostics(a: AisDiagnostics, b: AisDiagnostics): boolean {
  if (a === b) return true;
  if (a.failure !== b.failure) return false;
  if (
    a.counts.contacts !== b.counts.contacts ||
    a.counts.labels !== b.counts.labels ||
    a.counts.observationMarkers !== b.counts.observationMarkers ||
    a.counts.trackPrimitives !== b.counts.trackPrimitives ||
    a.counts.predictedMarkers !== b.counts.predictedMarkers
  ) {
    return false;
  }
  if (a.gaps.length !== b.gaps.length) return false;
  for (let i = 0; i < a.gaps.length; i += 1) {
    if (a.gaps[i].mmsi !== b.gaps[i].mmsi || a.gaps[i].spanSeconds !== b.gaps[i].spanSeconds) {
      return false;
    }
  }
  if (a.drawnMmsis.length !== b.drawnMmsis.length) return false;
  for (let i = 0; i < a.drawnMmsis.length; i += 1) {
    if (a.drawnMmsis[i] !== b.drawnMmsis[i]) return false;
  }
  return true;
}

/**
 * A one-line, operator-readable statement of an AIS refusal.
 *
 * Returns null when there is nothing to refuse, so a caller can pass it straight through to
 * `recordRefusal` without inventing a reason for a healthy layer.
 */
export function describeAisFailure(failure: AisRenderFailure | null): string | null {
  switch (failure) {
    case 'RENDERER_UNAVAILABLE':
      return (
        'The AIS contact renderer could not be created, so no AIS contacts are being drawn. '
        + 'This usually means the WebGL context was lost. Every other layer is unaffected.'
      );
    case null:
      return null;
    default: {
      /*
       * EXHAUSTIVE ON PURPOSE. Adding a member to `AisRenderFailure` without a description here is a
       * TYPE ERROR rather than a row that renders `undefined` in the layer console -- which is how a
       * refusal reason becomes an empty tooltip and the operator learns nothing.
       */
      const exhaustive: never = failure;
      return `Unrecognised AIS renderer failure: ${String(exhaustive)}`;
    }
  }
}

/* ============================================================================================== *
 * THE REGISTRY
 * ============================================================================================== */

export type DiagnosticClass = 'PRODUCT_REACHABLE' | 'TEST_ONLY' | 'INTERNAL' | 'DEAD';

export type DiagnosticRegistration = {
  /** The field, as `file.ts:member`. Used verbatim in failure messages. */
  id: string;
  class: DiagnosticClass;
  /**
   * For `PRODUCT_REACHABLE`: the file that MUST contain a read of this field.
   *
   * A declared consumer that does not read the field is the defect this registry exists to catch, so
   * the test verifies the read rather than trusting the declaration.
   */
  consumer?: string;
  /** Why the classification is what it is. Read by the next person who wants to change it. */
  rationale: string;
};

/**
 * The registered product-facing diagnostics.
 *
 * SCOPED DELIBERATELY, per DF-X9.4H section 9: this is a registry of things we CLAIM are reachable,
 * not a sweep of every getter in the codebase. A sweep would either find hundreds of internal
 * helpers or, worse, be maintained by nobody and quietly rot.
 */
export const AIS_DIAGNOSTIC_REGISTRY: readonly DiagnosticRegistration[] = [
  {
    id: 'AisDiagnostics.gaps',
    class: 'PRODUCT_REACHABLE',
    consumer: 'src/temporal/AisPlaybackBar.tsx',
    rationale:
      'The gap list is what lets an operator answer "is this break where I seeked?" It reaches the '
      + 'product through the store, and the bar renders the count and total alongside the scrubber.',
  },
  {
    id: 'AisDiagnostics.failure',
    class: 'PRODUCT_REACHABLE',
    consumer: 'src/temporal/AisPlaybackBar.tsx',
    rationale:
      'A layer that silently draws nothing is indistinguishable from an archive with no vessels. '
      + 'The reason must reach the operator, and it also feeds the layer console refusal channel.',
  },
  {
    id: 'AisDiagnostics.counts',
    class: 'PRODUCT_REACHABLE',
    consumer: 'src/temporal/AisPlaybackBar.tsx',
    rationale:
      'Primitive counts as DRAWN, which is the only count that can contradict the bar\'s own derived '
      + 'figures. Rendering both is what makes a disagreement visible rather than silent.',
  },
  {
    id: 'AisDiagnostics.drawnMmsis',
    class: 'PRODUCT_REACHABLE',
    consumer: 'src/temporal/AisPlaybackBar.tsx',
    rationale:
      'The permanent regression for DF-X9.4G: a NOT_YET_OBSERVED contact must be ABSENT from this '
      + 'list. The E2E found that defect; making the list product-visible means the browser no longer '
      + 'has to be the only thing that can see it.',
  },
  {
    id: 'highlightedObservation',
    class: 'PRODUCT_REACHABLE',
    consumer: 'src/globe/aisRenderer.ts',
    rationale:
      'Set by selecting an AIS event on the mission timeline, and DRAWN as an enlarged ringed marker. '
      + 'A highlight stored in the store that no primitive reflects would be the "exposed is not '
      + 'reachable" defect a third time, in a field whose name promises exactly this.',
  },
  {
    id: 'AisContactRenderer.stats.lastBuildMs',
    class: 'TEST_ONLY',
    rationale:
      'A build-duration measurement. Surfacing it to an operator would imply a performance budget '
      + 'the product has not set, and the DF-X9.3D audit found this field carried only test readers.',
  },
];

/**
 * Classify one registration given whether its declared consumer really reads it.
 *
 * A `PRODUCT_REACHABLE` registration whose consumer does not read the field is DOWNGRADED, and
 * `DOWNGRADED` is itself the defect. Reclassifying it to `TEST_ONLY` and moving on would hide exactly
 * the failure mode this module documents.
 */
export function classify(
  registration: DiagnosticRegistration,
  consumerReadsField: boolean | null,
): { class: DiagnosticClass; problem: string | null } {
  if (registration.class !== 'PRODUCT_REACHABLE') {
    return { class: registration.class, problem: null };
  }
  if (registration.consumer === undefined) {
    return {
      class: registration.class,
      problem: `${registration.id} claims PRODUCT_REACHABLE but declares no consumer file`,
    };
  }
  if (consumerReadsField === null) {
    return {
      class: registration.class,
      problem:
        `${registration.id} claims PRODUCT_REACHABLE via ${registration.consumer}, which could not `
        + `be read. A consumer this registry cannot open is not a consumer.`,
    };
  }
  if (!consumerReadsField) {
    return {
      class: registration.class,
      problem:
        `${registration.id} claims PRODUCT_REACHABLE via ${registration.consumer}, but that file `
        + `does not read it. This is the "exposed is not reachable" defect.`,
    };
  }
  return { class: registration.class, problem: null };
}
