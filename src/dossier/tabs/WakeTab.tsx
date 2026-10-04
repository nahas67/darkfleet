/**
 * WAKE -- experimental evidence, stated as such.
 *
 * Two rules this tab exists to enforce.
 *
 * FIRST, the status banner is not decoration. The detector is EXPERIMENTAL and NOT
 * CALIBRATED, and it does not participate in classification. An operator reading a
 * wake measurement with no such statement would reasonably assume the number
 * carries production weight, and it does not.
 *
 * SECOND, a FAILED analysis must never read as "no wake detected". Those are
 * opposite claims: one says the radar saw a hull and nothing trailing it, the other
 * says the software broke and nobody looked. `readWake` keeps them apart and this
 * tab renders the distinction rather than collapsing it.
 *
 * GEOMETRY IS DRAWN ONLY WHEN THE DETECTOR RETURNED IT
 *
 * No axis is inferred from hull heading. A centroid and a heading are different
 * quantities and neither implies the other, so a missing wake direction leaves
 * nothing to draw.
 */

import type { VesselTarget } from '../../api/contract';
import { measurement, readWake, WAKE_STATUS_BANNER } from '../format';
import {
  AbsentText,
  DataTable,
  Maybe,
  Pill,
  Provenance,
  Row,
  SectionTitle,
  StatusBanner,
  SubTitle,
  type Column,
} from '../primitives';

export function WakeTab({ target }: { target: VesselTarget }) {
  const analysis = target.wakeAnalysis ?? null;
  const reading = readWake(analysis);

  return (
    <div data-df-tab="WAKE" className="space-y-2">
      <StatusBanner lines={WAKE_STATUS_BANNER} />

      <div>
        <SectionTitle>Analysis state</SectionTitle>
        <Row label="State">
          <Pill tone={reading.kind === 'FAILED' ? 'fault' : reading.kind === 'ANALYSED' ? 'info' : 'neutral'}>
            {reading.kind}
          </Pill>
        </Row>
        <Row label="Interpretation">
          <span className="text-[10px] leading-tight">{reading.label}</span>
        </Row>
        {reading.kind === 'FAILED' ? (
          <Row label="Failure">
            <Maybe value={reading.detail} />
          </Row>
        ) : null}
      </div>

      {/*
        Everything below is shown ONLY for a completed analysis. Rendering a
        measurement table beside a FAILED state would invite a reader to treat the
        stale or zeroed values as a result.
      */}
      {reading.kind === 'ANALYSED' ? (
        <>
          <div>
            <SectionTitle>Measurement</SectionTitle>
            <Row label="Detected">
              <Pill tone={reading.detected ? 'info' : 'neutral'}>
                {reading.detected ? 'WAKE-LIKE EVIDENCE' : 'NOT DETECTED'}
              </Pill>
            </Row>
            <Row label="Evidence strength">
              {/* Evidence strength, NOT P(wake). The label matters: a number shown
                  next to a bare heading reads as a probability, and it is not one. */}
              {reading.confidence === null ? (
                <AbsentText reason="NOT_ESTABLISHED" />
              ) : (
                <span className="df-num" title="Bounded evidence strength. Not a probability.">
                  {reading.confidence.toFixed(3)}
                </span>
              )}
            </Row>
            <Row label="Method">
              <Maybe value={analysis?.method ?? null} />
            </Row>
            <Row label="Wake heading">
              <Maybe value={measurement(analysis?.heading_deg ?? null, { digits: 1, unit: 'deg' })} />
            </Row>
            <Row label="Wake direction">
              <Maybe value={measurement(analysis?.wake_direction_deg ?? null, { digits: 1, unit: 'deg' })} />
            </Row>
            <Row label="Apparent length">
              <Maybe value={measurement(analysis?.apparent_length_m ?? null, { digits: 0, unit: 'm' })} />
            </Row>
          </div>

          {/*
            The two angle conventions travel together and must both be shown.
            `arm_angle_deg` is a DIRECTED difference folded to 0..180; the axial value
            is the UNDIRECTED line angle in 0..90. Showing only the directed figure
            produced values in the 149-158 range that read as near-perpendicular
            geometry when the underlying axial angles were 19-31 degrees, inside the
            detector's own acceptance window.
          */}
          <div>
            <SubTitle>Arm geometry</SubTitle>
            <DataTable
              rows={[{ analysis }]}
              rowKey={() => 'arm'}
              caption="Directed and undirected conventions. Both are reported; neither replaces the other."
              columns={[
                {
                  key: 'directed',
                  header: 'Reported angle (directed, 0-180)',
                  numeric: true,
                  render: () => (
                    <Maybe value={measurement(analysis?.arm_angle_deg ?? null, { digits: 1, unit: 'deg' })} />
                  ),
                },
                {
                  key: 'axial',
                  header: 'Axial line angle (undirected, 0-90)',
                  numeric: true,
                  render: () => (
                    <Maybe value={measurement(analysis?.arm_angle_line_deg ?? null, { digits: 1, unit: 'deg' })} />
                  ),
                },
              ]}
              empty={<div className="text-[11px] text-ink-dim">NOT ESTABLISHED</div>}
            />
          </div>
        </>
      ) : null}

      <Provenance label="Detector notes and conventions">
        <div className="text-[11px] text-ink-2">
          {analysis?.notes ? analysis.notes : 'No notes were recorded for this analysis.'}
        </div>
        <div className="pt-1 text-[10px] text-ink-dim">
          Absence of wake evidence is NOT negative evidence and carries no penalty. A stationary
          hull, a wake beyond the chip, a low sea state and a head-on aspect all produce no
          detectable wake while the vessel is real. Wake does not modify{' '}
          <span className="df-num">sarConf</span>, AIS association, heading tolerance or
          classification.
        </div>
      </Provenance>
    </div>
  );
}