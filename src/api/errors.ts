/**
 * API errors.
 *
 * Three ideas, deliberately kept apart:
 *
 *   ApiError          -- the server answered, and the answer was a refusal.
 *   CoverageError     -- the source cannot speak to this request at all. NOT a
 *                        zero result. See `state/coverage.ts`.
 *   ContractViolation -- the payload did not match the generated contract.
 *
 * Collapsing any two of these into a generic "failed" is how an unobserved
 * region comes to read as an empty one, so the types exist to keep them apart
 * all the way to the panel that renders them.
 */

export type ApiErrorCode =
  | 'NETWORK_ERROR'
  | 'EMPTY_RESPONSE'
  | 'UNEXPECTED_STATUS'
  | 'SCAN_NOT_READY'
  | 'UNKNOWN_SCAN'
  | 'UNKNOWN_TARGET'
  | 'UNKNOWN_RASTER_LAYER'
  | 'RASTER_NOT_AVAILABLE'
  | 'RASTER_LAYER_ABSENT'
  | 'INVALID_MMSI'
  | 'REAL_DATA_UNAVAILABLE'
  | string;

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly detail: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** True when retrying could plausibly produce a different answer. */
  get retryable(): boolean {
    return this.status >= 500 || this.code === 'NETWORK_ERROR';
  }
}

export class ContractViolation extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ContractViolation';
    this.path = path;
  }
}

/**
 * A specific, truthful sentence per backend error code.
 *
 * The retired UI had this mapping inline in one panel and absent everywhere else,
 * so the same failure read three different ways. Centralised here.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  SCAN_NOT_READY: 'The scan has not finished. Its targets appear at COMPLETE.',
  UNKNOWN_SCAN: 'No such scan. It may never have run, or its record was not kept.',
  UNKNOWN_TARGET: 'No such target in the persisted scan history.',
  UNKNOWN_RASTER_LAYER: 'That raster layer does not exist. See the layer list for what does.',
  RASTER_NOT_AVAILABLE:
    'This scan did not persist its raster artifacts, so no image can be rendered. Re-run the scan to produce them.',
  RASTER_LAYER_ABSENT: 'This scan stored no image for that layer.',
  INVALID_MMSI: 'That is not a 9-digit MMSI, so no track can exist for it.',
  REAL_DATA_UNAVAILABLE: 'The provider could not serve real data for this request.',
};

export function explain(error: unknown): string {
  if (error instanceof ApiError) {
    return MESSAGES[error.code] ?? error.message;
  }
  if (error instanceof ContractViolation) {
    return `The backend response did not match the generated contract at ${error.path}. ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return 'The request could not be completed.';
}

/** Reads a backend error body without assuming its shape. */
function parseErrorBody(status: number, body: unknown): ApiError {
  const record = (body ?? {}) as Record<string, unknown>;
  const code = typeof record.error === 'string' ? record.error : `HTTP_${status}`;
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : `The server responded ${status}.`;
  return new ApiError(status, code, message, record.detail ?? record);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The single HTTP entry point.
 *
 * Every network call in the product goes through here so that error shape,
 * base URL and credential handling exist exactly once.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    // An abort is NOT a network failure. Reporting it as one is a lie that the
    // operator sees: switching targets quickly aborts the superseded requests,
    // and every one of them would otherwise surface as "the backend could not be
    // reached" beside a perfectly healthy dossier. Cancellation is the expected
    // path here, not an error worth showing.
    if (isAbort(cause)) throw cause;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'The backend could not be reached. This is a connection failure, not an empty result.',
      cause,
    );
  }

  const body = await readBody(response);
  if (!response.ok) throw parseErrorBody(response.status, body);
  if (body === null || body === '') {
    throw new ApiError(response.status, 'EMPTY_RESPONSE', 'The server returned no body.');
  }
  return body as T;
}

/** Was this rejection a cancellation rather than a failure? */
export function isAbort(cause: unknown): boolean {
  if (cause instanceof DOMException && cause.name === 'AbortError') return true;
  return cause instanceof Error && cause.name === 'AbortError';
}

export const api = {
  /**
   * `signal` is accepted on GET as well as POST.
   *
   * Every dossier tab loads independently and the operator changes targets
   * quickly, so a superseded GET is the normal case rather than the exception.
   * Without a signal those requests cannot be cancelled at all: they run to
   * completion and then race the newer one to the screen. Aborting is still not
   * sufficient alone -- a response already in flight when the abort fires can
   * still resolve -- so callers pair this with a generation token. See
   * `useOwnedRequest`.
   */
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  /**
   * `signal` is threaded through so a superseded request can be cancelled.
   *
   * Cancellation matters for the coordinate probe specifically: click A then
   * click B, and if A's response lands second it would overwrite B's coordinate
   * on screen next to B's marker -- a confident statement about the wrong water.
   * Aborting is not sufficient on its own (see `usePixelProbe`'s generation
   * counter), and ignoring is not sufficient on its own either.
   */
  post: <T>(path: string, payload: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(payload), signal }),
};