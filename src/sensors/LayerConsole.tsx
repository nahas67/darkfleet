/**
 * Layer console.
 *
 * NOW DRIVEN BY THE REGISTRY, NOT BY A LOCAL LIST.
 *
 * This component previously held its own `DEFINITIONS` array of eleven layers, its
 * own `LayerGroup` enum, and derived `visible` from data availability on every
 * render. The result was three defects:
 *
 *   1. `visible` was RECOMPUTED, so a toggle wrote to the store and snapped back. Ten
 *      of eleven controls did nothing while looking operational.
 *   2. Labels, groups and the id union existed here AND in the engine AND in the
 *      store. Nothing compared them, so they drifted silently.
 *   3. Only GRATICULE reached the engine, via a hardcoded `if`.
 *
 * Now: the registry declares every layer's label, category and renderer; the store
 * holds only the operator's choices; `engine.setLayerVisibility` is the sole path to
 * Cesium. There is no group enum here and no `if (id === ...)` special case.
 *
 * Availability is still DERIVED rather than stored, because a stored capability flag
 * drifts out of step with the data and ends up offering an empty layer. But a derived
 * unavailability is now only a reason to DISABLE the control -- it no longer
 * overrides the operator's choice, which is what made toggles non-sticky.
 */

import { useStore, store, type LayerId } from '../state/store';
import {
  asDefinition,
  listLayers,
  type LayerCategory,
  type LayerEntry,
} from '../globe/layerRegistry';
import { groupColor } from '../design/tokens';

import type { DatasetHealthResponse } from '../api/contract';

/**
 * What a layer needs before it has anything to draw.
 *
 * Derived from real state at render time. A layer whose backing data is absent is
 * DISABLED WITH A REASON -- never shown as an enabled toggle that draws nothing,
 * and never silently dropped from the list.
 */
type Requirement = 'targets' | 'uncertainty' | 'ais' | 'tracks' | 'prediction' | 'raster' | 'maritime';

const REQUIREMENT: Partial<Record<LayerId, Requirement>> = {
  SAR_RASTER: 'raster',
  SAR_SCENE_FOOTPRINT: 'raster',
  SAR_DETECTIONS: 'targets',
  UNCERTAINTY_RADII: 'uncertainty',
  AIS_CONTACTS: 'ais',
  AIS_TRACKS: 'tracks',
  AIS_PREDICTED: 'prediction',
  // Maritime reference layers are gated on the LOCAL DATASET STORE, not on a scan.
  REFERENCE_COASTLINE: 'maritime',
  EEZ_BOUNDARIES: 'maritime',
  HIGH_SEAS: 'maritime',
};

/**
 * Per-layer reasons a maritime reference layer cannot draw, keyed by layer id.
 *
 * DISTINGUISHING THE THREE FAILURES, because they need different actions
 * ---------------------------------------------------------------------
 *   not installed here    the operator may install it -- an actionable step
 *   not installed, blocked  the operator CANNOT install it; retrying will not help
 *   corrupt                something is wrong on disk and the payload digest did not match
 *
 * A single "reference data unavailable" string would be wrong in all three cases: it would
 * invite an operator to keep retrying a download that cannot succeed, and it would hide a
 * disk fault behind what looks like a missing optional dataset.
 *
 * The reason is read from the dataset-health response, which is the backend's own account
 * of the store. It is not reconstructed from the layer id, so a dataset that becomes
 * installed mid-session reports correctly without this file changing.
 */
/**
 * The three control states a layer row can be in, and what each one reports.
 *
 * DF-X9.4H section 10 requires these be DISTINCT states rather than a boolean plus a flag:
 *
 *   enabled + on             an operator can turn it off, and it is on
 *   enabled + off            an operator can turn it on, and it is off
 *   disabled + unavailable   an operator can do nothing, and it is NOT on
 *
 * The third is where the E2E caught a real incoherence: the row was `disabled` with a stated refusal
 * AND `aria-pressed="true"`, which describes a control that is simultaneously on and unusable.
 *
 * EXTRACTED AND PURE so it can be tested without a DOM. What it returns is a THREE-STATE value, not a
 * pair of booleans, so the invalid combination cannot be expressed by accident at the call site.
 */
