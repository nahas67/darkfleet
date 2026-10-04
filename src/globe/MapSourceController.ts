/**
 * MapSourceController -- one owner for the basemap.
 *
 * THE PROBLEM IT REPLACES
 *
 * `cesiumViewer.ts` hardcoded a single OpenStreetMap imagery provider inside a
 * `try/catch` that fell back to `baseLayer = false`. That gave four real failures:
 *
 *   1. One tile server down left a blank world, with no fallback and no message.
 *   2. `creditContainer: undefined` disabled Cesium's credit bar, so OSM's ODbL
 *      attribution requirement was simply not met.
 *   3. There was no seam, so a provider could not be swapped, tested, or replaced.
 *   4. Imagery tile errors were never observed at all -- there was no `errorEvent`
 *      listener anywhere in `src/globe`.
 *
 * WHY IT DOES NOT IMPORT CESIUM
 *
 * The controller takes provider CONSTRUCTION as an injected function and reports
 * failures through an injected observer. That is not architectural purity for its own
 * sake: it is the only way the fallback policy can be tested at all. The repo runs
 * vitest in a `node` environment with no DOM and no Cesium, so a controller that
 * imported Cesium would be untestable -- and an untestable fallback policy is a
 * fallback policy nobody can prove works.
 *
 * FALLBACK MUST NOT HIDE FAILURE (§12)
 *
 * When the primary is abandoned, `status` says so and names the reason and the source
 * actually in use. Silently swapping providers is worse than a blank world, because
 * the operator cannot then tell which imagery they are looking at.
 *
 * NO PROVIDER MAY BE LOAD-BEARING (§10)
 *
 * DarkFleet must start with no credentials. The registry is ordered, the keyless
 * source comes first, and a configured commercial source is an addition rather than a
 * prerequisite.
 */

/** Provider health. Mirrors the backend's SourceHealth; deliberately NOT the same
 *  concept as dataset coverage, which lives in the maritime provenance model. */
export type ProviderHealth =
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'NOT_CONFIGURED';

/** A configured basemap source. */
export type MapSourceSpec = {
  readonly id: string;
  readonly label: string;
  /** Human-facing attribution. Required: it is a licence obligation, not decoration. */
  readonly attribution: string;
  /**
   * Whether this source can be used right now.
   *
   * A commercial or token source with no credential is NOT_CONFIGURED, which is a
   * distinct state from UNAVAILABLE and keeps the keyless path authoritative.
   */
  readonly configured: boolean;
  /** Construct the provider. Injected so this module never imports Cesium. */
  readonly create: () => unknown;
};

/** Why the active source changed. Carried so the UI can explain itself. */
export type SourceChangeReason =
  | 'INITIAL'
  | 'MANUAL'
  | 'FALLBACK'
  | 'RECOVERY'
  | 'ALL_SOURCES_EXHAUSTED';

export type MapSourceStatus = {
  /** The source actually in use, or null when nothing could be constructed. */
  readonly activeId: string | null;
  readonly activeLabel: string | null;
  readonly health: ProviderHealth;
  /** True when the active source is not the preferred one. */
  readonly isFallback: boolean;
  /** Populated whenever `isFallback`, naming what failed and why. */
  readonly notice: string | null;
  readonly reason: SourceChangeReason;
  /** Ordered ids actually attempted, for the system panel. */
  readonly attempted: readonly string[];
};

/** Failure policy. A single missing tile is normal; a run of them is not. */
export type FailurePolicy = {
  /** Failures within `windowMs` required before falling back. */
  readonly threshold: number;
  readonly windowMs: number;
  /** Minimum dwell on a fallback before the primary may be retried. */
  readonly cooldownMs: number;
};

export const DEFAULT_FAILURE_POLICY: FailurePolicy = {
  threshold: 5,
  windowMs: 30_000,
  cooldownMs: 60_000,
};

type Attempt = { at: number };

