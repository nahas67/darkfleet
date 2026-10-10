/** Persistent operator viewpoint bookmarks, separate from original measurements. */

import type {
  SavedViewOut, SavedViewsOut, ScanStateResponse, Snapshot, ViewCreate, ViewReplace,
} from './contract';
import { SAVEDVIEWOUT_FIELDS, SAVEDVIEWSOUT_FIELDS } from './contract';
import { api, ContractViolation, request } from './errors';
import { contractValidator } from './validateGenerated';
import { loadRaster, loadScanAis, loadScanResults, releaseStageStream } from './client';
import { engine } from '../globe/engine';
import { aisCamera } from '../globe/aisCamera';
import { store, toBBox, type LayerId, type State } from '../state/store';
import { temporal, rangeFromTimestamps } from '../temporal/TemporalController';

const validateView = contractValidator<SavedViewOut>(SAVEDVIEWOUT_FIELDS, 'SavedViewOut');
const validateList = contractValidator<SavedViewsOut>(SAVEDVIEWSOUT_FIELDS, 'SavedViewsOut');

function checkedView(input: unknown): SavedViewOut {
  const view = validateView(input);
  if (!Array.isArray(view.missing_resources)) {
    throw new ContractViolation('SavedViewOut.missing_resources', 'Expected an array.');
  }
  if (view.status === 'OK' && (!view.snapshot || typeof view.snapshot !== 'object')) {
    throw new ContractViolation('SavedViewOut.snapshot', 'A healthy view requires its snapshot.');
  }
  return view;
}

export async function listSavedViews(): Promise<SavedViewOut[]> {
  const payload = validateList(await api.get<unknown>('/api/views'));
  if (!Array.isArray(payload.views)) {
    throw new ContractViolation('SavedViewsOut.views', 'Expected an array.');
  }
  return payload.views.map(checkedView);
}

export async function createSavedView(body: ViewCreate): Promise<SavedViewOut> {
  return checkedView(await api.post<unknown>('/api/views', body));
}