export type LayerControlState = 'ON' | 'OFF' | 'UNAVAILABLE';

export function layerControlState(
  visible: boolean,
  unavailableReason: string | null | undefined,
): LayerControlState {
  if (unavailableReason !== null && unavailableReason !== undefined) return 'UNAVAILABLE';
  return visible ? 'ON' : 'OFF';
}

/** The `aria-pressed` value for a control state. `UNAVAILABLE` is never pressed. */
export function ariaPressedFor(state: LayerControlState): boolean {
  return state === 'ON';
}

/** The `disabled` attribute for a control state. */
export function disabledFor(state: LayerControlState): boolean {
  return state === 'UNAVAILABLE';
}

export function maritimeLayerReason(
  health: DatasetHealthResponse | null,
  datasetId: string,
): string | undefined {
  if (health === null) {
    // Null covers both "still loading" and "the probe failed", because neither case may
    // enable a toggle for data whose presence is unknown. The console shows a disabled row
    // either way, and the SYSTEM panel carries the specific reason.
    return 'The local reference-data store has not been read yet.';
  }
  const entry = (health.datasets ?? []).find((candidate) => candidate.id === datasetId);
  if (entry === undefined) {
    return `${datasetId} is not a registered dataset.`;
  }
  if (entry.usable) return undefined;

  if (entry.install_status === 'CHECKSUM_MISMATCH' || entry.install_status === 'INVALID') {
    return (
      `${entry.label} is present on disk but does not match its recorded checksum. ` +
      'Re-install it; the local copy has been altered or truncated.'
    );
  }
  if (entry.blocker_reason) {
    // Not actionable by the operator. The full cause is rendered in the SYSTEM panel; here
    // it is shortened so the console row stays one line.
    return `${entry.label} — TRUSTED SOURCE UNAVAILABLE. See SYSTEM for the recorded reason.`;
  }
  if (entry.optional) {
    return `${entry.label} is optional and not installed.`;
  }
  return `${entry.label} is not installed.`;
}

/** Which dataset each maritime layer draws from. Mirrors the registry's source paths. */
const LAYER_DATASET: Partial<Record<LayerId, string>> = {
  REFERENCE_COASTLINE: 'natural_earth_coastline',
  EEZ_BOUNDARIES: 'marine_regions_eez_wfs',
  HIGH_SEAS: 'marine_regions_high_seas_wfs',
};

/**
 * Layers the globe cannot show as a simultaneous overlay, with the reason.
 *
 * Kept as a declared block rather than a `notImplemented` flag on the definition,
 * because these are not missing features -- the capability exists and is rendered
 * server-side in ANALYTICS. The globe attaches ONE raster at a time.
 */
const BLOCKED: Partial<Record<LayerId, string>> = {
  CORRELATION_LINKS:
    'Correlation-link geometry is not currently sent to the globe. No source calls the correlation-link renderer.',
  LAND_MASK:
    'The globe draws one SAR raster at a time. View the land mask in ANALYTICS, or run it as the raster layer.',
  CFAR_DEBUG:
    'The globe draws one SAR raster at a time. View the CFAR threshold in ANALYTICS, or run it as the raster layer.',
};

/** Display order. Categories with no layers are simply absent from the panel. */
const CATEGORY_ORDER: readonly LayerCategory[] = [
  'SENSOR',
  'CONTACT',
  'MARITIME_BOUNDARY',
  'MARITIME_REFERENCE',
  'SEABED',
  'ANALYSIS',
  'OPERATIONAL',
];

