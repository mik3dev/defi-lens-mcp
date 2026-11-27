import {
  type Address,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Hex,
  isAddressEqual,
  maxUint256,
  parseAbi,
  toFunctionSelector,
} from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { AAVE_V3_ADDRESSES_PROVIDER } from '../../../../src/protocols/aave/addresses.js';
import {
  baseToUsd,
  bpsToFraction,
  parseHealthFactor,
  readAavePosition,
} from '../../../../src/protocols/aave/positions.js';
import { testContext } from '../../../helpers/context.js';
import { type FakeChain, type FakeContract, startFakeChain } from '../../../helpers/fake-chain.js';
import { rawCalls } from '../../../helpers/uniswap-fake.js';

describe('baseToUsd', () => {
  it('converts an 8-decimal base currency amount', () => {
    expect(baseToUsd(123456789000n)).toBe(1234.56789);
    expect(baseToUsd(0n)).toBe(0);
  });
});

describe('parseHealthFactor', () => {
  it('is null for maxUint256 (no debt)', () => {
    expect(parseHealthFactor(2n ** 256n - 1n)).toBeNull();
  });

  it('divides by 1e18 and truncates to 4 decimal places', () => {
    expect(parseHealthFactor(1_500000000000000000n)).toBe(1.5);
    expect(parseHealthFactor(987654321000000000n)).toBe(0.9876);
    expect(parseHealthFactor(987640000000000000n)).toBe(0.9876);
    expect(parseHealthFactor(0n)).toBe(0);
  });

  it('never reads a liquidatable position as 1', () => {
    expect(parseHealthFactor(999950000000000000n)).toBe(0.9999);
    expect(parseHealthFactor(999999999999999999n)).toBe(0.9999);
    expect(parseHealthFactor(1_000000000000000000n)).toBe(1);
  });
});

describe('bpsToFraction', () => {
  it('converts basis points to a fraction', () => {
    expect(bpsToFraction(8250n)).toBe(0.825);
    expect(bpsToFraction(0n)).toBe(0);
  });
});

const providerAbi = parseAbi([
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPriceOracle() view returns (address)',
]);
const poolAbi = parseAbi([
  'function getUserAccountData(address) view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getUserEMode(address) view returns (uint256)',
]);
const dataAbi = parseAbi([
  'struct TokenData { string symbol; address tokenAddress; }',
  'function getAllReservesTokens() view returns (TokenData[])',
  'function getUserReserveData(address asset, address user) view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint40, bool)',
]);
const oracleAbi = parseAbi(['function getAssetsPrices(address[]) view returns (uint256[])']);
const LIST_SELECTOR = toFunctionSelector('function getAllReservesTokens()');
const ACCOUNT_SELECTOR = toFunctionSelector('function getUserAccountData(address)');

const PROVIDER = AAVE_V3_ADDRESSES_PROVIDER.ethereum;
const POOL: Address = '0x0000000000000000000000000000000000000a01';
const DATA: Address = '0x0000000000000000000000000000000000000a02';
const ORACLE: Address = '0x0000000000000000000000000000000000000a03';
const USDC: Address = getAddress('0x0000000000000000000000000000000000000b01');
const WETH: Address = getAddress('0x0000000000000000000000000000000000000b02');
const IDLE: Address = getAddress('0x0000000000000000000000000000000000000b03');
const USER: Address = '0x00000000000000000000000000000000000000c1';
const block = { number: 20_000_000n, timestamp: 1n };

/** getUserReserveData answer: [aToken, stableDebt, variableDebt, …, usageAsCollateralEnabled]. */
interface ReserveRow {
  supplied: bigint;
  stableDebt?: bigint;
  variableDebt?: bigint;
  collateral?: boolean;
}

const ACCOUNT = [
  123456789000n, // totalCollateralBase: $1 234.56789
  50000000000n, // totalDebtBase: $500
  25000000000n, // availableBorrowsBase: $250
  8250n, // currentLiquidationThreshold
  8000n, // ltv
  1_500000000000000000n, // healthFactor
] as const;

const ROWS: Record<Address, ReserveRow> = {
  [USDC]: { supplied: 0n, variableDebt: 500_000000n },
  [WETH]: { supplied: 2n * 10n ** 18n, collateral: true },
  [IDLE]: { supplied: 0n },
};
const PRICES: Record<Address, bigint> = {
  [USDC]: 100000000n,
  [WETH]: 250000000000n,
  [IDLE]: 7n,
};

