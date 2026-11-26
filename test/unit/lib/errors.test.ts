import { BaseError, HttpRequestError, RpcRequestError, TimeoutError } from 'viem';
import { describe, expect, it } from 'vitest';
import { AppError, redact, toAppError } from '../../../src/lib/errors.js';

const body = { method: 'eth_call' };
const url = 'https://h/v2/KEY';

describe('redact', () => {
  it('replaces secrets', () => {
    expect(redact('fail https://h/v2/SECRETKEY', ['SECRETKEY'])).toBe(
      'fail https://h/v2/[REDACTED]',
    );
  });
  it('skips empty secrets', () => {
    expect(redact('abc', [''])).toBe('abc');
  });
  it('handles overlapping secrets longest first', () => {
    expect(redact('token=abcdef', ['abc', 'abcdef'])).toBe('token=[REDACTED]');
  });
  it('replaces every occurrence', () => {
    expect(redact('k k', ['k'])).toBe('[REDACTED] [REDACTED]');
  });
});

describe('toAppError', () => {
  it('passes AppError through', () => {
    const e = new AppError('NOT_FOUND', 'x');
    expect(toAppError(e)).toBe(e);
    expect(toAppError(e)).toMatchObject({ code: 'NOT_FOUND', retryable: false });
  });
  it('maps viem TimeoutError', () => {
    expect(toAppError(new TimeoutError({ body, url }))).toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      retryable: true,
    });
  });
  it('maps nested viem TimeoutError', () => {
    const wrapped = new BaseError('wrapper', { cause: new TimeoutError({ body, url }) });
    expect(toAppError(wrapped)).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });
  it('maps HTTP 429 as retryable', () => {
    expect(toAppError(new HttpRequestError({ url, status: 429 }))).toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });
  });
  it('maps HTTP 5xx as retryable', () => {
    expect(toAppError(new HttpRequestError({ url, status: 503 }))).toMatchObject({
      retryable: true,
    });
  });
  it('maps HTTP 4xx other than 429 as non-retryable', () => {
    expect(toAppError(new HttpRequestError({ url, status: 400 }))).toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: false,
    });
  });
  it('maps generic viem RPC error with shortMessage', () => {
    const e = new RpcRequestError({
      body,
      url,
      error: { code: -32000, message: 'execution reverted' },
    });
    expect(toAppError(e)).toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: false,
      message: e.shortMessage,
    });
  });
  it('hides unknown errors', () => {
    expect(toAppError(new Error('boom https://h/v2/KEY'))).toMatchObject({
      code: 'INTERNAL',
      retryable: false,
      message: 'Internal error',
    });
    expect(toAppError('str')).toMatchObject({ code: 'INTERNAL' });
  });
});
