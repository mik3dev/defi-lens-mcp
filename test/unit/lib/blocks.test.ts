import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestScope } from '../../../src/context.js';
import { pinBlock } from '../../../src/lib/blocks.js';
import { testContext } from '../../helpers/context.js';
import { type Endpoint, startReplayServer } from '../../helpers/rpc-server.js';

const block = {
  number: '0x2faf080',
  timestamp: '0x6553f100',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  transactions: [],
};
const recording = [{ method: 'eth_getBlockByNumber', params: ['latest', false], result: block }];

let ep: Endpoint | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await ep?.stop();
  ep = undefined;
});

async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const store = { upstreamRequests: 0 };
  const value = await requestScope.run(store, fn);
  return [value, store.upstreamRequests];
}

describe('pinBlock', () => {
  it('returns the latest block number and timestamp', async () => {
    ep = await startReplayServer(recording);
    const ctx = testContext({ ethereum: ep.rpcUrl });
    expect(await pinBlock(ctx, 'ethereum')).toEqual({
      number: 50_000_000n,
      timestamp: 1_700_000_000n,
    });
  });

  it('caches the block per chain for the chain block time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    ep = await startReplayServer(recording);
    const ctx = testContext({ ethereum: ep.rpcUrl });
    const [, first] = await counted(() => pinBlock(ctx, 'ethereum'));
    vi.advanceTimersByTime(11_000);
    const [, cached] = await counted(() => pinBlock(ctx, 'ethereum'));
    vi.advanceTimersByTime(2_000);
    const [, refreshed] = await counted(() => pinBlock(ctx, 'ethereum'));
    expect([first, cached, refreshed]).toEqual([1, 0, 1]);
  });

  it('uses CACHE_TTL_SECONDS when configured', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    ep = await startReplayServer(recording);
    const ctx = testContext({ ethereum: ep.rpcUrl }, { cacheTtlSeconds: 60 });
    await pinBlock(ctx, 'ethereum');
    vi.advanceTimersByTime(30_000);
    const [, cached] = await counted(() => pinBlock(ctx, 'ethereum'));
    expect(cached).toBe(0);
  });

  it('throws CHAIN_NOT_CONFIGURED for a chain without a client', async () => {
    const ctx = testContext({ ethereum: 'http://x' });
    await expect(pinBlock(ctx, 'base')).rejects.toMatchObject({ code: 'CHAIN_NOT_CONFIGURED' });
  });
});
