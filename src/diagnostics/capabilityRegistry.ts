/**
 * PRODUCT-CAPABILITY REACHABILITY REGISTRY.
 *
 * ================================ WHY THIS EXISTS ================================
 *
 * Three capabilities in this codebase were fully built and completely unreachable:
 *
 *   `aisRenderFailureReason`   survived DF-X9.3, DF-X9.3D (whose own audit flagged it) and
 *                              DF-X9.4E. Dead.
 *   `engine.gaps`              its commit message claimed a capability that did not exist.
 *                              Dead.
 *   `GhostVesselPanel`         backend computed the decision record, the contract declared
 *                              it, the component rendered it, and its only importer was a
 *                              superseded component. The operator question it answered --
 *                              "why was no AIS association accepted?" -- had no reachable
 *                              answer at all.
 *
 * The three had different shapes and one cause. Each was correct. Each was wired to something.
 * None was wired to something a PERSON CAN REACH.
 *
 * ================================ WHY NOT A SWEEP ================================
 *
 * Two automatic approaches were built and MEASURED during DF-X9.4H, and both failed:
 *
 *   Export sweep        166 exports across 77 production files have zero references from
 *                       other production files. Almost all are legitimate: generated contract
 *                       constants, pure helpers used within their own module, deliberately
 *                       narrow API surfaces. A gate over that list is a list nobody maintains,
 *                       which is the dead code it exists to prevent.
 *
 *   Import-graph        73 of 77 modules are reachable from `main.tsx`. The four that are not
 *                       were 3 legitimate (a test-only text helper, and two casualties of the
 *                       ghost-vessel regression itself) and 1 real. Useful -- it found the
 *                       ghost-vessel regression -- but it CANNOT see this defect class, because
 *                       `LayerConsole.tsx` is perfectly reachable and the `aria-pressed` bug
 *                       was inside it. Reachability is a property of MODULES; the defect lives
 *                       between a function and an attribute.
 *
 * So the unit here is a REGISTERED CAPABILITY, not a variable. Adding an entry is a claim that
 * must hold, and the claim is checked in four directions -- see `capabilityReachability.test.ts`.
 *
 * ================================ WHAT "REACHABLE" MEANS HERE ================================
 *
 * Five links, and a capability is not complete until all five hold:
 *
 *   DEFINITION     the capability exists as code
 *   CALLER         a production module calls it (not a test)
 *   PRODUCT_SURFACE a reachable component renders it
 *   USER_ACTION    an operator can cause it, by a named interaction
 *   BROWSER        a browser observation has been recorded, with evidence
 *
 * The last link is the one that was missing three times, and it is the only one a unit test
 * cannot supply -- which is why `browserEvidence` is a required field with no default.
 */

/** How far along the chain a capability is proven to be. */
export type ReachabilityStage =
  /** Code exists. Says nothing about whether anyone can reach it. */
  | 'DEFINED'
  /** A production module calls it. */
  | 'CALLER_REACHABLE'
  /** A component reachable from the entry point renders it. */
  | 'PRODUCT_REACHABLE'
  /** An operator can cause it through a named interaction. */
  | 'BROWSER_ACTION_REACHABLE'
  /** A browser observation has been recorded and cited. */
  | 'BROWSER_PROVEN';

export const REACHABILITY_ORDER: readonly ReachabilityStage[] = [
  'DEFINED',
  'CALLER_REACHABLE',
  'PRODUCT_REACHABLE',
  'BROWSER_ACTION_REACHABLE',
  'BROWSER_PROVEN',
];

export interface CapabilityRegistration {
  /** Stable kebab-case id. */
  readonly id: string;
  /** What question the operator can now answer that they could not before. */
  readonly operatorQuestion: string;
  /** The module that owns the capability. */
  readonly owner: string;
  /** The production module that calls it. Empty string is legal only below CALLER_REACHABLE. */
  readonly caller: string;
  /** The component that renders it in the shipped app. */
  readonly productSurface: string;
  /**
   * The exported symbol a caller must reference for this capability to be reachable.
   *
   * An EXPLICIT field rather than something parsed out of `productSurface`. The first version of
   * this gate derived the symbol by splitting the surface string on `->` and taking a word, which
   * broke the moment a surface was described as a path rather than a single component -- and a
   * check that guesses what to look for is a check that will eventually look for the wrong thing
   * and report a confident false answer.
   */
  readonly symbol: string;
  /** The user action that causes it. An empty string means there is none yet. */
  readonly userAction: string;
  readonly stage: ReachabilityStage;
  /** A stable DOM selector or attribute an E2E can assert on. Required from BROWSER_ACTION on. */
  readonly browserSelector: string;
  /**
   * Evidence of an actual browser observation: the section id and run that produced it.
   *
   * REQUIRED and NOT DEFAULTED. A capability cannot reach `BROWSER_PROVEN` with this empty,
   * because "the browser proved it" is precisely the claim that has been wrong three times and
   * the one that cannot be checked from source.
   */
  readonly browserEvidence: string;
}

