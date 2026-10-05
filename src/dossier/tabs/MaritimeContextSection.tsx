/**
 * MARITIME CONTEXT -- where this vessel sits in reference geography.
 *
 * CONTEXT IS NOT EVIDENCE, AND THE LAYOUT ENFORCES THAT
 * ------------------------------------------------------
 * This block is a separate section with its own heading, below TARGET EVIDENCE and never
 * inside it. That is deliberate and load-bearing: a reader who sees "inside Malaysia's
 * exclusive economic zone" next to a confidence number and a Ghost Vessel classification
 * will reasonably read them as related. They are not. Maritime context is where the water
 * is; classification is what the radar saw. Nothing in this component feeds
 * classification, `sarConf`, AIS association, correlation or the Ghost Vessel set, and the
 * analytical-delta test asserts the evidence document is byte-identical when maritime data
 * is present.
 *
 * NULL NEVER RENDERS AS ZERO
 * ---------------------------
 * Each channel reports a status. An absent port dataset renders as `NOT ESTABLISHED` with
 * the dataset named and the reason given -- never `0 km`, never `NO PORTS NEARBY`, never
 * `ZERO PORTS`. The system does not know that; it knows it cannot answer. Those are
 * different claims, and only one of them is true.
 *
 * THE PORT PANEL IS NOT HIDDEN
 * ---------------------------
 * An absent optional dataset could be omitted entirely, and a hidden channel looks like a
 * feature that was never built. Showing it with its provenance and its blocker reason makes
 * the absence operationally useful: an operator learns which dataset would answer and why
 * it is not answering.
 *
 * PROXIMITY IS NOT INTENT
 * -----------------------
 * A nearest port establishes distance and identity. It does not establish destination,
 * origin, ETA, intent or a port call. The backend's `interpretation` string says so and it
 * is rendered verbatim rather than restated, so the qualifier cannot be lost in a
 * re-layout.
 */

import type {
  BathymetryContext,
  CoastContext,
  PortContext,
  TargetMaritimeContextResponse,
  ZoneContext,
} from '../../api/contract';
import { Maybe, Pill, PillTone, Row, SectionTitle, SubTitle } from '../primitives';

/** Metres, shown in km once past a kilometre. Never rounded to a bare `0`. */
function distance(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return null;
  if (meters < 1_000) return `${meters.toFixed(0)} m`;
  return `${(meters / 1_000).toFixed(1)} km`;
}

function zoneTone(zone: ZoneContext): PillTone {
  if (!zone.established) return 'neutral';
  if (zone.disputed) return 'warn';
  if (zone.zone === 'HIGH_SEAS') return 'info';
  return 'neutral';
}

/**
 * The zone as one line.
 *
 * The DATASET'S representation, never DarkFleet's judgement about it. A point inside two
 * overlapping features reads DISPUTED with every claimant named -- the product reports the
 * overlap rather than picking a winner, which it has no standing to do.
 */
function zoneSummary(zone: ZoneContext): string {
  // `zone.zone` is optional in the generated contract, so the guard must exclude
  // `undefined` as well as `null`. Checking only for null let a missing value reach
  // `.replace` and print `undefined` where a zone name belongs.
  if (!zone.established || zone.zone === null || zone.zone === undefined) {
    return 'NOT ESTABLISHED';
  }
  return zone.zone.replace(/_/g, ' ');
}

/**
 * Provenance line for one channel.
 *
 * The version is shown only when it was established. A service snapshot whose publisher
 * publishes no per-layer version shows the retrieval timestamp instead of a version number
 * -- and specifically never inherits one from a different product.
 */
function provenanceLine(
  channel:
    | CoastContext
    | PortContext
    | BathymetryContext
    | ZoneContext,
): string | null {
  const provenance = channel.provenance;
  if (provenance === null || provenance === undefined) return null;
  const parts: string[] = [provenance.dataset, provenance.version];
  if (provenance.release_date) parts.push(provenance.release_date);
  // The retrieval timestamp is the ONLY version-like fact a service snapshot carries, so
  // it is shown whenever it exists. Without it two different Marine Regions snapshots
  // would be indistinguishable in the product.
  if (provenance.retrieved_at) parts.push(`retrieved ${provenance.retrieved_at}`);
  return `${parts.join(' · ')} — ${provenance.license.replace(/_/g, ' ')}`;
}

/**
 * A value the backend could not supply, rendered in the MARITIME vocabulary.
 *
 * Deliberately NOT `AbsentText`. That component speaks `AbsentReason`, whose vocabulary
 * has no `NOT_INSTALLED` -- and borrowing `NOT_ESTABLISHED` would be a lie of exactly the
 * kind this product refuses: it would say the answer is unknown when the truth is that
 * there is no dataset installed to ask. The backend already supplies the precise word in
 * `status`, so it is shown verbatim rather than translated into a nearby one.
 */
function NotAnswered({ status }: { status: string }) {
  return (
    <span className="df-num text-[11px] text-ink-dim">{status.replace(/_/g, ' ')}</span>
  );
}

function StatusRow({ channel }: { channel: { status: string } }) {
  return (
    <Row label="Status">
      <Pill tone={channel.status === 'AVAILABLE' ? 'info' : 'neutral'}>
        {channel.status.replace(/_/g, ' ')}
      </Pill>
    </Row>
  );
}

