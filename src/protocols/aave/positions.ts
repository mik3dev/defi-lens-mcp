import {
  type Address,
  formatUnits,
  getAddress,
  isAddress,
  maxUint256,
  type PublicClient,
} from 'viem';
import { type ChainId, getClient } from '../../chains.js';
import type { AppContext } from '../../context.js';
import type { PinnedBlock } from '../../lib/blocks.js';
import { AppError } from '../../lib/errors.js';
import { isBigint, type Outcome, success } from '../../lib/multicall.js';
import { readTokens, type TokenInfo } from '../erc20/tokens.js';
import { aaveDataProviderAbi, aaveOracleAbi, aavePoolAbi } from './abis.js';
import { type AaveMarket, resolveMarket } from './market.js';

export interface AaveReservePosition {
  token: TokenInfo;
  supplied: bigint;
  variableDebt: bigint;
  stableDebt: bigint;
  usedAsCollateral: boolean;
  priceUsd: number;
}

export interface AaveSummary {
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  ltv: number;
  liquidationThreshold: number;
  healthFactor: number | null;
  eModeCategory: number;
}

export interface AavePosition {
  summary: AaveSummary;
  /** Only reserves with a non-zero supplied, variable debt or stable debt amount, in reserve order. */
  reserves: AaveReservePosition[];
}

/** Decimals of the oracle base currency (USD) on every supported market. */
const BASE_DECIMALS = 8;
/** One step of the health factor's 4 decimal places, in its 18-decimal fixed point. */
const HEALTH_FACTOR_STEP = 10n ** 14n;
const BPS = 10_000;

/** An amount in the oracle base currency (8 decimals) as USD. */
export function baseToUsd(value: bigint): number {
  return Number(formatUnits(value, BASE_DECIMALS));
}

/** maxUint256 (no debt) → null; otherwise raw / 1e18 rounded half up to 4 decimal places. */
export function parseHealthFactor(raw: bigint): number | null {
  if (raw === maxUint256) return null;
  return Number((raw + HEALTH_FACTOR_STEP / 2n) / HEALTH_FACTOR_STEP) / 10_000;
}

export function bpsToFraction(bps: bigint): number {
  return Number(bps) / BPS;
}

interface HeldReserve {
  asset: Address;
  supplied: bigint;
  stableDebt: bigint;
  variableDebt: bigint;
  usedAsCollateral: boolean;
}

const isBigintArray = (v: unknown): v is readonly bigint[] => Array.isArray(v) && v.every(isBigint);

type AccountData = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

const isAccountData = (v: unknown): v is AccountData => isBigintArray(v) && v.length === 6;

const isReserveList = (v: unknown): v is readonly { tokenAddress: Address }[] =>
  Array.isArray(v) &&
  v.every(
    (e: unknown) =>
      typeof e === 'object' &&
      e !== null &&
      'tokenAddress' in e &&
      typeof e.tokenAddress === 'string' &&
      isAddress(e.tokenAddress),
  );

/** getUserReserveData: [aToken balance, stable debt, variable debt, …, usageAsCollateralEnabled]. */
const isUserReserve = (v: unknown): v is readonly [bigint, bigint, bigint, ...unknown[]] =>
  Array.isArray(v) &&
  v.length === 9 &&
  isBigint(v[0]) &&
  isBigint(v[1]) &&
  isBigint(v[2]) &&
  typeof v[8] === 'boolean';

function unreadable(chain: ChainId, what: string): AppError {
  return new AppError('UPSTREAM_ERROR', `Aave v3 ${what} on ${chain} could not be read`);
}

interface SummaryRead {
  summary: AaveSummary;
  /** Underlying asset of every reserve listed in the market at the pinned block. */
  assets: Address[];
}

function toSummary(data: AccountData, eMode: bigint): AaveSummary {
  const [collateral, debt, available, liquidationThreshold, ltv, healthFactor] = data;
  return {
    totalCollateralUsd: baseToUsd(collateral),
    totalDebtUsd: baseToUsd(debt),
    availableBorrowsUsd: baseToUsd(available),
    ltv: bpsToFraction(ltv),
    liquidationThreshold: bpsToFraction(liquidationThreshold),
    healthFactor: parseHealthFactor(healthFactor),
    eModeCategory: Number(eMode),
  };
}