function find<T>(table: Record<Address, T>, address: Address): T | undefined {
  const key = (Object.keys(table) as Address[]).find((k) => isAddressEqual(k, address));
  return key === undefined ? undefined : table[key];
}

function reserveData(rows: Record<Address, ReserveRow>): (data: Hex) => Hex | undefined {
  return (data) => {
    const call = decodeFunctionData({ abi: dataAbi, data });
    if (call.functionName !== 'getUserReserveData') return undefined;
    const row = find(rows, call.args[0]);
    if (!row) return undefined;
    const { supplied, stableDebt = 0n, variableDebt = 0n, collateral = false } = row;
    const result = [supplied, stableDebt, variableDebt, 0n, 0n, 0n, 0n, 0, collateral] as const;
    return encodeFunctionResult({ abi: dataAbi, functionName: 'getUserReserveData', result });
  };
}

function assetPrices(prices: Record<Address, bigint>, drop = 0): (data: Hex) => Hex {
  return (data) => {
    const call = decodeFunctionData({ abi: oracleAbi, data });
    const result = call.args[0].map((a) => find(prices, a) ?? 0n).slice(drop);
    return encodeFunctionResult({ abi: oracleAbi, functionName: 'getAssetsPrices', result });
  };
}

interface Scenario {
  account?: readonly bigint[];
  eMode?: bigint;
  reserves?: Address[];
  rows?: Record<Address, ReserveRow>;
  priceDrop?: number;
}

function contracts(s: Scenario = {}): Record<Address, FakeContract> {
  const reserves = (s.reserves ?? [USDC, WETH, IDLE]).map((tokenAddress) => ({
    symbol: 'X',
    tokenAddress,
  }));
  return {
    [PROVIDER]: {
      raw: rawCalls(providerAbi, {
        getPool: POOL,
        getPoolDataProvider: DATA,
        getPriceOracle: ORACLE,
      }),
    },
    [POOL]: {
      raw: rawCalls(poolAbi, {
        getUserAccountData: s.account ?? ACCOUNT,
        getUserEMode: s.eMode ?? 1n,
      }),
    },
    [DATA]: {
      raw: rawCalls(dataAbi, { getAllReservesTokens: reserves }),
      respond: reserveData(s.rows ?? ROWS),
    },
    [ORACLE]: { raw: {}, respond: assetPrices(PRICES, s.priceDrop) },
    [USDC]: { symbol: 'USDC', decimals: 6 },
    [WETH]: { symbol: 'WETH', decimals: 18 },
    [IDLE]: { symbol: 'IDLE', decimals: 18 },
  };
}