export function MaritimeContextSection({
  context,
}: {
  context: TargetMaritimeContextResponse;
}) {
  const { maritime_zone: zone, nearest_coast: coast, nearest_port: port, bathymetry } = context;

  return (
    <div data-df-maritime-context>
      {/*
        The heading states what this is before any value is shown, because the first value
        an operator reads is otherwise the zone, and "EXCLUSIVE ECONOMIC ZONE" with no
        qualifier reads as a statement about the vessel.
      */}
      <SubTitle>Maritime context</SubTitle>
      <p className="mb-1.5 text-[10px] leading-relaxed text-ink-dim">
        Reference geography for this position. This is CONTEXT, not evidence about the
        vessel: it does not affect detection, classification, confidence or correlation, and
        it is not a statement about destination, origin, intent or a port call.
      </p>

      <div className="grid grid-cols-2 gap-x-3">
        <div>
          <SectionTitle>Zone</SectionTitle>
          <Row label="Zone">
            <Pill tone={zoneTone(zone)}>{zoneSummary(zone)}</Pill>
          </Row>
          <StatusRow channel={zone} />
          {/*
            EVERY name the source gives, joined, never reduced to one. A dataset naming
            three claimants reports three; choosing among them would be DarkFleet taking a
            sovereignty position it has no standing to take.
          */}
          {(zone.sovereign_names?.length ?? 0) > 0 ? (
            <Row label="Claimants">
              <span className="text-[11px]">{zone.sovereign_names?.join(' · ')}</span>
            </Row>
          ) : null}
          {zone.dispute_note ? (
            <Row label="Dispute">
              <span className="text-[11px] text-warn">{zone.dispute_note}</span>
            </Row>
          ) : null}
          {zone.reason ? (
            <Row label="Reason">
              <span className="text-[11px] text-ink-2">{zone.reason}</span>
            </Row>
          ) : null}
          <Row label="Source">
            <span className="text-[10px] leading-relaxed text-ink-dim">
              {provenanceLine(zone) ?? 'NOT ESTABLISHED'}
            </span>
          </Row>
        </div>

        <div>
          <SectionTitle>Nearest coast</SectionTitle>
          <Row label="Distance">
            <Maybe value={distance(coast.meters)} />
          </Row>
          <StatusRow channel={coast} />
          <Row label="Method">
            {/*
              The method is named, never smoothed into "measured". A distance computed to
              densified samples is not an exact point-to-segment measurement and presenting
              it as one overstates the precision by up to half the sample spacing.
            */}
            <span className="text-[10px] text-ink-dim">
              {(coast.method ?? 'NOT_ESTABLISHED').replace(/_/g, ' ')}
              {coast.sample_spacing_m != null
                ? ` (≤${distance(coast.sample_spacing_m)} samples)`
                : ''}
            </span>
          </Row>
          <Row label="Searched to">
            <span className="text-[10px] text-ink-dim">{distance(coast.searched_radius_m) ?? 'NOT_ESTABLISHED'}</span>
          </Row>
          <Row label="Source">
            <span className="text-[10px] leading-relaxed text-ink-dim">
              {provenanceLine(coast) ?? 'NOT ESTABLISHED'}
            </span>
          </Row>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3">
        <div>
          <SectionTitle>Port context</SectionTitle>
          <Row label="Nearest port">
            {/*
              The critical line. When no port dataset is installed this must read NOT
              ESTABLISHED -- never 0 km, never "no ports nearby". The system does not know
              that no port is nearby; it knows it cannot look.
            */}
            {port.name ? (
              <span className="text-[11px]">{port.name}</span>
            ) : (
              <NotAnswered status={port.status} />
            )}
          </Row>
          <Row label="Distance">
            {port.meters === null || port.meters === undefined ? (
              <NotAnswered status={port.status} />
            ) : (
              <span className="df-num">{distance(port.meters)}</span>
            )}
          </Row>
          <StatusRow channel={port} />
          {port.country ? (
            <Row label="Country">
              <span className="text-[11px]">{port.country}</span>
            </Row>
          ) : null}
          <Row label="Dataset">
            <span className="text-[10px] leading-relaxed text-ink-dim">
              {provenanceLine(port) ?? 'NOT ESTABLISHED'}
            </span>
          </Row>
          {/*
            The qualifier is rendered from the backend, not restated here. A re-layout must
            not be able to drop the statement that proximity is not a port call.
          */}
          {port.interpretation ? (
            <p className="pt-1 text-[10px] leading-relaxed text-ink-dim">
              {port.interpretation}
            </p>
          ) : null}
          {port.detail ? (
            <p className="pt-1 text-[10px] leading-relaxed text-warn">{port.detail}</p>
          ) : null}
        </div>

        <div>
          <SectionTitle>Reference depth</SectionTitle>
          <Row label="Depth">
            {bathymetry.meters === null || bathymetry.meters === undefined ? (
              <NotAnswered status={bathymetry.status} />
            ) : (
              <span className="df-num">{bathymetry.meters.toFixed(0)} m</span>
            )}
          </Row>
          <StatusRow channel={bathymetry} />
          {bathymetry.resolution_deg ? (
            <Row label="Resolution">
              <span className="df-num text-[11px]">{bathymetry.resolution_deg}°</span>
            </Row>
          ) : null}
          <Row label="Dataset">
            <span className="text-[10px] leading-relaxed text-ink-dim">
              {provenanceLine(bathymetry) ?? 'NOT ESTABLISHED'}
            </span>
          </Row>
          {bathymetry.detail ? (
            <p className="pt-1 text-[10px] leading-relaxed text-ink-dim">
              {bathymetry.detail}
            </p>
          ) : null}
          {/*
            Stated unconditionally rather than only when a depth exists. Reference
            bathymetry is not fit for navigation, and that qualification has to be visible
            at the moment a number is read -- not discovered later by whoever uses it.
          */}
          <p className="pt-1 text-[10px] leading-relaxed text-ink-dim">
            Reference bathymetry — not for navigation.
          </p>
        </div>
      </div>
    </div>
  );
}
