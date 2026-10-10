import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  caseFileMime, deleteCaseAttachment, listCaseAttachments,
  uploadCaseAttachment, MAX_ATTACHMENT_BYTES,
} from './investigationAttachments';

const CASE = 'case-alpha';
const ID = 'a0f00000-0000-0000-0000-000000000001';
const path = `/api/investigations/${CASE}/attachments`;
const saved = {
  id: ID, investigation_id: CASE, filename: 'operator-note.txt', media_type: 'text/plain',
  size_bytes: 13, sha256: 'a'.repeat(64), created_at: '2026-10-11T05:00:00Z',
  provenance: 'OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE',
  download_url: `${path}/${ID}/content`,
};
const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

afterEach(() => vi.unstubAllGlobals());

describe('binary operator-authored evidence contract', () => {
  it('runs real GET/list, raw bytes POST and metadata-derived download, and DELETE endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ count: 1, attachments: [saved] }))
      .mockResolvedValueOnce(response(saved, 201))
      .mockResolvedValueOnce(response(null, 204));
    vi.stubGlobal('fetch', fetchMock);
    const rows = await listCaseAttachments(CASE);
    expect(rows[0]).toMatchObject({ provenance: 'OPERATOR_ATTACHMENT_NOT_SENSOR_EVIDENCE',
      download_url: `${path}/${ID}/content`, sha256: 'a'.repeat(64) });
    const file = new File(['operator note'], 'operator-note.txt', { type: 'text/plain' });
    expect((await uploadCaseAttachment(CASE, file)).id).toBe(ID);
    await deleteCaseAttachment(CASE, ID);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([path, path, `${path}/${ID}`]);
    expect(fetchMock.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual([
      'GET', 'POST', 'DELETE',
    ]);
    const upload = fetchMock.mock.calls[1][1];
    expect(upload.body).toBe(file);
    expect(upload.headers['Content-Type']).toBe('text/plain');
    expect(upload.headers['X-Attachment-Filename']).toBe('operator-note.txt');
  });

  it('rejects path-like names, unsafe types, oversize bytes and no-content uploads locally', async () => {
    for (const name of ['../secrets.pdf', 'raw.exe', 'bad:name.txt', 'CON.txt', 'report..pdf', 't💾.txt']) {
      expect(() => caseFileMime(name)).toThrow();
    }
    expect(caseFileMime('ARCHIVE.PDF')).toBe('application/pdf');
    vi.stubGlobal('fetch', vi.fn());
    await expect(uploadCaseAttachment(CASE, new File([], 'empty.txt'))).rejects.toThrow(/1 byte/);
    await expect(uploadCaseAttachment(CASE, { name: 'large.txt', size: MAX_ATTACHMENT_BYTES + 1 } as File))
      .rejects.toThrow(/8 MiB/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects forged sensor provenance, foreign download URLs, metadata counts and malformed hashes', async () => {
    for (const value of [
      { ...saved, provenance: 'SAR_OBSERVED' },
      { ...saved, download_url: 'https://outside.test/exfiltrate' },
      { ...saved, sha256: 'fake' },
      { ...saved, investigation_id: 'other-case' },
      { ...saved, media_type: 'application/javascript' },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ count: 1, attachments: [value] })));
      await expect(listCaseAttachments(CASE)).rejects.toThrow();
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ count: 9, attachments: [] })));
    await expect(listCaseAttachments(CASE)).rejects.toThrow('List count or contents invalid');
  });

  it('never claims an unacknowledged binary write succeeded after an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      error: 'ATTACHMENT_TOO_LARGE', message: 'Maximum attachment size is 8 MiB.',
    }, 413)));
    await expect(uploadCaseAttachment(CASE, new File(['one'], 'valid.txt')))
      .rejects.toMatchObject({ status: 413, code: 'ATTACHMENT_TOO_LARGE' });
  });
});
