/**
 * Scan job state, driven by REAL backend stage transitions (API-004).
 *
 * The hook creates a scan through `POST /api/scans`, then follows
 * `GET /api/scans/{id}/events` (server-sent events) and mirrors the stage names
 * the runner actually recorded. There is deliberately no progress percentage,
 * no interpolation and no timer: a stage the backend never emitted is never
 * displayed, and a stage the client does not recognise is surfaced verbatim
 * rather than coerced into something plausible.
 *
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeMode, ScanRequest, ScanStage, StageEvent } from '../types/api.ts';
import { SCAN_PIPELINE } from '../types/api.ts';
import { createApiClient } from './useApi.ts';
import type { ApiClient } from './useApi.ts';

/** Every `ScanStage` value, used to validate what the server sends. */
const SCAN_STAGES: readonly ScanStage[] = [...SCAN_PIPELINE, 'FAILED'];

export function isScanStage(value: string): value is ScanStage {
  return (SCAN_STAGES as readonly string[]).includes(value);
}

export type ConnectionState = 'IDLE' | 'CONNECTING' | 'STREAMING' | 'CLOSED' | 'ERROR';

export interface ScanState {
  /** Scan id echoed by the backend, or null before a scan exists. */
  readonly scanId: string | null;
  readonly stage: ScanStage | null;
  readonly history: readonly StageEvent[];
  /** Terminal failure detail reported by the backend. Never synthesised. */
  readonly error: string | null;
  readonly terminal: boolean;
  /**
   * Provenance the BACKEND reported for this job, echoed verbatim. There is no
   * synthetic runtime to select, so this is metadata about the job rather than
   * a mode the user chooses — the value is always `REAL` in production.
   */
  readonly runtimeMode: RuntimeMode | null;
  /** Backend-reported provenance flag. Kept as reported; never assumed false. */
  readonly synthetic: boolean | null;
  readonly connection: ConnectionState;
  /** Stage strings the backend sent that this build does not model. */
  readonly unknownStages: readonly string[];
}

export const IDLE_SCAN_STATE: ScanState = {
  scanId: null,
  stage: null,
  history: [],
  error: null,
  terminal: false,
  runtimeMode: null,
  synthetic: null,
  connection: 'IDLE',
  unknownStages: [],
};

// ------------------------------------------------------------------- reducer

/**
 * Fold one backend stage event into scan state.
 *
 * Every field here comes from the payload. Nothing is derived, estimated or
 * filled in — in particular there is no progress field, because the backend
 * does not emit one.
 */
export function applyStageEvent(state: ScanState, payload: StageEvent): ScanState {
  if (payload.stage === 'FAILED') {
    return {
      ...state,
      stage: 'FAILED',
      terminal: true,
      error: payload.detail || 'Scan failed.',
      connection: 'CLOSED',
      history: [...state.history, payload],
    };
  }

  const known = isScanStage(payload.stage);
  if (!known) {
    // Show what the server said rather than guessing which stage it meant.
    return {
      ...state,
      unknownStages: [...state.unknownStages, payload.stage],
      history: [...state.history, payload],
    };
  }

  const terminal = payload.stage === 'COMPLETE';
  return {
    ...state,
    stage: payload.stage,
    terminal,
    error: terminal ? null : state.error,
    connection: terminal ? 'CLOSED' : state.connection,
    history: [...state.history, payload],
  };
}

export function withScanAccepted(
  state: ScanState,
  accepted: { scan_id: string; runtime_mode: RuntimeMode; synthetic: boolean },
): ScanState {
  return {
    ...IDLE_SCAN_STATE,
    scanId: accepted.scan_id,
    // Provenance straight from the accept response, not a local choice.
    runtimeMode: accepted.runtime_mode,
    synthetic: accepted.synthetic,
    connection: 'CONNECTING',
  };
}

export function withConnection(state: ScanState, connection: ConnectionState): ScanState {
  return state.connection === connection ? state : { ...state, connection };
}

export function withScanError(state: ScanState, error: string): ScanState {
  return { ...state, error, connection: 'ERROR' };
}

// ---------------------------------------------------------------------- SSE

/** One decoded server-sent event. `data` is the raw JSON string. */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Incremental SSE decoder. Handles CRLF, multi-line `data:` fields and `:`
 * comment lines (the backend sends a keep-alive comment before the first
 * stage), which `EventSource` would otherwise hide from us.
 */
export function createSseDecoder(): (chunk: string) => SseFrame[] {
  let buffer = '';
  return (chunk: string): SseFrame[] => {
    buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const frames: SseFrame[] = [];
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const frame = parseSseBlock(block);
      if (frame) frames.push(frame);
      index = buffer.indexOf('\n\n');
    }
    return frames;
  };
}

