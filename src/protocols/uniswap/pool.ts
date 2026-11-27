import {
  type Address,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  isAddressEqual,
  keccak256,
  zeroAddress,
} from 'viem';
import { type ChainId, getClient } from '../../chains.js';
import type { AppContext } from '../../context.js';
import type { PinnedBlock } from '../../lib/blocks.js';
import { AppError } from '../../lib/errors.js';
import { isBigint, isNumber, isString, type Outcome, success } from '../../lib/multicall.js';
import { readBalances, readTokens, type TokenInfo } from '../erc20/tokens.js';
import { uniswapV3FactoryAbi, uniswapV3PoolAbi } from './abis.js';
import { UNISWAP_V3 } from './addresses.js';

export interface PoolState {
  pool: Address;
  token0: TokenInfo;
  token1: TokenInfo;
  feeTier: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  reserve0: bigint;
  reserve1: bigint;
}

export interface PoolSelector {
  pool?: Address;
  tokenA?: Address;
  tokenB?: Address;
  feeTier?: number;
}

interface PoolImmutables {
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
}

interface PoolDynamics {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

const IMMUTABLE_FUNCTIONS = ['token0', 'token1', 'fee', 'tickSpacing', 'factory'] as const;
type PoolFunction = 'slot0' | 'liquidity' | (typeof IMMUTABLE_FUNCTIONS)[number];

const isSlot0 = (v: unknown): v is readonly [bigint, number, ...unknown[]] =>
  Array.isArray(v) && isBigint(v[0]) && isNumber(v[1]);

const immutablesKey = (chain: ChainId, pool: Address) =>
  `uniswap-v3:pool:${chain}:${pool.toLowerCase()}`;

function poolKey(chain: ChainId, a: Address, b: Address, fee: number): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `uniswap-v3:get-pool:${chain}:${x}:${y}:${fee}`;
}

function notAPool(chain: ChainId, pool: Address): AppError {
  return new AppError('INVALID_INPUT', `${pool} is not a Uniswap v3 pool on ${chain}`);
}

async function callPool(
  ctx: AppContext,
  chain: ChainId,
  pool: Address,
  functions: readonly PoolFunction[],
  block: PinnedBlock,
): Promise<readonly Outcome[]> {
  return (await getClient(ctx, chain).multicall({
    allowFailure: true,
    blockNumber: block.number,
    contracts: functions.map((functionName) => ({
      address: pool,
      abi: uniswapV3PoolAbi,
      functionName,
    })),
  })) as readonly Outcome[];
}

function parseDynamics(
  slot0: Outcome | undefined,
  liquidity: Outcome | undefined,
): PoolDynamics | undefined {
  const s = success(slot0, isSlot0);
  const l = success(liquidity, isBigint);
  return s && l !== undefined ? { sqrtPriceX96: s[0], tick: s[1], liquidity: l } : undefined;
}

/** Address the chain's Uniswap v3 factory deploys the (token0, token1, fee) pool at (CREATE2). */
export function computePoolAddress(
  chain: ChainId,
  token0: Address,
  token1: Address,
  fee: number,
): Address {
  const { factory, poolInitCodeHash } = UNISWAP_V3[chain];
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
      [token0, token1, fee],
    ),
  );
  return getContractAddress({
    opcode: 'CREATE2',
    from: factory,
    salt,
    bytecodeHash: poolInitCodeHash,
  });
}

function parseImmutables(chain: ChainId, results: readonly Outcome[]): PoolImmutables | undefined {
  const [token0, token1, fee, tickSpacing, factory] = [
    success(results[0], isString),
    success(results[1], isString),
    success(results[2], isNumber),
    success(results[3], isNumber),
    success(results[4], isString),
  ];
  if (!token0 || !token1 || fee === undefined || tickSpacing === undefined || !factory) {
    return undefined;
  }
  if (!isAddressEqual(factory as Address, UNISWAP_V3[chain].factory)) return undefined;
  return { token0: getAddress(token0), token1: getAddress(token1), fee, tickSpacing };
}

/** A contract can report any immutables; only the factory's CREATE2 address proves it is a pool. */
function isCanonicalPool(chain: ChainId, pool: Address, immutables: PoolImmutables): boolean {
  const { token0, token1, fee } = immutables;
  return isAddressEqual(pool, computePoolAddress(chain, token0, token1, fee));
}

/**
 * slot0 + liquidity, plus the immutables in the same multicall unless they are cached. Any failed
 * call, a factory() other than the chain's Uniswap v3 factory, or an address that is not the
 * factory's CREATE2 address for the reported (token0, token1, fee) means the address is not a pool.
 * Immutables are cached only after these checks pass.
 */
