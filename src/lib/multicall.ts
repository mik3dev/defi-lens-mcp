import {
  AbiDecodingDataSizeInvalidError,
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  RawContractError,
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

// The contract answered: it reverted, has no code, or returned data that does not decode.
const CONTRACT_FAILURES: ErrorClass[] = [
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  RawContractError,
  AbiDecodingZeroDataError,
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingDataSizeInvalidError,
];

// The request did not get a contract answer: network, HTTP, timeout or JSON-RPC failure.
const TRANSPORT_FAILURES: ErrorClass[] = [
  HttpRequestError,
  TimeoutError,
  RpcRequestError,
  RpcError,
  WebSocketRequestError,
  SocketClosedError,
];

function inCauseChain(error: BaseError, classes: ErrorClass[]): boolean {
  return error.walk((e) => classes.some((c) => e instanceof c)) !== null;
}

/**
 * Throws the upstream AppError when a failed outcome failed for a transport reason. viem wraps
 * both per-call reverts and whole-chunk request failures in ContractFunctionExecutionError, so the
 * cause chain decides: a known transport error and no contract-level error means an outage.
 */
function assertNotTransportFailure(outcome: Outcome | undefined): void {
  if (outcome?.status !== 'failure' || !(outcome.error instanceof BaseError)) return;
  const { error } = outcome;
  if (inCauseChain(error, CONTRACT_FAILURES) || !inCauseChain(error, TRANSPORT_FAILURES)) return;
  throw toAppError(error);
}

export const isString = (v: unknown): v is string => typeof v === 'string';
export const isNumber = (v: unknown): v is number => typeof v === 'number';
export const isBigint = (v: unknown): v is bigint => typeof v === 'bigint';

/**
 * The result of a successful call that passes `guard`; undefined for a contract-level failure or a
 * result of the wrong type. A transport-level failure throws an UPSTREAM_* AppError instead.
 */
export function success<T>(
  outcome: Outcome | undefined,
  guard: (v: unknown) => v is T,
): T | undefined {
  assertNotTransportFailure(outcome);
  return outcome?.status === 'success' && guard(outcome.result) ? outcome.result : undefined;
}
