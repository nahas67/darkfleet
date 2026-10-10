/** Persistent operator WGS84 annotations; globe clicks are operator drawings, never sensor evidence. */
import { useEffect, useState } from 'react';
import {
  createGeoAnnotation, deleteGeoAnnotation, listGeoAnnotations, parseLonLatLines,
  updateGeoAnnotation,
  type GeoAnnotation, type GeoDraft, type GeometryKind,
} from '../api/investigationGeometry';
import { explain } from '../api/errors';
import { fmtInstant } from '../design/format';
import { engine } from '../globe/engine';
import { editVertices, initialVertexHistory, redoVertices, undoVertices } from './geometryVertexHistory';
import { commitAndReconcile } from './commitAndReconcile';

const EMPTY = { label: '', notes: '', radius: '1000', kind: 'point' as GeometryKind };
const show = (value: number | null) => value === null ? '—' : value.toLocaleString(undefined, {
  maximumFractionDigits: 3,
});

export function InvestigationGeometryPanel(props: { caseId: string; scanId: string | null }) {
  const [items, setItems] = useState<GeoAnnotation[]>([]);
  const [draft, setDraft] = useState(EMPTY);
  const [vertices, setVertices] = useState(initialVertexHistory);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationResult, setMutationResult] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);

  // A case owns its overlay. Change of case or departure from the notebook
  // removes annotations from the globe instead of leaving another analyst's
  // hand-drawn marks visible as if they belonged to the next investigation.
  useEffect(() => {
    engine.showOperatorGeometries(items);
  }, [items]);

  useEffect(() => () => engine.clearOperatorGeometries(), [props.caseId]);

  // Preview is display-only. Only the server validates vertices and computes
  // WGS84 geodesic measurements on save, and a half-typed vertex is not drawn.
  useEffect(() => {
    try {
      if (!vertices.current.trim()) {
        engine.showOperatorDraft(null);
        return;
      }
      const coordinates = parseLonLatLines(vertices.current);
      const radius = Number(draft.radius);
      engine.showOperatorDraft({
        kind: draft.kind,
        coordinates,
        radius_m: draft.kind === 'range_ring' && Number.isFinite(radius) ? radius : null,
      });
    } catch {
      engine.showOperatorDraft(null);
    }
  }, [draft, vertices.current]);

  useEffect(() => {
    if (!drawing) return;
    const disarm = engine.armOperatorDrawing(([lon, lat]) => {
      setVertices((prior) => {
        const nextPoint = `${lon.toFixed(7)}, ${lat.toFixed(7)}`;
        if (draft.kind === 'point' || draft.kind === 'range_ring') {
          return editVertices(prior, nextPoint);
        }
        const lines = prior.current.trim();
        return editVertices(prior, lines ? `${lines}\n${nextPoint}` : nextPoint);
      });
    });
    return () => disarm();
  }, [drawing, props.caseId, draft.kind]);

  useEffect(() => {
    let active = true;
    setItems([]);
    setDraft(EMPTY);
    setVertices(initialVertexHistory());
    setEditingId(null);
    setDrawing(false);
    setPendingDelete(null);
    setLoading(true);
    setLoaded(false);
    setError(null);
    setMutationResult(null);
    void listGeoAnnotations(props.caseId)
      .then((result) => { if (active) { setItems(result); setLoaded(true); } })
      .catch((cause: unknown) => { if (active) setError(explain(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.caseId]);

  const run = (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void operation().catch((cause: unknown) => setError(explain(cause)))
      .finally(() => setBusy(false));
  };
  const retry = () => run(async () => {
    setLoading(true);
    try {
      const persisted = await listGeoAnnotations(props.caseId);
      setItems(persisted);
      setLoaded(true);
      setMutationResult(null);
    } finally { setLoading(false); }
  });
  const reset = () => {
    setDrawing(false);
    setEditingId(null);
    setPendingDelete(null);
    setDraft(EMPTY);
    setVertices(initialVertexHistory());
  };
  const save = () => run(async () => {
    setMutationResult(null);
    const coordinates = parseLonLatLines(vertices.current);
    const radius = Number(draft.radius);
    if (draft.kind === 'range_ring' && (!draft.radius.trim() ||
        !Number.isFinite(radius) || radius < 1 || radius > 2_000_000)) {
      throw new Error('Range ring radius must be 1–2,000,000 metres.');
    }
    const payload: GeoDraft = {
      label: draft.label.trim(),
      notes: draft.notes,
      geometry: {
        kind: draft.kind, coordinates,
        radius_m: draft.kind === 'range_ring' ? radius : null,
      },
    };
    if (!payload.label) throw new Error('Geometry label is required.');
    const updating = editingId !== null;
    const caseId = props.caseId;
    const result = await commitAndReconcile(
      async () => {
        if (editingId) await updateGeoAnnotation(caseId, editingId, payload);
        else await createGeoAnnotation(caseId, payload);
      },
      async () => {
        setLoaded(false);
        setLoading(true);
        try { return await listGeoAnnotations(caseId); }
        finally { setLoading(false); }
      },
    );
    // The server accepted the write. Clearing the editor prevents duplicating
    // it when a separate list GET has failed after the successful POST/PUT.
    reset();
    setLoaded(false);
    if (result.kind === 'CONFIRMED') {
      setItems(result.value);
      setLoaded(true);
      setMutationResult(updating ? 'Geometry update saved and reloaded.' : 'Geometry saved and reloaded.');
    } else {
      setMutationResult(`${updating ? 'Geometry update' : 'Geometry'} saved on server, but the refreshed list could not be verified. Do not submit again; retry the list.`);
    }
  });
  const edit = (item: GeoAnnotation) => {
    setDrawing(false);
    setEditingId(item.id);
    setPendingDelete(null);
    setError(null);
    setDraft({
      label: item.label,
      notes: item.notes,
      kind: item.geometry.kind,
      radius: String(item.geometry.radius_m ?? 1000),
    });
    setVertices(initialVertexHistory(item.geometry.coordinates.map(
      ([lon, lat]) => `${lon}, ${lat}`,
    ).join('\n')));
  };
  const remove = (id: string) => run(async () => {
    setMutationResult(null);
    const result = await commitAndReconcile(
      () => deleteGeoAnnotation(props.caseId, id),
      async () => {
        setLoaded(false);
        setLoading(true);
        try { return await listGeoAnnotations(props.caseId); }
        finally { setLoading(false); }
      },
    );
    setLoaded(false);
    if (result.kind === 'CONFIRMED') {
      setItems(result.value);
      setLoaded(true);
      setMutationResult('Geometry removed from server and reloaded.');
    } else {
      setMutationResult('Geometry removed from server, but the refreshed list could not be verified. Do not repeat deletion; retry the list.');
    }
    if (editingId === id) reset();
    setPendingDelete(null);
  });

  return (
    <section className="space-y-2 border-t border-structural pt-3" data-df-geo-panel>
      <p className="df-label text-[10px]">Geo-annotations &amp; WGS84 measurements</p>
      <p className="text-[11px] text-ink-dim">
        Operator-added geometry — NOT SAR/AIS sensor evidence.
        {' '}{props.scanId ? `Case references scan ${props.scanId}; current source availability is not established here.` : 'Unlinked case geometry.'}
        {' '}Draw by clicking the globe, or enter WGS84 longitude, latitude manually.
        Measurements are calculated from Earth coordinates on the backend, never screen pixels.
      </p>
      <label htmlFor="df-geo-kind" className="df-label text-[10px]">Shape type</label>
      <select id="df-geo-kind" data-df-geo-kind className="df-input w-full"
          disabled={busy || !loaded} value={draft.kind}
        onChange={(event) => setDraft((prior) => ({
          ...prior, kind: event.target.value as GeometryKind,
        }))}>
        <option value="point">Point</option>
        <option value="polyline">Polyline / distance &amp; bearings</option>
        <option value="polygon">Polygon / geodesic area &amp; perimeter</option>
        <option value="range_ring">Range ring / radius</option>
      </select>
      <label htmlFor="df-geo-label" className="df-label text-[10px]">Geometry label</label>
      <input id="df-geo-label" data-df-geo-label className="df-input w-full"
        placeholder="e.g. Patrol transit segment" maxLength={120}
        disabled={busy || !loaded} value={draft.label}
        onChange={(event) => setDraft((prior) => ({ ...prior, label: event.target.value }))} />
      <label htmlFor="df-geo-vertices" className="df-label text-[10px]">
        WGS84 vertices · longitude, latitude · one per line
      </label>
      <textarea id="df-geo-vertices" data-df-geo-vertices className="df-input w-full"
        rows={3} maxLength={6000} spellCheck={false} disabled={busy || !loaded}
        value={vertices.current} placeholder={'103.801, 1.281\n103.811, 1.292'}
        onChange={(event) => setVertices((prior) => editVertices(prior, event.target.value))} />
      <p className="text-[10px] text-ink-dim">
        {draft.kind === 'point' || draft.kind === 'range_ring' ? 'Exactly 1 vertex.' :
          draft.kind === 'polyline' ? 'At least 2 vertices.' :
            'At least 3 vertices; closure is automatic.'}
        {' '}Coordinates may cross the ±180° antimeridian.
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Draw geometry on globe">
        <button type="button" className="df-btn" data-df-geo-draw-toggle
          disabled={engine.viewer === null || busy || !loaded}
          aria-pressed={drawing}
          onClick={() => setDrawing((value) => !value)}>
          {drawing ? 'Stop globe drawing' : 'Draw by globe clicks'}
        </button>
        <button type="button" className="df-btn" data-df-geo-undo-point
          disabled={busy || !loaded || vertices.past.length === 0}
          onClick={() => setVertices(undoVertices)}>Undo vertices</button>
        <button type="button" className="df-btn" data-df-geo-redo-point
          disabled={busy || !loaded || vertices.future.length === 0}
          onClick={() => setVertices(redoVertices)}>Redo vertices</button>
        <button type="button" className="df-btn" data-df-geo-clear-points
          disabled={busy || !loaded || !vertices.current.trim()}
          onClick={() => setVertices((prior) => editVertices(prior, ''))}>Clear vertices</button>
      </div>
      {drawing ? <p className="text-[10px] text-ink" data-df-geo-drawing-status role="status">
        Globe drawing armed · click ocean or land to add a WGS84 vertex. For a point
        or range ring, each click replaces the centre. Stop drawing before selecting
        another SAR or AIS contact.
      </p> : null}
      {draft.kind === 'range_ring' ? <>
        <label htmlFor="df-geo-radius" className="df-label text-[10px]">Geodesic radius (metres)</label>
        <input id="df-geo-radius" data-df-geo-radius className="df-input w-full"
          type="number" min="1" max="2000000" step="1" value={draft.radius}
          disabled={busy || !loaded} onChange={(event) => setDraft((prior) => ({
            ...prior, radius: event.target.value,
          }))} />
      </> : null}
      <label htmlFor="df-geo-notes" className="df-label text-[10px]">Operator notes</label>
      <textarea id="df-geo-notes" data-df-geo-notes className="df-input w-full"
        rows={2} maxLength={4000} value={draft.notes} disabled={busy || !loaded}
        onChange={(event) => setDraft((prior) => ({ ...prior, notes: event.target.value }))} />
      <div className="flex gap-2">
        <button className="df-btn" type="button" data-df-geo-save
          disabled={busy || !loaded || !draft.label.trim() || !vertices.current.trim()} onClick={save}>
          {editingId ? 'Update geometry' : 'Save geometry'}
        </button>
        {editingId ? <button className="df-btn" type="button" disabled={busy}
          data-df-geo-cancel onClick={reset}>Cancel edit</button> : null}
      </div>
      <p className="df-label text-[10px]">Persisted geometries {loaded ? `(${items.length})` : '(unverified)'}</p>
      {loading ? <p className="text-[11px] text-ink-dim">Loading saved geometry…</p> : null}
      {!loading && loaded && items.length === 0 ?
        <p className="text-[11px] text-ink-dim">No operator geometry recorded for this case.</p> : null}
      {!loading && !loaded ? <div role="alert" data-df-geo-unavailable className="text-[11px] text-fault">
        Geometry inventory could not be verified; this is not an empty case.
        <button type="button" className="df-btn ml-2" data-df-geo-retry
          disabled={busy} onClick={retry}>Retry geometry list</button>
      </div> : null}
      {loaded ? <ul className="space-y-2" data-df-geo-list>
        {items.map((item) => <li key={item.id} className="space-y-1 border border-structural p-2"
          data-df-geo-item={item.id}>
          <p className="text-xs text-ink">{item.label} · {item.geometry.kind}</p>
          <p className="text-[10px] text-ink-dim">Operator annotation · {fmtInstant(item.updated_at)}
            {' '}· {item.geometry.coordinates.length} WGS84 vertices
          </p>
          {item.notes ? <p className="whitespace-pre-wrap text-[11px] text-ink-dim">{item.notes}</p> : null}
          <p className="df-num text-[11px] text-ink">
            {item.measurements.length_km !== null ? `Distance ${show(item.measurements.length_km)} km / ${show(item.measurements.length_nm)} nm · ` : ''}
            {item.measurements.perimeter_km !== null ? `Perimeter ${show(item.measurements.perimeter_km)} km / ${show(item.measurements.perimeter_nm)} nm · ` : ''}
            {item.measurements.area_km2 !== null ? `Area ${show(item.measurements.area_km2)} km² · ` : ''}
            {item.measurements.radius_km !== null ? `Radius ${show(item.measurements.radius_km)} km / ${show(item.measurements.radius_nm)} nm · ` : ''}
            {item.measurements.initial_bearing_deg !== null ? `Initial bearing ${show(item.measurements.initial_bearing_deg)}° · ` : ''}
            WGS84
          </p>
          <p className="text-[10px] text-ink-dim">{item.measurements.method}</p>
          <button type="button" className="df-btn" disabled={busy}
            data-df-geo-edit onClick={() => edit(item)}>Edit</button>
          <button type="button" className="df-btn ml-2"
            data-df-geo-frame disabled={busy || engine.viewer === null} onClick={() => {
              const point = item.geometry.coordinates[0];
              if (point) engine.flyTo(point[1], point[0], 125_000);
            }}>Frame on globe</button>
          {pendingDelete === item.id ? <>
            <button type="button" className="df-btn ml-2" disabled={busy}
              data-df-geo-confirm-delete onClick={() => remove(item.id)}>Confirm remove</button>
            <button type="button" className="df-btn ml-2" disabled={busy}
              onClick={() => setPendingDelete(null)}>Cancel</button>
          </> : <button type="button" className="df-btn ml-2" disabled={busy}
            data-df-geo-delete onClick={() => setPendingDelete(item.id)}>Remove</button>}
        </li>)}
      </ul> : null}
      {error ? <p role="alert" className="text-[11px] text-fault"
        data-df-geo-error>{error}</p> : null}
      {mutationResult ? <p role="status" className="text-[11px] text-ink"
        data-df-geo-persistence-receipt>{mutationResult}</p> : null}
    </section>
  );
}
