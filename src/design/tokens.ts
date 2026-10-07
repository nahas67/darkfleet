/**
 * DarkFleet design tokens — military maritime ISR.
 *
 * Built from scratch for this product generation. Nothing here is inherited from
 * the retired UI: the old palette was a consumer dark theme, and the new one is
 * a low-luminance operations console that has to stay readable when it is the
 * only light source in a darkened room.
 *
 * The palette is deliberately desaturated. SAR imagery and AIS symbology are the
 * only things on screen allowed to be saturated, because saturated colour is a
 * data channel here -- not decoration. Chrome that competes with the picture is
 * chrome that costs situational awareness.
 */

export const palette = {
  /** Void. The globe's own background shows through wherever a panel is absent. */
  void: '#040705',
  /** Base plane behind every floating surface. */
  base: '#070C09',
  /** Panel fill. */
  surface: '#0B110D',
  /** Raised panel fill: active surfaces, hover rows, inputs. */
  surfaceRaised: '#111812',
  /** Hairlines, dividers, inactive borders. */
  structural: '#1E2820',
  /** Structural at full strength: focused borders, active edges. */
  structuralBright: '#2C3A2F',

  /** Primary body text. Off-white, never pure #FFF -- pure white blooms on OLED. */
  text: '#D8E4DC',
  /** Secondary: labels, units, supporting copy. */
  textSecondary: '#8FA396',
  /** Tertiary: axis ticks, disabled, provenance lines. */
  textDim: '#5C6E63',

  /** Nominal / measured / healthy. */
  green: '#3FB950',
  /** Informational, selection, focus. Muted cyan, not neon. */
  cyan: '#3FA9C4',
  /** Attention without alarm: unmatched, low confidence, degraded. */
  amber: '#D9A03C',
  /** Failure, unavailable, error. */
  red: '#D4553F',
  /** Association, correlation links. */
  violet: '#7C6BB0',
} as const;

/**
 * Classification colours.
 *
 * `UNRESOLVED` is deliberately near-grey. Carried forward from the retired UI's
 * reasoning, which is worth repeating: a bright mark on an unresolved contact
 * would overstate what is actually known. Muted is the honest encoding.
 */
export const classificationColor: Readonly<Record<string, string>> = {
  SAR_MATCHED_AIS: palette.green,
  SAR_UNMATCHED: palette.amber,
  STATIONARY_OR_INFRASTRUCTURE: palette.violet,
  AIS_ONLY: palette.cyan,
  LOW_CONFIDENCE: palette.amber,
  UNRESOLVED: '#55606B',
  SEA_CLUTTER: palette.textDim,
};

/**
 * Coverage states.
 *
 * `NO_COVERAGE` is visually distinct from a zero result on purpose. "We did not
 * observe this" and "we observed nothing" are different claims and must not
 * render the same way.
 */
export const coverageColor: Readonly<Record<string, string>> = {
  AVAILABLE: palette.green,
  PARTIAL: palette.amber,
  NO_COVERAGE: palette.textDim,
  NOT_CONFIGURED: palette.textDim,
};

/**
 * Provider health, worst-first. Severity order is meaningful and used by the
 * system panel to summarise a group by its worst member, so a single failing
 * provider can never hide behind a healthy sibling.
 */
export const healthSeverity: readonly string[] = [
  'AVAILABLE',
  'DEGRADED',
  'STALE',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
  'NO_COVERAGE',
  'UNAVAILABLE',
  'NOT_CONFIGURED',
];

export const healthColor: Readonly<Record<string, string>> = {
  AVAILABLE: palette.green,
  DEGRADED: palette.amber,
  STALE: palette.amber,
  RATE_LIMITED: palette.amber,
  AUTH_REQUIRED: palette.red,
  NO_COVERAGE: palette.textDim,
  UNAVAILABLE: palette.red,
  NOT_CONFIGURED: palette.textDim,
};

/**
 * Layer category accents. Thin, used only for a 2px group rule and the active chip.
 *
 * Keyed by the REGISTRY's category names rather than the old display groups, so a
 * category with no accent cannot silently inherit an unrelated colour. Maritime and
 * seabed categories are declared here in advance: an unaccented category renders a
 * rule with no colour at all, which reads as a rendering fault rather than a new
 * group.
 */
export const groupColor: Readonly<Record<string, string>> = {
  SENSOR: palette.cyan,
  CONTACT: palette.green,
  OPERATIONAL: palette.textSecondary,
  ANALYSIS: palette.amber,
  MARITIME_BOUNDARY: palette.violet,
  MARITIME_REFERENCE: palette.green,
  SEABED: palette.cyan,
};

/**
 * Type scale.
 *
 * Two families with distinct jobs: a condensed grotesque for labels and headings
 * (dense, technical, low width), and a monospace for every number. Numerals are
 * monospaced everywhere so a telemetry column does not shimmer as values change.
 */
export const type = {
  /** Section labels, panel titles, rail captions. */
  label: {
    fontFamily: '"Arial Narrow", "Liberation Sans Narrow", "Segoe UI", system-ui, sans-serif',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
  },
  /** Values, coordinates, ids, timestamps. */
  mono: {
    fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontVariantNumeric: 'tabular-nums' as const,
  },
  /** Prose. Sentence case -- this product does not shout. */
  body: {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '12px',
    lineHeight: 1.5,
  },
} as const;

/**
 * Geometry.
 *
 * Angled corners and hairlines rather than rounded cards. A 2px clipped corner
 * reads as instrumentation; a 12px radius reads as a consumer app.
 */
export const geometry = {
  /** The clip applied to panel corners, as a CSS polygon. */
  clipCorner: (size = 8) =>
    `polygon(0 0, calc(100% - ${size}px) 0, 100% ${size}px, 100% 100%, ${size}px 100%, 0 calc(100% - ${size}px))`,
  hairline: '1px solid var(--df-structural)',
  radius: '2px',
} as const;

/** The four canonical view resolutions the layout is verified against. */
export const breakpoints = {
  full: 1920,
  laptop: 1440,
  small: 1280,
  tablet: 1024,
} as const;