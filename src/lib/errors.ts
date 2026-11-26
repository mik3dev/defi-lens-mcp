import { BaseError, HttpRequestError, TimeoutError } from 'viem';

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'CHAIN_NOT_CONFIGURED'
  | 'NOT_FOUND'
  | 'INDEXER_NOT_CONFIGURED'
  | 'SIMULATION_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.retryable = opts.retryable ?? false;
  }
}

const INTERNAL_MESSAGE = 'Internal error';

function isRetryableHttp(status: number | undefined): boolean {
  return status !== undefined && (status === 429 || status >= 500);
}

const MAX_UPSTREAM_MESSAGE = 200;

// Upstream text is untrusted: drop control characters and cap the length. Secret redaction happens in runTool.
function cleanUpstreamMessage(text: string): string {
  return text.replace(/\p{C}/gu, '').slice(0, MAX_UPSTREAM_MESSAGE);
}

function fromViem(e: BaseError): AppError {
  if (e.walk((err) => err instanceof TimeoutError) instanceof TimeoutError) {
    return new AppError('UPSTREAM_TIMEOUT', 'Upstream request timed out', {
      retryable: true,
      cause: e,
    });
  }
  const http = e.walk((err) => err instanceof HttpRequestError);
  if (http instanceof HttpRequestError) {
    return new AppError('UPSTREAM_ERROR', cleanUpstreamMessage(e.shortMessage), {
      retryable: isRetryableHttp(http.status),
      cause: e,
    });
  }
  return new AppError('UPSTREAM_ERROR', cleanUpstreamMessage(e.shortMessage), { cause: e });
}

/** Maps any thrown value to an AppError whose message is safe to return to clients. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof BaseError) return fromViem(e);
  return new AppError('INTERNAL', INTERNAL_MESSAGE, { cause: e });
}

/** Replaces every occurrence of each non-empty secret, longest secret first. */
export function redact(text: string, secrets: string[]): string {
  const ordered = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  return ordered.reduce((acc, s) => acc.split(s).join('[REDACTED]'), text);
}