export type LayerRow = {
  id: LayerId;
  label: string;
  category: LayerCategory;
  /** The operator's stored choice. Not recomputed. */
  visible: boolean;
  opacity: number;
  supportsOpacity: boolean;
  /** Why this layer cannot be shown, when it cannot. Absence means usable. */
  unavailableReason?: string;
  /**
   * The three-state control model for this row. Always present, so no consumer has to infer it from a
   * pair of booleans that can be combined into an invalid state.
   */
  controlState: LayerControlState;
};

/**
 * Derive the console rows: registry order, real availability, stored choices.
 *
 * The important property is that `visible` here is READ, not derived. An earlier
 * version computed it as `unavailableReason === undefined`, which is precisely why
 * toggles could not stick.
 */
export function deriveLayers(
  state: ReturnType<typeof useStore>,
  maritimeHealth: DatasetHealthResponse | null = null,
  maritimeRefusals: Readonly<Record<string, string>> = {},
): LayerRow[] {
  const hasTargets = state.scanId !== null && state.targets.length > 0;
  // Both must hold: the artifact exists AND it is actually on the globe.
  const hasRaster = state.rasterLoaded && state.scanId !== null;
  const hasAis = state.aisOnly.length > 0 || state.aisObservations?.length > 0 ||
    (state.track?.observed?.length ?? 0) > 0;
  const usableFixesByMmsi = new Map<string, number>();
  for (const fix of state.aisObservations ?? []) {
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !Number.isFinite(Date.parse(fix.timestamp))) continue;
    usableFixesByMmsi.set(fix.mmsi, (usableFixesByMmsi.get(fix.mmsi) ?? 0) + 1);
  }
  const hasTracks = [...usableFixesByMmsi.values()].some((count) => count >= 2) ||
    (state.track?.observed?.length ?? 0) >= 2;
  const hasPredictions = (state.targetDetail ?? []).some((target) => {
    const corr = target.corr;
    return corr && Number.isFinite(corr.predictedLat) && Number.isFinite(corr.predictedLon);
  });
  // Maritime layers do NOT require a scan. A coastline is the same whether or not a vessel
  // was detected in it, and gating reference context on a detection would mean the sea is
  // invisible on an empty scan -- which is exactly when an operator wants to see it.
  const satisfied: Record<Requirement, boolean> = {
    targets: hasTargets,
    uncertainty: state.targets.some((target) =>
      target.geolocationUncertaintyM !== null && Number.isFinite(target.geolocationUncertaintyM) && target.geolocationUncertaintyM > 0),
    ais: hasAis,
    tracks: hasTracks,
    prediction: hasPredictions,
    raster: hasRaster,
    maritime: true,
  };

  const reasons: Record<Requirement, string> = {
    targets: 'No completed scan has produced detections.',
    uncertainty: 'No detection has a recorded positive geolocation uncertainty.',
    ais: 'No AIS source has answered for the current selection.',
    tracks: 'No vessel has at least two usable recorded positions for a track.',
    prediction: 'No correlated detection has a recorded predicted AIS position.',
    raster: 'This scan has no rendered raster artifact.',
    maritime: '',
  };

  return listLayers().map((entry: LayerEntry) => {
    const id = entry.id as LayerId;
    const choice = state.layerState[id];
    const required = REQUIREMENT[id];
    const blockedReason = BLOCKED[id];

    let unavailableReason = blockedReason;
    if (!unavailableReason && required !== undefined && !satisfied[required]) {
      unavailableReason = reasons[required];
    }

    // Maritime availability is read per LAYER from the backend's dataset-health account,
    // because the three maritime layers come from three different datasets and only one of
    // them could be missing while the others draw.
    const datasetId = LAYER_DATASET[id];
    if (!unavailableReason && datasetId !== undefined) {
      unavailableReason = state.datasetHealthError
        ? `The local reference-data re-check failed: ${state.datasetHealthError}. Installed data cannot be verified.`
        : state.datasetHealthLoading
          ? 'The local reference-data inventory is being checked.'
          : maritimeLayerReason(maritimeHealth, datasetId);
    }

    /*
     * A RUNTIME REFUSAL OUTRANKS EVERYTHING ELSE.
     *
     * The layer can have usable data, a live renderer and an enabled control, and still draw
     * nothing -- because the served provenance did not match what the registry declares, or
     * the payload failed to load. That happened during DF-X8.5, and the only visible symptom
     * was an enabled toggle over an empty globe with no error anywhere.
     *
     * So whatever the loader recorded wins, and it is reported VERBATIM rather than
     * summarised: "provenance mismatch: the layer declares X and the server returned Y" is
     * actionable, and a generic "unavailable" would not be.
     */
    const refusal = maritimeRefusals?.[id];
    if (refusal !== undefined && refusal !== '') {
      unavailableReason = refusal;
    }

    return {
      id,
      label: entry.label,
      category: entry.category,
      visible: choice?.visible ?? entry.defaultVisibility,
      opacity: choice?.opacity ?? 1,
      // Opacity on a point or vector layer has no meaning, so the control is not
      // rendered. A slider that does nothing is an inert control.
      // The globe currently applies layer visibility only. Its engine has no
      // opacity setter, so exposing a slider here would be a decorative control.
      supportsOpacity: false,
      ...(unavailableReason ? { unavailableReason } : {}),
      /*
       * THE THREE STATES, DERIVED ONCE AND ON THE ROW.
       *
       * `UNAVAILABLE` outranks visibility. A layer with nothing to draw is not "on", whatever its
       * stored flag says, and that precedence is what stops `disabled` and `aria-pressed` from
       * contradicting each other -- the incoherence DF-X9.4H section 10 records, where a disabled row
       * still announced itself as pressed.
       *
       * Deriving it HERE rather than in the JSX means the row object is self-consistent: a consumer
       * reading `row.controlState` and the DOM reading `aria-pressed` cannot disagree, because both
       * come from one value.
       */
      controlState: layerControlState(choice?.visible ?? entry.defaultVisibility, unavailableReason),
    };
  });
}

