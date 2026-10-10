/** Actual binary operator-authored case attachments; never SAR/AIS sensor data. */
import { api, ApiError, ContractViolation, request } from './errors';

export type CaseAttachment = Readonly<{
  id: string;
  investigation_id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  provenance: 'OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE';
  download_url: string;
}>;

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MIME: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.txt': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json',
};
const casePath = (caseId: string) => `/api/investigations/${encodeURIComponent(caseId)}/attachments`;

export function caseFileMime(filename: string): string {
  const safe = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,119}$/.test(filename) &&
    !filename.includes('..') && !/[. ]$/.test(filename) &&
    !/^(CON|PRN|NUL|AUX|COM1|LPT1)(?:\.[^.]+)?$/i.test(filename);
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (!safe || !(ext in MIME)) {
    throw new Error('Choose a safe ASCII PDF, PNG, JPEG, TXT, CSV or JSON filename (1–120 characters).');
  }
  return MIME[ext];
}

function checked(raw: unknown, caseId: string): CaseAttachment {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContractViolation('AttachmentOut', 'Expected an object.');
  }
  const item = raw as Record<string, unknown>;
  if (item.investigation_id !== caseId || typeof item.id !== 'string' ||
      !/^[0-9a-fA-F-]{36}$/.test(item.id) || typeof item.filename !== 'string' ||
      typeof item.media_type !== 'string' || typeof item.created_at !== 'string' ||
      !Number.isSafeInteger(item.size_bytes) || (item.size_bytes as number) < 1 ||
      (item.size_bytes as number) > MAX_ATTACHMENT_BYTES ||
      typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) ||
      item.provenance !== 'OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE' ||
      item.download_url !== `${casePath(caseId)}/${encodeURIComponent(item.id)}/content` ||
      Object.keys(item).length !== 9 ||
      item.media_type !== caseFileMime(item.filename)) {
    throw new ContractViolation('AttachmentOut', 'Unverifiable operator attachment metadata.');
  }
  return raw as CaseAttachment;
}

export async function listCaseAttachments(caseId: string): Promise<CaseAttachment[]> {
  const payload = await api.get<unknown>(casePath(caseId));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ContractViolation('AttachmentsOut', 'Expected list response.');
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.attachments) || !Number.isSafeInteger(record.count) ||
      record.count !== record.attachments.length || Object.keys(record).length !== 2) {
    throw new ContractViolation('AttachmentsOut', 'List count or contents invalid.');
  }
  return record.attachments.map((item) => checked(item, caseId));
}

export async function uploadCaseAttachment(caseId: string, file: File): Promise<CaseAttachment> {
  const filename = file.name;
  const mime = caseFileMime(filename);
  if (file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Attachment must contain 1 byte to 8 MiB.');
  }
  // Raw file body, not JSON and not multipart. The backend computes SHA-256,
  // validates the signature and stores both bytes+metadata in one transaction.
  let response: Response;
  try {
    response = await fetch(casePath(caseId), {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': mime,
        'X-Attachment-Filename': filename },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Attachment server could not be reached; upload outcome is unverified. Check the case library before retrying.');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    throw new ApiError(response.status, typeof record.error === 'string' ? record.error : 'UPLOAD_FAILED',
      typeof record.message === 'string' ? record.message : `Attachment rejected: HTTP ${response.status}.`);
  }
  return checked(body, caseId);
}

export async function deleteCaseAttachment(caseId: string, attachmentId: string): Promise<void> {
  await request<void>(`${casePath(caseId)}/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
}
