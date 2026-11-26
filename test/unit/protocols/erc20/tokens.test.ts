import type { Address } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { NATIVE_ADDRESS } from '../../../../src/chains.js';
import { requestScope } from '../../../../src/context.js';
import type { PinnedBlock } from '../../../../src/lib/blocks.js';
import { readBalances, readTokens } from '../../../../src/protocols/erc20/tokens.js';
import { testContext } from '../../../helpers/context.js';
import { type FakeChain, startFakeChain } from '../../../helpers/fake-chain.js';
import { type Endpoint, startRpcServer } from '../../../helpers/rpc-server.js';

const BLOCK: PinnedBlock = { number: 50_000_000n, timestamp: 1_700_000_000n };
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const MKR: Address = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2';
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const DEAD: Address = '0x000000000000000000000000000000000000dEaD';
const NOSYM: Address = '0x1111111111111111111111111111111111111111';
const EVIL: Address = '0x2222222222222222222222222222222222222222';
const OWNER: Address = '0x3333333333333333333333333333333333333333';

let chain: FakeChain | undefined;
let failing: Endpoint | undefined;
afterEach(async () => {
  await chain?.stop();
  await failing?.stop();
  chain = undefined;
  failing = undefined;
});

/** A chain whose every eth_call fails with a non-retryable JSON-RPC error; counts the requests. */
async function failingChain(): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  failing = await startRpcServer(() => {
    calls += 1;
    return { error: { code: -32602, message: 'fake: invalid params' } };
  });
  return { url: failing.rpcUrl, calls: () => calls };
}

async function setup() {
  chain = await startFakeChain({
    blockNumber: BLOCK.number,
    contracts: {
      [WETH]: { symbol: 'WETH', decimals: 18, balances: { [OWNER]: 5n } },
      [MKR]: { symbolBytes32: 'MKR', decimals: 18 },
      [MULTICALL3]: { revert: true },
      [NOSYM]: { decimals: 6 },
      [EVIL]: { symbol: 'EV\u0000IL‮', decimals: 8 },
    },
    ethBalances: { [OWNER]: 7n },
  });
  return testContext({ ethereum: chain.rpcUrl });
}

async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const store = { upstreamRequests: 0 };
  const value = await requestScope.run(store, fn);
  return [value, store.upstreamRequests];
}

describe('readTokens', () => {
  it('reads string symbols and decimals with one multicall at the pinned block', async () => {
    const ctx = await setup();
    const [tokens, requests] = await counted(() => readTokens(ctx, 'ethereum', [WETH], BLOCK));
    expect(tokens.get(WETH)).toEqual({ address: WETH, symbol: 'WETH', decimals: 18 });
    expect(requests).toBe(1);
    expect(chain?.callBlocks).toEqual([BLOCK.number]);
  });

  it('retries a failed symbol with the bytes32 ABI', async () => {
    const ctx = await setup();
    const tokens = await readTokens(ctx, 'ethereum', [MKR], BLOCK);
    expect(tokens.get(MKR)).toEqual({ address: MKR, symbol: 'MKR', decimals: 18 });
  });

  it('returns null for no code, non-ERC-20 contracts and unreadable symbols', async () => {
    const ctx = await setup();
    const tokens = await readTokens(ctx, 'ethereum', [DEAD, MULTICALL3, NOSYM], BLOCK);
    expect([...tokens.values()]).toEqual([null, null, null]);
  });

  it('sanitizes on-chain symbols', async () => {
    const ctx = await setup();
    const tokens = await readTokens(ctx, 'ethereum', [EVIL], BLOCK);
    expect(tokens.get(EVIL)?.symbol).toBe('EVIL');
  });

  it('resolves the native descriptor without an RPC call', async () => {
    const ctx = await setup();
    const polygon = testContext({ polygon: 'http://unused.invalid' });
    const [eth, requests] = await counted(() =>
      readTokens(ctx, 'ethereum', [NATIVE_ADDRESS], BLOCK),
    );
    expect(eth.get(NATIVE_ADDRESS)).toEqual({
      address: NATIVE_ADDRESS,
      symbol: 'ETH',
      decimals: 18,
    });
    expect(requests).toBe(0);
    const pol = await readTokens(polygon, 'polygon', [NATIVE_ADDRESS], BLOCK);
    expect(pol.get(NATIVE_ADDRESS)?.symbol).toBe('POL');
  });

  it('caches token metadata forever and keeps the input order and keys', async () => {
    const ctx = await setup();
    await readTokens(ctx, 'ethereum', [WETH], BLOCK);
    const lower = MKR.toLowerCase() as Address;
    const [tokens, requests] = await counted(() =>
      readTokens(ctx, 'ethereum', [lower, WETH, lower], BLOCK),
    );
    expect([...tokens.keys()]).toEqual([lower, WETH]);
    expect(tokens.get(lower)).toEqual({ address: MKR, symbol: 'MKR', decimals: 18 });
    expect(ctx.cache.get(`token:ethereum:${WETH.toLowerCase()}`)).toEqual({
      address: WETH,
      symbol: 'WETH',
      decimals: 18,
    });
    expect(requests).toBeGreaterThan(0);
    const [, again] = await counted(() => readTokens(ctx, 'ethereum', [MKR, WETH], BLOCK));
    expect(again).toBe(0);
  });
});

