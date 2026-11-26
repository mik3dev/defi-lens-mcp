import { type Address, getAddress, isAddress, type PublicClient } from 'viem';
import { z } from 'zod/v4';
import type { ChainId } from '../chains.js';
import type { AppContext } from '../context.js';
import { AppError, toAppError } from '../lib/errors.js';

/** Most token candidates one discovery returns; the rest are reported as truncated. */
export const DISCOVERY_CANDIDATE_CAP = 400;
/** Most pages one discovery requests, so a provider that keeps returning a pageKey cannot loop. */
export const DISCOVERY_PAGE_LIMIT = 20;

/** ERC-20 interfaces of a chain's native token. The native balance is read separately, so skip them. */
const NATIVE_TOKEN_CONTRACTS: Partial<Record<ChainId, readonly string[]>> = {
  polygon: ['0x0000000000000000000000000000000000001010'],
};

// Response of alchemy_getTokenBalances (docs/spikes/provider-capabilities.md, Q8). Pages hold up to
// 100 entries, can be shorter while a pageKey follows, and include zero balances.
const pageSchema = z.object({
  tokenBalances: z.array(
    z.object({
      contractAddress: z.string().refine((a) => isAddress(a, { strict: false })),
      tokenBalance: z
        .string()
        .regex(/^0x[0-9a-fA-F]{1,64}$/)
        .nullish(),
    }),
  ),
  pageKey: z.string().nullish(),
});

type Page = z.infer<typeof pageSchema>;
type RawRequest = (args: { method: string; params: unknown[] }) => Promise<unknown>;

export interface Discovery {
  tokens: Address[];
  truncated: boolean;
}

export function hasIndexer(ctx: AppContext, chain: ChainId): boolean {
  return ctx.indexerClients[chain] !== undefined;
}

async function fetchPage(client: PublicClient, owner: Address, pageKey?: string): Promise<Page> {
  const params = pageKey === undefined ? [owner, 'erc20'] : [owner, 'erc20', { pageKey }];
  // A provider-specific method outside viem's typed public RPC schema.
  const request = client.request as unknown as RawRequest;
  const parsed = pageSchema.safeParse(
    await request({ method: 'alchemy_getTokenBalances', params }),
  );
  if (!parsed.success) throw new AppError('UPSTREAM_ERROR', 'Unexpected indexer response');
  return parsed.data;
}

/** Lowercase contract addresses on `page` with a non-zero balance that are not excluded. */
function candidatesOf(page: Page, excluded: ReadonlySet<string>): string[] {
  return page.tokenBalances
    .filter((t) => t.tokenBalance != null && BigInt(t.tokenBalance) !== 0n)
    .map((t) => t.contractAddress.toLowerCase())
    .filter((a) => !excluded.has(a));
}

function result(found: ReadonlySet<string>, truncated: boolean): Discovery {
  const tokens = [...found].slice(0, DISCOVERY_CANDIDATE_CAP).map((a) => getAddress(a));
  return { tokens, truncated };
}

async function collect(client: PublicClient, chain: ChainId, owner: Address): Promise<Discovery> {
  const excluded = new Set(NATIVE_TOKEN_CONTRACTS[chain] ?? []);
  const found = new Set<string>();
  let pageKey: string | undefined;
  for (let page = 0; page < DISCOVERY_PAGE_LIMIT; page += 1) {
    const current = await fetchPage(client, owner, pageKey);
    for (const address of candidatesOf(current, excluded)) found.add(address);
    pageKey = current.pageKey ?? undefined;
    // At the cap no further page is requested; more may exist if this page overflowed or has a next.
    if (found.size >= DISCOVERY_CANDIDATE_CAP) {
      return result(found, found.size > DISCOVERY_CANDIDATE_CAP || pageKey !== undefined);
    }
    if (pageKey === undefined) return result(found, false);
  }
  return result(found, true);
}

/**
 * ERC-20 contracts in which `owner` has a non-zero balance, from the chain's indexer, in provider
 * order, at most DISCOVERY_CANDIDATE_CAP of them. alchemy_getTokenBalances reports current state and
 * cannot be pinned to a block, so callers read the balances themselves at their pinned block.
 * Throws AppError('INDEXER_NOT_CONFIGURED') without an indexer client; provider failures become
 * AppErrors through toAppError.
 */
export async function discoverTokens(
  ctx: AppContext,
  chain: ChainId,
  owner: Address,
): Promise<Discovery> {
  const client = ctx.indexerClients[chain];
  if (!client) {
    throw new AppError(
      'INDEXER_NOT_CONFIGURED',
      `Token discovery on ${chain} needs an indexer: set ALCHEMY_API_KEY`,
    );
  }
  try {
    return await collect(client, chain, owner);
  } catch (e) {
    throw toAppError(e);
  }
}
