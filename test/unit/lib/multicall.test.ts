import {
  AbiDecodingDataSizeTooSmallError,
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
  HttpRequestError,
  RawContractError,
  RpcRequestError,
  TimeoutError,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/lib/errors.js';
import { isBigint, isNumber, isString, type Outcome, success } from '../../../src/lib/multicall.js';

const URL = 'http://127.0.0.1:1';
const CALL = { abi: erc20Abi, functionName: 'decimals' } as const;

/** How viem reports a per-call or a whole-chunk failure in an allowFailure multicall. */
const wrapped = (cause: Error): Error => new ContractFunctionExecutionError(cause as never, CALL);
const chunk = (cause: Error): Error => wrapped(new CallExecutionError(cause as never, {}));
const failure = (error: unknown): Outcome => ({ status: 'failure', error });

function thrown(outcome: Outcome): AppError {
  try {
    success(outcome, isNumber);
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected success() to throw');
}

describe('multicall result guards', () => {
  it('narrow by runtime type', () => {
    expect(isString('a')).toBe(true);
    expect(isString(1)).toBe(false);
    expect(isNumber(1)).toBe(true);
    expect(isNumber(1n)).toBe(false);
    expect(isBigint(1n)).toBe(true);
    expect(isBigint('1')).toBe(false);
  });
});

describe('success', () => {
  it('returns the result of a successful call that passes the guard', () => {
    expect(success({ status: 'success', result: 5n }, isBigint)).toBe(5n);
  });
  it('returns undefined for a failed call', () => {
    expect(success({ status: 'failure', result: 5n }, isBigint)).toBeUndefined();
  });
  it('returns undefined when the result fails the guard', () => {
    expect(success({ status: 'success', result: 'x' }, isBigint)).toBeUndefined();
  });
  it('returns undefined for a missing outcome', () => {
    expect(success(undefined, isBigint)).toBeUndefined();
  });
});

describe('success with a transport-level failure', () => {
  it('throws UPSTREAM_TIMEOUT for a timed-out chunk', () => {
    const error = thrown(failure(chunk(new TimeoutError({ body: {}, url: URL }))));
    expect(error).toMatchObject({ code: 'UPSTREAM_TIMEOUT', retryable: true });
  });

  it('throws a retryable UPSTREAM_ERROR for an HTTP failure', () => {
    const error = thrown(failure(chunk(new HttpRequestError({ url: URL, status: 503 }))));
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
  });

  it('throws UPSTREAM_ERROR for a JSON-RPC error', () => {
    const rpc = new RpcRequestError({
      body: {},
      error: { code: -32602, message: 'bad' },
      url: URL,
    });
    expect(thrown(failure(chunk(rpc)))).toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('throws for an unwrapped transport error', () => {
    const error = thrown(failure(new HttpRequestError({ url: URL })));
    expect(error.code).toBe('UPSTREAM_ERROR');
  });
});

describe('success with a contract-level failure', () => {
  const reverted = new ContractFunctionRevertedError({ ...CALL, message: 'execution reverted' });
  const revertedOverRpc = new ContractFunctionRevertedError({
    ...CALL,
    message: 'execution reverted',
    cause: new RpcRequestError({ body: {}, error: { code: 3, message: 'reverted' }, url: URL }),
  });
  const cases: [string, Error][] = [
    ['a revert', wrapped(reverted)],
    ['a revert reported by the RPC', chunk(revertedOverRpc)],
    ['a raw failed call', wrapped(new RawContractError({ data: '0x' }))],
    ['empty return data', wrapped(new ContractFunctionZeroDataError({ functionName: 'decimals' }))],
    [
      'undecodable return data',
      wrapped(new AbiDecodingDataSizeTooSmallError({ data: '0x01', params: [], size: 1 })),
    ],
    ['a non-viem error', new Error('boom')],
  ];

  it.each(cases)('returns undefined for %s', (_name, error) => {
    expect(success(failure(error), isNumber)).toBeUndefined();
  });
});
