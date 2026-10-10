/** Durable analyst-authored case notes and saved SAR target selections. */
import { useEffect, useState } from 'react';
import {
  addInvestigationNote, addInvestigationWatch, createInvestigation, listInvestigations,
  removeInvestigation, removeInvestigationNote, removeInvestigationWatch,
  restoreInvestigationScan,
} from '../api/investigations';
import type { InvestigationOut } from '../api/contract';
import { explain } from '../api/errors';
import { store, useStore } from '../state/store';
import { fmtInstant } from '../design/format';

export function InvestigationNotebook() {
  const state = useStore();
  const [cases, setCases] = useState<InvestigationOut[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [scoped, setScoped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let active = true;
    void listInvestigations()
      .then((items) => {
        if (!active) return;
        setCases(items);
        setSelectedId((prior) =>
          prior && items.some((item) => item.id === prior) ? prior : (items[0]?.id ?? null));
      })
      .catch((cause: unknown) => { if (active) setError(explain(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const selected = cases.find((item) => item.id === selectedId) ?? null;
  const currentTarget = state.selection.kind === 'target' ? state.selection : null;
  const targetId = selected && currentTarget && selected.scan_id &&
    state.scanId === selected.scan_id &&
    (currentTarget.scanId === undefined || currentTarget.scanId === selected.scan_id)
      ? currentTarget.targetId : null;
  const alreadyWatched = targetId
    ? selected?.watchlist.some((entry) => entry.target_id === targetId) ?? false : false;
  const linkableScan = state.scanId !== null && state.scanStage === 'COMPLETE'
    ? state.scanId : null;

  const refresh = async (preferredId?: string | null) => {
    const items = await listInvestigations();
    setCases(items);
    setSelectedId((prior) => {
      const requested = preferredId === undefined ? prior : preferredId;
      return requested && items.some((item) => item.id === requested)
        ? requested : (items[0]?.id ?? null);
    });
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(explain(cause)); }
    finally { setBusy(false); }
  };
  const create = () => void run(async () => {
    const created = await createInvestigation({
      title: title.trim(),
      ...(linkableScan ? { scan_id: linkableScan } : {}),
    });
    setTitle('');
    await refresh(created.id);
  });
  const save = () => {
    if (!selected || !note.trim()) return;
    void run(async () => {
      await addInvestigationNote(selected.id, {
        content: note.trim(),
        ...(scoped && targetId ? { target_id: targetId } : {}),
      });
      setNote('');
      setScoped(false);
      await refresh(selected.id);
    });
  };
  const inspect = (caseRecord: InvestigationOut, watchedTarget?: string) => void run(async () => {
    await restoreInvestigationScan(caseRecord);
    if (watchedTarget && caseRecord.scan_id) {
      store.select({ kind: 'target', targetId: watchedTarget, scanId: caseRecord.scan_id });
      store.set({ workspace: 'INTELLIGENCE' });
    } else {
      store.set({ workspace: 'TASKING' });
    }
  });

  return (
    <section className="space-y-3 border-t border-structural pt-3" data-df-investigations>
      <p className="df-label text-[10px]">Investigation notebook · saved on server</p>
      <div>
        <label className="df-label mb-1 block text-[10px]" htmlFor="df-new-case">New investigation</label>
        <input id="df-new-case" className="df-input w-full" value={title} maxLength={120}
          placeholder="Investigation title" onChange={(event) => setTitle(event.target.value)} />
        <p className="df-num mt-1 text-[10px] text-ink-dim">
          {linkableScan
            ? `Links to verified persisted scan ${linkableScan}.`
            : 'No completed scan selected. Creates an unlinked case for general notes.'}
        </p>
        <button type="button" data-df-investigation-create
          className="df-btn mt-2 w-full justify-center" disabled={busy || !title.trim()}
          onClick={create}>Create investigation</button>
      </div>

      <div>
        <label className="df-label mb-1 block text-[10px]" htmlFor="df-investigation-select">
          Saved investigations
        </label>
        <select className="df-input w-full" id="df-investigation-select"
          data-df-investigation-select disabled={busy || cases.length === 0}
          value={selectedId ?? ''}
          onChange={(event) => {
            setSelectedId(event.target.value);
            setConfirmDelete(false);
            setNote('');
            setScoped(false);
          }}>
          {cases.length === 0 ? <option value="">No saved investigations</option> : null}
          {cases.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        {loading ? <p className="text-[11px] text-ink-dim">Loading saved investigations…</p> : null}
      </div>

      {selected ? <div className="space-y-3" data-df-investigation-detail={selected.id}>
        <p className="df-num text-[10px] text-ink-dim">
          Created {fmtInstant(selected.created_at)} · Scan {selected.scan_id ?? 'NOT LINKED'}
        </p>
        {selected.scan_id ? <button type="button" className="df-btn w-full justify-center"
          disabled={busy} onClick={() => inspect(selected)} data-df-investigation-restore>
          Restore saved scan
        </button> : null}
        <div>
          <label className="df-label mb-1 block text-[10px]" htmlFor="df-note">
            Analyst annotation
          </label>
          <textarea id="df-note" className="df-input w-full" rows={4} maxLength={4000}
            placeholder="Record evidence, unknowns, and checks performed." value={note}
            onChange={(event) => setNote(event.target.value)} />
          {targetId ? <label className="mt-1 flex items-center gap-2 text-[11px] text-ink-dim">
            <input type="checkbox" checked={scoped}
              onChange={(event) => setScoped(event.target.checked)} />
            Attach note to selected target {targetId}
          </label> : null}
          <button type="button" className="df-btn mt-2 w-full justify-center"
            data-df-investigation-save-note disabled={busy || !note.trim()}
            onClick={save}>Save annotation</button>
        </div>

        <div>
          <p className="df-label mb-1 text-[10px]">Saved annotations ({selected.annotations.length})</p>
          {selected.annotations.length === 0
            ? <p className="text-[11px] text-ink-dim">No analyst annotations recorded.</p>
            : <ul className="space-y-2" data-df-investigation-notes>
              {selected.annotations.map((entry) => <li key={entry.id} className="border border-structural p-2">
                <p className="whitespace-pre-wrap break-words text-[11px] text-ink">{entry.content}</p>
                <p className="df-num mt-1 text-[10px] text-ink-dim">
                  {fmtInstant(entry.created_at)} · {entry.target_id ?? 'Case-wide annotation'}
                </p>
                <button type="button" className="df-btn mt-1" disabled={busy}
                  aria-label={`Remove annotation from ${fmtInstant(entry.created_at)}`}
                  onClick={() => void run(async () => {
                    await removeInvestigationNote(selected.id, entry.id);
                    await refresh(selected.id);
                  })}>Remove</button>
              </li>)}
            </ul>}
        </div>

        <div>
          <p className="df-label mb-1 text-[10px]">
            Watched SAR targets ({selected.watchlist.length})
          </p>
          {targetId && !alreadyWatched ? <button type="button"
            className="df-btn mb-2 w-full justify-center" disabled={busy}
            data-df-investigation-add-watch
            onClick={() => void run(async () => {
              await addInvestigationWatch(selected.id, { target_id: targetId });
              await refresh(selected.id);
            })}>Watch selected target {targetId}</button> : null}
          {selected.watchlist.length === 0
            ? <p className="text-[11px] text-ink-dim">
              Select a target from this case&apos;s scan to add it.
            </p>
            : <ul className="space-y-1" data-df-investigation-watchlist>
              {selected.watchlist.map((entry) => <li key={entry.id}
                className="flex items-center justify-between gap-1">
                <button type="button" className="df-btn min-w-0 flex-1 truncate normal-case"
                  disabled={busy} title={entry.target_id}
                  onClick={() => inspect(selected, entry.target_id)}>
                  {entry.target_id} · inspect
                </button>
                <button type="button" className="df-btn" disabled={busy}
                  aria-label={`Stop watching ${entry.target_id}`}
                  onClick={() => void run(async () => {
                    await removeInvestigationWatch(selected.id, entry.id);
                    await refresh(selected.id);
                  })}>Remove</button>
              </li>)}
            </ul>}
        </div>

        <div className="border-t border-structural pt-2">
          {confirmDelete ? <div className="space-y-2">
            <p className="text-[11px] text-ink-dim">
              Delete this case and its notes? Source evidence remains intact.
            </p>
            <button type="button" className="df-btn" disabled={busy}
              onClick={() => void run(async () => {
                await removeInvestigation(selected.id);
                setConfirmDelete(false);
                await refresh(null);
              })}>Confirm delete</button>
            <button type="button" className="df-btn ml-2"
              onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div> : <button type="button" className="df-btn"
            onClick={() => setConfirmDelete(true)}>Delete investigation</button>}
        </div>
      </div> : null}
      {error ? <p role="alert" className="text-[11px] text-fault"
        data-df-investigation-error>{error}</p> : null}
    </section>
  );
}