export const CAPABILITY_REGISTRY: readonly CapabilityRegistration[] = [
  {
    id: 'ais-render-failure-reason',
    operatorQuestion: 'Why are no AIS contacts being drawn?',
    owner: 'src/globe/engine.ts',
    caller: 'src/sensors/LayerConsole.tsx',
    productSurface: 'LayerConsole',
    symbol: 'LayerConsole',
    userAction: 'Open the layer console; the AIS contacts row states the reason and refuses to toggle.',
    stage: 'BROWSER_PROVEN',
    browserSelector: '[data-df-layer="AIS_CONTACTS"]',
    browserEvidence:
      'DF-X9.4H section R, run94b: with a failure injected at the store, the typed code reached '
      + 'store.aisRenderFailureReason, the bar rendered it as text, and the layer row was disabled '
      + 'with the reason verbatim in its title. Dead from DF-X9.3 until that run.',
  },
  {
    id: 'ais-gap-diagnostics',
    operatorQuestion: 'Is there a hole in this vessel\'s track, and where?',
    owner: 'src/globe/engine.ts',
    caller: 'src/temporal/AisPlaybackBar.tsx',
    productSurface: 'AisPlaybackBar',
    symbol: 'AisPlaybackBar',
    userAction: 'Read the playback bar: the gap count and the MMSI it belongs to.',
    stage: 'BROWSER_PROVEN',
    browserSelector: '[data-df-ais-gap-mssis]',
    browserEvidence:
      'DF-X9.4H sections D and J, run94b: gaps=[{mmsi: 257009003, spanSeconds: 720}] read '
      + 'identically from engine.aisDiagnostics.gaps, store.aisDiagnostics.gaps and the bar\'s own '
      + 'data-df-ais-gap-mssis attribute.',
  },
  {
    id: 'ghost-vessel-semantics',
    operatorQuestion:
      'Why is this target SAR_UNMATCHED, what was observed, what was inferred, and what is unknown?',
    owner: 'backend/darkfleet/ghost_vessel.py',
    caller: 'src/dossier/tabs/EvidenceTab.tsx',
    productSurface: 'DossierWorkspace -> EVIDENCE tab -> GhostSemantics',
    symbol: 'GhostSemantics',
    userAction:
      'Select a SAR_UNMATCHED target, open the dossier EVIDENCE tab: the decision record, the '
      + 'coverage verdict, the structured observed block, and the rejected near miss.',
    stage: 'BROWSER_PROVEN',
    browserSelector: '[data-df-ghost-semantics="true"]',
    /*
     * PROVEN IN A BROWSER, against a strict build stamped `4dc55cd` and verified fresh by
     * `freshness.py` (exit 0, digest `c25ccb88`, `build_dirty=false`) served from `dist/`.
     *
     * The evidence is a 3x2 matrix rather than a single target, because the defect this capability
     * inherited was a CONSTANT: `decision.ais_coverage_state` was `NOT_ESTABLISHED` for every
     * target, so one green screenshot would have hidden it. Three targets differing only in
     * `candidatesConsidered` (key absent / 0 / 3) against two deployments differing only in
     * whether an `ais/` archive exists:
     *
     *   no archive  + null      -> AIS SOURCE NOT CONFIGURED   (candidates field blank)
     *   no archive  + 0         -> AIS SOURCE NOT CONFIGURED
     *   no archive  + 3         -> AIS SOURCE NOT CONFIGURED
     *   archive    + null      -> NOT ESTABLISHED               (candidates field BLANK, not 0)
     *   archive    + 0         -> ZERO CANDIDATES CONSIDERED    (candidates 0)
     *   archive    + 3         -> CANDIDATES REJECTED           (candidates 3)
     *
     * Six cells, six distinct renderings. The null cell rendering BLANK rather than `0` is the
     * specific regression: a null candidate count must never become a measured zero.
     *
     * Also rendered and read from the live DOM: `GHOST VESSEL` above `SAR_UNMATCHED`; the semantic
     * warning verbatim ("No sufficiently confident AIS association ... This alone does not
     * establish why."); the closest rejected candidate (MMSI 257000001, short by 0.29 at 1,840 m /
     * 96 s); the score decomposition (spatial 0.18, temporal 0.31, heading 0.22, size 0.14,
     * composite 0.11); `AIS COVERAGE STATE`; 6 hypotheses and 8 unknowns.
     *
     * Negative language: 0 violations across the rendered surface.
     */
    browserEvidence:
      'DF-X9.4S section GV, run at build 4dc55cd (digest c25ccb88): 6-cell coverage matrix '
      + '(3 candidate counts x 2 deployments), every cell rendered a distinct coverage verdict; '
      + 'null candidate count rendered BLANK not 0; decomposition 0.18/0.31/0.22/0.14/0.11; '
      + 'closest rejected MMSI 257000001 short by 0.29 at 1840 m / 96 s; 6 hypotheses, 8 unknowns; '
      + '0 forbidden-inference violations. Screenshots: shots_s2/s2_ghost_*.png.',
  },
  {
    id: 'ais-layer-control-aria-state',
    operatorQuestion: 'Is this layer control switched on, off, or unusable?',
    owner: 'src/sensors/LayerConsole.tsx',
    caller: 'src/sensors/LayerConsole.tsx',
    productSurface: 'LayerConsole',
    symbol: 'LayerConsole',
    userAction: 'Focus a layer row: its aria-pressed state is "true", "false", or false-when-disabled.',
    stage: 'BROWSER_PROVEN',
    browserSelector: '[data-df-layer] button[aria-pressed]',
    /*
     * PROVEN IN A BROWSER, section S10, against the strict build stamped `4dc55cd`.
     *
     * Source, compiled bundle and React's own server renderer had each "verified" this earlier and
     * all three were insufficient: the binding was absent from the DOM and no amount of reading
     * the code could have said so. The browser read all 14 rows: every `[data-df-layer] button`
     * carries `df-btn flex-1 justify-start`, 11 toggled and all settled with `aria-pressed`
     * inverting correctly, three legitimately UNAVAILABLE rows (`AIS_PREDICTED`, `LAND_MASK`,
     * `CFAR_DEBUG`) all reading `disabled=true, aria-pressed="false"`, and NO row anywhere reading
     * `disabled=true` together with `aria-pressed="true"`. No absent attribute.
     *
     * Three UNAVAILABLE rows, not one: the brief expected only `AIS_PREDICTED`, and an earlier
     * harness inferred "only AIS_PREDICTED may be disabled" and produced a false failure from it.
     * A harness that invents a rule and then reports the product against it is worse than no
     * harness, so the rule was withdrawn rather than the product changed.
     */
    browserEvidence:
      'DF-X9.4S section S10, run at build 4dc55cd (digest c25ccb88): 14/14 layer rows read live, '
      + 'all with class df-btn flex-1 justify-start; 11 toggled and settled with aria-pressed '
      + 'inverting; UNAVAILABLE = AIS_PREDICTED, LAND_MASK, CFAR_DEBUG all disabled=true with '
      + 'aria-pressed="false"; zero rows with disabled=true AND aria-pressed="true"; zero absent '
      + 'attributes. Screenshots: shots_s2/s2_layers_panel_1920x1080.png, '
      + 's2_layers_after_toggles.png.',
  },
  {
    id: 'timeline-ais-sync',
    operatorQuestion: 'What did this vessel look like at the moment on the mission timeline?',
    owner: 'src/timeline/MissionTimeline.tsx',
    caller: 'src/timeline/MissionTimeline.tsx',
    productSurface: 'MissionTimeline',
    symbol: 'MissionTimeline',
    userAction: 'Click an AIS event: the playhead seeks, the vessel is selected, its marker is ringed.',
    stage: 'BROWSER_PROVEN',
    browserSelector: '[data-df-ais-event]',
    browserEvidence:
      'DF-X9.4H section T, run94b: playhead moved 08:03:42.251Z -> 08:08:00.000Z (the observation '
      + 'instant exactly), highlightedObservation={mmsi:257000003, at:08:08:00Z}, selection stayed '
      + 'kind=mmsi, and exactly 1 of 54 markers enlarged to 15x15 in the selected colour with '
      + 'destroyed=false.',
  },
];

/** The weakest stage any registration claims, which is the registry's own verdict on itself. */
export function registryWeakestStage(): ReachabilityStage {
  return CAPABILITY_REGISTRY.reduce<ReachabilityStage>((weakest, entry) => {
    return REACHABILITY_ORDER.indexOf(entry.stage) < REACHABILITY_ORDER.indexOf(weakest)
      ? entry.stage
      : weakest;
  }, 'BROWSER_PROVEN');
}

/**
 * Every registration still AWAITING a browser run.
 *
 * Named for what it selects: entries whose stage is below `BROWSER_PROVEN` and which therefore
 * still owe an observation. The first version of this function filtered for stages at or above
 * `BROWSER_ACTION_REACHABLE`, which returned the entries that already HAD their evidence and
 * excluded the ones that needed it -- the inverse of its own name. A helper that reports the
 * opposite of what it says is worse than no helper, because a status report built on it would
 * list the finished work as the outstanding work.
 */
export function awaitingBrowserProof(): CapabilityRegistration[] {
  return CAPABILITY_REGISTRY.filter(
    (entry) => REACHABILITY_ORDER.indexOf(entry.stage) < REACHABILITY_ORDER.indexOf('BROWSER_PROVEN'),
  );
}
