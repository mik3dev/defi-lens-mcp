import type { Address } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { type AppContext, requestScope } from '../../../../src/context.js';
import type { PinnedBlock } from '../../../../src/lib/blocks.js';
import { readPoolState, resolvePool } from '../../../../src/protocols/uniswap/pool.js';
import { testContext } from '../../../helpers/context.js';
import { type FakeChain, type FakeContract, startFakeChain } from '../../../helpers/fake-chain.js';
import {
  FACTORY,
  fakeFactory,
  fakePool,
  fakeTokens,
  POOL,
  Q96,
  USDC,
  WETH,
} from '../../../helpers/uniswap-fake.js';

const BLOCK: PinnedBlock = { number: 21_000_000n, timestamp: 1_700_000_000n };
const OTHER: Address = '0x1111111111111111111111111111111111111111';
const NO_CODE: Address = '0x000000000000000000000000000000000000dEaD';

let chain: FakeChain | undefined;
afterEach(async () => {
  await chain?.stop();
  chain = undefined;
});

async function setup(contracts: Record<Address, FakeContract>): Promise<AppContext> {
  chain = await startFakeChain({ blockNumber: BLOCK.number, contracts });
  return testContext({ ethereum: chain.rpcUrl });
}

async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const store = { upstreamRequests: 0 };
  const value = await requestScope.run(store, fn);
  return [value, store.upstreamRequests];
}

describe('readPoolState', () => {
  it('reads slot0, liquidity, immutables, tokens and reserves at the pinned block', async () => {
    const ctx = await setup({ [POOL]: fakePool(), ...fakeTokens(5_000_000n, 7n * 10n ** 18n) });
    const [state, requests] = await counted(() => readPoolState(ctx, 'ethereum', POOL, BLOCK));
    expect(state).toEqual({
      pool: POOL,
      token0: { address: USDC, symbol: 'USDC', decimals: 6 },
      token1: { address: WETH, symbol: 'WETH', decimals: 18 },
      feeTier: 500,
      tickSpacing: 10,
      sqrtPriceX96: 20_000n * Q96,
      tick: 198_079,
      liquidity: 123_456_789n,
      reserve0: 5_000_000n,
      reserve1: 7n * 10n ** 18n,
    });
    expect(requests).toBe(3); // pool multicall, token metadata, balances
    expect(new Set(chain?.callBlocks)).toEqual(new Set([BLOCK.number]));
  });

  it('caches pool immutables and token metadata forever', async () => {
    const ctx = await setup({ [POOL]: fakePool(), ...fakeTokens(1n, 2n) });
    await readPoolState(ctx, 'ethereum', POOL, BLOCK);
    const [state, requests] = await counted(() => readPoolState(ctx, 'ethereum', POOL, BLOCK));
    expect(state.feeTier).toBe(500);
    expect(state.reserve1).toBe(2n);
    expect(requests).toBe(2); // slot0 + liquidity, balances
  });

  it('accepts a lowercase pool address and returns it checksummed', async () => {
    const ctx = await setup({ [POOL]: fakePool(), ...fakeTokens(1n, 2n) });
    const lower = POOL.toLowerCase() as Address;
    expect((await readPoolState(ctx, 'ethereum', lower, BLOCK)).pool).toBe(POOL);
  });

  it('rejects a pool deployed by another factory as INVALID_INPUT', async () => {
    const ctx = await setup({ [POOL]: fakePool({ factory: OTHER }), ...fakeTokens(1n, 2n) });
    await expect(readPoolState(ctx, 'ethereum', POOL, BLOCK)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('not a Uniswap v3 pool'),
    });
  });

  it('rejects an ERC-20 token address as INVALID_INPUT', async () => {
    const ctx = await setup(fakeTokens(1n, 2n));
    await expect(readPoolState(ctx, 'ethereum', WETH, BLOCK)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects an address with no code as INVALID_INPUT', async () => {
    const ctx = await setup({});
    await expect(readPoolState(ctx, 'ethereum', NO_CODE, BLOCK)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('fails with NOT_FOUND when a pool token is not a readable ERC-20', async () => {
    const ctx = await setup({ [POOL]: fakePool({ token1: NO_CODE }), ...fakeTokens(1n, 2n) });
    await expect(readPoolState(ctx, 'ethereum', POOL, BLOCK)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('fails with UPSTREAM_ERROR when a reserve cannot be read', async () => {
    const ctx = await setup({
      [POOL]: fakePool(),
      [USDC]: { symbol: 'USDC', decimals: 6 }, // balanceOf reverts
      [WETH]: { symbol: 'WETH', decimals: 18, balances: { [POOL]: 1n } },
    });
    await expect(readPoolState(ctx, 'ethereum', POOL, BLOCK)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });
});

describe('resolvePool', () => {
  it('returns a given pool address checksummed without an RPC call', async () => {
    const ctx = testContext({});
    const lower = POOL.toLowerCase() as Address;
    const [pool, requests] = await counted(() =>
      resolvePool(ctx, 'ethereum', { pool: lower }, BLOCK),
    );
    expect(pool).toBe(POOL);
    expect(requests).toBe(0);
  });

  it('resolves tokens and fee tier through the factory and caches the result', async () => {
    const ctx = await setup({ [FACTORY]: fakeFactory(POOL) });
    const sel = { tokenA: WETH, tokenB: USDC, feeTier: 500 };
    const [pool, first] = await counted(() => resolvePool(ctx, 'ethereum', sel, BLOCK));
    expect(pool).toBe(POOL);
    expect(first).toBe(1);
    const swapped = { tokenA: USDC, tokenB: WETH, feeTier: 500 };
    const [again, second] = await counted(() => resolvePool(ctx, 'ethereum', swapped, BLOCK));
    expect(again).toBe(POOL);
    expect(second).toBe(0);
  });

  it('maps the zero address to NOT_FOUND', async () => {
    const ctx = await setup({ [FACTORY]: fakeFactory() });
    await expect(
      resolvePool(ctx, 'ethereum', { tokenA: WETH, tokenB: USDC, feeTier: 100 }, BLOCK),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires tokenA, tokenB and feeTier when no pool is given', async () => {
    const ctx = testContext({});
    await expect(
      resolvePool(ctx, 'ethereum', { tokenA: WETH, tokenB: USDC }, BLOCK),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