/** Account data, e-mode and the market's reserve list, in one multicall at the pinned block. */
async function readSummary(
  client: PublicClient,
  chain: ChainId,
  market: AaveMarket,
  user: Address,
  block: PinnedBlock,
): Promise<SummaryRead> {
  const outcomes = (await client.multicall({
    allowFailure: true,
    blockNumber: block.number,
    contracts: [
      { address: market.pool, abi: aavePoolAbi, functionName: 'getUserAccountData', args: [user] },
      { address: market.pool, abi: aavePoolAbi, functionName: 'getUserEMode', args: [user] },
      {
        address: market.dataProvider,
        abi: aaveDataProviderAbi,
        functionName: 'getAllReservesTokens',
      },
    ],
  })) as readonly Outcome[];
  const data = success(outcomes[0], isAccountData);
  const eMode = success(outcomes[1], isBigint);
  if (!data || eMode === undefined) throw unreadable(chain, 'account data');
  const list = success(outcomes[2], isReserveList);
  if (!list) throw unreadable(chain, 'reserve list');
  return { summary: toSummary(data, eMode), assets: list.map((r) => getAddress(r.tokenAddress)) };
}

/** The user's reserves with a non-zero amount; any unreadable reserve fails the whole read. */
async function readHeldReserves(
  client: PublicClient,
  chain: ChainId,
  market: AaveMarket,
  user: Address,
  assets: Address[],
  block: PinnedBlock,
): Promise<HeldReserve[]> {
  if (assets.length === 0) return [];
  const outcomes = (await client.multicall({
    allowFailure: true,
    blockNumber: block.number,
    contracts: assets.map((asset) => ({
      address: market.dataProvider,
      abi: aaveDataProviderAbi,
      functionName: 'getUserReserveData' as const,
      args: [asset, user] as const,
    })),
  })) as readonly Outcome[];
  const rows = assets.map((asset, i) => {
    const row = success(outcomes[i], isUserReserve);
    if (!row) throw unreadable(chain, `reserve ${asset}`);
    const [supplied, stableDebt, variableDebt] = row;
    return { asset, supplied, stableDebt, variableDebt, usedAsCollateral: row[8] === true };
  });
  return rows.filter((r) => r.supplied > 0n || r.stableDebt > 0n || r.variableDebt > 0n);
}

async function readPrices(
  client: PublicClient,
  chain: ChainId,
  market: AaveMarket,
  assets: Address[],
  block: PinnedBlock,
): Promise<readonly bigint[]> {
  const [outcome] = (await client.multicall({
    allowFailure: true,
    blockNumber: block.number,
    contracts: [
      {
        address: market.oracle,
        abi: aaveOracleAbi,
        functionName: 'getAssetsPrices',
        args: [assets],
      },
    ],
  })) as readonly Outcome[];
  const prices = success(outcome, isBigintArray);
  if (!prices || prices.length !== assets.length) throw unreadable(chain, 'oracle prices');
  return prices;
}

/** Token metadata and oracle price of each held reserve; an unreadable token fails the read. */
async function describeReserves(
  ctx: AppContext,
  chain: ChainId,
  market: AaveMarket,
  held: HeldReserve[],
  block: PinnedBlock,
): Promise<AaveReservePosition[]> {
  if (held.length === 0) return [];
  const assets = held.map((h) => h.asset);
  const [prices, tokens] = await Promise.all([
    readPrices(getClient(ctx, chain), chain, market, assets, block),
    readTokens(ctx, chain, assets, block),
  ]);
  return held.map(({ asset, ...amounts }, i) => {
    const token = tokens.get(asset);
    if (!token) throw unreadable(chain, `token ${asset}`);
    return { token, ...amounts, priceUsd: baseToUsd(prices[i] ?? 0n) };
  });
}

/**
 * The user's Aave v3 position on `chain` at `block`: account summary from the pool and every reserve
 * with a non-zero supplied or borrowed amount, priced by the market's oracle.
 */
export async function readAavePosition(
  ctx: AppContext,
  chain: ChainId,
  user: Address,
  block: PinnedBlock,
): Promise<AavePosition> {
  const market = await resolveMarket(ctx, chain, block);
  const client = getClient(ctx, chain);
  const { summary, assets } = await readSummary(client, chain, market, user, block);
  const held = await readHeldReserves(client, chain, market, user, assets, block);
  const reserves = await describeReserves(ctx, chain, market, held, block);
  return { summary, reserves };
}
