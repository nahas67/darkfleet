import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeMissionAlert, addMissionRule, createMission, evaluateMission,
  linkMissionScan, listMissions, parseMissionAOI, readMission,
  replaceMission, type Mission,
} from './missions';

const mission: Mission = {
  id: 'mission-1', title: 'Historical SAR watch',
  aoi: [103, 1, 104, 2], status: 'ACTIVE',
  created_at: '2026-10-10T08:00:00Z', updated_at: '2026-10-10T08:00:00Z',
  scan_ids: ['REAL-01'],
  rules: [{
    id: 'rule-1', mission_id: 'mission-1', investigation_id: 'case-1',
    scan_id: 'REAL-01', target_id: 'DF-001',
    kind: 'WATCHED_TARGET_SAR_CONFIDENCE',
    minimum_sar_confidence: 0.8, created_at: '2026-10-10T08:00:00Z',
  }],
  alerts: [{
    id: 'alert-1', mission_id: 'mission-1', rule_id: 'rule-1',
    scan_id: 'REAL-01', target_id: 'DF-001',
    sar_confidence: 0.92, minimum_sar_confidence: 0.8,
    classification: 'SAR_UNMATCHED',
    rationale: 'Operator-configured threshold met; no claim of illicit activity.',
    evidence: { source: 'PERSISTED_REAL_SAR_SCAN', sar_confidence: 0.92 },
    evidence_fingerprint: 'a0123456789',
    status: 'OPEN', acknowledged_at: null,
    provenance: 'PERSISTED_REAL_SAR_OPERATOR_THRESHOLD',
    created_at: '2026-10-10T08:00:00Z',
  }],
  evaluations: [{
    mission_id: 'mission-1', rule_id: 'rule-1',
    scan_id: 'REAL-01', target_id: 'DF-001',
    status: 'TRIGGERED', reason: 'Stored evidence met operator rule',
    evaluated_at: '2026-10-10T08:00:00Z', evidence_fingerprint: 'a0123456789',
  }],
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

afterEach(() => vi.unstubAllGlobals());

describe('mission API and historical threshold alerts', () => {
  it('persists real mission creation, status changes, links, watch rule and evaluations', async () => {
    const run = {
      mission_id: 'mission-1', evaluations: mission.evaluations,
      alerts_created: 0, existing_alerts: 1, not_evaluated: 0,
      note: 'Historical records only',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ missions: [mission] }))
      .mockResolvedValueOnce(response(mission, 201))
      .mockResolvedValueOnce(response(mission))
      .mockResolvedValueOnce(response(mission))
      .mockResolvedValueOnce(response(mission.rules[0], 201))
      .mockResolvedValueOnce(response(run))
      .mockResolvedValueOnce(response({ ...mission.alerts[0], status: 'ACKNOWLEDGED',
        acknowledged_at: '2026-10-10T10:00:00Z' }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await listMissions())[0].id).toBe('mission-1');
    await createMission({ title: 'SAR watch', aoi: [103, 1, 104, 2], status: 'PLANNED' });
    await replaceMission('mission-1', { title: 'SAR watch', aoi: [103, 1, 104, 2], status: 'ACTIVE' });
    await linkMissionScan('mission-1', 'REAL-01');
    await addMissionRule('mission-1', {
      investigation_id: 'case-1', target_id: 'DF-001', minimum_sar_confidence: 0.8,
    });
    const result = await evaluateMission('mission-1');
    expect(result.existing_alerts).toBe(1);
    expect(result.alerts_created).toBe(0);
    expect((await acknowledgeMissionAlert('mission-1', 'alert-1')).status).toBe('ACKNOWLEDGED');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/missions', '/api/missions', '/api/missions/mission-1',
      '/api/missions/mission-1/scans', '/api/missions/mission-1/rules',
      '/api/missions/mission-1/evaluate', '/api/missions/mission-1/alerts/alert-1/ack',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual([
      'GET', 'POST', 'PUT', 'POST', 'POST', 'POST', 'POST',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toEqual({
      investigation_id: 'case-1', target_id: 'DF-001', minimum_sar_confidence: 0.8,
    });
  });

  it('does not replace missing alerts/evaluations with invented empty values', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ missions: [{
      ...mission, alerts: undefined,
    }] })));
    await expect(listMissions()).rejects.toThrow(/missing required key.*alerts/);
  });

  it('refuses fake alert provenance, nonnumeric threshold and invalid status', () => {
    expect(() => readMission({ ...mission, status: 'AUTO_MONITORING' })).toThrow(/Mission.status/);
    expect(() => readMission({
      ...mission, rules: [{ ...mission.rules[0], minimum_sar_confidence: 'high' }],
    })).toThrow(/minimum_sar_confidence/);
    expect(() => readMission({
      ...mission, alerts: [{ ...mission.alerts[0], provenance: 'DETECTED_ILLICIT_ACTIVITY' }],
    })).toThrow(/provenance/);
  });

  it('parses WGS84 AOI deterministically and rejects dateline ambiguity', () => {
    expect(parseMissionAOI(' 103, 1, 104, 2 ')).toEqual([103, 1, 104, 2]);
    for (const input of [
      '180,0,-180,1', '103,1,103,2', '0,90,1,91', 'foo,1,2,3',
      '0,0,0', 'Infinity,1,2,3', '1,1,2,2,2',
    ]) expect(() => parseMissionAOI(input)).toThrow();
  });
});