export function LayerConsole() {
  const state = useStore();
  /*
   * Reads the store's single dataset-health value.
   *
   * NOT a hook of its own. Two panels need this fact, and as two hook instances they issued
   * two requests for one AND could disagree: with LAYERS opened straight after SYSTEM, this
   * console showed the maritime rows disabled while the system panel had rendered the whole
   * list seconds earlier. The browser E2E caught that; `client.loadDatasetHealth` is the one
   * fetch and `store.datasetHealth` is the one value.
   *
   * A null value -- still loading, or the read FAILED -- disables the maritime rows rather
   * than enabling them optimistically. Offering a toggle for data whose presence is unknown is
   * the inert-control failure in a new place, and "could not read the store" is not "no data
   * installed".
   */
  const rows = deriveLayers(state, state.datasetHealth, state.maritimeLayerRefusals);

  /**
   * Write one layer's choice to the store.
   *
   * The store is the single authority and the engine reads it from
   * `TacticalWorld`'s layer effect, so this component does NOT call the engine. That
   * is the difference between one path and two: an earlier version drove GRATICULE
   * here directly while every other layer went nowhere.
   */
  const commit = (id: LayerId, visible: boolean) => {
    store.set((prev) => ({
      layerState: {
        ...prev.layerState,
        [id]: {
          visible,
          opacity: prev.layerState[id].opacity,
          ...(prev.layerState[id].unavailableReason
            ? { unavailableReason: prev.layerState[id].unavailableReason }
            : {}),
        },
      },
    }));
  };

  return (
    <section className="df-panel df-scroll h-full overflow-y-auto" data-df-workspace="LAYERS">
      <header className="df-panel-head">
        <span className="df-label">Active layers</span>
      </header>
      <p className="px-3 pt-2 text-[10px] text-ink-dim" data-df-layer-opacity-status>
        Layer visibility is adjustable. Globe opacity adjustment is unavailable in this renderer.
      </p>
      <div className="p-3">
        {CATEGORY_ORDER.map((category) => {
          const groupRows = rows.filter((row) => row.category === category);
          if (groupRows.length === 0) return null;
          return (
            <div key={category} className="mb-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-0.5"
                  style={{ background: groupColor[category] }}
                />
                <span className="df-label text-[10px]">{category}</span>
              </div>
              <ul className="space-y-1">
                {groupRows.map((row) => {
                  /*
                   * ONE derivation, THREE consumers: the styling, `disabled`, and `aria-pressed`.
                   *
                   * DF-X9.4H section 10 was fixed here once already and the fix was INCOMPLETE: the
                   * comment block below stated the intent verbatim, `ariaPressedFor()` was exported
                   * and unit-tested, `controlState` was derived on every row -- and the <button>
                   * bound `disabled` only. A browser E2E read `getAttribute('aria-pressed') === null`
                   * on all 14 rows and called the exported helper dead code at the call site. It was.
                   *
                   * The cause was structural, not a typo: `disabled` was recomputed here from
                   * `row.unavailableReason !== undefined` -- a SECOND computation of a fact
                   * `controlState` already held -- and `aria-pressed` was never written at all. The
                   * lesson is the same one DF-X9.4G learned the expensive way with the playback bar's
                   * gap counts: when one fact has two homes, the unfixed home is the one that ships
                   * stale. So there is now exactly one home for this fact.
                   */
                  const controlState = row.controlState;
                  const disabled = disabledFor(controlState);
                  const shown = controlState === 'ON';
                  return (
                    <li key={row.id} data-df-layer={row.id}>
                      <div className="flex items-center gap-2">
                          {/*
                           * `aria-pressed` IS `false` FOR A DISABLED ROW, NOT ITS STORED VISIBILITY.
                           *
                           *
                           * The browser E2E caught this, and it is correct:
                           *
                           *   [FAIL] DISCLOSED, NOT ASSERTED AS CORRECT: the disabled control still reads
                           *          aria-pressed=true, so it presents as an enabled layer that cannot be switched off
                           *
                           * `aria-pressed` is the accessibility name for "this toggle is currently ON". A row disabled
                           * BECAUSE it has nothing to draw is not switched on -- it is unusable, which is exactly what
                           * `disabled` already communicates. Reporting `true` beside `disabled` describes a control
                           * that is simultaneously on and unavailable, which is incoherent to a screen reader AND to
                           * a test, which is why an E2E assertion tripped over it before anyone read the markup.
                           *
                           * The visible STYLING is deliberately unchanged: `AIS_PREDICTED` keeps its on-tint so the
                           * operator can see which layers are configured on, and the row states its refusal in the
                           * title. Only the ARIA state changes, because only the ARIA state was making a false claim.
                           */}
                        <button
                          type="button"
                          className="df-btn flex-1 justify-start"
                          style={
                            shown
                              ? { color: 'var(--df-text)', borderColor: 'var(--df-structural-bright)' }
                              : undefined
                          }
                          disabled={disabled}
                          aria-pressed={ariaPressedFor(controlState)}
                          title={row.unavailableReason ?? row.label}
                          onClick={() => commit(row.id, !row.visible)}
                        >
                          <span className="df-mono text-[10px]">{shown ? '◉' : '○'}</span>
                          <span className="truncate normal-case tracking-normal">{row.label}</span>
                        </button>
                      </div>
                      {disabled ? (
                        <p className="df-num mt-0.5 pl-1 text-[10px] text-ink-dim">
                          {row.unavailableReason}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Re-exported so drift checks can compare what the registry declares against what the
 * engine can actually render. `asDefinition` keeps the optional `notImplemented` key
 * readable off the literal-typed entries.
 */
export { asDefinition };
