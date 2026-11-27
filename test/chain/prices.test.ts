import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAIN_IDS, CHAINS, type ChainId, getClient, NATIVE_ADDRESS } from '../../src/chains.js';
import type { AppContext } from '../../src/context.js';
import { pinBlock } from '../../src/lib/blocks.js';
import { aggregatorV3Abi } from '../../src/protocols/chainlink/abi.js';
import { FEEDS } from '../../src/protocols/chainlink/feeds.js';
import { getUsdPrices } from '../../src/protocols/chainlink/prices.js';
import { readTokens } from '../../src/protocols/erc20/tokens.js';
import { PINNED } from '../fixtures/blocks.js';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { testContext } from '../helpers/context.js';

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const USDC: Record<ChainId, Address> = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

/** Symbol each configured token reads as on-chain at the pinned block (checked with `cast`). */
const TOKEN_SYMBOLS: Record<ChainId, Record<string, string>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
    '0x514910771af9ca656af840dff83e8264ecf986ca': 'LINK',
  },
  base: {
    '0x4200000000000000000000000000000000000006': 'WETH',
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 'USDT',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
    '0x0555e30da8f98308edb960aa94c0db47230d2b9c': 'WBTC',
    '0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196': 'LINK',
  },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC',
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USD₮0',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'DAI',
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'WBTC',
    '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': 'LINK',
  },
  polygon: {
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'WPOL',
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC',
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'USDC',
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'USDT0',
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 'DAI',
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 'WBTC',
    '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39': 'LINK',
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': 'WETH',
  },
};

/** ETH / USD latestRoundData at PINNED.ethereum, derived independently with `cast` (see `commands`). */
interface ExpectedPrice {
  block: string;
  feed: Address;
  answer: string;
  usd: string;
  commands: string[];
}

function expectedPrice(): ExpectedPrice {
  const url = new URL('../fixtures/prices.ethereum.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ExpectedPrice;
}

describe.each(CHAIN_IDS)('chainlink prices on %s', (chain) => {
  const fixture = `prices.${chain}`;

  describe('at the pinned block', () => {
    let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;

    beforeAll(async () => {
      endpoint = await chainEndpoint(chain, fixture);
    }, 120_000);

    afterAll(async () => {
      await endpoint?.stop();
    });

    // A fresh context per test, so no test is served from another test's cache.
    const fresh = (): AppContext => {
      if (!endpoint) throw new Error('endpoint not started');
      return testContext({ [chain]: endpoint.rpcUrl });
    };

    it('every configured feed reports the expected description', async () => {
      const c = fresh();
      const block = await pinBlock(c, chain);
      expect(block.number).toBe(PINNED[chain]);
      const configs = Object.values(FEEDS[chain]);
      const descriptions = await getClient(c, chain).multicall({
        allowFailure: false,
        blockNumber: block.number,
        contracts: configs.map((config) => ({
          address: config.feed,
          abi: aggregatorV3Abi,
          functionName: 'description' as const,
        })),
      });
      expect(descriptions).toEqual(configs.map((config) => config.description));
    });

    it('every configured token reads as its expected symbol', async () => {
      const c = fresh();
      const tokens = Object.keys(FEEDS[chain]).filter(
        (key) => key !== NATIVE_ADDRESS.toLowerCase(),
      );
      expect(tokens.sort()).toEqual(Object.keys(TOKEN_SYMBOLS[chain]).sort());
      const infos = await readTokens(c, chain, tokens as Address[], await pinBlock(c, chain));
      for (const token of tokens) {
        expect(infos.get(token as Address)?.symbol).toBe(TOKEN_SYMBOLS[chain][token]);
      }
    });

    it('prices native and wrapped native identically', async () => {
      const c = fresh();
      const wrapped = CHAINS[chain].wrappedNative;
      const prices = await getUsdPrices(
        c,
        chain,
        [NATIVE_ADDRESS, wrapped],
        await pinBlock(c, chain),
      );
      const native = prices.get(NATIVE_ADDRESS);
      expect(native?.usd).toBeGreaterThan(0);
      expect(prices.get(wrapped)).toEqual(native);
    });

    it('returns null for a token with no feed', async () => {
      const c = fresh();
      const prices = await getUsdPrices(c, chain, [MULTICALL3], await pinBlock(c, chain));
      expect(prices.get(MULTICALL3)).toBeNull();
    });

    it('prices a stablecoin near 1', async () => {
      const c = fresh();
      const prices = await getUsdPrices(c, chain, [USDC[chain]], await pinBlock(c, chain));
      const usd = prices.get(USDC[chain])?.usd;
      expect(usd).toBeGreaterThan(0.98);
      expect(usd).toBeLessThan(1.02);
    });

    // A plain conditional, not runIf: the other chains must not report skipped tests.
    if (chain === 'ethereum')
      describe('ethereum only', () => {
        it('matches the feed answer at the pinned block', async () => {
          const c = fresh();
          const expected = expectedPrice();
          const block = await pinBlock(c, chain);
          expect(expected.block).toBe(block.number.toString());
          expect(FEEDS.ethereum[NATIVE_ADDRESS.toLowerCase()]?.feed).toBe(expected.feed);
          const prices = await getUsdPrices(c, chain, [NATIVE_ADDRESS], block);
          expect(prices.get(NATIVE_ADDRESS)).toEqual({ usd: Number(expected.usd), stale: false });
        });
      });
  });
});
