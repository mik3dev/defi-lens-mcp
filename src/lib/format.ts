export interface Amount {
  raw: string;
  formatted: string;
  decimals: number;
}

const DEFAULT_SIGNIFICANT = 12;

function trimZeros(fraction: string): string {
  return fraction.replace(/0+$/, '');
}

export function toAmount(raw: bigint, decimals: number): Amount {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString();
  const fraction = trimZeros((abs % base).toString().padStart(decimals, '0'));
  const body = fraction === '' ? whole : `${whole}.${fraction}`;
  return { raw: raw.toString(), formatted: negative && abs !== 0n ? `-${body}` : body, decimals };
}

/**
 * Decimal string of numerator/denominator keeping `significant` significant digits.
 * Digits beyond that are truncated (rounded toward zero); no trailing zeros, no exponent.
 */
export function formatRatio(
  numerator: bigint,
  denominator: bigint,
  significant = DEFAULT_SIGNIFICANT,
): string {
  if (denominator === 0n) throw new RangeError('formatRatio: zero denominator');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  if (n === 0n) return '0';

  const whole = (n / d).toString();
  let remainder = n % d;
  let budget = whole === '0' ? significant : Math.max(0, significant - whole.length);
  let fraction = '';
  let started = whole !== '0';
  while (remainder !== 0n && budget > 0) {
    remainder *= 10n;
    const digit = remainder / d;
    remainder %= d;
    fraction += digit.toString();
    if (digit !== 0n) started = true;
    if (started) budget -= 1;
  }
  const trimmed = trimZeros(fraction);
  const body = trimmed === '' ? whole : `${whole}.${trimmed}`;
  return negative ? `-${body}` : body;
}

export function usdValue(raw: bigint, decimals: number, price: number | null): number | null {
  if (price === null) return null;
  return Number(toAmount(raw, decimals).formatted) * price;
}
