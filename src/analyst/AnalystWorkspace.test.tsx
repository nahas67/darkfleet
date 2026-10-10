import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AnalystWorkspace, listAnalystCases, readGroundedAnalysis,
  runGroundedAnalysis, type GroundedAnalysis,
} from './AnalystWorkspace';

const caseId = 'aaacb2c2-13c0-4321-b30e-0f5a11955001';
const scanId = 'REAL-001';
const analysis: GroundedAnalysis = {
  kind: 'DARKFLEET_GROUNDED_ANALYST',
  case_id: caseId,
  case_title: 'Real SAR review',
  linked_scan_id: scanId,
  source_status: 'PERSISTED_REAL',
  intent: 'SAR_AIS',
  focused_target_id: 'DF-001',
  model_status: 'NO_MODEL_DETERMINISTIC_OFFLINE',
  operator_note_count: 1,
  operator_watch_count: 1,
  source_canonical_sha256: 'a'.repeat(64),
  disclaimer: 'No claim of vessel identity or illicit conduct.',
  claims: [{
    id: 'fact-001',
    statement: 'Saved SAR detector confidence for target DF-001 is 0.9100.',
    value: 0.91,
    classification: 'SENSOR_RECORD',
    uncertainty: 'Algorithmic detection score, not vessel identity.',
    sources: [{
      kind: 'PERSISTED_REAL_SCAN',
      source_id: scanId,
      record_path: 'scans/REAL-001.json',
      field_path: '$.targets[0].sarConf',
    }],
  }],
  unknowns: [{
    code: 'AIS_COVERAGE_NOT_ESTABLISHED',
    explanation: 'Saved AIS coverage metadata absent.',
    source_id: scanId,
    expected_field_path: '$.ais_coverage.status',
    next_check: 'Check coverage for the scan acquisition window.',
  }],
};

const json = (data: unknown) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
afterEach(() => vi.unstubAllGlobals());

describe('DF-X20 offline grounded analyst', () => {
  it('discovers cases and requests only a bounded intent and optional saved target ID', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      cases: [{
        case_id: caseId, title: 'Real SAR review',
        linked_scan_id: scanId, created_at: '2026-10-10T08:00:00Z',
      }],
      total: 1, note: 'Saved local cases',
    })).mockResolvedValueOnce(json(analysis));
    vi.stubGlobal('fetch', fetchMock);
    expect((await listAnalystCases())[0].case_id).toBe(caseId);
    const result = await runGroundedAnalysis(caseId, 'SAR_AIS', 'DF-001');
    expect(result.claims[0].sources[0].field_path).toBe('$.targets[0].sarConf');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/analyst/cases', `/api/analyst/cases/${caseId}/analyze`,
    ]);
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      intent: 'SAR_AIS', target_id: 'DF-001',
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('operator_note');
  });

  it('never treats unreferenced facts or false sources as validated', () => {
    expect(() => readGroundedAnalysis({ ...analysis, claims: [{
      ...analysis.claims[0], sources: [],
    }] })).toThrow(/citations/);
    expect(() => readGroundedAnalysis({ ...analysis, claims: [{
      ...analysis.claims[0], sources: [{
        kind: 'OPERATOR_CASE', source_id: caseId, record_path: 'investigations.sqlite3',
        field_path: 'investigations.title',
      }],
    }] })).toThrow(/Sensor claim must cite/);
    expect(() => readGroundedAnalysis({
      ...analysis, source_status: 'SOURCE_MISSING',
    })).toThrow(/Unavailable source cannot support sensor claims/);
    expect(() => readGroundedAnalysis({
      ...analysis, model_status: 'REMOTE_GENERATIVE_MODEL',
    })).toThrow(/offline analyst authority/);
    expect(() => readGroundedAnalysis({
      ...analysis, source_canonical_sha256: 'NOT_A_DIGEST',
    })).toThrow(/Invalid scan digest/);
    expect(() => readGroundedAnalysis({
      ...analysis, claims: [{ ...analysis.claims[0], value: Number.NaN }],
    })).toThrow(/finite recorded scalar/);
  });

  it('distinguishes missing source from an empty finding', () => {
    const missing = readGroundedAnalysis({
      ...analysis, source_status: 'SOURCE_MISSING', claims: [],
      source_canonical_sha256: null,
    });
    expect(missing.claims).toEqual([]);
    expect(missing.unknowns[0].code).toBe('AIS_COVERAGE_NOT_ESTABLISHED');
    expect(missing.source_status).toBe('SOURCE_MISSING');
    expect(() => readGroundedAnalysis({
      ...missing, source_canonical_sha256: 'b'.repeat(64),
    })).toThrow(/verified scan digest/);
  });

  it('rejects freeform prompts and a path-shaped target before HTTP request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(runGroundedAnalysis('NOT_UUID', 'SUMMARY')).rejects.toThrow(/saved investigation/);
    await expect(runGroundedAnalysis(caseId, 'SAR_AIS', '../private')).rejects.toThrow(/unsupported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders actual no-model, saved-case and unknown controls independently', () => {
    const html = renderToStaticMarkup(<AnalystWorkspace />);
    expect(html).toContain('data-df-grounded-analyst');
    expect(html).toContain('data-df-analyst-model-state');
    expect(html).toContain('NO MODEL CONFIGURED');
    expect(html).toContain('data-df-analyst-case');
    expect(html).toContain('data-df-analyst-intent');
    expect(html).toContain('data-df-analyst-run');
    expect(html).toContain('Operator notes and prompts are not used');
    expect(html).not.toContain('data-df-analyst-claims');
  });
});
