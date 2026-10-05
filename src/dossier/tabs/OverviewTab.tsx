/**
 * OVERVIEW -- the condensed intelligence summary.
 *
 * Renders from the already-loaded target object, so it appears immediately with no
 * request of its own (§50). That is deliberate: the operator's first question is
 * "what am I looking at", and making them wait on a network round trip to learn
 * the target's classification would be the wrong trade for a panel that can
 * already answer from state.
 *
 * Everything shown here is passed through from the target record. Nothing is
 * derived, rescored or inferred in this component.
 */

import type { ScanScene, TargetMaritimeContextResponse, VesselTarget } from '../../api/contract';
import { isGhostVessel, measurement, readPolarization, readWake, text } from '../format';
import {
  AbsentText,
  Epistemics,
  Maybe,
  Pill,
  Row,
  SectionTitle,
  StatusBanner,
  SubTitle,
} from '../primitives';
import { POLARIZATION_STATUS_BANNER, WAKE_STATUS_BANNER } from '../format';
import { POLARIZATION_UNAVAILABLE_NOTE } from './polarizationNote';
import { MaritimeContextSection } from './MaritimeContextSection';
import { ClassificationPill } from '../classification';

export function OverviewTab({
  target,
  scene,
  maritime,
}: {
  target: VesselTarget;
  scene: ScanScene | null;
  /**
   * Maritime context, when it has loaded.
   *
   * OPTIONAL AND DELIBERATELY SO. This tab is otherwise served entirely from the
   * already-loaded target object, with no request of its own -- the operator's first
   * question is "what am I looking at", and making them wait on a round trip for the
   * classification would be the wrong trade. Maritime context is the one field here that
   * needs the backend, because the position alone cannot answer "which EEZ".
   *
   * So it renders nothing rather than a spinner when absent or still loading: the rest of
   * OVERVIEW is complete without it, and a placeholder that says "loading maritime
   * context" next to a classification the operator can already read would suggest the two
   * are related. The block appears when it is real.
   */
  maritime?: TargetMaritimeContextResponse | null;
}) {
  const ghost = isGhostVessel(target.classification);
  const wake = readWake(target.wakeAnalysis ?? null);
  const pol = readPolarization(target.polarizationEvidence ?? null);

  return (
    <div data-df-tab="OVERVIEW" className="space-y-2">
      <div className="grid grid-cols-2 gap-x-3">
        <div>
          <SectionTitle>Detection</SectionTitle>
          <Row label="Target ID">
            <span className="df-num">{target.id}</span>
          </Row>
          <Row label="Classification">
            {/* Same readable-wording treatment as the header. Two sites show the
                classification on OVERVIEW, so fixing only one would leave the debt visible
                the moment the operator looked at the Detection block. */}
            <ClassificationPill classification={target.classification} />
          </Row>
          <Row label="Latitude">
            <span className="df-num">{target.lat.toFixed(5)}</span>
          </Row>
          <Row label="Longitude">
            <span className="df-num">{target.lon.toFixed(5)}</span>
          </Row>
          <Row label="SAR confidence">
            <span className="df-num">{target.sarConf.toFixed(2)}</span>
          </Row>
          <Row label="Footprint L×W">
            <span className="df-num">
              {target.lenM}×{target.widM} m
            </span>
          </Row>
          <Row label="Length uncertainty">
            <Maybe value={measurement(target.lenUncM, { digits: 0, unit: 'm' })} />
          </Row>
          <Row label="Heading">
            {/* Heading is nullable and stays that way. A wake axis is NOT a heading
                and must never be substituted for one. */}
            <Maybe value={measurement(target.hdg, { digits: 1, unit: 'deg' })} />
          </Row>
          <Row label="Mean backscatter">
            <span className="df-num">{target.meanDb.toFixed(2)} dB</span>
          </Row>
          <Row label="Max backscatter">
            <span className="df-num">{target.maxDb.toFixed(2)} dB</span>
          </Row>
        </div>

        <div>
          <SectionTitle>Acquisition</SectionTitle>
          <Row label="Acquisition time">
            <Maybe value={text(scene?.acquisition_time ?? null)} />
          </Row>
          <Row label="Scene ID">
            <Maybe value={text(scene?.item_id ?? null)} />
          </Row>
          <Row label="Platform">
            <Maybe value={text(scene?.platform ?? null)} />
          </Row>
          <Row label="Product">
            <Maybe value={text(scene?.product ?? null)} />
          </Row>
          <Row label="Polarization">
            <Maybe value={text(scene?.polarization ?? null)} />
          </Row>
          <Row label="Region">
            <AbsentText reason="NOT_ESTABLISHED" />
          </Row>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3">
        <div>
          <SectionTitle>AIS</SectionTitle>
          <Row label="Coverage state">
            {/* Deliberately NOT ESTABLISHED here: coverage is an archive-and-window
                fact that the AIS branch answers properly. Guessing it from the
                classification would assert "no coverage" for every unmatched target,
                which is a different and much stronger claim. */}
            <AbsentText reason="NOT_ESTABLISHED" />
          </Row>
          <Row label="Association">
            {target.classification === 'SAR_MATCHED_AIS' ? (
              <Maybe value={text(target.corr?.mmsi ?? null)} />
            ) : ghost ? (
              <Pill tone="warn">UNMATCHED</Pill>
            ) : (
              <AbsentText reason="NOT_ESTABLISHED" />
            )}
          </Row>
          <Row label="Candidates considered">
            <AbsentText reason="NOT_ESTABLISHED" />
          </Row>
          <Row label="Acceptance threshold">
            <AbsentText reason="NOT_ESTABLISHED" />
          </Row>
          <Row label="Closest rejected">
            <AbsentText reason="NOT_ESTABLISHED" />
          </Row>
        </div>

        <div>
          <SectionTitle>Secondary channels</SectionTitle>
          <Row label="Wake">
            <Pill tone={wake.kind === 'ANALYSED' ? 'info' : 'neutral'}>{wake.kind}</Pill>
          </Row>
          <Row label="Wake product status">
            <span className="text-[10px] text-warn">NOT CALIBRATED</span>
          </Row>
          <Row label="Polarization">
            <Pill tone={pol.kind === 'FEATURES' ? 'info' : 'neutral'}>{pol.kind}</Pill>
          </Row>
          <Row label="Multipass">
            <AbsentText reason="NOT_ESTABLISHED" />
          </Row>
          <Row label="Revisit">
            <AbsentText reason="NOT_ESTABLISHED" />
          </Row>
          <Row label="Patterns">
            <AbsentText reason="NOT_ESTABLISHED" />
          </Row>
        </div>
      </div>

      <SubTitle>Mandatory product status</SubTitle>
      <StatusBanner lines={WAKE_STATUS_BANNER} />
      <StatusBanner lines={POLARIZATION_STATUS_BANNER} />

      {/*
        MARITIME CONTEXT IS ITS OWN BLOCK, BELOW TARGET EVIDENCE
        -------------------------------------------------------
        It sits after the evidence sections and outside them, never interleaved into
        DETECTION or SECONDARY CHANNELS. A reader scanning this tab must not be able to
        read "inside Malaysia's EEZ" as one more attribute of the detection. It is where
        the water is; the detection is what the radar saw.
      */}
      {maritime ? <MaritimeContextSection context={maritime} /> : null}

      {ghost ? (
        <>
          <SubTitle>Why this target is unmatched</SubTitle>
          {/*
            The three blocks are the whole answer to "why", and they are kept
            separate on purpose. `CORRELATION` holds the candidate arithmetic; this
            is the epistemics summary and it deliberately does NOT restate it, so an
            operator can read the reasoning here and check the numbers there.
          */}
          <Epistemics
            observed={[
              `A SAR return was measured at ${target.lat.toFixed(5)}, ${target.lon.toFixed(5)} with detection confidence ${target.sarConf.toFixed(2)}.`,
              `The classification is SAR_UNMATCHED, which means no AIS association reached the acceptance threshold.`,
            ]}
            hypotheses={[
              'Hypothesis: the AIS coverage for this place and time was absent, incomplete, or did not contain a vessel in the match window.',
              'This is a hypothesis about data availability. It is not a statement about the vessel or any operator of one.',
            ]}
            unknowns={[
              'Identity: unknown. DarkFleet cannot say what vessel this was, if any.',
              'Intent: unknown. Nothing in the evidence supports a statement about intention.',
              'Whether a wake was present: see the WAKE tab. The detector is experimental and not calibrated.',
            ]}
          />
        </>
      ) : null}
    </div>
  );
}