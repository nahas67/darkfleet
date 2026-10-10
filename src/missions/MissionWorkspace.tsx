/** Local-first mission controls and evidence-scoped historical alert rules. */
import { useEffect, useRef, useState } from 'react';
import {
  acknowledgeMissionAlert, addMissionRule, createMission, deleteMission,
  evaluateMission, linkMissionScan, listMissions, parseMissionAOI,
  removeMissionRule, replaceMission, unlinkMissionScan,
  type EvaluationRun, type Mission, type MissionStatus,
} from '../api/missions';
import { listInvestigations } from '../api/investigations';
import type { InvestigationOut } from '../api/contract';
import { explain } from '../api/errors';
import { fmtInstant } from '../design/format';
import { useStore } from '../state/store';

const statuses: MissionStatus[] = ['PLANNED', 'ACTIVE', 'PAUSED', 'CLOSED'];
const statusHelp: Record<MissionStatus, string> = {
  PLANNED: 'Configure scans and rules; evaluation remains disabled.',
  ACTIVE: 'Explicit manual evaluation is enabled. No background polling.',
  PAUSED: 'Evaluation disabled; existing alerts remain saved.',
  CLOSED: 'Evaluation and new configuration disabled. Alert history is retained.',
};
const formatAOI = (values: readonly number[]) => values.join(', ');

