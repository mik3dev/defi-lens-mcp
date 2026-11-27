import type { Address } from 'viem';
import { type ChainId, getClient } from '../../chains.js';
import type { AppContext } from '../../context.js';
import type { PinnedBlock } from '../../lib/blocks.js';
import { AppError } from '../../lib/errors.js';
import { isString, success } from '../../lib/multicall.js';
import { aaveAddressesProviderAbi } from './abis.js';
import { AAVE_V3_ADDRESSES_PROVIDER } from './addresses.js';

export interface AaveMarket {
  pool: Address;
  dataProvider: Address;
  oracle: Address;
}

const FUNCTIONS = ['getPool', 'getPoolDataProvider', 'getPriceOracle'] as const;

async function readMarket(
  ctx: AppContext,
  chain: ChainId,
  block: PinnedBlock,
): Promise<AaveMarket> {
  const address = AAVE_V3_ADDRESSES_PROVIDER[chain];
  const outcomes = await getClient(ctx, chain).multicall({
    allowFailure: true,
    blockNumber: block.number,
    contracts: FUNCTIONS.map((functionName) => ({
      address,
      abi: aaveAddressesProviderAbi,
      functionName,
    })),
  });
  const [pool, dataProvider, oracle] = outcomes.map((o) => success(o, isString));
  if (!pool || !dataProvider || !oracle) {
    throw new AppError('UPSTREAM_ERROR', `Aave v3 addresses provider on ${chain} did not resolve`);
  }
  return {
    pool: pool as Address,
    dataProvider: dataProvider as Address,
    oracle: oracle as Address,
  };
}

/** Pool, data provider and oracle of the Aave v3 market on `chain`; cached forever per chain. */
export function resolveMarket(
  ctx: AppContext,
  chain: ChainId,
  block: PinnedBlock,
): Promise<AaveMarket> {
  return ctx.cache.wrap(`aave:market:${chain}`, 'forever', () => readMarket(ctx, chain, block));
}
