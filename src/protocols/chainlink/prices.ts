import type { Address } from 'viem';
import { CHAINS, type ChainId, getClient } from '../../chains.js';
import type { AppContext } from '../../context.js';
import type { PinnedBlock } from '../../lib/blocks.js';
import { toAmount } from '../../lib/format.js';
import { isBigint, isNumber, type Outcome, success } from '../../lib/multicall.js';
import { aggregatorV3Abi } from './abi.js';
import { FEEDS, type FeedConfig } from './feeds.js';

/** Seconds past a feed's heartbeat before its answer counts as stale. */
export const STALE_GRACE_SECONDS = 600;

export interface Price {
  usd: number;
  stale: boolean;
}

/** latestRoundData(): roundId, answer, startedAt, updatedAt, answeredInRound. */
type RoundData = readonly [bigint, bigint, bigint, bigint, bigint];

const isRoundData = (v: unknown): v is RoundData =>
  Array.isArray(v) && v.length === 5 && v.every(isBigint);

const lower = (address: Address): string => address.toLowerCase();
const decimalsKey = (chain: ChainId, feed: Address) => `feed-decimals:${chain}:${lower(feed)}`;
const priceKey = (chain: ChainId, feed: Address, block: PinnedBlock) =>
  `price:${chain}:${lower(feed)}:${block.number}`;

/**
 * USD price from a feed answer. null for a non-positive answer. Stale when `now` is more than
 * heartbeat + STALE_GRACE_SECONDS after `updatedAt`; a stale price is still returned.
 */
export function toPrice(
  answer: bigint,
  feedDecimals: number,
  updatedAt: bigint,
  now: bigint,
  heartbeatSeconds: number,
): Price | null {
  if (answer <= 0n) return null;
  const usd = Number(toAmount(answer, feedDecimals).formatted);
  const stale = now - updatedAt > BigInt(heartbeatSeconds + STALE_GRACE_SECONDS);
  return { usd, stale };
}

/** latestRoundData of every feed, plus decimals() of feeds whose decimals are not cached. */
async function callFeeds(
  ctx: AppContext,
  chain: ChainId,
  configs: FeedConfig[],
  block: PinnedBlock,
): Promise<{ rounds: (RoundData | undefined)[]; decimals: (number | undefined)[] }> {
  const uncached = configs.filter((c) => !ctx.cache.has(decimalsKey(chain, c.feed)));
  const results = (await getClient(ctx, chain).multicall({
    allowFailure: true,
    blockNumber: block.number,
    contracts: [
      ...configs.map((c) => ({
        address: c.feed,
        abi: aggregatorV3Abi,
        functionName: 'latestRoundData' as const,
      })),
      ...uncached.map((c) => ({
        address: c.feed,
        abi: aggregatorV3Abi,
        functionName: 'decimals' as const,
      })),
    ],
  })) as readonly Outcome[];
  uncached.forEach((c, i) => {
    const value = success(results[configs.length + i], isNumber);
    if (value !== undefined) ctx.cache.set(decimalsKey(chain, c.feed), value, 'forever');
  });
  return {
    rounds: configs.map((_, i) => success(results[i], isRoundData)),
    decimals: configs.map((c) => ctx.cache.get<number>(decimalsKey(chain, c.feed))),
  };
}

/** Prices of `configs` by lowercase feed address. Only successful reads are cached. */
async function readFeeds(
  ctx: AppContext,
  chain: ChainId,
  configs: FeedConfig[],
  block: PinnedBlock,
): Promise<Map<string, Price | null>> {
  const ttlMs = (ctx.config.cacheTtlSeconds ?? CHAINS[chain].blockTimeSeconds) * 1000;
  const { rounds, decimals } = await callFeeds(ctx, chain, configs, block);
  return new Map(
    configs.map((c, i) => {
      const round = rounds[i];
      const feedDecimals = decimals[i];
      if (!round || feedDecimals === undefined) return [lower(c.feed), null];
      const price = toPrice(round[1], feedDecimals, round[3], block.timestamp, c.heartbeatSeconds);
      ctx.cache.set(priceKey(chain, c.feed, block), price, ttlMs);
      return [lower(c.feed), price];
    }),
  );
}

function uniqueByFeed(configs: FeedConfig[]): FeedConfig[] {
  return [...new Map(configs.map((c) => [lower(c.feed), c])).values()];
}

/**
 * Chainlink USD prices at `block`, keyed by the given addresses. null = no feed for the token or the
 * feed could not be read. One multicall of latestRoundData for the distinct feeds not cached for
 * this block; "now" for staleness is the block timestamp. Feed decimals are cached forever, prices
 * under `price:<chain>:<feed>:<blockNumber>` for CACHE_TTL_SECONDS (default: the chain's block time).
 */
export async function getUsdPrices(
  ctx: AppContext,
  chain: ChainId,
  tokens: Address[],
  block: PinnedBlock,
): Promise<Map<Address, Price | null>> {
  const configOf = (token: Address): FeedConfig | undefined => FEEDS[chain][lower(token)];
  const configs = uniqueByFeed(tokens.flatMap((t) => configOf(t) ?? []));
  const isHit = (c: FeedConfig) => ctx.cache.has(priceKey(chain, c.feed, block));
  const hits = new Map(
    configs
      .filter(isHit)
      .map((c) => [
        lower(c.feed),
        ctx.cache.get<Price | null>(priceKey(chain, c.feed, block)) ?? null,
      ]),
  );
  const misses = configs.filter((c) => !isHit(c));
  const fetched = misses.length > 0 ? await readFeeds(ctx, chain, misses, block) : new Map();
  const all = new Map<string, Price | null>([...hits, ...fetched]);
  return new Map(
    tokens.map((t) => {
      const config = configOf(t);
      return [t, config ? (all.get(lower(config.feed)) ?? null) : null];
    }),
  );
}

/** One 'price feed stale: <SYMBOL>' warning per distinct stale token symbol (address if unknown). */
export function staleWarnings(
  prices: Map<Address, Price | null>,
  symbols: Map<Address, string>,
): string[] {
  const warnings = [...prices]
    .filter(([, price]) => price?.stale === true)
    .map(([address]) => `price feed stale: ${symbols.get(address) ?? address}`);
  return [...new Set(warnings)];
}
