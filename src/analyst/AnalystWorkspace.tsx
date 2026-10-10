/** Local deterministic grounded analyst, independently mountable by prime.
 *
 * This UI does NOT send freeform notes/prompts to a model. It requests bounded
 * case-scoped evidence extraction, then shows saved source paths and unknowns.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ContractViolation, explain } from '../api/errors';

export type AnalystIntent = 'SUMMARY' | 'WATCHLIST' | 'SAR_AIS' | 'GAPS';
export type SourceStatus =
  | 'PERSISTED_REAL' | 'NO_SCAN_LINKED' | 'SOURCE_MISSING' | 'SOURCE_UNVERIFIED';
export interface AnalystCaseBrief {
  case_id: string;
  title: string;
  linked_scan_id: string | null;
  created_at: string;
}
export interface AnalystSource {
  kind: 'PERSISTED_REAL_SCAN' | 'OPERATOR_CASE' | 'OPERATOR_WATCHLIST';
  source_id: string;
  record_path: string;
  field_path: string;
}
export interface AnalystClaim {
  id: string;
  statement: string;
  value: string | number | boolean;
  classification: 'SENSOR_RECORD' | 'OPERATOR_RECORD';
  uncertainty: string;
  sources: AnalystSource[];
}
export interface AnalystUnknown {
  code: string;
  explanation: string;
  source_id: string | null;
  expected_field_path: string | null;
  next_check: string;
}
export interface GroundedAnalysis {
  kind: 'DARKFLEET_GROUNDED_ANALYST';
  case_id: string;
  case_title: string;
  linked_scan_id: string | null;
  source_status: SourceStatus;
  intent: AnalystIntent;
  focused_target_id: string | null;
  model_status: 'NO_MODEL_DETERMINISTIC_OFFLINE';
  claims: AnalystClaim[];
  unknowns: AnalystUnknown[];
  operator_note_count: number;
  operator_watch_count: number;
  source_canonical_sha256: string | null;
  disclaimer: string;
}

const intents: AnalystIntent[] = ['SUMMARY', 'WATCHLIST', 'SAR_AIS', 'GAPS'];
const statuses: SourceStatus[] = [
  'PERSISTED_REAL', 'NO_SCAN_LINKED', 'SOURCE_MISSING', 'SOURCE_UNVERIFIED',
];
const safeTargetId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractViolation(at, `${at} is not an object.`);
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new ContractViolation(at, `${at} is not text.`);
  return value;
}
function optionalString(value: unknown, at: string): string | null {
  return value === null ? null : string(value, at);
}
function count(value: unknown, at: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0) {
    throw new ContractViolation(at, `${at} must be a nonnegative count.`);
  }
  return value;
}
function items(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new ContractViolation(at, `${at} must be an array.`);
  return value;
}
export function readAnalystCases(raw: unknown): AnalystCaseBrief[] {
  const v = object(raw, 'AnalystCaseListOut');
  const total = count(v.total, 'AnalystCaseListOut.total');
  string(v.note, 'AnalystCaseListOut.note');
  const rows = items(v.cases, 'AnalystCaseListOut.cases');
  if (rows.length > total || rows.length > 200) {
    throw new ContractViolation('AnalystCaseListOut.cases', 'Case count is inconsistent.');
  }
  return rows.map((row) => {
    const c = object(row, 'AnalystCaseBrief');
    string(c.case_id, 'AnalystCaseBrief.case_id');
    string(c.title, 'AnalystCaseBrief.title');
    optionalString(c.linked_scan_id, 'AnalystCaseBrief.linked_scan_id');
    string(c.created_at, 'AnalystCaseBrief.created_at');
    return c as unknown as AnalystCaseBrief;
  });
}
export function readGroundedAnalysis(raw: unknown): GroundedAnalysis {
  const v = object(raw, 'GroundedAnalysis');
  if (v.kind !== 'DARKFLEET_GROUNDED_ANALYST' ||
      v.model_status !== 'NO_MODEL_DETERMINISTIC_OFFLINE') {
    throw new ContractViolation('GroundedAnalysis.kind', 'Unrecognized offline analyst authority.');
  }
  string(v.case_id, 'GroundedAnalysis.case_id');
  string(v.case_title, 'GroundedAnalysis.case_title');
  optionalString(v.linked_scan_id, 'GroundedAnalysis.linked_scan_id');
  optionalString(v.focused_target_id, 'GroundedAnalysis.focused_target_id');
  optionalString(v.source_canonical_sha256, 'GroundedAnalysis.source_canonical_sha256');
  if (v.source_canonical_sha256 !== null &&
      !/^[a-f0-9]{64}$/.test(v.source_canonical_sha256 as string)) {
    throw new ContractViolation('GroundedAnalysis.source_canonical_sha256', 'Invalid scan digest.');
  }
  if (!statuses.includes(v.source_status as SourceStatus)) {
    throw new ContractViolation('GroundedAnalysis.source_status', 'Unknown source status.');
  }
  if (!intents.includes(v.intent as AnalystIntent)) {
    throw new ContractViolation('GroundedAnalysis.intent', 'Unknown analyst intent.');
  }
  string(v.disclaimer, 'GroundedAnalysis.disclaimer');
  count(v.operator_note_count, 'GroundedAnalysis.operator_note_count');
  count(v.operator_watch_count, 'GroundedAnalysis.operator_watch_count');
  const claims = items(v.claims, 'GroundedAnalysis.claims');
  const unknowns = items(v.unknowns, 'GroundedAnalysis.unknowns');
  if (claims.length > 150 || unknowns.length > 150) {
    throw new ContractViolation('GroundedAnalysis', 'Unbounded evidence payload.');
  }
  for (const claim of claims) {
    const c = object(claim, 'AnalystClaim');
    string(c.id, 'AnalystClaim.id');
    string(c.statement, 'AnalystClaim.statement');
    string(c.uncertainty, 'AnalystClaim.uncertainty');
    if (!['SENSOR_RECORD', 'OPERATOR_RECORD'].includes(c.classification as string)) {
      throw new ContractViolation('AnalystClaim.classification', 'Unsupported evidence classification.');
    }
    if (!(typeof c.value === 'string' || typeof c.value === 'boolean' ||
      (typeof c.value === 'number' && Number.isFinite(c.value)))) {
      throw new ContractViolation('AnalystClaim.value', 'Expected a finite recorded scalar.');
    }
    const refs = items(c.sources, 'AnalystClaim.sources');
    if (!refs.length || refs.length > 3) {
      throw new ContractViolation('AnalystClaim.sources', 'A claim must include bounded citations.');
    }
    for (const ref of refs) {
      const s = object(ref, 'AnalystSource');
      if (!['PERSISTED_REAL_SCAN', 'OPERATOR_CASE', 'OPERATOR_WATCHLIST'].includes(s.kind as string)) {
        throw new ContractViolation('AnalystSource.kind', 'Unknown source classification.');
      }
      string(s.source_id, 'AnalystSource.source_id');
      string(s.record_path, 'AnalystSource.record_path');
      const fieldPath = string(s.field_path, 'AnalystSource.field_path');
      if (c.classification === 'SENSOR_RECORD' &&
          (s.kind !== 'PERSISTED_REAL_SCAN' || !fieldPath.startsWith('$.'))) {
        throw new ContractViolation('AnalystSource', 'Sensor claim must cite a JSON scan field.');
      }
      if (c.classification === 'OPERATOR_RECORD' && s.kind === 'PERSISTED_REAL_SCAN') {
        throw new ContractViolation('AnalystSource', 'Operator claim cannot masquerade as sensor evidence.');
      }
    }
  }
  if (v.source_status !== 'PERSISTED_REAL' &&
      claims.some((c) => object(c, 'AnalystClaim').classification === 'SENSOR_RECORD')) {
    throw new ContractViolation('GroundedAnalysis.claims', 'Unavailable source cannot support sensor claims.');
  }
  if (v.source_status !== 'PERSISTED_REAL' && v.source_canonical_sha256 !== null) {
    throw new ContractViolation('GroundedAnalysis.source_canonical_sha256',
      'Unavailable source cannot have a verified scan digest.');
  }
  for (const issue of unknowns) {
    const u = object(issue, 'AnalystUnknown');
    string(u.code, 'AnalystUnknown.code');
    string(u.explanation, 'AnalystUnknown.explanation');
    optionalString(u.source_id, 'AnalystUnknown.source_id');
    optionalString(u.expected_field_path, 'AnalystUnknown.expected_field_path');
    string(u.next_check, 'AnalystUnknown.next_check');
  }
  return v as unknown as GroundedAnalysis;
}

export async function listAnalystCases(): Promise<AnalystCaseBrief[]> {
  return readAnalystCases(await api.get<unknown>('/api/analyst/cases'));
}
export async function runGroundedAnalysis(
  caseId: string, intent: AnalystIntent, targetId?: string,
): Promise<GroundedAnalysis> {
  if (!/^[0-9a-fA-F-]{36}$/.test(caseId)) {
    throw new Error('Select a saved investigation case.');
  }
  if (targetId && !safeTargetId.test(targetId)) {
    throw new Error('Target ID has unsupported characters.');
  }
  const raw = await api.post<unknown>(`/api/analyst/cases/${encodeURIComponent(caseId)}/analyze`, {
    intent, ...(targetId ? { target_id: targetId } : {}),
  });
  const outcome = readGroundedAnalysis(raw);
  if (outcome.case_id !== caseId || outcome.intent !== intent ||
      outcome.focused_target_id !== (targetId || null)) {
    throw new ContractViolation('GroundedAnalysis.case_id', 'Response is for another case or requested analysis.');
  }
  return outcome;
}

export function AnalystWorkspace() {
  const [cases, setCases] = useState<AnalystCaseBrief[]>([]);
  const [caseId, setCaseId] = useState('');
  const [intent, setIntent] = useState<AnalystIntent>('SUMMARY');
  const [targetId, setTargetId] = useState('');
  const [analysis, setAnalysis] = useState<GroundedAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    void listAnalystCases().then((rows) => {
      if (!active) return;
      setCases(rows);
      setCaseId(rows[0]?.case_id ?? '');
    }).catch((cause: unknown) => {
      if (active) setError(explain(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const resetSelection = () => {
    generation.current++;
    setAnalysis(null);
    setError(null);
  };
  const reload = () => {
    resetSelection();
    setLoading(true);
    void listAnalystCases().then((rows) => {
      setCases(rows);
      setCaseId((old) => rows.some((row) => row.case_id === old) ? old : rows[0]?.case_id ?? '');
    }).catch((cause: unknown) => setError(explain(cause)))
      .finally(() => setLoading(false));
  };
  const analyze = () => {
    resetSelection();
    const token = generation.current;
    setBusy(true);
    const scopedTarget = (intent === 'SAR_AIS' || intent === 'WATCHLIST') ?
      targetId.trim() || undefined : undefined;
    void runGroundedAnalysis(caseId, intent, scopedTarget).then((result) => {
      if (token === generation.current) setAnalysis(result);
    }).catch((cause: unknown) => {
      if (token === generation.current) setError(explain(cause));
    }).finally(() => {
      if (token === generation.current) setBusy(false);
    });
  };
  const selected = cases.find((entry) => entry.case_id === caseId);
  return (
    <section className="space-y-3 overflow-y-auto p-3" data-df-grounded-analyst>
      <h2 className="df-label text-xs">Grounded case analyst · DF-X20</h2>
      <p className="text-[11px] text-ink-dim" data-df-analyst-model-state>
        NO MODEL CONFIGURED — deterministic offline analysis. No local or
        remote LLM is contacted. Operator notes and prompts are not used as
        instructions or sensor evidence.
      </p>
      <p className="text-[11px] text-ink-dim">
        Every claim below cites a saved scan JSON field or an operator case
        record. Unknown evidence is shown as unknown, never inferred.
      </p>
      <button type="button" className="df-btn" data-df-analyst-refresh
        disabled={loading} onClick={reload}>Refresh saved cases</button>
      {loading ? <p role="status" className="df-note">Loading saved cases…</p> : null}
      {!loading && !cases.length && !error ? <p role="status" className="df-note">
        No persisted investigation cases are available. Create a case in Reports first.
      </p> : null}
      <label className="block space-y-1 text-[11px]" htmlFor="df-analyst-case">
        <span className="df-label">Persisted investigation</span>
        <select id="df-analyst-case" className="df-input w-full" data-df-analyst-case
          disabled={loading || !cases.length} value={caseId}
          onChange={(event) => { resetSelection(); setCaseId(event.target.value); }}>
          {!cases.length ? <option value="">No saved cases</option> : null}
          {cases.map((entry) => <option key={entry.case_id} value={entry.case_id}>
            {entry.title} · {entry.linked_scan_id ?? 'UNLINKED CASE'}
          </option>)}
        </select>
      </label>
      {selected ? <p className="df-num break-all text-[10px] text-ink-dim">
        Case {selected.case_id} · Scan {selected.linked_scan_id ?? 'not linked'}
      </p> : null}
      <label className="block space-y-1 text-[11px]" htmlFor="df-analyst-intent">
        <span className="df-label">Evidence question</span>
        <select id="df-analyst-intent" className="df-input w-full" data-df-analyst-intent
          value={intent} onChange={(event) => {
            resetSelection(); setIntent(event.target.value as AnalystIntent);
          }}>
          <option value="SUMMARY">Case summary — saved source and counts</option>
          <option value="WATCHLIST">What is watched and what is measured?</option>
          <option value="SAR_AIS">What do saved SAR/AIS correlation fields say?</option>
          <option value="GAPS">What evidence is missing or unverified?</option>
        </select>
      </label>
      {(intent === 'SAR_AIS' || intent === 'WATCHLIST') ?
        <label className="block space-y-1 text-[11px]" htmlFor="df-analyst-target">
          <span className="df-label">Optional saved SAR target ID (not freeform prompt)</span>
          <input id="df-analyst-target" className="df-input w-full" data-df-analyst-target
            maxLength={100} placeholder="DF-001" value={targetId}
            onChange={(event) => { resetSelection(); setTargetId(event.target.value); }} />
        </label> : null}
      <button type="button" className="df-btn" data-df-analyst-run
        disabled={busy || loading || !caseId} onClick={analyze}>Analyze saved case (read-only)</button>
      {busy ? <p role="status" className="df-note">Inspecting local case and saved scan fields…</p> : null}
      {error ? <p role="alert" className="text-[11px] text-fault"
        data-df-analyst-error>{error}</p> : null}
      {analysis ? <div className="space-y-3 border-t border-structural pt-3"
        data-df-analyst-analysis={analysis.case_id}>
        <p className="df-label text-[11px]" data-df-analyst-source-status>
          Source: {analysis.source_status}
        </p>
        <p className="text-[11px] text-ink-dim">
          Operator annotations: {analysis.operator_note_count} · Watch entries:
          {' '}{analysis.operator_watch_count}
        </p>
        <p className="df-num break-all text-[10px] text-ink-dim">
          Canonical scan SHA-256: {analysis.source_canonical_sha256 ?? 'NOT AVAILABLE'}
        </p>
        <h3 className="df-label text-[11px]">Evidence-linked factual claims ({analysis.claims.length})</h3>
        {!analysis.claims.length ? <p className="df-note">
          No cited factual claim is supported for this question by the available saved material.
        </p> : null}
        <ul className="space-y-2" data-df-analyst-claims>
          {analysis.claims.map((item) => <li key={item.id} className="border border-structural p-2">
            <p className="df-label text-[10px]">{item.classification === 'SENSOR_RECORD'
              ? 'Persisted SAR/AIS processing record' : 'Operator-authored case record'}</p>
            <p className="text-[11px] text-ink">{item.statement}</p>
            <p className="text-[11px] text-ink-dim">{item.uncertainty}</p>
            {item.sources.map((source) => <p key={source.source_id + source.field_path}
              className="df-num break-all text-[10px] text-ink-dim"
              data-df-analyst-citation>
              Source {source.kind} · ID {source.source_id}
              {' '}· {source.record_path} :: {source.field_path}
            </p>)}
          </li>)}
        </ul>
        <h3 className="df-label text-[11px]">Unknowns and next checks ({analysis.unknowns.length})</h3>
        {!analysis.unknowns.length ? <p className="df-note">
          No additional missing fields identified by this limited deterministic check.
        </p> : null}
        <ul className="space-y-2" data-df-analyst-unknowns>
          {analysis.unknowns.map((u, index) => <li key={u.code + index}
            className="border border-structural p-2 text-[11px]">
            <p className="df-num text-ink">{u.code}</p>
            <p className="text-ink-dim">{u.explanation}</p>
            {u.expected_field_path ? <p className="df-num text-ink-dim">
              Expected source field: {u.expected_field_path}
            </p> : null}
            <p className="text-ink-dim">Next: {u.next_check}</p>
          </li>)}
        </ul>
        <p className="text-[11px] text-ink-dim">{analysis.disclaimer}</p>
      </div> : null}
    </section>
  );
}
