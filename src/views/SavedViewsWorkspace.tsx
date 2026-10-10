/** Server-backed named investigation viewpoints, with explicit restoration diagnostics. */
import { useCallback, useEffect, useState } from 'react';
import type { SavedViewOut } from '../api/contract';
import {
  captureSnapshot, createSavedView, deleteSavedView,
  listSavedViews, replaceSavedView, restoreSavedView,
} from '../api/savedViews';
import { explain } from '../api/errors';

export function SavedViewsWorkspace() {
  const [views, setViews] = useState<SavedViewOut[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const active = views.find((item) => item.id === chosen) ?? null;

  // A failed post-mutation list read must not be mistaken for confirmation that
  // the operator's library is current. Return the result to mutation handlers.
  const reload = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const records = await listSavedViews();
      setViews(records);
      setChosen((previous) => previous && records.some((item) => item.id === previous)
        ? previous : records[0]?.id ?? null);
      setError(null);
      return true;
    } catch (cause) {
      setError(explain(cause));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(async (operation: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    setSuccess(null);
    setWarnings([]);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setWorking(false);
    }
  }, [working]);

  const validName = name.trim().length >= 1 && name.trim().length <= 120;

  return (
    <section className="df-panel flex min-h-0 h-full flex-col" data-df-workspace="VIEWS">
      <header className="df-panel-head">
        <h2 className="df-label">Saved investigation views</h2>
        <p className="df-note mt-1">
          Persist the current camera, basemap, visible layers, scan and evidence selection,
          workspace and available AIS playback state.
        </p>
      </header>
      <div className="df-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <section className="space-y-2 border border-structural/50 p-2" aria-label="Create or update saved view">
          <label className="df-label block text-[10px]" htmlFor="df-view-name">
            View name
          </label>
          <input
            id="df-view-name" aria-label="Saved view name" maxLength={120}
            className="df-input w-full"
            value={name}
            placeholder="e.g. Strait of Malacca inspection"
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button data-df-view-save className="df-btn" type="button"
              disabled={!validName || working || loading}
              onClick={() => void run(async () => {
                const saved = await createSavedView({ title: name.trim(), snapshot: captureSnapshot() });
                const refreshed = await reload();
                setChosen(saved.id);
                setName(saved.title);
                if (!refreshed) {
                  setViews((prior) => [saved, ...prior.filter((item) => item.id !== saved.id)]);
                  setWarnings(['Server created this view, but library refresh failed. Refresh to reconcile saved records.']);
                } else setSuccess(`Saved view "${saved.title}".`);
              })}>
              SAVE NEW
            </button>
            <button data-df-view-update className="df-btn" type="button"
              disabled={!active || active.status !== 'OK' || !validName || working || loading}
              onClick={() => void run(async () => {
                if (!active) return;
                const updated = await replaceSavedView(active.id, {
                  title: name.trim(), expected_revision: active.revision, snapshot: captureSnapshot(),
                });
                const refreshed = await reload();
                setChosen(updated.id);
                if (!refreshed) {
                  setViews((prior) => prior.map((item) => item.id === updated.id ? updated : item));
                  setWarnings(['Server updated this view, but library refresh failed. Refresh to reconcile revisions.']);
                } else setSuccess(`Updated view "${updated.title}" (revision ${updated.revision}).`);
              })}>
              UPDATE SELECTED
            </button>
          </div>
          <p className="df-note text-[10px]">
            Each update captures the current operator state. Original satellite and AIS
            measurements are never edited by saving a view.
          </p>
        </section>

        <section className="space-y-2 border border-structural/50 p-2" aria-label="Saved view library">
          <div className="flex justify-between items-center">
            <span className="df-label">Saved views ({views.length})</span>
            <button type="button" className="df-btn" data-df-view-refresh
              onClick={() => void reload()} disabled={working || loading}>
              REFRESH
            </button>
          </div>
          {loading && <p className="df-note">Loading saved views…</p>}
          {!loading && views.length === 0 && !error && (
            <p className="df-note">No saved views in this local installation.</p>
          )}
          {!loading && views.length > 0 && (
            <select aria-label="Saved views" data-df-view-picker className="df-btn w-full"
              value={chosen ?? ''}
              onChange={(event) => {
                const view = views.find((item) => item.id === event.target.value);
                setChosen(view?.id ?? null);
                setName(view?.title ?? '');
                setConfirmDelete(false);
                setSuccess(null);
                setWarnings([]);
              }}>
              <option value="" disabled>Choose a saved view</option>
              {views.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.title} · revision {view.revision}
                  {view.missing_resources.length > 0 ? ' · missing resource' : ''}
                </option>
              ))}
            </select>
          )}
          {active && (
            <div className="space-y-2 text-[11px]" data-df-view-selected={active.id}>
              <div className="flex gap-2 items-baseline flex-wrap">
                <span className="df-mono">{active.title}</span>
                <span className="df-note">Revision {active.revision}</span>
              </div>
              <p className="df-note">
                Recorded {new Date(active.updated_at).toLocaleString()}. Scan:{' '}
                {active.snapshot?.scan_id ?? 'none'}. Workspace:{' '}
                {active.snapshot?.workspace ?? 'unavailable'}.
              </p>
              {active.status === 'CORRUPT' && (
                <p role="alert" className="text-fault">
                  The stored view record is invalid. It cannot be restored or updated from that
                  payload; preserve it for review or delete it.
                </p>
              )}
              {active.missing_resources.length > 0 && (
                <p role="status" className="text-fault" data-df-view-missing>
                  Missing: {active.missing_resources.join(', ')}. Reinstall the original
                  source before attempting evidence restoration.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button data-df-view-restore className="df-btn" type="button"
                  disabled={active.status !== 'OK' || active.missing_resources.includes('SCAN_MISSING') || working}
                  onClick={() => void run(async () => {
                    const warnings = await restoreSavedView(active);
                    setWarnings(warnings);
                    setSuccess(warnings.length
                      ? 'Restored available state. Review missing-resource notices.'
                      : 'Saved camera, layers, selections and available playback state restored.');
                  })}>
                  RESTORE VIEW
                </button>
                <button data-df-view-rename className="df-btn" type="button"
                  disabled={working || active.status !== 'OK'}
                  onClick={() => setName(active.title)}>
                  EDIT NAME
                </button>
                {!confirmDelete ? (
                  <button type="button" className="df-btn" data-df-view-delete-start
                    disabled={working}
                    onClick={() => setConfirmDelete(true)}>DELETE…</button>
                ) : (
                  <>
                    <button type="button" className="df-btn text-fault" data-df-view-delete-confirm
                      disabled={working}
                      onClick={() => void run(async () => {
                        await deleteSavedView(active.id);
                        setConfirmDelete(false);
                        const refreshed = await reload();
                        if (!refreshed) {
                          setViews((prior) => prior.filter((item) => item.id !== active.id));
                          setChosen(null);
                          setWarnings(['Server deleted this view, but library refresh failed. Refresh to reconcile remaining records.']);
                          return;
                        }
                        setName('');
                        setSuccess('Saved view deleted. Source observations remain intact.');
                      })}>CONFIRM DELETE</button>
                    <button type="button" className="df-btn" onClick={() => setConfirmDelete(false)}>
                      CANCEL
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </section>
        {error && <p role="alert" data-df-view-error className="text-fault text-[11px]">{error}</p>}
        {success && <p role="status" data-df-view-status className="df-note text-[11px]">{success}</p>}
        {warnings.length > 0 && <div role="status" className="text-fault text-[11px]">
          {warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>}
        <p className="df-note text-[10px]">
          Bookmarks may become partially unavailable when their original scan, contact,
          investigation, or map provider is removed. Restoring one cannot replace missing
          observations or create sensor evidence.
        </p>
      </div>
    </section>
  );
}
