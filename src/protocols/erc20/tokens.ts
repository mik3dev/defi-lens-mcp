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
import { sanitizeSymbol } from '../../lib/sanitize.js';
import { erc20Abi, erc20Bytes32Abi, multicall3EthBalanceAbi } from './abi.js';

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

/** One `allowFailure` multicall result; `result` is untrusted until its type is checked. */
interface Outcome {
  status: 'success' | 'failure';
  result?: unknown;
}

const NATIVE_DECIMALS = 18;

const isNative = (address: Address): boolean => isAddressEqual(address, NATIVE_ADDRESS);
const lower = (address: Address): string => address.toLowerCase();
const tokenKey = (chain: ChainId, address: Address): string => `token:${chain}:${lower(address)}`;

function success<T>(outcome: Outcome | undefined, guard: (v: unknown) => v is T): T | undefined {
  return outcome?.status === 'success' && guard(outcome.result) ? outcome.result : undefined;
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number';
const isBigint = (v: unknown): v is bigint => typeof v === 'bigint';

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
      const symbol = r.symbol ?? bytes32.get(lower(r.address));
      const info =
        symbol === undefined || r.decimals === undefined
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

/**
 * Token metadata at `block`. null = not a readable ERC-20 (no code, reverts, or no symbol/decimals).
 * NATIVE_ADDRESS resolves to the native descriptor without an RPC call. Readable tokens are cached
 * forever under `token:<chain>:<address>`; nulls are not cached. Keys are the given addresses.
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
  const fetched =
    misses.length > 0 ? await fetchTokens(ctx, chain, misses, block) : new Map<string, null>();
  for (const info of fetched.values()) {
    if (info) ctx.cache.set(tokenKey(chain, info.address), info, 'forever');
  }
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
