import { CHAINS, type ChainId, getClient } from '../chains.js';
import type { AppContext } from '../context.js';

export interface PinnedBlock {
  number: bigint;
  timestamp: bigint;
}

/**
 * Latest block of `chain`, cached per chain for CACHE_TTL_SECONDS (default: the chain's block time).
 * Volatile cache keys include the block number, so a cached value is only reused for its block.
 */
export async function pinBlock(ctx: AppContext, chain: ChainId): Promise<PinnedBlock> {
  const client = getClient(ctx, chain);
  const ttlMs = (ctx.config.cacheTtlSeconds ?? CHAINS[chain].blockTimeSeconds) * 1000;
  return ctx.cache.wrap(`block:${chain}`, ttlMs, async () => {
    const block = await client.getBlock({ blockTag: 'latest' });
    return { number: block.number, timestamp: block.timestamp };
  });
}