async function readPoolCore(
  ctx: AppContext,
  chain: ChainId,
  pool: Address,
  block: PinnedBlock,
): Promise<PoolImmutables & PoolDynamics> {
  const cached = ctx.cache.get<PoolImmutables>(immutablesKey(chain, pool));
  const functions: PoolFunction[] = cached
    ? ['slot0', 'liquidity']
    : ['slot0', 'liquidity', ...IMMUTABLE_FUNCTIONS];
  const results = await callPool(ctx, chain, pool, functions, block);
  const dynamics = parseDynamics(results[0], results[1]);
  const immutables = cached ?? parseImmutables(chain, results.slice(2));
  if (!dynamics || !immutables) throw notAPool(chain, pool);
  if (!cached && !isCanonicalPool(chain, pool, immutables)) throw notAPool(chain, pool);
  if (!cached) ctx.cache.set(immutablesKey(chain, pool), immutables, 'forever');
  return { ...immutables, ...dynamics };
}

function requireToken(info: TokenInfo | null | undefined, token: Address, pool: Address) {
  if (!info)
    throw new AppError('NOT_FOUND', `Token ${token} of pool ${pool} is not a readable ERC-20`);
  return info;
}

function requireReserve(balance: bigint | undefined, token: Address, pool: Address): bigint {
  if (balance === undefined) {
    throw new AppError('UPSTREAM_ERROR', `Could not read the ${token} balance of pool ${pool}`);
  }
  return balance;
}

/** Full state of a Uniswap v3 pool at `block`. Throws INVALID_INPUT if `pool` is not one. */
export async function readPoolState(
  ctx: AppContext,
  chain: ChainId,
  pool: Address,
  block: PinnedBlock,
): Promise<PoolState> {
  const address = getAddress(pool);
  const core = await readPoolCore(ctx, chain, address, block);
  const tokens = [core.token0, core.token1];
  const [infos, balances] = await Promise.all([
    readTokens(ctx, chain, tokens, block),
    readBalances(ctx, chain, address, tokens, block),
  ]);
  return {
    pool: address,
    token0: requireToken(infos.get(core.token0), core.token0, address),
    token1: requireToken(infos.get(core.token1), core.token1, address),
    feeTier: core.fee,
    tickSpacing: core.tickSpacing,
    sqrtPriceX96: core.sqrtPriceX96,
    tick: core.tick,
    liquidity: core.liquidity,
    reserve0: requireReserve(balances.get(core.token0), core.token0, address),
    reserve1: requireReserve(balances.get(core.token1), core.token1, address),
  };
}

async function getPool(
  ctx: AppContext,
  chain: ChainId,
  tokenA: Address,
  tokenB: Address,
  fee: number,
  block: PinnedBlock,
): Promise<Address> {
  const [pool] = await getClient(ctx, chain).multicall({
    allowFailure: false,
    blockNumber: block.number,
    contracts: [
      {
        address: UNISWAP_V3[chain].factory,
        abi: uniswapV3FactoryAbi,
        functionName: 'getPool',
        args: [tokenA, tokenB, fee],
      },
    ],
  });
  return pool;
}

/**
 * Pool address for `sel`: the given `pool` (checksummed, validated later by readPoolState), or
 * factory.getPool(tokenA, tokenB, feeTier). No pool is NOT_FOUND. Found pools are cached forever.
 */
export async function resolvePool(
  ctx: AppContext,
  chain: ChainId,
  sel: PoolSelector,
  block: PinnedBlock,
): Promise<Address> {
  if (sel.pool) return getAddress(sel.pool);
  const { tokenA, tokenB, feeTier } = sel;
  if (!tokenA || !tokenB || feeTier === undefined) {
    throw new AppError('INVALID_INPUT', 'Give either pool, or tokenA, tokenB and feeTier');
  }
  const key = poolKey(chain, tokenA, tokenB, feeTier);
  const cached = ctx.cache.get<Address>(key);
  if (cached) return cached;
  const pool = await getPool(ctx, chain, tokenA, tokenB, feeTier, block);
  if (isAddressEqual(pool, zeroAddress)) {
    throw new AppError(
      'NOT_FOUND',
      `No Uniswap v3 pool for ${tokenA} / ${tokenB} with fee tier ${feeTier} on ${chain}`,
    );
  }
  const address = getAddress(pool);
  ctx.cache.set(key, address, 'forever');
  return address;
}
