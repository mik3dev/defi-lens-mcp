import { describe, expect, it } from 'vitest';
import { sqrtPriceX96ToPrices } from '../../../../src/protocols/uniswap/math.js';

const Q96 = 2n ** 96n;

describe('sqrtPriceX96ToPrices', () => {
  it('returns 1 / 1 at sqrtPrice = Q96 with equal decimals', () => {
    expect(sqrtPriceX96ToPrices(Q96, 18, 18)).toEqual({ price0In1: '1', price1In0: '1' });
  });

  it('squares the sqrt price', () => {
    expect(sqrtPriceX96ToPrices(2n * Q96, 18, 18)).toEqual({ price0In1: '4', price1In0: '0.25' });
  });

  it('adjusts for token decimals', () => {
    expect(sqrtPriceX96ToPrices(Q96, 6, 18).price0In1).toBe('0.000000000001');
    expect(sqrtPriceX96ToPrices(Q96, 6, 18).price1In0).toBe('1000000000000');
  });

  it('handles a realistic USDC/WETH price without precision loss', () => {
    // sqrtPriceX96 such that 1 WETH = 2500 USDC: raw price1/0 = 1e18 / 2500e6 = 4e8.
    const sqrt = 20_000n * Q96; // sqrt(4e8) = 20 000
    const prices = sqrtPriceX96ToPrices(sqrt, 6, 18);
    expect(prices.price0In1).toBe('0.0004');
    expect(prices.price1In0).toBe('2500');
  });

  it('handles the maximum sqrt price without overflow', () => {
    const max = 1461446703485210103287273052203988822378723970342n;
    const prices = sqrtPriceX96ToPrices(max, 18, 18);
    // floor(max² / 2¹⁹²), computed independently with plain BigInt arithmetic.
    expect(prices.price0In1).toBe('340256786836388094070642339899681172762');
    expect(prices.price1In0).toMatch(/^0\.0{38}\d+$/);
  });

  it('returns 0 / 0 for an uninitialized pool (sqrtPrice 0)', () => {
    expect(sqrtPriceX96ToPrices(0n, 6, 18)).toEqual({ price0In1: '0', price1In0: '0' });
  });
});
