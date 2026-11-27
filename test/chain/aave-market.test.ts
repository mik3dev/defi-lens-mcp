import { zeroAddress } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAIN_IDS, getClient } from '../../src/chains.js';
import { type AppContext, requestScope } from '../../src/context.js';
import { aaveOracleAbi, aavePoolAbi } from '../../src/protocols/aave/abis.js';
import {
  AAVE_V3_ADDRESSES_PROVIDER,
  AAVE_V3_MARKET_NAME,
} from '../../src/protocols/aave/addresses.js';
import { resolveMarket } from '../../src/protocols/aave/market.js';
import { PINNED } from '../fixtures/blocks.js';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { testContext } from '../helpers/context.js';

describe.each(CHAIN_IDS)('aave v3 market resolution on %s', (chain) => {
  let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;
  let ctx: AppContext;
  const block = { number: PINNED[chain], timestamp: 0n };

  beforeAll(async () => {
    endpoint = await chainEndpoint(chain, `aave-market.${chain}`);
  }, 120_000);

  // A fresh context (and cache) per test: no test depends on reads another test cached.
  beforeEach(() => {
    if (!endpoint) throw new Error(`No chain endpoint for ${chain}`);
    ctx = testContext({ [chain]: endpoint.rpcUrl });
  });

  afterAll(async () => {
    await endpoint?.stop();
  });

  it('resolves pool, data provider and oracle to non-zero addresses', async () => {
    const market = await resolveMarket(ctx, chain, block);
    for (const address of [market.pool, market.dataProvider, market.oracle]) {
      expect(address).not.toBe(zeroAddress);
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(AAVE_V3_MARKET_NAME[chain]).toMatch(/^Aave v3 /);
  });

  it('the pool points back at the provider', async () => {
    const { pool } = await resolveMarket(ctx, chain, block);
    const provider = await getClient(ctx, chain).readContract({
      address: pool,
      abi: aavePoolAbi,
      functionName: 'ADDRESSES_PROVIDER',
      blockNumber: block.number,
    });
    expect(provider).toBe(AAVE_V3_ADDRESSES_PROVIDER[chain]);
  });

  it('the oracle is denominated in USD with 8 decimals', async () => {
    const { oracle } = await resolveMarket(ctx, chain, block);
    const unit = await getClient(ctx, chain).readContract({
      address: oracle,
      abi: aaveOracleAbi,
      functionName: 'BASE_CURRENCY_UNIT',
      blockNumber: block.number,
    });
    expect(unit).toBe(100000000n);
  });

  it('resolves once and serves later calls from cache', async () => {
    const count = async (): Promise<number> => {
      const scope = { upstreamRequests: 0 };
      await requestScope.run(scope, () => resolveMarket(ctx, chain, block));
      return scope.upstreamRequests;
    };
    expect(await count()).toBeGreaterThan(0);
    expect(await count()).toBe(0);
  });
});