function parseSseBlock(block: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

/** Decode one backend `event: stage` payload into a `StageEvent`. */
export function parseStagePayload(data: string): StageEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const stage = record.stage;
  // `stage: null` is the backend's timeout notice, not a transition.
  if (typeof stage !== 'string') return null;
  const detail = typeof record.detail === 'string' ? record.detail : '';
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : '';
  return {
    // Unknown stage names are preserved here; `applyStageEvent` decides what
    // to do with them instead of silently dropping them.
    stage: stage as ScanStage,
    timestamp,
    detail,
  };
}

/**
 * Opens a stream and returns an unsubscribe function. Injectable so tests can
 * drive real stage frames without a network.
 */
export type SseConnector = (url: string) => (onFrame: (frame: SseFrame) => void) => () => void;

// --------------------------------------------------------------------- hook

export interface UseScanResult {
  readonly state: ScanState;
  /** Create a backend scan and follow its stage stream. */
  readonly startScan: (request: ScanRequest) => Promise<void>;
  readonly reset: () => void;
}

export interface UseScanOptions {
  readonly client?: ApiClient;
  /** Inject a stream source. Defaults to fetch + ReadableStream. */
  readonly connect?: SseConnector;
}

export function useScan(options: UseScanOptions = {}): UseScanResult {
  const client = options.client ?? createApiClient();
  const connect = options.connect ?? fetchSseConnector();
  const [state, setState] = useState<ScanState>(IDLE_SCAN_STATE);
  const closeRef = useRef<(() => void) | null>(null);

  const disconnect = useCallback(() => {
    closeRef.current?.();
    closeRef.current = null;
  }, []);

  useEffect(() => disconnect, [disconnect]);

  const startScan = useCallback(
    async (request: ScanRequest) => {
      disconnect();
      let accepted;
      try {
        accepted = await client.createScan(request);
      } catch (err) {
        setState((prev) =>
          withScanError({ ...prev, scanId: null }, err instanceof Error ? err.message : String(err)),
        );
        return;
      }

      const started = withScanAccepted(IDLE_SCAN_STATE, accepted);
      setState(started);

      const attach = connect(client.scanEventsUrl(accepted.scan_id));
      const stop = attach((frame) => {
        if (frame.event !== 'stage') return;
        const event = parseStagePayload(frame.data);
        if (!event) return;
        setState((prev) => {
          const next = applyStageEvent(prev, event);
          // The stream ends on its own after a terminal stage; release it.
          if (next.terminal && closeRef.current === stop) closeRef.current = null;
          return next;
        });
      });
      closeRef.current = stop;
    },
    [client, connect, disconnect],
  );

  const reset = useCallback(() => {
    disconnect();
    setState(IDLE_SCAN_STATE);
  }, [disconnect]);

  return { state, startScan, reset };
}

/**
 * Default SSE source: fetch the stream and decode it by hand so comment frames
 * and unknown event names stay visible to the reducer.
 */
export function fetchSseConnector(fetchImpl?: typeof fetch): SseConnector {
  const doFetch = fetchImpl ?? globalThis.fetch;
  return (url: string) => (onFrame: (frame: SseFrame) => void) => {
    const controller = new AbortController();
    const decoder = createSseDecoder();

    void (async () => {
      try {
        const response = await doFetch(url, {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
        });
        if (!response.ok || !response.body) {
          // The stage history is still recoverable from the state endpoint.
          return;
        }
        const reader = response.body.getReader();
        const utf8 = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of decoder(utf8.decode(value, { stream: true }))) onFrame(frame);
        }
      } catch {
        // Stream failures surface as "no further stages"; the shell reports the
        // last real stage rather than inventing one.
      }
    })();

    return () => controller.abort();
  };
}

// ------------------------------------------------------------- presentation

const STAGE_LABELS: Readonly<Record<ScanStage, string>> = {
  QUEUED: 'Queued',
  SEARCHING_SCENE: 'Searching scene',
  READING_SAR: 'Reading SAR',
  PREPROCESSING: 'Preprocessing',
  MASKING: 'Land masking',
  FILTERING: 'Filtering',
  DETECTING: 'Detecting',
  EXTRACTING: 'Extracting',
  GEOLOCATING: 'Geolocating',
  LOADING_AIS: 'Loading AIS',
  ALIGNING: 'Aligning AIS',
  CORRELATING: 'Correlating',
  SCORING: 'Scoring',
  PERSISTING: 'Persisting',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
};

/** Display label for a stage. Unknown names pass through unchanged. */
export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage as ScanStage] ?? stage;
}

/**
 * Position of a stage in the fixed pipeline, e.g. "3 of 14".
 *
 * This is a stage COUNTER read off `SCAN_PIPELINE`, not a completion
 * estimate: stages do not take equal time, so this is never rendered as a
 * percentage or a progress bar.
 */
export function stagePosition(stage: ScanStage | null): { index: number; total: number } | null {
  if (!stage || stage === 'FAILED') return null;
  const index = SCAN_PIPELINE.indexOf(stage);
  if (index === -1) return null;
  return { index: index + 1, total: SCAN_PIPELINE.length };
}