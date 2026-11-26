import {
  type Abi,
  type Address,
  encodeFunctionResult,
  getAbiItem,
  type Hex,
  toFunctionSelector,
  zeroAddress,
} from 'viem';
import { uniswapV3FactoryAbi, uniswapV3PoolAbi } from '../../src/protocols/uniswap/abis.js';
import { UNISWAP_V3 } from '../../src/protocols/uniswap/addresses.js';
import type { FakeContract } from './fake-chain.js';

export const Q96 = 2n ** 96n;
export const POOL: Address = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
export const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const FACTORY: Address = UNISWAP_V3.ethereum.factory;

/** Encodes `results` (function name → return value) as fake-chain raw answers keyed by selector. */
export function rawCalls(abi: Abi, results: Record<string, unknown>): Record<Hex, Hex> {
  return Object.fromEntries(
    Object.entries(results).map(([name, result]) => {
      const item = getAbiItem({ abi, name } as never);
      const selector = toFunctionSelector(item as never).toLowerCase() as Hex;
      return [selector, encodeFunctionResult({ abi, functionName: name, result } as never)];
    }),
  );
}

export interface FakePoolOptions {
  sqrtPriceX96?: bigint;
  tick?: number;
  liquidity?: bigint;
  token0?: Address;
  token1?: Address;
  fee?: number;
  tickSpacing?: number;
  factory?: Address;
}

/** A contract that answers the Uniswap v3 pool reads. Defaults: USDC/WETH 0.05%, 1 WETH = 2500 USDC. */
export function fakePool(opts: FakePoolOptions = {}): FakeContract {
  return {
    raw: rawCalls(uniswapV3PoolAbi, {
      slot0: [opts.sqrtPriceX96 ?? 20_000n * Q96, opts.tick ?? 198_079, 0, 1, 1, 0, true],
      liquidity: opts.liquidity ?? 123_456_789n,
      token0: opts.token0 ?? USDC,
      token1: opts.token1 ?? WETH,
      fee: opts.fee ?? 500,
      tickSpacing: opts.tickSpacing ?? 10,
      factory: opts.factory ?? FACTORY,
    }),
  };
}

/** A factory whose getPool returns `pool` for any arguments (zero address = no pool). */
export function fakeFactory(pool: Address = zeroAddress): FakeContract {
  return { raw: rawCalls(uniswapV3FactoryAbi, { getPool: pool }) };
}

/** USDC and WETH token contracts holding the given pool balances. */
export function fakeTokens(reserve0: bigint, reserve1: bigint): Record<Address, FakeContract> {
  return {
    [USDC]: { symbol: 'USDC', decimals: 6, balances: { [POOL]: reserve0 } },
    [WETH]: { symbol: 'WETH', decimals: 18, balances: { [POOL]: reserve1 } },
  };
}
