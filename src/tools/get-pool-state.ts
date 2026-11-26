import type { McpServer } from '@modelcontextprotocol/server';
import { type Address, isAddressEqual } from 'viem';
import { z } from 'zod/v4';
import type { ChainId } from '../chains.js';
import type { AppContext } from '../context.js';
import { pinBlock } from '../lib/blocks.js';
import { AppError } from '../lib/errors.js';
import { type Amount, toAmount } from '../lib/format.js';
import type { TokenInfo } from '../protocols/erc20/tokens.js';
import { sqrtPriceX96ToPrices } from '../protocols/uniswap/math.js';
import { type PoolState, readPoolState, resolvePool } from '../protocols/uniswap/pool.js';
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

const TOOL_NAME = 'get_pool_state';
const MAX_FEE = 999_999; // Uniswap v3 fees are uint24 and below 1e6 (100%)

const DESCRIPTION = [
  'Current state of a Uniswap v3 pool (Uniswap v3 only) at the latest block: tokens, fee tier,',
  'tick spacing, sqrtPriceX96, tick, active liquidity, the token balances held by the pool and its',
  'spot price in both directions (price0In1 = token1 per token0).',
  "The price is the pool's own spot price, not a market-wide or USD price.",
  'Identify the pool either by `pool`, or by `tokenA` + `tokenB` + `feeTier` (in either token order).',
].join(' ');

// Plain object on purpose: the either/or rule between `pool` and the token triple is checked in
// the handler, so the advertised JSON Schema stays a plain object.
const inputSchema = z.object({
  chain: chainSchema.describe('Chain to read from'),
  pool: addressSchema
    .optional()
    .describe('Pool address. Do not combine with tokenA/tokenB/feeTier'),
  tokenA: addressSchema.optional().describe('One token of the pair (requires tokenB and feeTier)'),
  tokenB: addressSchema.optional().describe('The other token of the pair'),
  feeTier: z
    .number()
    .int()
    .min(1)
    .max(MAX_FEE)
    .optional()
    .describe('Fee in hundredths of a basis point: usually 100, 500, 3000 or 10000'),
});

export type PoolStateInput = z.input<typeof inputSchema>;
type ParsedInput = z.output<typeof inputSchema>;

const poolStateDataSchema = z.object({
  pool: checksumAddressSchema,
  token0: tokenSchema,
  token1: tokenSchema,
  feeTier: z.number().int(),
  tickSpacing: z.number().int(),
  sqrtPriceX96: z.string(),
  tick: z.number().int(),
  liquidity: z.string(),
  price0In1: z.string(),
  price1In0: z.string(),
  reserves: z.object({
    amount0: amountSchema,
    amount1: amountSchema,
    usd0: z.number().nullable(),
    usd1: z.number().nullable(),
  }),
  tvlUsd: z.number().nullable(),
});

const outputSchema = envelope(poolStateDataSchema);

export interface PoolStateData {
  pool: Address;
  token0: TokenInfo;
  token1: TokenInfo;
  feeTier: number;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  price0In1: string;
  price1In0: string;
  reserves: { amount0: Amount; amount1: Amount; usd0: number | null; usd1: number | null };
  tvlUsd: number | null;
}

const UNINITIALIZED_WARNING =
  'Pool is not initialized: it has no price yet, prices are reported as 0';

function invalid(message: string): AppError {
  return new AppError('INVALID_INPUT', message);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}

/** Schema check (also for direct callers) plus the cross-field rule. */
function parseInput(input: PoolStateInput): ParsedInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw invalid(`Invalid input: ${describeIssues(parsed.error)}`);
  const { pool, tokenA, tokenB, feeTier } = parsed.data;
  const hasPair = tokenA !== undefined || tokenB !== undefined || feeTier !== undefined;
  if (pool && hasPair) throw invalid('Give either pool, or tokenA, tokenB and feeTier, not both');
  if (!pool && (!tokenA || !tokenB || feeTier === undefined)) {
    throw invalid('Give either pool, or all of tokenA, tokenB and feeTier');
  }
  if (tokenA && tokenB && isAddressEqual(tokenA, tokenB)) {
    throw invalid('tokenA and tokenB must be different tokens');
  }
  return parsed.data;
}

function toData(state: PoolState): PoolStateData {
  const { token0, token1 } = state;
  return {
    pool: state.pool,
    token0,
    token1,
    feeTier: state.feeTier,
    tickSpacing: state.tickSpacing,
    sqrtPriceX96: state.sqrtPriceX96.toString(),
    tick: state.tick,
    liquidity: state.liquidity.toString(),
    ...sqrtPriceX96ToPrices(state.sqrtPriceX96, token0.decimals, token1.decimals),
    reserves: {
      amount0: toAmount(state.reserve0, token0.decimals),
      amount1: toAmount(state.reserve1, token1.decimals),
      usd0: null, // USD pricing arrives in a later phase
      usd1: null,
    },
    tvlUsd: null,
  };
}

export async function getPoolState(
  ctx: AppContext,
  input: PoolStateInput,
): Promise<ToolOutput<PoolStateData>> {
  const sel = parseInput(input);
  const chain: ChainId = sel.chain;
  const block = await pinBlock(ctx, chain);
  const pool = await resolvePool(ctx, chain, sel, block);
  const state = await readPoolState(ctx, chain, pool, block);
  const warnings = state.sqrtPriceX96 === 0n ? [UNINITIALIZED_WARNING] : [];
  return ok(chain, block, toData(state), warnings);
}

export function register(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Uniswap v3 pool state',
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => runTool(ctx, TOOL_NAME, args.chain, () => getPoolState(ctx, args)),
  );
}
