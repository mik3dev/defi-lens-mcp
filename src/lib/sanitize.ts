const MAX_SYMBOL_LENGTH = 32;
/** Symbol used when a token has none, or none survives sanitizing. */
export const FALLBACK_SYMBOL = 'UNKNOWN';
// Control/format/unassigned/surrogate characters plus the line and paragraph separators.
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/gu;

/**
 * Strips control/format characters and line/paragraph separators from on-chain token text, trims
 * it and truncates it to MAX_SYMBOL_LENGTH code points (never splitting a surrogate pair).
 */
export function sanitizeSymbol(value: string): string {
  const cleaned = value.replace(UNSAFE, '').trim();
  const truncated = Array.from(cleaned).slice(0, MAX_SYMBOL_LENGTH).join('').trim();
  return truncated === '' ? FALLBACK_SYMBOL : truncated;
}
