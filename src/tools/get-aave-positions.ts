import type { McpServer } from '@modelcontextprotocol/server';
import type { Address } from 'viem';
import { z } from 'zod/v4';
import type { ChainId } from '../chains.js';
import type { AppContext } from '../context.js';
import { pinBlock } from '../lib/blocks.js';
import { type Amount, toAmount, usdValue } from '../lib/format.js';
import { AAVE_V3_MARKET_NAME } from '../protocols/aave/addresses.js';
import {
  type AavePosition,
  type AaveReservePosition,
  type AaveSummary,
  readAavePosition,
} from '../protocols/aave/positions.js';
import type { TokenInfo } from '../protocols/erc20/tokens.js';
import {
  addressSchema,
  amountSchema,
  chainSchema,
  checksumAddressSchema,
  envelope,
  ok,
  runTool,
  type ToolOutput,
  tokenSchema,
} from './shared.js';

const TOOL_NAME = 'get_aave_positions';
const NO_DEBT_NOTE = 'no debt';
const LIQUIDATION_WARNING = 'Health factor is below 1: the position can be liquidated.';

const DESCRIPTION = [
  "An address's Aave v3 position (main Aave v3 market only) at the latest block: account summary",
  '(total collateral and debt in USD, borrowing power left, LTV, liquidation threshold, health',
  'factor, e-mode category) and every reserve it supplies or borrows (supplied amount, variable and',
  'stable debt, whether it counts as collateral).',
  'Other Aave markets on the same chain (e.g. Ethereum Prime/Lido, EtherFi) and Aave v2 are not',
  'covered: a position there reads as empty.',
  "USD values use Aave's own oracle, the prices the protocol liquidates on, not a market-wide price;",
  'a reserve USD field is null when the oracle has no usable price for it (never estimated).',
  'ltv and liquidationThreshold are fractions from 0 to 1; eModeCategory 0 means no e-mode.',
  'A health factor below 1 means the position is liquidatable; healthFactor is truncated (not',
  'rounded) to 4 decimals, so a liquidatable position never reads as 1.',
  `healthFactor is null with healthFactorNote "${NO_DEBT_NOTE}" when the address has no debt.`,
  'Reserves are sorted by supplied plus borrowed USD, largest first.',
  "Reserve tokens are the market's governance-listed assets, identified by address; their symbols",
  'are read on-chain.',
].join(' ');

const inputSchema = z.object({
  chain: chainSchema.describe('Chain to read from'),
  address: addressSchema.describe('Wallet address whose Aave v3 position to read'),
});

export type AavePositionsInput = z.input<typeof inputSchema>;

const aavePositionsDataSchema = z.object({
  address: checksumAddressSchema,
  market: z.object({ name: z.string(), pool: checksumAddressSchema }),
  priceSource: z.literal('aave-oracle'),
  summary: z.object({
    totalCollateralUsd: z.number(),
    totalDebtUsd: z.number(),
    availableBorrowsUsd: z.number(),
    ltv: z.number(),
    liquidationThreshold: z.number(),
    healthFactor: z.number().nullable(),
    healthFactorNote: z.string().nullable(),
    eModeCategory: z.number().int(),
  }),
  reserves: z.array(
    z.object({
      token: tokenSchema,
      supplied: amountSchema,
      suppliedUsd: z.number().nullable(),
      variableDebt: amountSchema,
      stableDebt: amountSchema,
      debtUsd: z.number().nullable(),
      usedAsCollateral: z.boolean(),
    }),
  ),
});

export interface AaveReserveData {
  token: TokenInfo;
  supplied: Amount;
  suppliedUsd: number | null;
  variableDebt: Amount;
  stableDebt: Amount;
  debtUsd: number | null;
  usedAsCollateral: boolean;
}

export interface AavePositionsData {
  address: Address;
  market: { name: string; pool: Address };
  priceSource: 'aave-oracle';
  summary: AaveSummary & { healthFactorNote: string | null };
  reserves: AaveReserveData[];
}

/** Identifies whose position it is and on which chain; the mapper cannot derive either. */
export interface AaveSubject {
  chain: ChainId;
  address: Address;
}

/** A zero oracle price means the oracle has no usable price: no USD value, never a guess. */
const priceOrNull = (priceUsd: number): number | null => (priceUsd > 0 ? priceUsd : null);

function toReserveData(r: AaveReservePosition): AaveReserveData {
  const { decimals } = r.token;
  const price = priceOrNull(r.priceUsd);
  return {
    token: r.token,
    supplied: toAmount(r.supplied, decimals),
    suppliedUsd: usdValue(r.supplied, decimals, price),
    variableDebt: toAmount(r.variableDebt, decimals),
    stableDebt: toAmount(r.stableDebt, decimals),
    debtUsd: usdValue(r.variableDebt + r.stableDebt, decimals, price),
    usedAsCollateral: r.usedAsCollateral,
  };
}

const exposure = (r: AaveReserveData): number => (r.suppliedUsd ?? 0) + (r.debtUsd ?? 0);

/** Pure mapping from the protocol read to the tool's data; reserves sorted by total USD exposure. */
export function toAaveData(position: AavePosition, subject: AaveSubject): AavePositionsData {
  const { summary } = position;
  return {
    address: subject.address,
    market: { name: AAVE_V3_MARKET_NAME[subject.chain], pool: position.market.pool },
    priceSource: 'aave-oracle',
    summary: {
      ...summary,
      healthFactorNote: summary.healthFactor === null ? NO_DEBT_NOTE : null,
    },
    reserves: position.reserves.map(toReserveData).sort((a, b) => exposure(b) - exposure(a)),
  };
}

export function aaveWarnings(position: AavePosition): string[] {
  const { healthFactor } = position.summary;
  const liquidatable = healthFactor !== null && healthFactor < 1 ? [LIQUIDATION_WARNING] : [];
  const unpriced = position.reserves
    .filter((r) => priceOrNull(r.priceUsd) === null)
    .map((r) => `Aave oracle has no price for token ${r.token.address}: its USD values are null`);
  return [...liquidatable, ...unpriced];
}

export async function getAavePositions(
  ctx: AppContext,
  input: AavePositionsInput,
): Promise<ToolOutput<AavePositionsData>> {
  const { chain, address } = inputSchema.parse(input);
  const block = await pinBlock(ctx, chain);
  const position = await readAavePosition(ctx, chain, address, block);
  return ok(chain, block, toAaveData(position, { chain, address }), aaveWarnings(position));
}

export function register(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Aave v3 positions',
      description: DESCRIPTION,
      inputSchema,
      outputSchema: envelope(aavePositionsDataSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => runTool(ctx, TOOL_NAME, args.chain, () => getAavePositions(ctx, args)),
  );
}
