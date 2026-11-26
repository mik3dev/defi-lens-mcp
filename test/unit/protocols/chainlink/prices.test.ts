import { type Address, encodeAbiParameters, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAINS, NATIVE_ADDRESS } from '../../../../src/chains.js';
import { requestScope } from '../../../../src/context.js';
import type { PinnedBlock } from '../../../../src/lib/blocks.js';
import { FEEDS } from '../../../../src/protocols/chainlink/feeds.js';
import {
  getUsdPrices,
  type Price,
  STALE_GRACE_SECONDS,
  staleWarnings,
  toPrice,
} from '../../../../src/protocols/chainlink/prices.js';
import { testContext } from '../../../helpers/context.js';
import { type FakeChain, type FakeContract, startFakeChain } from '../../../helpers/fake-chain.js';

const BLOCK: PinnedBlock = { number: 50_000_000n, timestamp: 1_700_000_000n };
const NEXT: PinnedBlock = { number: 50_000_001n, timestamp: 1_700_000_012n };
const WETH = CHAINS.ethereum.wrappedNative;
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI: Address = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const NO_FEED: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const LATEST_ROUND_DATA: Hex = '0xfeaf968c';

function feedOf(token: Address): Address {
  const config = FEEDS.ethereum[token.toLowerCase()];
  if (!config) throw new Error(`no feed for ${token}`);
  return config.feed;
}

function roundData(answer: bigint, updatedAt: bigint): Hex {
  return encodeAbiParameters(
    [
      { type: 'uint80' },
      { type: 'int256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint80' },
    ],
    [1n, answer, updatedAt, updatedAt, 1n],
  );
}

/** A fake feed; `decimals: null` makes decimals() revert. */
function feed(answer: bigint, updatedAt: bigint, decimals: number | null = 8): FakeContract {
  const raw = { [LATEST_ROUND_DATA]: roundData(answer, updatedAt) };
  return decimals === null ? { raw } : { decimals, raw };
}

let chain: FakeChain | undefined;
afterEach(async () => {
  await chain?.stop();
  chain = undefined;
});

async function setup(contracts: Record<Address, FakeContract>) {
  await chain?.stop();
  chain = await startFakeChain({ blockNumber: BLOCK.number, contracts });
  return chain.rpcUrl;
}

async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const store = { upstreamRequests: 0 };
  const value = await requestScope.run(store, fn);
  return [value, store.upstreamRequests];
}

describe('toPrice', () => {
  it('scales the answer by the feed decimals and flags staleness past heartbeat + grace', () => {
    expect(toPrice(2000_00000000n, 8, 1000n, 1100n, 3600)).toEqual({ usd: 2000, stale: false });
    expect(toPrice(2000_00000000n, 8, 1000n, 1000n + 3600n + 600n, 3600)).toEqual({
      usd: 2000,
      stale: false,
    }); // at the edge
    expect(toPrice(2000_00000000n, 8, 1000n, 1000n + 3600n + 601n, 3600)).toEqual({
      usd: 2000,
      stale: true,
    });
    expect(toPrice(0n, 8, 1000n, 1100n, 3600)).toBeNull();
    expect(toPrice(-1n, 8, 1000n, 1100n, 3600)).toBeNull();
    expect(toPrice(1_000000000000000000n, 18, 1000n, 1100n, 3600)?.usd).toBe(1);
  });

  it('uses a 600 second grace period', () => {
    expect(STALE_GRACE_SECONDS).toBe(600);
  });
});

describe('staleWarnings', () => {
  it('warns once per stale price by symbol, falling back to the address', () => {
    const fresh: Price = { usd: 1, stale: false };
    const stale: Price = { usd: 1, stale: true };
    const prices = new Map<Address, Price | null>([
      [NATIVE_ADDRESS, stale],
      [WETH, stale],
      [USDC, fresh],
      [DAI, null],
      [NO_FEED, stale],
    ]);
    const symbols = new Map<Address, string>([
      [NATIVE_ADDRESS, 'ETH'],
      [WETH, 'ETH'],
      [USDC, 'USDC'],
    ]);
    expect(staleWarnings(prices, symbols)).toEqual([
      'price feed stale: ETH',
      `price feed stale: ${NO_FEED}`,
    ]);
  });
});

