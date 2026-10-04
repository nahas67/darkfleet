/**
 * POLARIZATION -- an evidence channel that reports one channel.
 *
 * The honest shape of this tab is a short table of one channel's statistics
 * beside an explicit list of what does not exist. That is not an incomplete
 * feature; it is an accurate description of a single-polarization acquisition.
 *
 * The failure this prevents is showing a dual-pol ratio as `0` or blank. Zero
 * reads as "the cross-polarized return equalled the co-polarized return", which is
 * a physical claim about the radar return that nobody measured. And a short table
 * with no explanation invites the reader to assume the product lacks the capability
 * rather than that this acquisition does not carry it.
 */

import type { VesselTarget } from '../../api/contract';
import {
  POLARIZATION_STATUS_BANNER,
  readPolarization,
  unavailableDualPol,
} from '../format';
import {
  DataTable,
  Empty,
  Maybe,
  Pill,
  Provenance,
  Row,
  SectionTitle,
  StatusBanner,
  SubTitle,
} from '../primitives';
import { POLARIZATION_UNAVAILABLE_NOTE } from './polarizationNote';

const NOT_AVAILABLE = 'NOT AVAILABLE';

export function PolarizationTab({ target }: { target: VesselTarget }) {
  const reading = readPolarization(target.polarizationEvidence ?? null);
  const missing = unavailableDualPol(reading.available);

  return (
    <div data-df-tab="POLARIZATION" className="space-y-2">
      <StatusBanner lines={POLARIZATION_STATUS_BANNER} />

      <div>
        <SectionTitle>Channel status</SectionTitle>
        <Row label="Status">
          <Pill tone={reading.kind === 'FAILED' ? 'fault' : reading.kind === 'FEATURES' ? 'info' : 'neutral'}>
            {reading.kind}
          </Pill>
        </Row>
        <Row label="Calibration domain">
          {/* sigma0 (GRD) and gamma0 (RTC) differ by an incidence-angle term, so the
              domain is part of the meaning of any number below it. */}
          <span className="df-num">{reading.domain}</span>
        </Row>
        <Row label="Available channels">
          {reading.available.length === 0 ? (
            <span className="text-ink-dim">{NOT_AVAILABLE}</span>
          ) : (
            <span className="df-num">{reading.available.join(', ')}</span>
          )}
        </Row>
        {reading.kind !== 'FEATURES' ? (
          <Row label="Reason">
            <Maybe value={reading.kind === 'FAILED' || reading.kind === 'NOT_AVAILABLE' ? reading.reason : null} />
          </Row>
        ) : null}
      </div>

      {reading.kind === 'FEATURES' ? (
        <>
          <div>
            <SubTitle>Per-channel statistics over the target mask</SubTitle>
            <DataTable
              rows={Object.entries(reading.perPol).map(([channel, stats]) => ({ channel, stats }))}
              rowKey={(row) => row.channel}
              caption="Mean / max / P95 in dB, measured over this target's own component mask."
              columns={[
                { key: 'ch', header: 'Channel', render: (row) => <span className="df-num">{row.channel}</span> },
                {
                  key: 'mean',
                  header: 'Mean dB',
                  numeric: true,
                  render: (row) => <NumOrAbsent value={row.stats.mean_db} />,
                },
                {
                  key: 'max',
                  header: 'Max dB',
                  numeric: true,
                  render: (row) => <NumOrAbsent value={row.stats.max_db} />,
                },
                {
                  key: 'p95',
                  header: 'P95 dB',
                  numeric: true,
                  render: (row) => <NumOrAbsent value={row.stats.p95_db} />,
                },
              ]}
              empty={<Empty heading="NO STATISTICS" detail="The mask selected no measurable pixels." />}
            />
          </div>

          <Provenance label="Mask provenance and sample size">
            <div className="text-[11px] text-ink-2">
              Statistics are computed over this target's own component footprint, thresholded
              midway between the component's measured clutter floor and its peak. The mask is
              derived from the component itself, never from a nearest-target inference.
            </div>
            <div className="pt-1 text-[10px] text-ink-dim">
              P95 is reported from a small sample: for a five-pixel hull the 95th percentile is
              the brightest of those pixels, so P95 and Max will be close. That is a property of
              the sample size, not evidence that the hull is uniform.
            </div>
          </Provenance>
        </>
      ) : null}

      <div>
        <SubTitle>Dual-polarization outputs</SubTitle>
        <div className="border border-structural/50 px-2 py-1.5">
          <DataTable
            rows={[
              { name: 'VH/VV', available: reading.available.includes('VH') && reading.available.includes('VV') },
              { name: 'HV/HH', available: reading.available.includes('HV') && reading.available.includes('HH') },
              { name: 'Dual-pol vessel flags', available: false },
            ]}
            rowKey={(row) => row.name}
            columns={[
              { key: 'n', header: 'Output', render: (row) => <span className="df-num">{row.name}</span> },
              {
                key: 's',
                header: 'State',
                render: (row) =>
                  row.available ? <Pill tone="info">MEASURED</Pill> : <span className="text-ink-dim">{NOT_AVAILABLE}</span>,
              },
            ]}
            empty={null}
          />
          <div className="pt-1.5 text-[10px] leading-tight text-ink-dim">{POLARIZATION_UNAVAILABLE_NOTE}</div>
        </div>
      </div>

      {missing.length > 0 ? (
        <Row label="Channels not opened">
          <span className="df-num">{missing.join(', ')}</span>
        </Row>
      ) : null}

      <div className="text-[10px] leading-tight text-ink-dim">
        A polarization flag is a flag, not a probability, and not a calibrated vessel
        classifier. It does not modify <span className="df-num">sarConf</span>, AIS association or
        classification.
      </div>
    </div>
  );
}

function NumOrAbsent({ value }: { value: number | string | undefined }) {
  if (typeof value === 'number') return <span className="df-num">{value.toFixed(3)}</span>;
  // The backend's NOT_AVAILABLE sentinel is a string, not a number. Rendering it as
  // 0.000 would be the exact fabrication this tab exists to avoid.
  return <span className="text-ink-dim">{NOT_AVAILABLE}</span>;
}