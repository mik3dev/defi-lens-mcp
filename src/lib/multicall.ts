import {
  BaseError,
  CallExecutionError,
  HttpRequestError,
  RpcError,
  RpcRequestError,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
} from 'viem';
import { toAppError } from './errors.js';

/** One `allowFailure` multicall result; `result` and `error` are untrusted until checked. */
export interface Outcome {
  status: 'success' | 'failure';
  result?: unknown;
  error?: unknown;
}

type ErrorClass = abstract new (...args: never[]) => Error;

// Errors that only a failed aggregate3 request can carry. viem builds per-call failures locally
// from each call's returnData, so a single token's revert or bad data never contains these.
const REQUEST_FAILURES: ErrorClass[] = [
  CallExecutionError,
  HttpRequestError,
  TimeoutError,
  RpcRequestError,
  RpcError,
  WebSocketRequestError,
  SocketClosedError,
];

/**
 * Throws the upstream AppError when a failed outcome comes from a failed multicall request rather
 * than from its own call. viem marks every call of a failed chunk as a failure wrapped in
 * ContractFunctionExecutionError, and may add a ContractFunctionRevertedError in front when the RPC
 * answered with code 3 or -32603, so only the request-level errors in the cause chain decide.
 */
function assertNotTransportFailure(outcome: Outcome | undefined): void {
  if (outcome?.status !== 'failure' || !(outcome.error instanceof BaseError)) return;
  const { error } = outcome;
  if (error.walk((e) => REQUEST_FAILURES.some((c) => e instanceof c)) === null) return;
  throw toAppError(error);
}

export const isString = (v: unknown): v is string => typeof v === 'string';
export const isNumber = (v: unknown): v is number => typeof v === 'number';
export const isBigint = (v: unknown): v is bigint => typeof v === 'bigint';

/**
 * The result of a successful call that passes `guard`; undefined when that call itself failed
 * (revert, no code, undecodable data) or returned the wrong type. A failed multicall request
 * (network, HTTP, timeout or JSON-RPC error) throws an UPSTREAM_* AppError instead.
 */
export function success<T>(
  outcome: Outcome | undefined,
  guard: (v: unknown) => v is T,
): T | undefined {
  assertNotTransportFailure(outcome);
  return outcome?.status === 'success' && guard(outcome.result) ? outcome.result : undefined;
}
