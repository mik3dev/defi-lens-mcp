import { type Address, isAddress, zeroAddress } from 'viem';
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

function isResolved(value: string | undefined): value is Address {
  return value !== undefined && isAddress(value) && value !== zeroAddress;
}

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
  if (!isResolved(pool) || !isResolved(dataProvider) || !isResolved(oracle)) {
    throw new AppError('UPSTREAM_ERROR', `Aave v3 addresses provider on ${chain} did not resolve`);
  }
  return { pool, dataProvider, oracle };
}

/** Pool, data provider and oracle of the Aave v3 market on `chain`; cached forever per chain. */
export function resolveMarket(
  ctx: AppContext,
  chain: ChainId,
  block: PinnedBlock,
): Promise<AaveMarket> {
  // Market addresses are resolved once per chain at the first caller's pinned block and treated as static.
  return ctx.cache.wrap(`aave:market:${chain}`, 'forever', () => readMarket(ctx, chain, block));
}
