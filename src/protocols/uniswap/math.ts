import { formatRatio } from '../../lib/format.js';

const Q192 = 2n ** 192n;

export interface PoolPrices {
  price0In1: string; // units of token1 per one token0
  price1In0: string; // units of token0 per one token1
}

/**
 * Spot prices of a Uniswap v3 pool from slot0's sqrtPriceX96, adjusted for token decimals:
 * price0In1 = sqrtPriceX96² / 2¹⁹² · 10^(decimals0 − decimals1). Exact bigint arithmetic, formatted
 * with formatRatio's default significant digits. An uninitialized pool (sqrtPriceX96 = 0) yields '0'.
 */
export function sqrtPriceX96ToPrices(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): PoolPrices {
  if (sqrtPriceX96 === 0n) return { price0In1: '0', price1In0: '0' };
  const numerator = sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(decimals0);
  const denominator = Q192 * 10n ** BigInt(decimals1);
  return {
    price0In1: formatRatio(numerator, denominator),
    price1In0: formatRatio(denominator, numerator),
  };
}
