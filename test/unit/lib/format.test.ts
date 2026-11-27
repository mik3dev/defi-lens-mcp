import { describe, expect, it } from 'vitest';
import { formatRatio, toAmount, usdValue } from '../../../src/lib/format.js';

describe('toAmount', () => {
  it('formats with trimmed zeros', () => {
    expect(toAmount(1500000n, 6)).toEqual({ raw: '1500000', formatted: '1.5', decimals: 6 });
  });
  it('formats zero', () => {
    expect(toAmount(0n, 18).formatted).toBe('0');
  });
  it('formats whole numbers and zero decimals', () => {
    expect(toAmount(3000000n, 6).formatted).toBe('3');
    expect(toAmount(42n, 0).formatted).toBe('42');
  });
  it('formats sub-unit and negative values', () => {
    expect(toAmount(1n, 18).formatted).toBe('0.000000000000000001');
    expect(toAmount(-1500000n, 6).formatted).toBe('-1.5');
  });
});

describe('formatRatio', () => {
  it('truncates to significant digits', () => {
    expect(formatRatio(1n, 3n, 6)).toBe('0.333333');
    expect(formatRatio(2n, 3n, 6)).toBe('0.666666');
    expect(formatRatio(10n, 3n, 6)).toBe('3.33333');
  });
  it('formats integers without trailing zeros', () => {
    expect(formatRatio(4n, 1n)).toBe('4');
    expect(formatRatio(1n, 4n)).toBe('0.25');
  });
  it('uses plain notation for tiny values', () => {
    expect(formatRatio(1n, 10n ** 12n)).toBe('0.000000000001');
  });
  it('handles large integer parts, zero and negatives', () => {
    expect(formatRatio(123456789n, 1n, 3)).toBe('123456789');
    expect(formatRatio(0n, 5n)).toBe('0');
    expect(formatRatio(-1n, 3n, 3)).toBe('-0.333');
  });
  it('rejects a zero denominator', () => {
    expect(() => formatRatio(1n, 0n)).toThrow(RangeError);
  });
});

describe('usdValue', () => {
  it('multiplies amount by price', () => {
    expect(usdValue(2_500000n, 6, 2)).toBe(5);
  });
  it('returns null without price', () => {
    expect(usdValue(1n, 6, null)).toBeNull();
  });
  it('returns null for a NaN, negative or non-finite price', () => {
    expect(usdValue(1_000000n, 6, Number.NaN)).toBeNull();
    expect(usdValue(1_000000n, 6, -1)).toBeNull();
    expect(usdValue(1_000000n, 6, Number.POSITIVE_INFINITY)).toBeNull();
    expect(usdValue(1_000000n, 6, Number.NEGATIVE_INFINITY)).toBeNull();
  });
  it('accepts a zero price', () => {
    expect(usdValue(1_000000n, 6, 0)).toBe(0);
  });
});