export class MapSourceController {
  #sources: readonly MapSourceSpec[];
  #policy: FailurePolicy;
  #active: MapSourceSpec | null = null;
  #activeHandle: unknown = null;
  #failures: Attempt[] = [];
  #fallbackSince: number | null = null;
  /** Sources that FAILED (threw, or exceeded the failure threshold). */
  #attempted: string[] = [];
  /**
   * Sources skipped because they are NOT_CONFIGURED.
   *
   * Kept apart from `#attempted` because the two warrant different wording. A source
   * that threw is UNAVAILABLE; a source with no credential was never available to be
   * unavailable. Reporting an unconfigured source as "primary unavailable" would be
   * a false alarm, and reporting the fallback as a clean start would hide the fact
   * that the operator is not on the source they selected.
   */
  #unconfigured: string[] = [];
  #reason: SourceChangeReason = 'INITIAL';
  #now: () => number;

  constructor(opts: {
    sources: readonly MapSourceSpec[];
    policy?: Partial<FailurePolicy>;
    /** Injected clock, so the policy is testable without waiting in real time. */
    now?: () => number;
  }) {
    this.#sources = opts.sources;
    this.#policy = { ...DEFAULT_FAILURE_POLICY, ...(opts.policy ?? {}) };
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Every source in preference order, healthy or not. */
  get sources(): readonly MapSourceSpec[] {
    return this.#sources;
  }

  get active(): MapSourceSpec | null {
    return this.#active;
  }

  /** The provider object in use, for handing to the viewer. Null when none. */
  get activeHandle(): unknown {
    return this.#activeHandle;
  }

  status(): MapSourceStatus {
    if (this.#active === null) {
      return {
        activeId: null,
        activeLabel: null,
        health: 'UNAVAILABLE',
        isFallback: this.#reason !== 'INITIAL',
        notice:
          this.#reason === 'ALL_SOURCES_EXHAUSTED'
            ? 'No configured basemap source could be constructed. The globe will render without imagery.'
            : null,
        reason: this.#reason,
        attempted: [...this.#attempted],
      };
    }
    const isFallback = this.#reason === 'FALLBACK';
    const failedOthers = this.#attempted.filter((id) => id !== this.#active?.id);
    return {
      activeId: this.#active.id,
      activeLabel: this.#active.label,
      health: isFallback ? 'DEGRADED' : 'AVAILABLE',
      isFallback,
      notice: isFallback ? this.#notice(failedOthers) : null,
      reason: this.#reason,
      attempted: [...this.#attempted],
    };
  }

  /**
   * Why the active source is not the preferred one.
   *
   * Two different stories with two different words: a provider that FAILED is
   * unavailable, and a provider with no credential is not configured. Collapsing them
   * either raises a false alarm or hides a real substitution.
   */
  #notice(failedOthers: string[]): string {
    const parts: string[] = [];
    if (failedOthers.length > 0) {
      parts.push(`BASEMAP PRIMARY UNAVAILABLE — ${failedOthers.join(', ')} failed.`);
    }
    if (this.#unconfigured.length > 0) {
      parts.push(`Basemap source(s) ${this.#unconfigured.join(', ')} NOT CONFIGURED.`);
    }
    parts.push(`Using "${this.#active?.label ?? 'none'}".`);
    return parts.join(' ');
  }

  /**
   * Attribution for the ACTIVE source.
   *
   * Returns the active source's own attribution, never a hardcoded string, because a
   * hardcoded credit is how a provider swap leaves the previous provider's name on
   * screen. Separate credits are kept for basemap, maritime datasets and the SAR
   * provider; this is only the first of the three.
   */
  attribution(): string | null {
    return this.#active?.attribution ?? null;
  }

  /** Construct the preferred usable source. */
  start(): MapSourceStatus {
    this.#failures = [];
    this.#attempted = [];
    this.#unconfigured = [];
    this.#reason = 'INITIAL';
    return this.#activateNext('INITIAL');
  }

  /** Explicit operator choice. Pins the source so recovery will not override it. */
  select(id: string): MapSourceStatus {
    const spec = this.#sources.find((s) => s.id === id);
    if (!spec) return this.status();
    this.#failures = [];
    this.#attempted = [];
    this.#unconfigured = [];
    this.#attempted.push(id);
    this.#reason = 'MANUAL';
    this.#active = null;
    this.#activeHandle = null;
    return this.#construct(spec, 'MANUAL');
  }

  /**
   * Report one imagery failure from the provider currently in use.
   *
   * Counts within a sliding window. A single transient 404 on one tile must not
   * demote a working source, which is the reason the policy is a count over a window
   * rather than a boolean: tile-level failures are normal and only a sustained run
   * says anything about the provider.
   */
  reportFailure(): MapSourceStatus {
    const now = this.#now();
    this.#failures.push({ at: now });
    const cutoff = now - this.#policy.windowMs;
    this.#failures = this.#failures.filter((f) => f.at >= cutoff);
    if (this.#failures.length < this.#policy.threshold) return this.status();
    return this.#fallBack(now);
  }

  /** Report recovery of the source currently in use. Clears the failure run. */
  reportHealthy(): MapSourceStatus {
    this.#failures = [];
    return this.status();
  }

  /**
   * Retry the preferred source once the cooldown has elapsed.
   *
   * Guarded so it cannot thrash: without the cooldown a provider flapping between
   * healthy and unreachable would swap the basemap several times a minute, and the
   * operator would see the imagery change under them for no legible reason.
   */
  maybeRecover(): MapSourceStatus {
    if (this.#reason !== 'FALLBACK') return this.status();
    const now = this.#now();
    if (this.#fallbackSince === null) return this.status();
    if (now - this.#fallbackSince < this.#policy.cooldownMs) return this.status();

    // Only the preferred source is retried automatically. A manual choice is not
    // overridden by a background probe.
    const preferred = this.#sources[0];
    if (!preferred) return this.status();
    const attempt = this.#construct(preferred, 'RECOVERY');
    if (attempt.isFallback || attempt.activeId === null) {
      // Still bad. Restart the cooldown so the next probe is a full interval away.
      this.#fallbackSince = this.#now();
      return attempt;
    }
    this.#failures = [];
    this.#fallbackSince = null;
    return attempt;
  }

  /** Release the active provider. Must be called before the viewer is destroyed. */
  dispose(): void {
    this.#active = null;
    this.#activeHandle = null;
    this.#failures = [];
    this.#attempted = [];
    this.#unconfigured = [];
    this.#fallbackSince = null;
  }

  #fallBack(now: number): MapSourceStatus {
    const previous = this.#active?.id ?? null;
    if (previous) this.#attempted.push(previous);
    this.#active = null;
    this.#activeHandle = null;
    this.#failures = [];
    this.#fallbackSince = now;
    const status = this.#activateNext('FALLBACK');
    if (status.activeId === null) {
      // Every source is exhausted. That is a real, reportable state, and the globe
      // still works without imagery.
      this.#reason = 'ALL_SOURCES_EXHAUSTED';
      return this.status();
    }
    return status;
  }

  /** Walk the registry from the top, skipping the ones already known bad. */
  #activateNext(reason: SourceChangeReason): MapSourceStatus {
    this.#reason = reason;
    for (const spec of this.#sources) {
      if (reason === 'FALLBACK' && this.#attempted.includes(spec.id)) continue;
      const status = this.#construct(spec, reason);
      if (status.activeId !== null) {
        /*
         * Landing on anything other than the first candidate IS a fallback, whatever
         * we were doing before. Without this, a primary that throws during
         * construction is silently replaced at STARTUP and the status reads INITIAL --
         * so the operator is told nothing while looking at the wrong imagery.
         *
         * MANUAL and RECOVERY keep their own reason: an explicit choice is not a
         * fallback, and a successful recovery is not one either.
         */
        if (reason === 'INITIAL' && (this.#attempted.length > 0 || this.#unconfigured.length > 0)) {
          this.#reason = 'FALLBACK';
          return this.status();
        }
        return status;
      }
    }
    // Nothing constructed. That is a real, reportable state -- distinct from "not
    // started yet" -- and the globe still works without imagery.
    this.#reason = 'ALL_SOURCES_EXHAUSTED';
    return this.status();
  }

  #construct(spec: MapSourceSpec, reason: SourceChangeReason): MapSourceStatus {
    if (!spec.configured) {
      // NOT recorded as a failure: nothing broke, so it must not appear in the
      // "primary unavailable" wording. Tracked separately.
      if (!this.#unconfigured.includes(spec.id)) this.#unconfigured.push(spec.id);
      return this.status();
    }
    let handle: unknown;
    try {
      handle = spec.create();
    } catch {
      // A provider that cannot even be constructed is a hard failure, and it is
      // recorded so the notice can name it rather than reporting a blank world.
      this.#attempted.push(spec.id);
      return this.status();
    }
    this.#active = spec;
    this.#activeHandle = handle;
    this.#reason = reason;
    return this.status();
  }
}