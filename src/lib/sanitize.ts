const MAX_SYMBOL_LENGTH = 32;
const FALLBACK_SYMBOL = 'UNKNOWN';

/** Strips control/format characters from on-chain token text, trims and truncates it. */
export function sanitizeSymbol(value: string): string {
  const cleaned = value.replace(/\p{C}/gu, '').trim().slice(0, MAX_SYMBOL_LENGTH);
  return cleaned === '' ? FALLBACK_SYMBOL : cleaned;
}
