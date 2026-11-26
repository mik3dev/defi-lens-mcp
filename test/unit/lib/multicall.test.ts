import { describe, expect, it } from 'vitest';
import { isBigint, isNumber, isString, success } from '../../../src/lib/multicall.js';

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
