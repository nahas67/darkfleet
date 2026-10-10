/** Durable operator missions, validated REAL scan links, and historical alerts. */
import { api, ContractViolation, request } from './errors';
import { validateShape } from './validateGenerated';
import {
  EVALUATIONRUNOUT_FIELDS, MISSIONALERTOUT_FIELDS, MISSIONEVALUATIONOUT_FIELDS,
  MISSIONLISTOUT_FIELDS, MISSIONOUT_FIELDS, MISSIONRULEOUT_FIELDS,
} from './contract';
import type {
  EvaluationRunOut, MissionAlertOut, MissionBody, MissionEvaluationOut,
  MissionOut, MissionRuleOut, WatchRuleCreate,
} from './contract';

export type MissionStatus = MissionOut['status'];
export type AlertStatus = MissionAlertOut['status'];
export type FindingStatus = MissionEvaluationOut['status'];
export type MissionAOI = [number, number, number, number];

export interface MissionDraft extends MissionBody {
  title: string;
  aoi: MissionAOI;
  status: MissionStatus;
}
export interface WatchRuleDraft extends WatchRuleCreate {
  investigation_id: string;
  target_id: string;
  minimum_sar_confidence: number;
}
export interface MissionRule extends MissionRuleOut {
  id: string;
  mission_id: string;
  investigation_id: string;
  scan_id: string;
  target_id: string;
  kind: 'WATCHED_TARGET_SAR_CONFIDENCE';
  minimum_sar_confidence: number;
  created_at: string;
}
export interface MissionAlert extends MissionAlertOut {
  id: string;
  mission_id: string;
  rule_id: string;
  scan_id: string;
  target_id: string;
  minimum_sar_confidence: number;
  sar_confidence: number;
  classification: string | null;
  rationale: string;
  evidence: Readonly<Record<string, unknown>>;
  evidence_fingerprint: string;
  status: AlertStatus;
  created_at: string;
  acknowledged_at: string | null;
  provenance: 'PERSISTED_REAL_SAR_OPERATOR_THRESHOLD';
}
export interface MissionEvaluation extends MissionEvaluationOut {
  mission_id: string;
  rule_id: string;
  scan_id: string;
  target_id: string;
  status: FindingStatus;
  reason: string;
  evaluated_at: string;
  evidence_fingerprint: string | null;
}
export interface Mission extends MissionOut {
  id: string;
  title: string;
  aoi: MissionAOI;
  status: MissionStatus;
  created_at: string;
  updated_at: string;
  scan_ids: string[];
  rules: MissionRule[];
  alerts: MissionAlert[];
  evaluations: MissionEvaluation[];
}
export interface EvaluationRun extends EvaluationRunOut {
  mission_id: string;
  evaluations: MissionEvaluation[];
  alerts_created: number;
  existing_alerts: number;
  not_evaluated: number;
  note: string;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractViolation(name, 'Expected an object.');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new ContractViolation(name, 'Expected a string.');
  return value;
}
function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractViolation(name, `${name}: expected a finite number.`);
  }
  return value;
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new ContractViolation(name, `${name}: expected an array.`);
  return value;
}
function nullableText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name);
}
function enumValue<T extends string>(
  value: unknown, allowed: readonly T[], name: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ContractViolation(name, `${name}: unrecognised enum state.`);
  }
  return value as T;
}
const statuses: MissionStatus[] = ['PLANNED', 'ACTIVE', 'PAUSED', 'CLOSED'];
const alertStatuses: AlertStatus[] = ['OPEN', 'ACKNOWLEDGED'];
const findingStatuses: FindingStatus[] = ['TRIGGERED', 'BELOW_THRESHOLD', 'NOT_EVALUATED'];

export function parseMissionAOI(value: string): MissionAOI {
  const parts = value.trim().split(/[\s,;]+/);
  if (parts.length !== 4 || parts.some((item) => !item.length)) {
    throw new Error('AOI needs four WGS84 numbers: west, south, east, north.');
  }
  const [west, south, east, north] = parts.map((item) => Number(item));
  if (![west, south, east, north].every(Number.isFinite) ||
      !(west >= -180 && east <= 180 && west < east && south >= -90 && north <= 90 && south < north)) {
    throw new Error('AOI must be ordered WGS84 west < east, south < north.');
  }
  return [west, south, east, north];
}

