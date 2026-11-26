import {
  type Address,
  getAddress,
  getChainContractAddress,
  hexToString,
  isAddressEqual,
  isHex,
  type PublicClient,
} from 'viem';
import { CHAINS, type ChainId, getClient, NATIVE_ADDRESS } from '../../chains.js';
import type { AppContext } from '../../context.js';
import type { PinnedBlock } from '../../lib/blocks.js';
import type { TtlCache } from '../../lib/cache.js';
import { isBigint, isNumber, isString, type Outcome, success } from '../../lib/multicall.js';
import { sanitizeSymbol } from '../../lib/sanitize.js';
import { erc20Abi, erc20Bytes32Abi, multicall3EthBalanceAbi } from './abi.js';

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

const NATIVE_DECIMALS = 18;
const PLACEHOLDER_SYMBOL = 'UNKNOWN';

const isNative = (address: Address): boolean => isAddressEqual(address, NATIVE_ADDRESS);
const lower = (address: Address): string => address.toLowerCase();
const tokenKey = (chain: ChainId, address: Address): string => `token:${chain}:${lower(address)}`;

function nativeToken(chain: ChainId): TokenInfo {
  return { address: NATIVE_ADDRESS, symbol: CHAINS[chain].nativeSymbol, decimals: NATIVE_DECIMALS };
}

async function readBytes32Symbols(
  client: PublicClient,
  addresses: Address[],
  block: PinnedBlock,
): Promise<Map<string, string>> {
  if (addresses.length === 0) return new Map();
  const results = (await client.multicall({
    allowFailure: true,
    blockNumber: block.number,
    contracts: addresses.map((address) => ({
      address,
      abi: erc20Bytes32Abi,
      functionName: 'symbol' as const,
    })),
  })) as readonly Outcome[];
  return new Map(
    addresses.flatMap((address, i) => {
      const raw = success(results[i], isString);
      return raw && isHex(raw) ? [[lower(address), hexToString(raw, { size: 32 })] as const] : [];
    }),
  );
}

/** symbol + decimals in one multicall; tokens whose string `symbol` fails are retried as bytes32. */
async function fetchTokens(
  ctx: AppContext,
  chain: ChainId,
  addresses: Address[],
  block: PinnedBlock,
): Promise<Map<string, TokenInfo | null>> {
  const client = getClient(ctx, chain);
  const results = (await client.multicall({
    allowFailure: true,
    blockNumber: block.number,
    contracts: addresses.flatMap((address) => [
      { address, abi: erc20Abi, functionName: 'symbol' as const },
      { address, abi: erc20Abi, functionName: 'decimals' as const },
    ]),
  })) as readonly Outcome[];
  const reads = addresses.map((address, i) => ({
    address,
    symbol: success(results[2 * i], isString),
    decimals: success(results[2 * i + 1], isNumber),
  }));
  const retry = reads.filter((r) => r.decimals !== undefined && r.symbol === undefined);
  const bytes32 = await readBytes32Symbols(
    client,
    retry.map((r) => r.address),
    block,
  );
  return new Map(
    reads.map((r) => {
      // EIP-20 makes symbol() optional: a token with decimals() but no symbol stays readable.
      const symbol = r.symbol ?? bytes32.get(lower(r.address)) ?? PLACEHOLDER_SYMBOL;
      const info =
        r.decimals === undefined
          ? null
          : {
              address: getAddress(r.address),
              symbol: sanitizeSymbol(symbol),
              decimals: r.decimals,
            };
      return [lower(r.address), info];
    }),
  );
}

function uniqueByAddress(addresses: Address[]): Address[] {
  return [...new Map(addresses.map((a) => [lower(a), a])).values()];
}

type Pending = Map<string, Promise<TokenInfo | null>>;

/** In-flight metadata reads per cache (one cache per server context), keyed like the cache. */
const inflight = new WeakMap<TtlCache, Pending>();

function pendingOf(ctx: AppContext): Pending {
  const existing = inflight.get(ctx.cache);
  if (existing) return existing;
  const created: Pending = new Map();
  inflight.set(ctx.cache, created);
  return created;
}

/** Starts one multicall for `addresses` and registers a per-token promise until it settles. */
function startFetch(
  ctx: AppContext,
  chain: ChainId,
  addresses: Address[],
  block: PinnedBlock,
  pending: Pending,
): void {
  const batch = fetchTokens(ctx, chain, addresses, block).then((fetched) => {
    for (const info of fetched.values()) {
      if (info) ctx.cache.set(tokenKey(chain, info.address), info, 'forever');
    }
    return fetched;
  });
  for (const address of addresses) {
    const key = tokenKey(chain, address);
    const promise: Promise<TokenInfo | null> = batch
      .then((fetched) => fetched.get(lower(address)) ?? null)
      .finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
    pending.set(key, promise);
  }
}

/**
 * Token metadata at `block`. null = not a readable ERC-20 (no code, reverts, or no decimals); a missing symbol() becomes 'UNKNOWN'.
 * NATIVE_ADDRESS resolves to the native descriptor without an RPC call. Readable tokens are cached
 * forever under `token:<chain>:<address>`; nulls are not cached. Concurrent calls share the
 * in-flight read of a token; it is dropped once settled. Keys are the given addresses.
 */
export async function readTokens(
  ctx: AppContext,
  chain: ChainId,
  addresses: Address[],
  block: PinnedBlock,
): Promise<Map<Address, TokenInfo | null>> {
  const known = (a: Address): TokenInfo | undefined =>
    isNative(a) ? nativeToken(chain) : ctx.cache.get<TokenInfo>(tokenKey(chain, a));
  const misses = uniqueByAddress(addresses.filter((a) => known(a) === undefined));
  const pending = pendingOf(ctx);
  const fresh = misses.filter((a) => !pending.has(tokenKey(chain, a)));
  if (fresh.length > 0) startFetch(ctx, chain, fresh, block, pending);
  const reads = misses.map(async (a) => [lower(a), await pending.get(tokenKey(chain, a))] as const);
  const fetched = new Map(await Promise.all(reads));
  return new Map(addresses.map((a) => [a, known(a) ?? fetched.get(lower(a)) ?? null]));
}

/**
 * Balances of `owner` at `block` in one multicall; NATIVE_ADDRESS reads the native balance via
 * Multicall3.getEthBalance. Tokens whose balance cannot be read are absent from the result.
 */
export async function readBalances(
  ctx: AppContext,
  chain: ChainId,
  owner: Address,
  tokens: Address[],
  block: PinnedBlock,
): Promise<Map<Address, bigint>> {
  if (tokens.length === 0) return new Map();
  const client = getClient(ctx, chain);
  const multicall3 = getChainContractAddress({
    chain: CHAINS[chain].viemChain,
    contract: 'multicall3',
    blockNumber: block.number,
  });
  const results = (await client.multicall({
    allowFailure: true,
    blockNumber: block.number,
    contracts: tokens.map((token) =>
      isNative(token)
        ? {
            address: multicall3,
            abi: multicall3EthBalanceAbi,
            functionName: 'getEthBalance' as const,
            args: [owner] as const,
          }
        : {
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf' as const,
            args: [owner] as const,
          },
    ),
  })) as readonly Outcome[];
  return new Map(
    tokens.flatMap((token, i) => {
      const balance = success(results[i], isBigint);
      return balance === undefined ? [] : [[token, balance] as const];
    }),
  );
}