describe('readTokens concurrency', () => {
  it('shares one in-flight read between concurrent calls for the same token', async () => {
    const ctx = await setup();
    const [a, b] = await Promise.all([
      readTokens(ctx, 'ethereum', [WETH], BLOCK),
      readTokens(ctx, 'ethereum', [WETH.toLowerCase() as Address], BLOCK),
    ]);
    expect(chain?.callBlocks).toHaveLength(1);
    expect(a.get(WETH)).toEqual({ address: WETH, symbol: 'WETH', decimals: 18 });
    expect(b.get(WETH.toLowerCase() as Address)).toEqual(a.get(WETH));
  });

  it('only fetches the tokens not already in flight', async () => {
    const ctx = await setup();
    const [a, b] = await Promise.all([
      readTokens(ctx, 'ethereum', [WETH], BLOCK),
      readTokens(ctx, 'ethereum', [WETH, NOSYM], BLOCK),
    ]);
    expect(a.get(WETH)?.symbol).toBe('WETH');
    expect(b.get(WETH)?.symbol).toBe('WETH');
    expect(b.get(NOSYM)).toBeNull();
    const reads = (t: Address) => chain?.callTargets.filter((c) => c === t).length;
    expect(reads(WETH)).toBe(2); // symbol + decimals, once
    expect(reads(NOSYM)).toBe(3); // symbol + decimals + bytes32 symbol retry
  });

  it('shares a failed read with concurrent callers but does not keep it', async () => {
    const { url, calls } = await failingChain();
    const ctx = testContext({ ethereum: url });
    const results = await Promise.allSettled([
      readTokens(ctx, 'ethereum', [WETH], BLOCK),
      readTokens(ctx, 'ethereum', [WETH], BLOCK),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(calls()).toBe(1);
    await expect(readTokens(ctx, 'ethereum', [WETH], BLOCK)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
    expect(calls()).toBe(2);
  });
});

describe('readBalances', () => {
  it('reads native and token balances in one multicall', async () => {
    const ctx = await setup();
    const [balances, requests] = await counted(() =>
      readBalances(ctx, 'ethereum', OWNER, [NATIVE_ADDRESS, WETH], BLOCK),
    );
    expect(balances).toEqual(
      new Map<Address, bigint>([
        [NATIVE_ADDRESS, 7n],
        [WETH, 5n],
      ]),
    );
    expect(requests).toBe(1);
    expect(chain?.callBlocks).toEqual([BLOCK.number]);
  });

  it('omits tokens whose balance cannot be read', async () => {
    const ctx = await setup();
    const balances = await readBalances(ctx, 'ethereum', OWNER, [WETH, DEAD, MULTICALL3], BLOCK);
    expect([...balances.keys()]).toEqual([WETH]);
  });

  it('returns an empty map for no tokens without an RPC call', async () => {
    const ctx = await setup();
    const [balances, requests] = await counted(() =>
      readBalances(ctx, 'ethereum', OWNER, [], BLOCK),
    );
    expect(balances.size).toBe(0);
    expect(requests).toBe(0);
  });
});
