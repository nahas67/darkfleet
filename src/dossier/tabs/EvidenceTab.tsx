/**
 * EVIDENCE -- the structured evidence document, in full.
 *
 * This is the tab an operator opens when they want the record rather than a
 * summary of it: the backend's own Observed / Hypotheses / Unknowns structure, plus
 * the provenance that says how the record was produced.
 *
 * WHY THIS TAB AND NOT THE SUMMARY ROUTE
 *
 * `/targets/{id}/summary` returns an ANALYST SUMMARY -- a deterministic narrative
 * rendering of the structured evidence. It is explicitly labelled as a
 * representation, not as the authority, because a narrative can be read as a
 * conclusion while the structured record underneath it is what can be checked.
 * So the narrative is rendered here under its own heading, clearly subordinate, and
 * the structured blocks remain the primary content.
 *
 * NOTHING IS RE-DERIVED
 *
 * Every line is passed through from the response. If the evidence document lacks a
 * fact the operator wants, the correct response is that DarkFleet does not know it,
 * which is what the Unknowns block is for.
 */

import { useCallback } from 'react';

import type {
  EvidenceDocument,
  EvidenceDocumentResponse,
  TargetEvidenceResponse,
  GhostVesselDossier,
  GhostVesselNotApplicable,
  TargetSummaryResponse,
  VesselTarget,
} from '../../api/contract';
import { loadScanRecord, loadTargetSlice, loadTargetSummary } from '../api';
import { GhostSemantics } from './GhostSemantics';
import { readWake } from '../format';
import type { TargetRef } from '../../intelligence/targetRef';
import {
  AbsentText,
  Empty,
  Epistemics,
  Maybe,
  Pill,
  Provenance,
  Row,
  SectionTitle,
  SubTitle,
  TabError,
  TabLoading,
} from '../primitives';
import { useTabData } from '../useTabData';

/**
 * Text of an evidence bullet.
 *
 * The backend declares these as objects with a `text` field, not as bare strings,
 * and that is deliberate: a bullet may grow structure later (a confidence, a
 * source) without a schema change breaking every consumer. So they are read
 * through the generated `EvidenceBullet` type rather than coerced from `unknown`.
 */
function texts(rows: readonly { text: string }[] | undefined): string[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => row.text ?? '').filter((line) => line.trim().length > 0);
}

/** Is this the Ghost Vessel branch of the union, rather than the not-applicable marker? */
function isGhostDossier(
  value: GhostVesselDossier | GhostVesselNotApplicable,
): value is GhostVesselDossier {
  return value !== null && typeof value === 'object' && 'is_ghost_vessel' in value;
}

/**
 * The Observed register, stated from the record's structured fields.
 *
 * Written here rather than read from a prose block because these are the facts an
 * operator will check against the other tabs, and prose that restates them can
 * drift from the numbers it was generated from.
 */
function observedStatements(evidence: EvidenceDocument): string[] {
  const lines: string[] = [];
  if (evidence.summary) lines.push(evidence.summary);
  for (const tag of evidence.tags ?? []) {
    if (tag === 'SAR_UNMATCHED' || tag === 'STATIC_INFRASTRUCTURE' || tag === 'HIGH_RCS') {
      lines.push(`Recorded tag: ${tag}.`);
    }
  }
  return lines;
}

