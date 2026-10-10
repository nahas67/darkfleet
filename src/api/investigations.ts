/** Analyst-authored case records live outside immutable SAR/AIS scan evidence. */
import { api, ContractViolation } from './errors';
import { loadScanAis, loadScanResults, loadRaster, releaseStageStream } from './client';
import { contractValidator } from './validateGenerated';
import { store, toBBox } from '../state/store';
import type {
  AnnotationCreate,
  AnnotationOut,
  InvestigationCreate,
  InvestigationOut,
  InvestigationListOut,
  ScanStateResponse,
  WatchEntryCreate,
  WatchEntryOut,
} from './contract';
import {
  INVESTIGATIONOUT_FIELDS,
  INVESTIGATIONLISTOUT_FIELDS,
  ANNOTATIONOUT_FIELDS,
  WATCHENTRYOUT_FIELDS,
} from './contract';

const validateCase = contractValidator<InvestigationOut>(INVESTIGATIONOUT_FIELDS, 'InvestigationOut');
const validateList = contractValidator<InvestigationListOut>(
  INVESTIGATIONLISTOUT_FIELDS, 'InvestigationListOut',
);
const validateNote = contractValidator<AnnotationOut>(ANNOTATIONOUT_FIELDS, 'AnnotationOut');
const validateWatch = contractValidator<WatchEntryOut>(WATCHENTRYOUT_FIELDS, 'WatchEntryOut');

const endpoint = (id: string) => `/api/investigations/${encodeURIComponent(id)}`;

function checkedCase(value: unknown): InvestigationOut {
  const result = validateCase(value);
  if (!Array.isArray(result.annotations) || !Array.isArray(result.watchlist)) {
    throw new ContractViolation('InvestigationOut', 'Case entries must be arrays.');
  }
  result.annotations.forEach(validateNote);
  result.watchlist.forEach(validateWatch);
  return result;
}

export async function listInvestigations(): Promise<InvestigationOut[]> {
  const payload = validateList(await api.get<unknown>('/api/investigations'));
  if (!Array.isArray(payload.investigations)) {
    throw new ContractViolation('InvestigationListOut.investigations', 'Expected an array.');
  }
  return payload.investigations.map(checkedCase);
}

export async function createInvestigation(body: InvestigationCreate): Promise<InvestigationOut> {
  return checkedCase(await api.post<unknown>('/api/investigations', body));
}

export async function addInvestigationNote(
  caseId: string,
  body: AnnotationCreate,
): Promise<AnnotationOut> {
  return validateNote(await api.post<unknown>(`${endpoint(caseId)}/annotations`, body));
}

export async function addInvestigationWatch(
  caseId: string,
  body: WatchEntryCreate,
): Promise<WatchEntryOut> {
  return validateWatch(await api.post<unknown>(`${endpoint(caseId)}/watchlist`, body));
}

export async function removeInvestigation(caseId: string): Promise<void> {
  await api.delete(endpoint(caseId));
}

export async function removeInvestigationNote(caseId: string, noteId: string): Promise<void> {
  await api.delete(`${endpoint(caseId)}/annotations/${encodeURIComponent(noteId)}`);
}

export async function removeInvestigationWatch(caseId: string, entryId: string): Promise<void> {
  await api.delete(`${endpoint(caseId)}/watchlist/${encodeURIComponent(entryId)}`);
}

/**
 * Restore a case's actual persisted scan into the canonical domain store.
 * The scan is verified on the server before clearing the current view.
 */
export async function restoreInvestigationScan(investigation: InvestigationOut): Promise<void> {
  const scanId = investigation.scan_id;
  if (!scanId) throw new Error('This investigation is not linked to a scan.');
  const found = await api.get<ScanStateResponse>(`/api/scans/${encodeURIComponent(scanId)}`);
  if (!found.record_persisted || found.runtime_mode !== 'REAL' || found.synthetic !== false) {
    throw new Error('This investigation has no persisted REAL scan available to restore.');
  }
  releaseStageStream();
  const aoi = toBBox(investigation.aoi);
  store.set({
    scanId,
    scanStage: 'COMPLETE',
    scanStageHistory: [],
    scanError: null,
    targets: [],
    targetDetail: [],
    aisOnly: [],
    selectedAis: null,
    selection: { kind: 'none' },
    aoi,
    aoiText: aoi ? aoi.map((n) => n.toFixed(5)).join(', ') : '',
  });
  await Promise.all([loadScanResults(scanId), loadScanAis(scanId), loadRaster(scanId, 'raw')]);
}

/** A watchlist reference cannot itself prove a target survived the persisted reload. */
export function selectRestoredInvestigationTarget(scanId: string, targetId: string): void {
  const current = store.getState();
  if (current.scanId !== scanId || !current.targets.some((target) => target.id === targetId)) {
    throw new Error('Watched target is missing from the restored scan; no target was selected.');
  }
  store.select({ kind: 'target', scanId, targetId });
}
