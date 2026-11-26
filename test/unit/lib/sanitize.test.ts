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
  it('truncates by code points without splitting a surrogate pair', () => {
    const emoji = '\u{1F600}';
    expect(sanitizeSymbol(`${'A'.repeat(31)}${emoji}B`)).toBe(`${'A'.repeat(31)}${emoji}`);
    const result = sanitizeSymbol(emoji.repeat(40));
    expect(Array.from(result)).toHaveLength(32);
    expect(result).toBe(emoji.repeat(32));
  });
  it('strips line and paragraph separators', () => {
    expect(sanitizeSymbol('US\u2028D\u2029C')).toBe('USDC');
  });
  it('falls back to UNKNOWN', () => {
    expect(sanitizeSymbol('')).toBe('UNKNOWN');
    expect(sanitizeSymbol('\u0000\u0007')).toBe('UNKNOWN');
  });
});
