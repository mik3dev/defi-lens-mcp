import { type Address, encodeAbiParameters, type Hex, toFunctionSelector } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '../../../../src/lib/errors.js';
import { AAVE_V3_ADDRESSES_PROVIDER } from '../../../../src/protocols/aave/addresses.js';
import { resolveMarket } from '../../../../src/protocols/aave/market.js';
import { testContext } from '../../../helpers/context.js';
import { type FakeChain, startFakeChain } from '../../../helpers/fake-chain.js';

const PROVIDER = AAVE_V3_ADDRESSES_PROVIDER.ethereum;
const POOL: Address = '0x0000000000000000000000000000000000000a01';
const DATA: Address = '0x0000000000000000000000000000000000000a02';
const ORACLE: Address = '0x0000000000000000000000000000000000000a03';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const block = { number: 20_000_000n, timestamp: 1n };

const sel = (sig: string): Hex => toFunctionSelector(sig);
const word = (a: Address): Hex => encodeAbiParameters([{ type: 'address' }], [a]);
const raw = (pool: Address, data: Address, oracle: Address): Record<Hex, Hex> => ({
  [sel('function getPool()')]: word(pool),
  [sel('function getPoolDataProvider()')]: word(data),
  [sel('function getPriceOracle()')]: word(oracle),
});

describe('resolveMarket (fake chain)', () => {
  let chain: FakeChain | undefined;
  afterEach(async () => {
    await chain?.stop();
  });

  async function setup(contract: { raw?: Record<Hex, Hex>; revert?: boolean }) {
    const contracts: Record<Address, typeof contract> = { [PROVIDER]: contract };
    chain = await startFakeChain({ blockNumber: 20_000_000n, contracts });
    return { contracts, ctx: testContext({ ethereum: chain.rpcUrl }) };
  }

  it('returns the three addresses', async () => {
    const { ctx } = await setup({ raw: raw(POOL, DATA, ORACLE) });
    expect(await resolveMarket(ctx, 'ethereum', block)).toEqual({
      pool: POOL,
      dataProvider: DATA,
      oracle: ORACLE,
    });
  });

  it('throws UPSTREAM_ERROR when an inner call fails', async () => {
    const { ctx } = await setup({ revert: true });
    await expect(resolveMarket(ctx, 'ethereum', block)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    } satisfies Partial<AppError>);
  });

  it.each(['pool', 'dataProvider', 'oracle'] as const)(
    'throws UPSTREAM_ERROR when %s is the zero address',
    async (which) => {
      const addrs = { pool: POOL, dataProvider: DATA, oracle: ORACLE, [which]: ZERO };
      const { ctx } = await setup({ raw: raw(addrs.pool, addrs.dataProvider, addrs.oracle) });
      await expect(resolveMarket(ctx, 'ethereum', block)).rejects.toMatchObject({
        code: 'UPSTREAM_ERROR',
      });
    },
  );

  it('does not cache a failure: a retry re-reads', async () => {
    const { ctx, contracts } = await setup({ raw: raw(ZERO, DATA, ORACLE) });
    await expect(resolveMarket(ctx, 'ethereum', block)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
    contracts[PROVIDER] = { raw: raw(POOL, DATA, ORACLE) };
    expect((await resolveMarket(ctx, 'ethereum', block)).pool).toBe(POOL);
  });
});
