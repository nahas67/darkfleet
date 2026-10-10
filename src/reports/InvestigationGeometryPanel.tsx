/** Persistent operator WGS84 annotations; no claim of SAR detection or globe drawing. */
import { useEffect, useState } from 'react';
import {
  createGeoAnnotation, deleteGeoAnnotation, listGeoAnnotations, parseLonLatLines,
  updateGeoAnnotation,
  type GeoAnnotation, type GeoDraft, type GeometryKind,
} from '../api/investigationGeometry';
import { explain } from '../api/errors';
import { fmtInstant } from '../design/format';

const EMPTY = { label: '', notes: '', vertices: '', radius: '1000', kind: 'point' as GeometryKind };
const show = (value: number | null) => value === null ? '—' : value.toLocaleString(undefined, {
  maximumFractionDigits: 3,
});

export function InvestigationGeometryPanel(props: { caseId: string; scanId: string | null }) {
  const [items, setItems] = useState<GeoAnnotation[]>([]);
  const [draft, setDraft] = useState(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setItems([]);
    setDraft(EMPTY);
    setEditingId(null);
    setPendingDelete(null);
    setLoading(true);
    setError(null);
    void listGeoAnnotations(props.caseId)
      .then((result) => { if (active) setItems(result); })
      .catch((cause: unknown) => { if (active) setError(explain(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.caseId]);

  const run = (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void operation().catch((cause: unknown) => setError(explain(cause)))
      .finally(() => setBusy(false));
  };
  const reset = () => {
    setEditingId(null);
    setPendingDelete(null);
    setDraft(EMPTY);
  };
  const save = () => run(async () => {
    const coordinates = parseLonLatLines(draft.vertices);
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
    if (editingId) await updateGeoAnnotation(props.caseId, editingId, payload);
    else await createGeoAnnotation(props.caseId, payload);
    const persisted = await listGeoAnnotations(props.caseId);
    setItems(persisted);
    reset();
  });
  const edit = (item: GeoAnnotation) => {
    setEditingId(item.id);
    setPendingDelete(null);
    setError(null);
    setDraft({
      label: item.label,
      notes: item.notes,
      kind: item.geometry.kind,
      vertices: item.geometry.coordinates.map(([lon, lat]) => `${lon}, ${lat}`).join('\n'),
      radius: String(item.geometry.radius_m ?? 1000),
    });
  };
  const remove = (id: string) => run(async () => {
    await deleteGeoAnnotation(props.caseId, id);
    setItems(await listGeoAnnotations(props.caseId));
    if (editingId === id) reset();
    setPendingDelete(null);
  });

  return (
    <section className="space-y-2 border-t border-structural pt-3" data-df-geo-panel>
      <p className="df-label text-[10px]">Geo-annotations &amp; WGS84 measurements</p>
      <p className="text-[11px] text-ink-dim">
        Operator-added geometry — NOT SAR/AIS sensor evidence.
        {' '}{props.scanId ? `Case linked to persisted scan ${props.scanId}.` : 'Unlinked case geometry.'}
        {' '}Enter coordinates manually as longitude, latitude (degrees); no screen-pixel measurements.
      </p>
      <label htmlFor="df-geo-kind" className="df-label text-[10px]">Shape type</label>
      <select id="df-geo-kind" data-df-geo-kind className="df-input w-full"
        disabled={busy} value={draft.kind}
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
        disabled={busy} value={draft.label}
        onChange={(event) => setDraft((prior) => ({ ...prior, label: event.target.value }))} />
      <label htmlFor="df-geo-vertices" className="df-label text-[10px]">
        WGS84 vertices · longitude, latitude · one per line
      </label>
      <textarea id="df-geo-vertices" data-df-geo-vertices className="df-input w-full"
        rows={3} maxLength={6000} spellCheck={false} disabled={busy}
        value={draft.vertices} placeholder={'103.801, 1.281\n103.811, 1.292'}
        onChange={(event) => setDraft((prior) => ({ ...prior, vertices: event.target.value }))} />
      <p className="text-[10px] text-ink-dim">
        {draft.kind === 'point' || draft.kind === 'range_ring' ? 'Exactly 1 vertex.' :
          draft.kind === 'polyline' ? 'At least 2 vertices.' :
            'At least 3 vertices; closure is automatic.'}
        {' '}Coordinates may cross the ±180° antimeridian.
      </p>
      {draft.kind === 'range_ring' ? <>
        <label htmlFor="df-geo-radius" className="df-label text-[10px]">Geodesic radius (metres)</label>
        <input id="df-geo-radius" data-df-geo-radius className="df-input w-full"
          type="number" min="1" max="2000000" step="1" value={draft.radius}
          disabled={busy} onChange={(event) => setDraft((prior) => ({
            ...prior, radius: event.target.value,
          }))} />
      </> : null}
      <label htmlFor="df-geo-notes" className="df-label text-[10px]">Operator notes</label>
      <textarea id="df-geo-notes" data-df-geo-notes className="df-input w-full"
        rows={2} maxLength={4000} value={draft.notes} disabled={busy}
        onChange={(event) => setDraft((prior) => ({ ...prior, notes: event.target.value }))} />
      <div className="flex gap-2">
        <button className="df-btn" type="button" data-df-geo-save
          disabled={busy || !draft.label.trim() || !draft.vertices.trim()} onClick={save}>
          {editingId ? 'Update geometry' : 'Save geometry'}
        </button>
        {editingId ? <button className="df-btn" type="button" disabled={busy}
          data-df-geo-cancel onClick={reset}>Cancel edit</button> : null}
      </div>
      <p className="df-label text-[10px]">Persisted geometries ({items.length})</p>
      {loading ? <p className="text-[11px] text-ink-dim">Loading saved geometry…</p> : null}
      {!loading && items.length === 0 ?
        <p className="text-[11px] text-ink-dim">No operator geometry recorded for this case.</p> : null}
      <ul className="space-y-2" data-df-geo-list>
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
          {pendingDelete === item.id ? <>
            <button type="button" className="df-btn ml-2" disabled={busy}
              data-df-geo-confirm-delete onClick={() => remove(item.id)}>Confirm remove</button>
            <button type="button" className="df-btn ml-2" disabled={busy}
              onClick={() => setPendingDelete(null)}>Cancel</button>
          </> : <button type="button" className="df-btn ml-2" disabled={busy}
            data-df-geo-delete onClick={() => setPendingDelete(item.id)}>Remove</button>}
        </li>)}
      </ul>
      {error ? <p role="alert" className="text-[11px] text-fault"
        data-df-geo-error>{error}</p> : null}
    </section>
  );
}