export function EvidenceTab({ targetRef, target }: { targetRef: TargetRef; target: VesselTarget }) {
  const sliceFetcher = useCallback((signal: AbortSignal) => loadTargetSlice(targetRef)(signal), [targetRef]);
  const recordFetcher = useCallback((signal: AbortSignal) => loadScanRecord(targetRef)(signal), [targetRef]);
  const summaryFetcher = useCallback(
    (signal: AbortSignal) => loadTargetSummary(targetRef)(signal),
    [targetRef],
  );

  /*
   * Three documents, loaded independently, because they answer different questions
   * and any one of them may be unavailable:
   *
   *   slice   this target's OBSERVED / HYPOTHESES / UNKNOWNS
   *   record  the owning scan: scene, AOI, provenance, every target in it
   *   summary a deterministic NARRATIVE representation of the structured record
   *
   * Each carries its own error. A missing summary must not hide the structured
   * record, and a failing scan-record endpoint must not hide the target's
   * epistemics -- the two are independent facts and one being unavailable says
   * nothing about the other.
   */
  const slice = useTabData<TargetEvidenceResponse>(targetRef, sliceFetcher);
  const record = useTabData<EvidenceDocumentResponse>(targetRef, recordFetcher);
  const summary = useTabData<TargetSummaryResponse>(targetRef, summaryFetcher);

  const wake = readWake(target.wakeAnalysis ?? null);

  return (
    <div data-df-tab="EVIDENCE" className="space-y-2">
      {slice.status === 'loading' || slice.status === 'idle' ? (
        <TabLoading label="evidence document" />
      ) : slice.status === 'failed' ? (
        <TabError reason={slice.reason} />
      ) : (
        <EvidenceBody payload={slice.value} />
      )}

      <ScanRecordSection record={record} />

      <Provenance label="Record provenance">
        <Row label="Scan ID">
          <Maybe value={targetRef.scanId ?? null} />
        </Row>
        <Row label="Target ID">
          <span className="df-num">{target.id}</span>
        </Row>
        <Row label="Wake state">
          <Pill tone={wake.kind === 'FAILED' ? 'fault' : 'neutral'}>{wake.kind}</Pill>
        </Row>
        <div className="pt-1 text-[10px] leading-tight text-ink-dim">
          The evidence document is produced by the backend from the stored scan record. This tab
          renders it and adds nothing to it.
        </div>
      </Provenance>

      <div>
        <SubTitle>Analyst summary</SubTitle>
        <div className="border border-structural/50 px-2 py-1.5">
          <div className="df-label text-[10px] uppercase text-ink-dim">
            A deterministic narrative representation of the structured record above. The structured
            record is authoritative.
          </div>
          <div className="pt-1">
            {summary.status === 'loading' || summary.status === 'idle' ? (
              <div className="text-[11px] text-ink-dim">Loading summary…</div>
            ) : summary.status === 'failed' ? (
              <div className="text-[11px] text-fault">The summary could not be produced: {summary.reason}</div>
            ) : (
              <SummaryBody value={summary.value} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EvidenceBody({ payload }: { payload: TargetEvidenceResponse }) {
  // The generated contract type, not a local mirror. §53 forbids hand-written
  // frontend schemas, and a local `EvidenceShape` would drift from the backend the
  // first time a block gained a field.
  const evidence = payload.evidence;
  // `ghost_vessel` is a real union on the wire: a Ghost Vessel dossier OR an
  // explicit not-applicable marker. Narrowing it by the discriminator rather than
  // by truthiness is what stops the "NOT APPLICABLE" branch from rendering as if it
  // were a dossier with empty fields.
  const ghost = isGhostDossier(evidence.ghost_vessel) ? evidence.ghost_vessel : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-3">
        <div>
          <SectionTitle>Identity</SectionTitle>
          <Row label="Target ID">
            <span className="df-num">{evidence.target_id}</span>
          </Row>
          <Row label="Classification">
            <span className="df-num">{evidence.classification}</span>
          </Row>
          <Row label="Designation">
            <Maybe value={evidence.designation ?? null} />
          </Row>
          {ghost ? (
            <>
              <Row label="Analytical classification">
                {/* The designation ("GHOST VESSEL") and the analytical classification
                    ("SAR_UNMATCHED") are different claims and both are shown. */}
                <span className="df-num">{ghost.analytical_classification}</span>
              </Row>
              <Row label="Ghost Vessel">
                <Pill tone="warn">{ghost.is_ghost_vessel === true ? 'YES' : 'NO'}</Pill>
              </Row>
            </>
          ) : (
            <Row label="Ghost Vessel dossier">
              <span className="text-ink-dim">NOT APPLICABLE</span>
            </Row>
          )}
        </div>
        <div>
          <SectionTitle>Record</SectionTitle>
          <Row label="Scan">
            <span className="df-num">{payload.scan_id}</span>
          </Row>
          <Row label="Ambiguous">
            <Pill tone={payload.ambiguous ? 'warn' : 'neutral'}>{payload.ambiguous ? 'YES' : 'NO'}</Pill>
          </Row>
          <Row label="Runtime mode">
            <span className="df-num">{payload.runtime_mode}</span>
          </Row>
          <Row label="Synthetic">
            <Pill tone={payload.synthetic ? 'fault' : 'neutral'}>{payload.synthetic ? 'YES' : 'NO'}</Pill>
          </Row>
        </div>
      </div>

      {ghost && ghost.semantic_warning ? (
        <div className="border border-warn/50 px-2 py-1.5" data-df-evidence-semantic-warning>
          <div className="df-label text-[10px] uppercase text-warn">Semantic warning</div>
          <div className="pt-0.5 text-[11px] text-ink-2">{ghost.semantic_warning}</div>
        </div>
      ) : null}

      {/*
        THE GHOST VESSEL DECISION.

        This is the block that was unreachable. `GhostVesselPanel` rendered it and nothing in the
        product mounted that panel, so the candidate count, the acceptance threshold, the rejected
        near miss and the score decomposition were computed by the backend and shown to no one --
        while this very tab fetched the same endpoint and already had the union narrowed in hand.

        It is rendered HERE rather than as a twelfth tab because the tab would have duplicated this
        one: same URL, same warning, two copies of the epistemics that could disagree. See the
        module header of `GhostSemantics.tsx`.
      */}
      {ghost ? <GhostSemantics ghost={ghost} /> : null}

      <div>
        <SubTitle>Structured epistemics</SubTitle>
        {/*
          The document separates what was measured from what might explain it and
          from what remains unknown. `observed` is stated from the record's own
          detection fields rather than reconstructed from prose, so it cannot drift
          from the structured data beside it.

          A GHOST VESSEL'S OWN bullets win. `evidence.hypotheses` is the record-wide list; the ghost
          dossier carries its own, written for this case. Reading the wrong one would put generic
          text beside a specific finding -- and the wrong list is the easier mistake to make
          silently, because both are arrays of `{ text }` and neither throws.
        */}
        <Epistemics
          observed={observedStatements(evidence)}
          hypotheses={texts(ghost?.hypotheses ?? evidence.hypotheses)}
          unknowns={texts(ghost?.unknowns ?? evidence.unknowns)}
        />
      </div>

      {evidence.summary ? (
        <div>
          <SubTitle>Record summary</SubTitle>
          <div className="text-[11px] text-ink-2">{evidence.summary}</div>
        </div>
      ) : null}

      {Array.isArray(evidence.tags) && evidence.tags.length > 0 ? (
        <div>
          <SubTitle>Tags</SubTitle>
          <div className="flex flex-wrap gap-1">
            {evidence.tags.map((tag) => (
              <Pill key={tag} tone={tag === 'SAR_UNMATCHED' ? 'warn' : 'neutral'}>
                {tag}
              </Pill>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The owning scan record.
 *
 * A different document from the target slice: this is the scan, with its scene, AOI,
 * provenance and every target it produced. It is what lets an operator confirm that
 * the target they are investigating came from the acquisition they think it did.
 */
function ScanRecordSection({ record }: { record: { status: string; value?: EvidenceDocumentResponse; reason?: string } }) {
  if (record.status === 'loading' || record.status === 'idle') {
    return (
      <div>
        <SubTitle>Owning scan record</SubTitle>
        <div className="text-[11px] text-ink-dim">Loading scan record…</div>
      </div>
    );
  }
  if (record.status === 'failed' || !record.value) {
    return (
      <div>
        <SubTitle>Owning scan record</SubTitle>
        <Empty heading="SCAN RECORD UNAVAILABLE" detail="The owning scan document could not be read. The target's own evidence above is unaffected." />
      </div>
    );
  }
  const doc = record.value.evidence;
  return (
    <div>
      <SubTitle>Owning scan record</SubTitle>
      <Row label="Scan ID">
        <span className="df-num">{doc.scan_id}</span>
      </Row>
      <Row label="Schema version">
        <span className="df-num">{doc.schema_version}</span>
      </Row>
      <Row label="Acquisition time">
        <span className="df-num">{doc.acquisition_time}</span>
      </Row>
      <Row label="Scene">
        <span className="df-num">{doc.scene?.item_id ?? 'NOT ESTABLISHED'}</span>
      </Row>
      <Row label="Targets in scan">
        <span className="df-num">{doc.targets?.length ?? 0}</span>
      </Row>
      <Row label="Runtime mode">
        <Pill tone={doc.synthetic ? 'fault' : 'neutral'}>{doc.synthetic ? 'SYNTHETIC' : doc.runtime_mode}</Pill>
      </Row>
      <Row label="Ambiguous id">
        <Pill tone={record.value.ambiguous ? 'warn' : 'neutral'}>
          {record.value.ambiguous ? 'YES' : 'NO'}
        </Pill>
      </Row>
      <div className="pt-1 text-[10px] leading-tight text-ink-dim">
        This is the whole scan, not this target. It is shown so the acquisition behind the
        investigation can be confirmed; the target&apos;s own epistemics are above.
      </div>
    </div>
  );
}

function SummaryBody({ value }: { value: TargetSummaryResponse }) {
  const narrative = value.narrative;
  if (narrative.status === 'AI_UNAVAILABLE') {
    return (
      <div className="text-[11px] text-ink-dim">
        <AbsentText reason="NOT_AVAILABLE" /> — {narrative.reason}
      </div>
    );
  }
  const doc = narrative.document;
  if (!doc) return <div className="text-[11px] text-ink-dim">NOT ESTABLISHED</div>;
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-ink-2">{doc.summary}</div>
      <div className="df-num text-[10px] text-ink-dim">
        writer {doc.provenance.writer} · network calls {doc.provenance.network_calls}
      </div>
      <Epistemics observed={doc.observed} hypotheses={doc.hypotheses} unknowns={doc.unknowns} />
    </div>
  );
}