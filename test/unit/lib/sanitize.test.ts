import { describe, expect, it } from 'vitest';
import { sanitizeSymbol } from '../../../src/lib/sanitize.js';

describe('sanitizeSymbol', () => {
  it('strips control characters', () => {
    expect(sanitizeSymbol('US\u0000DC\n')).toBe('USDC');
  });
  it('trims', () => {
    expect(sanitizeSymbol('  WETH ')).toBe('WETH');
  });
  it('truncates to 32', () => {
    expect(sanitizeSymbol('A'.repeat(40))).toHaveLength(32);
  });
  it('falls back to UNKNOWN', () => {
    expect(sanitizeSymbol('')).toBe('UNKNOWN');
    expect(sanitizeSymbol('\u0000\u0007')).toBe('UNKNOWN');
  });
});