describe('readAavePosition (fake chain)', () => {
  let chain: FakeChain | undefined;
  afterEach(async () => {
    await chain?.stop();
  });

  async function setup(table: Record<Address, FakeContract>) {
    chain = await startFakeChain({ blockNumber: block.number, contracts: table });
    return testContext({ ethereum: chain.rpcUrl });
  }

  it('converts the account data into the summary', async () => {
    const ctx = await setup(contracts());
    const { summary } = await readAavePosition(ctx, 'ethereum', USER, block);
    expect(summary).toEqual({
      totalCollateralUsd: 1234.56789,
      totalDebtUsd: 500,
      availableBorrowsUsd: 250,
      ltv: 0.8,
      liquidationThreshold: 0.825,
      healthFactor: 1.5,
      eModeCategory: 1,
    });
  });

  it('keeps only reserves with a non-zero amount, in reserve order, with token and price', async () => {
    const ctx = await setup(contracts());
    const { reserves } = await readAavePosition(ctx, 'ethereum', USER, block);
    expect(reserves).toEqual([
      {
        token: { address: USDC, symbol: 'USDC', decimals: 6 },
        supplied: 0n,
        variableDebt: 500_000000n,
        stableDebt: 0n,
        usedAsCollateral: false,
        priceUsd: 1,
      },
      {
        token: { address: WETH, symbol: 'WETH', decimals: 18 },
        supplied: 2n * 10n ** 18n,
        variableDebt: 0n,
        stableDebt: 0n,
        usedAsCollateral: true,
        priceUsd: 2500,
      },
    ]);
  });

  it('keeps a reserve whose only amount is stable debt', async () => {
    const rows = { ...ROWS, [IDLE]: { supplied: 0n, stableDebt: 3n } };
    const ctx = await setup(contracts({ rows }));
    const { reserves } = await readAavePosition(ctx, 'ethereum', USER, block);
    expect(reserves.map((r) => [r.token.symbol, r.stableDebt])).toEqual([
      ['USDC', 0n],
      ['WETH', 0n],
      ['IDLE', 3n],
    ]);
  });

  it('an address with no position: null health factor, empty reserves, no oracle read', async () => {
    const ctx = await setup(
      contracts({
        account: [0n, 0n, 0n, 0n, 0n, maxUint256],
        eMode: 0n,
        rows: { [USDC]: { supplied: 0n }, [WETH]: { supplied: 0n }, [IDLE]: { supplied: 0n } },
      }),
    );
    const position = await readAavePosition(ctx, 'ethereum', USER, block);
    expect(position.summary).toEqual({
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      availableBorrowsUsd: 0,
      ltv: 0,
      liquidationThreshold: 0,
      healthFactor: null,
      eModeCategory: 0,
    });
    expect(position.reserves).toEqual([]);
    expect(chain?.callTargets.some((t) => isAddressEqual(t, ORACLE))).toBe(false);
  });

  it('reads every call at the pinned block', async () => {
    const ctx = await setup(contracts());
    await readAavePosition(ctx, 'ethereum', USER, block);
    expect(new Set(chain?.callBlocks)).toEqual(new Set([block.number]));
  });

  it('reads the reserve list at the pinned block on every call, in the summary multicall', async () => {
    const table = contracts();
    const ctx = await setup(table);
    const listReads: { block: bigint | undefined; request: number }[] = [];
    const accountReads: number[] = [];
    // eth_call count so far: identifies the multicall each inner call arrived in.
    const requestCount = (): number => chain?.callBlocks.length ?? 0;
    const watch = (s: Scenario): Record<Address, FakeContract> => {
      const t = contracts(s);
      const data = t[DATA] as FakeContract;
      const pool = t[POOL] as FakeContract;
      return {
        [DATA]: {
          ...data,
          respond: (callData) => {
            if (callData.startsWith(LIST_SELECTOR)) {
              listReads.push({ block: chain?.callBlocks.at(-1), request: requestCount() });
            }
            return data.respond?.(callData);
          },
        },
        [POOL]: {
          ...pool,
          respond: (callData) => {
            if (callData.startsWith(ACCOUNT_SELECTOR)) accountReads.push(requestCount());
            return undefined;
          },
        },
      };
    };
    Object.assign(table, watch({}));
    await readAavePosition(ctx, 'ethereum', USER, block);
    // A reserve delisted before the next block is gone from the next call's read.
    Object.assign(table, watch({ reserves: [USDC] }));
    const later = { ...block, number: block.number + 1n };
    const position = await readAavePosition(ctx, 'ethereum', USER, later);
    expect(position.reserves.map((r) => r.token.address)).toEqual([USDC]);
    expect(listReads.map((r) => r.block)).toEqual([block.number, later.number]);
    expect(listReads.map((r) => r.request)).toEqual(accountReads);
  });

  it('throws UPSTREAM_ERROR when the account data call fails', async () => {
    const table = { ...contracts(), [POOL]: { revert: true } };
    const ctx = await setup(table);
    await expect(readAavePosition(ctx, 'ethereum', USER, block)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('throws UPSTREAM_ERROR when the reserve list cannot be read', async () => {
    const table = contracts();
    const ctx = await setup({ ...table, [DATA]: { raw: {}, respond: reserveData(ROWS) } });
    await expect(readAavePosition(ctx, 'ethereum', USER, block)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('throws UPSTREAM_ERROR when one reserve cannot be read', async () => {
    const rows = { [USDC]: ROWS[USDC] as ReserveRow, [WETH]: ROWS[WETH] as ReserveRow };
    const ctx = await setup(contracts({ rows }));
    await expect(readAavePosition(ctx, 'ethereum', USER, block)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('throws UPSTREAM_ERROR when a held token is not a readable ERC-20', async () => {
    const ctx = await setup({ ...contracts(), [WETH]: { revert: true } });
    await expect(readAavePosition(ctx, 'ethereum', USER, block)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('throws UPSTREAM_ERROR when the oracle returns the wrong number of prices', async () => {
    const ctx = await setup(contracts({ priceDrop: 1 }));
    await expect(readAavePosition(ctx, 'ethereum', USER, block)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  it('throws UPSTREAM_ERROR when the oracle call fails', async () => {
    const ctx = await setup({ ...contracts(), [ORACLE]: { revert: true } });
    await expect(readAavePosition(ctx, 'ethereum', USER, block)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });
});