function readRule(payload: unknown): MissionRule {
  const v = validateShape<MissionRuleOut>(
    payload, MISSIONRULEOUT_FIELDS, 'MissionRuleOut',
  ) as unknown as Record<string, unknown>;
  for (const key of ['id', 'mission_id', 'investigation_id', 'scan_id', 'target_id', 'created_at']) {
    text(v[key], `MissionRule.${key}`);
  }
  if (v.kind !== 'WATCHED_TARGET_SAR_CONFIDENCE') {
    throw new ContractViolation('MissionRule.kind', 'Unknown rule authority.');
  }
  const n = finite(v.minimum_sar_confidence, 'MissionRule.minimum_sar_confidence');
  if (n < 0 || n > 1) throw new ContractViolation('MissionRule.minimum_sar_confidence', 'Out of range.');
  return v as unknown as MissionRule;
}
function readAlert(payload: unknown): MissionAlert {
  const v = validateShape<MissionAlertOut>(
    payload, MISSIONALERTOUT_FIELDS, 'MissionAlertOut',
  ) as unknown as Record<string, unknown>;
  for (const key of [
    'id', 'mission_id', 'rule_id', 'scan_id', 'target_id',
    'rationale', 'evidence_fingerprint', 'created_at',
  ]) text(v[key], `MissionAlert.${key}`);
  if (v.provenance !== 'PERSISTED_REAL_SAR_OPERATOR_THRESHOLD') {
    throw new ContractViolation(
      'MissionAlert.provenance', 'MissionAlert.provenance: missing source classification.',
    );
  }
  enumValue(v.status, alertStatuses, 'MissionAlert.status');
  finite(v.minimum_sar_confidence, 'MissionAlert.minimum_sar_confidence');
  finite(v.sar_confidence, 'MissionAlert.sar_confidence');
  nullableText(v.classification, 'MissionAlert.classification');
  nullableText(v.acknowledged_at, 'MissionAlert.acknowledged_at');
  object(v.evidence, 'MissionAlert.evidence');
  return v as unknown as MissionAlert;
}
function readEvaluation(payload: unknown): MissionEvaluation {
  const v = validateShape<MissionEvaluationOut>(
    payload, MISSIONEVALUATIONOUT_FIELDS, 'MissionEvaluationOut',
  ) as unknown as Record<string, unknown>;
  for (const key of ['mission_id', 'rule_id', 'scan_id', 'target_id', 'reason', 'evaluated_at']) {
    text(v[key], `MissionEvaluation.${key}`);
  }
  enumValue(v.status, findingStatuses, 'MissionEvaluation.status');
  nullableText(v.evidence_fingerprint, 'MissionEvaluation.evidence_fingerprint');
  return v as unknown as MissionEvaluation;
}

export function readMission(payload: unknown): Mission {
  const v = validateShape<MissionOut>(
    payload, MISSIONOUT_FIELDS, 'MissionOut',
  ) as unknown as Record<string, unknown>;
  for (const key of ['id', 'title', 'created_at', 'updated_at']) text(v[key], `Mission.${key}`);
  enumValue(v.status, statuses, 'Mission.status');
  const aoi = array(v.aoi, 'Mission.aoi');
  if (aoi.length !== 4) throw new ContractViolation('Mission.aoi', 'Expected WGS84 bbox.');
  parseMissionAOI(aoi.map((n) => finite(n, 'Mission.aoi')).join(','));
  array(v.scan_ids, 'Mission.scan_ids').forEach((id) => text(id, 'Mission.scan_ids[]'));
  array(v.rules, 'Mission.rules').forEach(readRule);
  array(v.alerts, 'Mission.alerts').forEach(readAlert);
  array(v.evaluations, 'Mission.evaluations').forEach(readEvaluation);
  return v as unknown as Mission;
}

function readRun(payload: unknown): EvaluationRun {
  const v = validateShape<EvaluationRunOut>(
    payload, EVALUATIONRUNOUT_FIELDS, 'EvaluationRunOut',
  ) as unknown as Record<string, unknown>;
  text(v.mission_id, 'EvaluationRun.mission_id');
  text(v.note, 'EvaluationRun.note');
  array(v.evaluations, 'EvaluationRun.evaluations').forEach(readEvaluation);
  for (const field of ['alerts_created', 'existing_alerts', 'not_evaluated']) {
    const n = finite(v[field], `EvaluationRun.${field}`);
    if (!Number.isInteger(n) || n < 0) {
      throw new ContractViolation(`EvaluationRun.${field}`, 'Expected a count.');
    }
  }
  return v as unknown as EvaluationRun;
}
const root = '/api/missions';
const missionEndpoint = (id: string) => `${root}/${encodeURIComponent(id)}`;

export async function listMissions(): Promise<Mission[]> {
  const v = validateShape<{ missions: MissionOut[] }>(
    await api.get<unknown>(root), MISSIONLISTOUT_FIELDS, 'MissionListOut',
  );
  return array(v.missions, 'MissionList.missions').map(readMission);
}
export async function createMission(body: MissionDraft): Promise<Mission> {
  return readMission(await api.post<unknown>(root, body));
}
export async function replaceMission(id: string, body: MissionDraft): Promise<Mission> {
  return readMission(await request<unknown>(missionEndpoint(id), {
    method: 'PUT', body: JSON.stringify(body),
  }));
}
export async function deleteMission(id: string): Promise<void> {
  await api.delete(missionEndpoint(id));
}
export async function linkMissionScan(id: string, scanId: string): Promise<Mission> {
  return readMission(await api.post<unknown>(`${missionEndpoint(id)}/scans`, { scan_id: scanId }));
}
export async function unlinkMissionScan(id: string, scanId: string): Promise<Mission> {
  return readMission(await request<unknown>(
    `${missionEndpoint(id)}/scans/${encodeURIComponent(scanId)}`, { method: 'DELETE' },
  ));
}
export async function addMissionRule(id: string, rule: WatchRuleDraft): Promise<MissionRule> {
  return readRule(await api.post<unknown>(`${missionEndpoint(id)}/rules`, rule));
}
export async function removeMissionRule(id: string, ruleId: string): Promise<void> {
  await api.delete(`${missionEndpoint(id)}/rules/${encodeURIComponent(ruleId)}`);
}
export async function evaluateMission(id: string): Promise<EvaluationRun> {
  return readRun(await api.post<unknown>(`${missionEndpoint(id)}/evaluate`, {}));
}
export async function acknowledgeMissionAlert(id: string, alertId: string): Promise<MissionAlert> {
  return readAlert(await api.post<unknown>(
    `${missionEndpoint(id)}/alerts/${encodeURIComponent(alertId)}/ack`, {},
  ));
}