export async function replaceSavedView(id: string, body: ViewReplace): Promise<SavedViewOut> {
  return checkedView(await request<unknown>(`/api/views/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify(body),
  }));
}

export async function deleteSavedView(id: string): Promise<void> {
  await api.delete(`/api/views/${encodeURIComponent(id)}`);
}

/** Capture current operator choices, never the complete store, source or credentials. */
export function captureSnapshot(): Snapshot {
  const s = store.getState();
  const pose = engine.getCameraPose();
  const mapSourceId = engine.basemapStatus()?.activeId ?? null;
  const playhead = temporal.state.currentMs;
  const selected = s.selection;
  const target = selected.kind === 'target' && (selected.scanId ?? s.scanId)
    ? { scan_id: selected.scanId ?? s.scanId ?? '', target_id: selected.targetId }
    : null;
  const layers = Object.fromEntries(Object.entries(s.layerState).map(([id, config]) => [
    id, { visible: config.visible, opacity: config.opacity },
  ]));
  // Only a timestamp derived from the actual observation range can be saved as
  // playback time. Null is not converted into wall-clock time or acquisition time.
  const playbackAt = temporal.state.range.source === 'OBSERVATIONS'
    && playhead !== null && Number.isFinite(playhead)
    ? new Date(playhead).toISOString() : null;
  const contact = s.selectedAis && /^[0-9]{9}$/.test(s.selectedAis.mmsi)
    ? {
      mmsi: s.selectedAis.mmsi,
      observation_at: s.selectedAis.observationAt,
    }
    : null;
  const workspaces = [
    'TACTICAL', 'SEARCH', 'INTELLIGENCE', 'TASKING', 'LAYERS',
    'ANALYTICS', 'ADVANCED', 'REPORTS', 'SYSTEM', 'VIEWS',
  ] as const;
  const workspace = workspaces.find((name) => name === s.workspace) ?? 'TACTICAL';
  return {
    schema_version: 1,
    camera: pose,
    map_source_id: mapSourceId,
    layers,
    scan_id: s.scanId,
    target,
    contact,
    playback_at: playbackAt,
    playback_speed: temporal.state.speed,
    workspace,
    aoi: s.aoi,
  };
}

/**
 * Restore with explicit partial-result diagnostics. A missing persisted scan
 * aborts source/selection restoration while allowing a camera-only bookmark to
 * remain useful. Selected targets and AIS observation markers are revalidated
 * against the NEWLY loaded authoritative scan; no stale identity is reused.
 */
export async function restoreSavedView(view: SavedViewOut): Promise<string[]> {
  if (view.status !== 'OK' || view.snapshot === null) {
    throw new Error('This saved view is corrupt and cannot be restored.');
  }
  const snapshot = view.snapshot;
  const messages = [...view.missing_resources];
  const scanId = snapshot.scan_id ?? null;
  if (scanId !== null) {
    if (messages.includes('SCAN_MISSING')) {
      throw new Error('Referenced scan is no longer installed. The bookmark has been retained.');
    }
    const found = await api.get<ScanStateResponse>(`/api/scans/${encodeURIComponent(scanId)}`);
    if (!found.record_persisted || found.runtime_mode !== 'REAL' || found.synthetic !== false) {
      throw new Error('Referenced scan has no persisted, verified REAL record.');
    }
    releaseStageStream();
    const aoi = toBBox(snapshot.aoi);
    store.set({
      scanId,
      scanStage: 'COMPLETE',
      scanStageHistory: [],
      scanError: null,
      selection: { kind: 'none' },
      selectedAis: null,
      targets: [],
      targetDetail: [],
      aisOnly: [],
      aisObservations: [],
      aoi,
      aoiText: aoi?.map((n) => n.toFixed(5)).join(', ') ?? '',
    });
    await Promise.all([loadScanResults(scanId), loadScanAis(scanId), loadRaster(scanId, 'raw')]);
    const latest = store.getState();
    if (snapshot.target !== null && snapshot.target !== undefined) {
      const target = latest.targets.find((item) => item.id === snapshot.target?.target_id);
      if (target) {
        store.select({ kind: 'target', scanId, targetId: target.id });
      } else {
        messages.push('TARGET_MISSING: the stored target ID was absent after reload.');
      }
    }
    if (snapshot.contact) {
      const present = latest.aisObservations.some((o) => o.mmsi === snapshot.contact?.mmsi);
      if (present) {
        const observedAt = snapshot.contact.observation_at;
        const exactFix = observedAt && latest.aisObservations.some((o) =>
          o.mmsi === snapshot.contact?.mmsi && Date.parse(o.timestamp) === Date.parse(observedAt));
        store.selectAis({ mmsi: snapshot.contact.mmsi, observationAt: exactFix ? observedAt ?? null : null });
        if (observedAt && !exactFix) messages.push('AIS_OBSERVATION_MISSING: contact restored without its absent source fix.');
      } else {
        messages.push('AIS_CONTACT_MISSING: selected contact is not in the persisted archive.');
      }
    }
    if (snapshot.playback_at) {
      const time = Date.parse(snapshot.playback_at);
      const observed = rangeFromTimestamps(latest.aisObservations.map((o) => o.timestamp));
      if (Number.isFinite(time) && observed.source === 'OBSERVATIONS'
        && time >= observed.startMs && time <= observed.endMs) {
        temporal.pause();
        temporal.setRange(observed);
        temporal.seek(time);
      } else {
        messages.push('PLAYBACK_TIME_UNAVAILABLE: time is outside the available AIS observation range.');
      }
    }
  } else if (store.getState().scanId) {
    messages.push('NO_SCAN_IN_VIEW: retained the currently loaded source; camera and layout were restored.');
  }

  // Selected presentation settings apply only to recognized runtime layers.
  const current = store.getState().layerState;
  const next = { ...current };
  for (const [key, value] of Object.entries(snapshot.layers ?? {})) {
    if (!(key in current)) {
      messages.push(`LAYER_UNAVAILABLE: ${key}`);
      continue;
    }
    const id = key as LayerId;
    next[id] = { ...current[id], visible: value.visible, opacity: value.opacity };
    engine.setLayerVisibility(id, value.visible);
  }
  store.set({ layerState: next });

  if (snapshot.map_source_id) {
    const status = engine.selectBasemapSource(snapshot.map_source_id);
    if (!status || status.activeId !== snapshot.map_source_id) {
      messages.push('MAP_SOURCE_UNAVAILABLE: the original basemap could not be reinstalled.');
    }
  }
  if (snapshot.camera) {
    aisCamera.setFollow(false);
    engine.setCameraPose(snapshot.camera.position, {
      heading: snapshot.camera.heading,
      pitch: snapshot.camera.pitch,
      roll: snapshot.camera.roll,
    });
  }
  if (snapshot.playback_speed) {
    temporal.setSpeed(snapshot.playback_speed as Parameters<typeof temporal.setSpeed>[0]);
  }
  if (snapshot.investigation_id) {
    messages.push('INVESTIGATION_REFERENCE: reopen the linked case in Reports to inspect its original analyst annotations.');
  }
  store.set({ workspace: snapshot.workspace ?? 'TACTICAL' });
  return [...new Set(messages)];
}