export function MissionWorkspace() {
  const domain = useStore();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [cases, setCases] = useState<InvestigationOut[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [aoiText, setAoiText] = useState('');
  const [status, setStatus] = useState<MissionStatus>('PLANNED');
  const [scanId, setScanId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [threshold, setThreshold] = useState('0.8');
  const [latestRun, setLatestRun] = useState<EvaluationRun | null>(null);
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loadGeneration = useRef(0);

  const loadAll = async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    const [saved, investigations] = await Promise.allSettled([listMissions(), listInvestigations()]);
    if (loadGeneration.current !== generation) return;
    if (saved.status === 'fulfilled') {
      setMissions(saved.value);
      setSelectedId((current) => current && saved.value.some((item) => item.id === current)
        ? current : saved.value[0]?.id ?? null);
    } else {
      setMissions([]);
      setSelectedId(null);
    }
    // A watchlist lookup failure must not erase otherwise accessible missions.
    // Conversely, never keep stale watch entries when their source is unavailable.
    setCases(investigations.status === 'fulfilled' ? investigations.value : []);
    const errors = [saved, investigations]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => explain(result.reason));
    setError(errors.length ? errors.join(' · ') : null);
    setLoading(false);
  };
  useEffect(() => {
    void loadAll();
    return () => { loadGeneration.current++; };
    // Initial load only; reload is explicitly operator controlled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = missions.find((item) => item.id === selectedId) ?? null;
  useEffect(() => {
    setStatus(selected?.status ?? 'PLANNED');
  }, [selected?.id, selected?.status]);
  const relevantCases = selected ? cases.filter((item) =>
    item.scan_id !== null && selected.scan_ids.includes(item.scan_id) && item.watchlist.length > 0,
  ) : [];
  const chosenCase = relevantCases.find((item) => item.id === caseId) ?? relevantCases[0] ?? null;
  const chosenTarget = chosenCase?.watchlist.find((entry) => entry.target_id === targetId)?.target_id ??
    chosenCase?.watchlist[0]?.target_id ?? null;

  const reload = async (preferredId?: string | null) => {
    const updated = await listMissions();
    setMissions(updated);
    setSelectedId((current) => {
      const requested = preferredId === undefined ? current : preferredId;
      return requested && updated.some((item) => item.id === requested)
        ? requested : updated[0]?.id ?? null;
    });
  };
  const run = (action: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    void action().catch((cause: unknown) => setError(explain(cause)))
      .finally(() => setWorking(false));
  };
  const make = () => run(async () => {
    const created = await createMission({
      title: title.trim(), aoi: parseMissionAOI(aoiText), status: 'PLANNED',
    });
    setTitle('');
    setAoiText('');
    setLatestRun(null);
    await reload(created.id);
  });
  const saveStatus = () => {
    if (!selected) return;
    run(async () => {
      await replaceMission(selected.id, {
        title: selected.title, aoi: selected.aoi, status,
      });
      await reload(selected.id);
    });
  };
  const evaluate = () => {
    if (!selected) return;
    run(async () => {
      setLatestRun(await evaluateMission(selected.id));
      await reload(selected.id);
    });
  };
  const availableScan = domain.scanId && domain.scanStage === 'COMPLETE' ? domain.scanId : null;
  const currentStatus = selected?.status ?? 'PLANNED';
  return (
    <section data-df-workspace="MISSIONS" className="h-full overflow-y-auto px-3 py-3">
      <h2 className="df-label text-xs">Missions &amp; evidence-grounded alerts</h2>
      <button type="button" className="df-btn mt-2" data-df-mission-reload
        disabled={loading || working} onClick={() => { void loadAll(); }}>
        {loading ? 'Loading mission records…' : 'Reload saved missions and watchlists'}
      </button>
      <p className="mt-2 text-[11px] text-ink-dim">
        Historical persisted REAL scans only. An operator-defined SAR confidence
        threshold is not an assessment of vessel identity or illicit activity.
        No automatic live monitoring or inferred observations.
      </p>

      <div className="mt-3 space-y-2 border-t border-structural pt-3">
        <p className="df-label text-[10px]">Create mission</p>
        <label htmlFor="df-mission-title" className="df-label text-[10px]">Mission title</label>
        <input id="df-mission-title" data-df-mission-title className="df-input w-full"
          maxLength={120} disabled={working} placeholder="Local coastal evidence review"
          value={title} onChange={(event) => setTitle(event.target.value)} />
        <label htmlFor="df-mission-aoi" className="df-label text-[10px]">
          WGS84 AOI · west, south, east, north
        </label>
        <input id="df-mission-aoi" data-df-mission-aoi className="df-input w-full"
          disabled={working} placeholder="103.0, 1.0, 104.0, 2.0"
          value={aoiText} onChange={(event) => setAoiText(event.target.value)} />
        {domain.aoi ? <button type="button" className="df-btn"
          disabled={working} data-df-mission-use-aoi
          onClick={() => setAoiText(formatAOI(domain.aoi ?? []))}>
          Use current operation AOI
        </button> : null}
        <button type="button" className="df-btn w-full justify-center"
          data-df-mission-create disabled={working || !title.trim() || !aoiText.trim()}
          onClick={make}>Create saved mission</button>
      </div>

      <div className="mt-3 space-y-2 border-t border-structural pt-3">
        <label htmlFor="df-mission-select" className="df-label text-[10px]">
          Persisted missions ({missions.length})
        </label>
        <select id="df-mission-select" data-df-mission-select className="df-input w-full"
          value={selectedId ?? ''} disabled={working || !missions.length}
          onChange={(event) => {
            const id = event.target.value;
            setSelectedId(id);
            setLatestRun(null);
            setCaseId('');
            setTargetId('');
            setConfirmDelete(false);
          }}>
          {missions.length === 0 ? <option value="">No saved missions</option> : null}
          {missions.map((mission) => <option value={mission.id} key={mission.id}>
            {mission.title} · {mission.status}
          </option>)}
        </select>
        {loading ? <p className="text-[11px] text-ink-dim">Loading persisted missions…</p> : null}
      </div>
      {selected ? <div className="mt-3 space-y-3" data-df-mission-detail={selected.id}>
        <p className="df-num text-[10px] text-ink-dim">
          {selected.title} · Created {fmtInstant(selected.created_at)}
        </p>
        <p className="df-num text-[10px] text-ink">AOI {formatAOI(selected.aoi)} (WGS84)</p>
        <p className="text-[10px] text-ink-dim">{statusHelp[currentStatus]}</p>
        <label htmlFor="df-mission-status" className="df-label text-[10px]">Mission status</label>
        <div className="flex gap-2">
          <select id="df-mission-status" data-df-mission-status
            className="df-input min-w-0 flex-1" disabled={working}
            value={status}
            onChange={(event) => setStatus(event.target.value as MissionStatus)}>
            {statuses.map((state) => <option key={state} value={state}>{state}</option>)}
          </select>
          <button type="button" className="df-btn" disabled={working}
            data-df-mission-save-status onClick={saveStatus}>Save status</button>
        </div>

        <div className="space-y-2 border-t border-structural pt-3">
          <p className="df-label text-[10px]">Linked persisted REAL scans ({selected.scan_ids.length})</p>
          <input className="df-input w-full" aria-label="Scan ID to link"
            data-df-mission-scan-input value={scanId} disabled={working || currentStatus === 'CLOSED'}
            placeholder="Persisted REAL scan ID" onChange={(event) => setScanId(event.target.value)} />
          {availableScan ? <button className="df-btn" type="button"
            data-df-mission-use-scan disabled={working || currentStatus === 'CLOSED'}
            onClick={() => setScanId(availableScan)}>
            Use completed scan {availableScan}
          </button> : null}
          <button className="df-btn w-full justify-center" type="button"
            data-df-mission-link-scan disabled={working || currentStatus === 'CLOSED' || !scanId.trim()}
            onClick={() => run(async () => {
              await linkMissionScan(selected.id, scanId.trim());
              setScanId('');
              await reload(selected.id);
            })}>Link verified scan</button>
          {selected.scan_ids.map((id) => <div key={id}
            className="flex items-center justify-between gap-2 border border-structural p-2">
            <span className="df-num min-w-0 truncate text-[11px] text-ink">{id}</span>
            <button type="button" className="df-btn" disabled={working}
              onClick={() => run(async () => {
                await unlinkMissionScan(selected.id, id);
                await reload(selected.id);
              })}>Unlink</button>
          </div>)}
        </div>

        <div className="space-y-2 border-t border-structural pt-3">
          <p className="df-label text-[10px]">Operator-configured watched-target rules</p>
          <p className="text-[11px] text-ink-dim">
            First add a SAR target to a linked scan investigation&apos;s watchlist
            in Reports. A rule evaluates only that recorded target&apos;s sarConf.
          </p>
          <button type="button" className="df-btn" disabled={working}
            data-df-mission-refresh-watches onClick={() => run(async () => {
              const refreshed = await listInvestigations();
              setCases(refreshed);
              setCaseId('');
              setTargetId('');
            })}>Refresh investigation watchlists</button>
          <label htmlFor="df-mission-watch-case" className="df-label text-[10px]">
            Linked investigation with saved watchlist
          </label>
          <select id="df-mission-watch-case" data-df-mission-watch-case
            disabled={working || !relevantCases.length || currentStatus === 'CLOSED'}
            className="df-input w-full" value={chosenCase?.id ?? ''}
            onChange={(event) => { setCaseId(event.target.value); setTargetId(''); }}>
            {!relevantCases.length ? <option value="">No eligible watched investigations</option> : null}
            {relevantCases.map((item) => <option value={item.id} key={item.id}>
              {item.title} · {item.scan_id}
            </option>)}
          </select>
          <label htmlFor="df-mission-watch-target" className="df-label text-[10px]">
            Watched SAR target
          </label>
          <select id="df-mission-watch-target" data-df-mission-watch-target
            disabled={working || !chosenCase || currentStatus === 'CLOSED'}
            className="df-input w-full" value={chosenTarget ?? ''}
            onChange={(event) => setTargetId(event.target.value)}>
            {!chosenCase ? <option value="">No watch entry available</option> : null}
            {chosenCase?.watchlist.map((entry) => <option key={entry.id} value={entry.target_id}>
              {entry.target_id}
            </option>)}
          </select>
          <label htmlFor="df-mission-threshold" className="df-label text-[10px]">
            Minimum saved SAR detection confidence (0.0–1.0)
          </label>
          <input id="df-mission-threshold" data-df-mission-threshold
            className="df-input w-full" type="number" min="0" max="1" step="0.05"
            disabled={working || currentStatus === 'CLOSED'} value={threshold}
            onChange={(event) => setThreshold(event.target.value)} />
          <button type="button" className="df-btn w-full justify-center"
            data-df-mission-add-rule disabled={working || currentStatus === 'CLOSED' ||
              !chosenCase || !chosenTarget || threshold.trim() === ''}
            onClick={() => run(async () => {
              const n = Number(threshold);
              if (!Number.isFinite(n) || n < 0 || n > 1) {
                throw new Error('Specify a finite SAR confidence threshold between 0 and 1.');
              }
              if (!chosenCase || !chosenTarget) return;
              await addMissionRule(selected.id, {
                investigation_id: chosenCase.id, target_id: chosenTarget,
                minimum_sar_confidence: n,
              });
              await reload(selected.id);
            })}>Add watchlist threshold rule</button>
          {selected.rules.map((rule) => <div key={rule.id}
            className="border border-structural p-2" data-df-mission-rule={rule.id}>
            <p className="df-num text-[11px] text-ink">
              {rule.target_id} · scan {rule.scan_id} · sarConf ≥ {rule.minimum_sar_confidence}
            </p>
            <p className="text-[10px] text-ink-dim">Investigation {rule.investigation_id}</p>
            <button className="df-btn mt-1" type="button" disabled={working}
              onClick={() => run(async () => {
                await removeMissionRule(selected.id, rule.id);
                await reload(selected.id);
              })}>Remove rule</button>
          </div>)}
        </div>

        <div className="space-y-2 border-t border-structural pt-3">
          <p className="df-label text-[10px]">Evaluate persisted evidence</p>
          <button className="df-btn w-full justify-center" type="button" data-df-mission-evaluate
            disabled={working || currentStatus !== 'ACTIVE' || selected.rules.length === 0}
            onClick={evaluate}>Evaluate watched target records now</button>
          {latestRun ? <p className="df-num text-[11px] text-ink"
            data-df-mission-evaluation-counts>
            New alerts {latestRun.alerts_created} · Existing {latestRun.existing_alerts}
            {' '}· Not evaluated {latestRun.not_evaluated}
          </p> : null}
          <p className="text-[11px] text-ink-dim">
            Missing scans, revoked watch entries or absent SAR confidence are
            NOT_EVALUATED, never zero or a fabricated alert.
          </p>
          <ul className="space-y-1" data-df-mission-evaluations>
            {selected.evaluations.map((item) => <li key={item.rule_id}
              className="border border-structural p-2">
              <p className="df-num text-[11px] text-ink">{item.target_id} · {item.status}</p>
              <p className="text-[11px] text-ink-dim">{item.reason}</p>
              <p className="df-num text-[10px] text-ink-dim">{fmtInstant(item.evaluated_at)}</p>
            </li>)}
          </ul>
        </div>

        <div className="space-y-2 border-t border-structural pt-3">
          <p className="df-label text-[10px]">Persistent alert ledger ({selected.alerts.length})</p>
          {selected.alerts.length === 0 ? <p className="text-[11px] text-ink-dim">
            No saved threshold alerts; no alert is inferred from missing evidence.
          </p> : null}
          <ul className="space-y-2" data-df-mission-alerts>
            {selected.alerts.map((alert) => <li key={alert.id} className="border border-structural p-2"
              data-df-mission-alert={alert.id}>
              <p className="df-num text-[11px] text-ink">
                {alert.target_id} · {alert.status} · {alert.sar_confidence} ≥ {alert.minimum_sar_confidence}
              </p>
              <p className="text-[11px] text-ink-dim">{alert.rationale}</p>
              <p className="df-num text-[10px] text-ink-dim">
                Scan {alert.scan_id} · {alert.classification ?? 'classification unavailable'}
                {' '}· fingerprint {alert.evidence_fingerprint.slice(0, 12)}
              </p>
              <p className="text-[10px] text-ink-dim">
                Persisted REAL evidence · {fmtInstant(alert.created_at)}
              </p>
              {alert.status === 'OPEN' ? <button type="button" className="df-btn mt-1"
                data-df-mission-ack disabled={working} onClick={() => run(async () => {
                  await acknowledgeMissionAlert(selected.id, alert.id);
                  await reload(selected.id);
                })}>Acknowledge</button> : <p className="text-[10px] text-ink-dim">
                Acknowledged {alert.acknowledged_at ? fmtInstant(alert.acknowledged_at) : 'time unknown'}
              </p>}
            </li>)}
          </ul>
        </div>
        <div className="border-t border-structural pt-3">
          {confirmDelete ? <>
            <p className="text-[11px] text-ink-dim">
              Delete this mission, rules, evaluations and alerts?
              Persisted scans and investigation watchlists remain intact.
            </p>
            <button type="button" className="df-btn" disabled={working}
              onClick={() => run(async () => {
                await deleteMission(selected.id);
                setLatestRun(null);
                setConfirmDelete(false);
                await reload(null);
              })}>Confirm delete mission</button>
            <button type="button" className="df-btn ml-2"
              onClick={() => setConfirmDelete(false)}>Cancel</button>
          </> : <button type="button" className="df-btn"
            data-df-mission-delete onClick={() => setConfirmDelete(true)}>Delete mission</button>}
        </div>
      </div> : null}
      {error ? <p role="alert" data-df-mission-error
        className="mt-3 text-[11px] text-fault">{error}</p> : null}
    </section>
  );
}
