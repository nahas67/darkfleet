/**
 * SSE stage stream.
 *
 * Hand-rolled rather than `EventSource`, for two reasons the backend forces:
 *
 *  1. It emits ``:`` comment keep-alives before the first stage event.
 *     `EventSource` swallows those silently, which is fine, but it also cannot
 *     be aborted deterministically on unmount, and a leaked stage stream holds a
 *     job open.
 *  2. The stream must be torn down the instant a terminal stage arrives. A
 *     connection left open against a completed scan is a resource leak that
 *     survives navigation.
 *
 * This is a transcription of the frame grammar, not a reimplementation of the
 * backend's protocol. Stage names are never interpreted here -- an unknown stage
 * is passed through verbatim so a backend that gains a stage does not break this
 * decoder.
 */

export type SseFrame = {
  event: string;
  data: string;
};

export type StageEvent = {
  stage: string;
  timestamp: string;
  detail: string;
  terminal: boolean;
};

/** Parse one SSE block. Exported for tests; the grammar is the contract. */
export function parseSseBlock(block: string): SseFrame | null {
  const lines = block.split(/\r?\n/);
  let event = 'message';
  const data: string[] = [];

  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue; // keep-alive / comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

export type StageStreamHandlers = {
  onStage: (event: StageEvent) => void;
  onState: (state: 'CONNECTING' | 'STREAMING' | 'CLOSED' | 'ERROR') => void;
  /** Called when the stream ends without a terminal stage. */
  onIncomplete?: (reason: string) => void;
};

export type StageStreamHandle = {
  close: () => void;
};

const TERMINAL_STAGES = new Set(['COMPLETE', 'FAILED']);

/**
 * Subscribe to a scan's stage stream.
 *
 * Returns a handle whose `close()` aborts the underlying fetch. A stream failure
 * is reported through `onState('ERROR')` and nothing else: no synthetic stage,
 * no fabricated completion.
 */
export function openStageStream(scanId: string, handlers: StageStreamHandlers): StageStreamHandle {
  const controller = new AbortController();
  let finished = false;

  const close = () => {
    if (finished) return;
    finished = true;
    controller.abort();
  };

  void (async () => {
    handlers.onState('CONNECTING');
    let response: Response;
    try {
      response = await fetch(`/api/scans/${scanId}/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
    } catch {
      if (!finished) handlers.onState('ERROR');
      return;
    }

    if (!response.ok || !response.body) {
      // Not fatal: the job's final state is still readable from the state
      // endpoint, so the stream is a convenience rather than the source of truth.
      handlers.onState(finished ? 'CLOSED' : 'ERROR');
      return;
    }

    handlers.onState('STREAMING');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; a partial frame stays buffered.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = parseSseBlock(block.replace(/\r\n/g, '\n'));
          if (frame && frame.event === 'stage') {
            try {
              const parsed = JSON.parse(frame.data) as StageEvent;
              handlers.onStage(parsed);
              if (TERMINAL_STAGES.has(parsed.stage)) {
                // The job is over. Release the connection now rather than holding
                // it until the browser times out.
                close();
                handlers.onState('CLOSED');
                return;
              }
            } catch {
              // A frame we cannot parse is not a stage we should invent.
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      if (!finished) {
        handlers.onState('CLOSED');
        handlers.onIncomplete?.('The stage stream ended before the scan reached a terminal stage.');
      }
    } catch {
      if (!finished) {
        handlers.onState('ERROR');
        handlers.onIncomplete?.('The stage stream failed. The job state is still authoritative.');
      }
    } finally {
      close();
    }
  })();

  return { close };
}