describe('getUsdPrices', () => {
  it('prices native and wrapped native from one feed with one multicall at the pinned block', async () => {
    const url = await setup({ [feedOf(WETH)]: feed(2000_00000000n, BLOCK.timestamp - 10n) });
    const ctx = testContext({ ethereum: url });
    const [prices, requests] = await counted(() =>
      getUsdPrices(ctx, 'ethereum', [NATIVE_ADDRESS, WETH], BLOCK),
    );
    expect(prices.get(NATIVE_ADDRESS)).toEqual({ usd: 2000, stale: false });
    expect(prices.get(WETH)).toEqual({ usd: 2000, stale: false });
    expect(requests).toBe(1);
    expect(chain?.callBlocks).toEqual([BLOCK.number]);
  });

  it('returns null for a token with no feed without an RPC call', async () => {
    const ctx = testContext({ ethereum: await setup({}) });
    const [prices, requests] = await counted(() => getUsdPrices(ctx, 'ethereum', [NO_FEED], BLOCK));
    expect(prices.get(NO_FEED)).toBeNull();
    expect(requests).toBe(0);
  });

  it('measures staleness against the block timestamp', async () => {
    const heartbeat = BigInt(FEEDS.ethereum[USDC.toLowerCase()]?.heartbeatSeconds ?? 0);
    const updatedAt = BLOCK.timestamp - heartbeat - BigInt(STALE_GRACE_SECONDS) - 1n;
    const ctx = testContext({
      ethereum: await setup({ [feedOf(USDC)]: feed(1_0000_0000n, updatedAt) }),
    });
    const prices = await getUsdPrices(ctx, 'ethereum', [USDC], BLOCK);
    expect(prices.get(USDC)).toEqual({ usd: 1, stale: true });
  });

  it('reuses a cached price for the same block and keeps decimals for later blocks', async () => {
    const ctx = testContext({
      ethereum: await setup({ [feedOf(WETH)]: feed(2000_00000000n, BLOCK.timestamp) }),
    });
    await getUsdPrices(ctx, 'ethereum', [WETH], BLOCK);
    const [again, requests] = await counted(() => getUsdPrices(ctx, 'ethereum', [WETH], BLOCK));
    expect(again.get(WETH)).toEqual({ usd: 2000, stale: false });
    expect(requests).toBe(0);
    // decimals() now reverts: the next block must be priced from the cached decimals.
    const url = await setup({ [feedOf(WETH)]: feed(2100_00000000n, NEXT.timestamp, null) });
    const next = await getUsdPrices(
      { ...ctx, clients: testContext({ ethereum: url }).clients },
      'ethereum',
      [WETH],
      NEXT,
    );
    expect(next.get(WETH)).toEqual({ usd: 2100, stale: false });
  });

  it('returns null and caches nothing when a feed call fails', async () => {
    const ctx = testContext({ ethereum: await setup({ [feedOf(WETH)]: { revert: true } }) });
    expect((await getUsdPrices(ctx, 'ethereum', [WETH], BLOCK)).get(WETH)).toBeNull();
    const [, requests] = await counted(() => getUsdPrices(ctx, 'ethereum', [WETH], BLOCK));
    expect(requests).toBe(1);
  });

  it('returns null for a non-positive answer and for unreadable decimals', async () => {
    const ctx = testContext({
      ethereum: await setup({
        [feedOf(WETH)]: feed(0n, BLOCK.timestamp),
        [feedOf(USDC)]: feed(1_0000_0000n, BLOCK.timestamp, null),
      }),
    });
    const prices = await getUsdPrices(ctx, 'ethereum', [WETH, USDC], BLOCK);
    expect(prices.get(WETH)).toBeNull();
    expect(prices.get(USDC)).toBeNull();
  });
});
