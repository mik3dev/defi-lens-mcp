import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAIN_IDS, CHAINS, type ChainId, getClient } from '../../src/chains.js';
import type { AppContext } from '../../src/context.js';
import { peripheryFactoryAbi } from '../../src/protocols/uniswap/abis.js';
import { UNISWAP_V3 } from '../../src/protocols/uniswap/addresses.js';
import { getPoolState } from '../../src/tools/get-pool-state.js';
import { PINNED } from '../fixtures/blocks.js';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { testContext } from '../helpers/context.js';

const USDC_WETH_005: Address = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_ETHEREUM: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DEAD: Address = '0x000000000000000000000000000000000000dEaD';

/** USDC paired with the wrapped native token in a 0.05% pool on each chain. */
const USDC: Record<ChainId, Address> = {
  ethereum: USDC_ETHEREUM,
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  polygon: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e: the deepest WPOL/USDC 0.05% pool
};

/** Expected pool values derived independently with `cast` at PINNED.ethereum (see `commands`). */
interface ExpectedPoolState {
  block: string;
  pool: Address;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  reserve0: string;
  reserve1: string;
  commands: string[];
}

function expectedPoolState(): ExpectedPoolState {
  const url = new URL('../fixtures/pool-state.ethereum.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ExpectedPoolState;
}

describe.each(CHAIN_IDS)('uniswap v3 pool state on %s', (chain) => {
  const fixture = `pool-state.${chain}`;

  describe('at the pinned block', () => {
    let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;
    let ctx: AppContext;

    beforeAll(async () => {
      endpoint = await chainEndpoint(chain, fixture);
    }, 120_000);

    const freshContext = (): AppContext => {
      if (!endpoint) throw new Error(`No chain endpoint for ${chain}`);
      return testContext({ [chain]: endpoint.rpcUrl });
    };

    // A fresh context (and cache) per test: no test depends on reads another test cached.
    beforeEach(() => {
      ctx = freshContext();
    });

    afterAll(async () => {
      await endpoint?.stop();
    });

    it('positionManager and quoterV2 point at the configured factory', async () => {
      const { factory, positionManager, quoterV2 } = UNISWAP_V3[chain];
      const results = await getClient(ctx, chain).multicall({
        allowFailure: false,
        blockNumber: PINNED[chain],
        contracts: [positionManager, quoterV2].map((address) => ({
          address,
          abi: peripheryFactoryAbi,
          functionName: 'factory' as const,
        })),
      });
      expect(results).toEqual([factory, factory]);
    });

    it('the wrapped-native/USDC 0.05% pool resolves and has liquidity', async () => {
      const out = await getPoolState(ctx, {
        chain,
        tokenA: CHAINS[chain].wrappedNative,
        tokenB: USDC[chain],
        feeTier: 500,
      });
      expect(out.blockNumber).toBe(String(PINNED[chain]));
      expect(out.data.feeTier).toBe(500);
      expect(BigInt(out.data.liquidity)).toBeGreaterThan(0n);
    });

    // Registered only for ethereum, so other chains report no skipped tests.
    if (chain === 'ethereum') {
      describe('ethereum only', () => {
        it('reads USDC/WETH 0.05% by pool address with exact on-chain values', async () => {
          const expected = expectedPoolState();
          const out = await getPoolState(ctx, { chain, pool: USDC_WETH_005 });
          expect(out.blockNumber).toBe(String(PINNED.ethereum));
          expect(expected.block).toBe(out.blockNumber);
          expect(out.data.token0.symbol).toBe('USDC');
          expect(out.data.token1.symbol).toBe('WETH');
          expect(out.data.feeTier).toBe(500);
          expect(out.data.tickSpacing).toBe(10);
          expect(out.data.pool).toBe(expected.pool);
          expect(out.data.sqrtPriceX96).toBe(expected.sqrtPriceX96);
          expect(out.data.tick).toBe(expected.tick);
          expect(out.data.liquidity).toBe(expected.liquidity);
          expect(out.data.reserves.amount0.raw).toBe(expected.reserve0);
          expect(out.data.reserves.amount1.raw).toBe(expected.reserve1);
        });

        it('resolves the same pool from tokens and fee tier in either order', async () => {
          const forward = await getPoolState(freshContext(), {
            chain,
            tokenA: USDC_ETHEREUM,
            tokenB: WETH,
            feeTier: 500,
          });
          // Separate context: the reverse lookup must not be answered from the forward lookup's cache.
          const reverse = await getPoolState(freshContext(), {
            chain,
            tokenA: WETH,
            tokenB: USDC_ETHEREUM,
            feeTier: 500,
          });
          expect(forward.data.pool).toBe(USDC_WETH_005);
          expect(reverse.data.pool).toBe(USDC_WETH_005);
        });

        it('returns NOT_FOUND for a pair with no pool at fee tier 100', async () => {
          await expect(
            getPoolState(ctx, { chain, tokenA: WETH, tokenB: DEAD, feeTier: 100 }),
          ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        });

        it('returns INVALID_INPUT when the pool address is a token', async () => {
          await expect(getPoolState(ctx, { chain, pool: WETH })).rejects.toMatchObject({
            code: 'INVALID_INPUT',
          });
        });

        it('returns INVALID_INPUT for pool plus tokenA, or tokenA without feeTier', async () => {
          await expect(
            getPoolState(ctx, { chain, pool: USDC_WETH_005, tokenA: WETH }),
          ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
          await expect(
            getPoolState(ctx, { chain, tokenA: WETH, tokenB: USDC_ETHEREUM }),
          ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        });
      });
    }
  });
});
