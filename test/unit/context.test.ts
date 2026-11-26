import { afterEach, describe, expect, it } from 'vitest';
import { getClient } from '../../src/chains.js';
import { requestScope } from '../../src/context.js';
import { TtlCache } from '../../src/lib/cache.js';
import { testContext } from '../helpers/context.js';
import { type Endpoint, startReplayServer } from '../helpers/rpc-server.js';

const recording = [{ method: 'eth_blockNumber', params: [], result: '0x10' }];

let ep: Endpoint | undefined;
afterEach(async () => {
  await ep?.stop();
  ep = undefined;
});

describe('createContext', () => {
  it('creates a client only for configured chains', () => {
    const ctx = testContext({ ethereum: 'http://a', polygon: 'http://b' });
    expect(Object.keys(ctx.clients).sort()).toEqual(['ethereum', 'polygon']);
    expect(ctx.clients.polygon?.transport.url).toBe('http://b');
    expect(ctx.clients.polygon?.chain?.id).toBe(137);
    expect(ctx.cache).toBeInstanceOf(TtlCache);
    expect(ctx.fetch).toBe(globalThis.fetch);
  });

  it('has no indexer clients without an Alchemy key', () => {
    expect(testContext({ ethereum: 'http://a' }).indexerClients).toEqual({});
  });

  it('creates Alchemy indexer clients for every chain when a key is set', () => {
    const ctx = testContext({ ethereum: 'http://a' }, { alchemyApiKey: 'k' });
    expect(Object.keys(ctx.indexerClients).sort()).toEqual([
      'arbitrum',
      'base',
      'ethereum',
      'polygon',
    ]);
    expect(ctx.indexerClients.base?.transport.url).toBe('https://base-mainnet.g.alchemy.com/v2/k');
  });

  it('counts upstream HTTP requests inside a request scope', async () => {
    ep = await startReplayServer(recording);
    const ctx = testContext({ ethereum: ep.rpcUrl });
    const store = { upstreamRequests: 0 };
    const n = await requestScope.run(store, () =>
      getClient(ctx, 'ethereum').getBlockNumber({ cacheTime: 0 }),
    );
    expect(n).toBe(16n);
    expect(store.upstreamRequests).toBe(1);
  });

  it('does not fail outside a request scope', async () => {
    ep = await startReplayServer(recording);
    const ctx = testContext({ ethereum: ep.rpcUrl });
    await expect(getClient(ctx, 'ethereum').getBlockNumber({ cacheTime: 0 })).resolves.toBe(16n);
  });
});
