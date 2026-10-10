/** Durable case-owned binary files; never confuse them with source observations. */
import { useEffect, useRef, useState } from 'react';
import { explain } from '../api/errors';
import {
  deleteCaseAttachment, listCaseAttachments, uploadCaseAttachment,
  type CaseAttachment, MAX_ATTACHMENT_BYTES,
} from '../api/investigationAttachments';
import { commitAndReconcile } from './commitAndReconcile';

export function InvestigationAttachments({ caseId }: { caseId: string }) {
  const [items, setItems] = useState<CaseAttachment[]>([]);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setVerified(false);
    setLoading(true);
    setError(null);
    setReceipt(null);
    void listCaseAttachments(caseId).then((rows) => {
      if (!active) return;
      setItems(rows);
      setVerified(true);
    }).catch((cause: unknown) => {
      if (active) setError(`Attachment library unavailable: ${explain(cause)}`);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [caseId]);

  const reload = async () => {
    if (busy) return;
    setBusy(true);
    setLoading(true);
    setError(null);
    try {
      const rows = await listCaseAttachments(caseId);
      setItems(rows);
      setVerified(true);
      setReceipt(null);
    } catch (cause) {
      setVerified(false);
      setError(`Attachment library could not be verified: ${explain(cause)}`);
    } finally { setBusy(false); setLoading(false); }
  };

  const run = async (op: 'upload' | 'delete', id?: string) => {
    if (!verified || busy || (op === 'upload' && !file) || (op === 'delete' && !id)) return;
    setBusy(true);
    setReceipt(null);
    setError(null);
    try {
      const result = await commitAndReconcile(
        op === 'upload'
          ? () => uploadCaseAttachment(caseId, file!)
          : () => deleteCaseAttachment(caseId, id!),
        () => listCaseAttachments(caseId),
      );
      // The backend has replied to the write. Clear both the file picker and
      // delete confirmation even if a separate GET now fails.
      if (op === 'upload') {
        setFile(null);
        if (input.current) input.current.value = '';
      }
      setConfirmDelete(null);
      if (result.kind === 'CONFIRMED') {
        setItems(result.value);
        setVerified(true);
        setReceipt(op === 'upload' ? 'Attachment stored on server and verified in the case inventory.'
          : 'Attachment removed on server and inventory reloaded.');
      } else {
        setVerified(false);
        setReceipt(`${op === 'upload' ? 'Attachment stored' : 'Attachment removed'} on server, but the library refresh failed. Reload the inventory; do not repeat the write.`);
      }
    } catch (cause) {
      setError(explain(cause));
    } finally { setBusy(false); }
  };

  return (
    <section className="space-y-2 border-t border-structural pt-3" data-df-case-attachments>
      <h3 className="df-label text-[10px]">Durable binary case attachments</h3>
      <p className="text-[11px] text-ink-dim">
        Operator-submitted files, NOT satellite/AIS sensor evidence. Maximum 8 MiB per file,
        32 files and 64 MiB per investigation. Backend records SHA-256 and validates source bytes.
      </p>
      <label htmlFor="df-case-attachment-file" className="df-label text-[10px]">Choose local evidence file</label>
      <input id="df-case-attachment-file" ref={input} data-df-attachment-file
        type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.json"
        className="df-input w-full" disabled={busy || !verified}
        onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <button type="button" className="df-btn" data-df-attachment-upload
        disabled={!verified || busy || !file || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES}
        onClick={() => void run('upload')}>Upload file to case</button>
      <button type="button" className="df-btn ml-2" data-df-attachment-reload
        disabled={busy || loading} onClick={() => void reload()}>Reload attachments</button>
      {loading ? <p role="status" data-df-attachments-loading className="df-note">
        Loading persisted attachment inventory…
      </p> : null}
      {!loading && !verified ? <p role="alert" data-df-attachments-unverified className="text-[11px] text-fault">
        Attachment inventory unverified. Its absence is not proof that this case has no files.
      </p> : null}
      {verified ? <>
        <p className="text-[11px] text-ink-2" data-df-attachment-count>
          Persisted attachments ({items.length})
        </p>
        {items.length === 0 ? <p className="df-note">No operator attachment recorded for this case.</p> : null}
        <ul className="space-y-2" data-df-attachment-list>
          {items.map((entry) => <li key={entry.id} data-df-attachment-id={entry.id}
            className="border border-structural p-2 text-[11px]">
            <p className="break-all text-ink">{entry.filename} · {entry.size_bytes.toLocaleString()} bytes</p>
            <p className="break-all text-[10px] text-ink-dim">SHA-256: {entry.sha256}</p>
            <p className="text-[10px] text-ink-dim">{entry.provenance}</p>
            <a className="df-btn mt-1" data-df-attachment-download
              href={entry.download_url} download={entry.filename}>Download verified bytes</a>
            {confirmDelete === entry.id ? <>
              <button type="button" className="df-btn ml-2" data-df-attachment-confirm-delete
                disabled={busy} onClick={() => void run('delete', entry.id)}>Confirm remove</button>
              <button type="button" className="df-btn ml-2" disabled={busy}
                onClick={() => setConfirmDelete(null)}>Cancel</button>
            </> : <button type="button" className="df-btn ml-2" data-df-attachment-delete
              disabled={busy} onClick={() => setConfirmDelete(entry.id)}>Remove</button>}
          </li>)}
        </ul>
      </> : null}
      {receipt ? <p role="status" data-df-attachment-receipt className="text-[11px] text-ink">
        {receipt}
      </p> : null}
      {error ? <p role="alert" data-df-attachment-error className="text-[11px] text-fault">
        {error}
      </p> : null}
    </section>
  );
}
