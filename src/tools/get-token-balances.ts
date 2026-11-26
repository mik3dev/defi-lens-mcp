import type { McpServer } from '@modelcontextprotocol/server';
import { type Address, isAddressEqual } from 'viem';
import { z } from 'zod/v4';
import { type ChainId, NATIVE_ADDRESS } from '../chains.js';
import type { AppContext } from '../context.js';
import { type PinnedBlock, pinBlock } from '../lib/blocks.js';
import { AppError } from '../lib/errors.js';
import { type Amount, toAmount, usdValue } from '../lib/format.js';
import { getUsdPrices, type Price, staleWarnings } from '../protocols/chainlink/prices.js';
import { readBalances, readTokens, type TokenInfo } from '../protocols/erc20/tokens.js';
import { discoverTokens, hasIndexer } from '../services/indexer.js';
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

const TOOL_NAME = 'get_token_balances';
const MAX_EXPLICIT_TOKENS = 100;
const MAX_TOKENS_LIMIT = 200;
const DEFAULT_MAX_TOKENS = 50;
/** Most tokens per on-chain read (one readTokens / readBalances multicall). */
const READ_CHUNK_SIZE = 100;

const DESCRIPTION = [
  'Native and ERC-20 token balances of a wallet at the latest block, with USD values.',
  'Without `tokens`, the token list is discovered from an indexer (needs ALCHEMY_API_KEY);',
  'balances, symbols and decimals are always read on-chain at one pinned block.',
  'With `tokens`, only those tokens are read (zero balances included) and no indexer is used.',
  'The native balance is always included. USD prices come from Chainlink feeds; tokens without a',
  'feed are returned with usd: null. Discovered lists can include spam or airdropped tokens.',
  `Rows are sorted native first, then by USD value, then by symbol; at most \`maxTokens\` token rows`,
  `(default ${DEFAULT_MAX_TOKENS}) are returned.`,
].join(' ');

const NO_DISCOVERY_WARNING =
  'Token discovery unavailable: set ALCHEMY_API_KEY or pass "tokens". Returning native balance only.';
const TRUNCATED_WARNING = 'More tokens exist than were scanned.';

const inputSchema = z.object({
  chain: chainSchema.describe('Chain to read from'),
  address: addressSchema.describe('Wallet address'),
  tokens: z
    .array(addressSchema)
    .max(MAX_EXPLICIT_TOKENS)
    .optional()
    .describe('ERC-20 contracts to read instead of indexer discovery (at most 100)'),
  maxTokens: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOKENS_LIMIT)
    .optional()
    .describe(`Most token rows to return, native excluded (1-200, default ${DEFAULT_MAX_TOKENS})`),
});

export type TokenBalancesInput = z.input<typeof inputSchema>;
type ParsedInput = z.output<typeof inputSchema>;

const balanceRowSchema = z.object({
  token: tokenSchema,
  balance: amountSchema,
  usd: z.number().nullable(),
  priceSource: z.enum(['chainlink']).nullable(),
});

const tokenBalancesDataSchema = z.object({
  address: checksumAddressSchema,
  discovery: z.enum(['indexer', 'explicit', 'none']),
  balances: z.array(balanceRowSchema),
  totalUsd: z.number().nullable(),
});

const outputSchema = envelope(tokenBalancesDataSchema);

export interface BalanceRow {
  token: TokenInfo;
  balance: Amount;
  usd: number | null;
  priceSource: 'chainlink' | null;
}

export type Discovery = 'indexer' | 'explicit' | 'none';

export interface TokenBalancesData {
  address: Address;
  discovery: Discovery;
  balances: BalanceRow[];
  totalUsd: number | null;
}

interface Candidates {
  discovery: Discovery;
  tokens: Address[];
  warnings: string[];
}

const isNative = (address: Address): boolean => isAddressEqual(address, NATIVE_ADDRESS);

function parseInput(input: TokenBalancesInput): ParsedInput {
  const parsed = inputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  throw new AppError('INVALID_INPUT', `Invalid input: ${issues}`);
}

function compareRows(a: BalanceRow, b: BalanceRow): number {
  const nativeOrder = Number(isNative(b.token.address)) - Number(isNative(a.token.address));
  if (nativeOrder !== 0) return nativeOrder;
  if (a.usd !== null && b.usd !== null && a.usd !== b.usd) return b.usd - a.usd;
  if ((a.usd === null) !== (b.usd === null)) return a.usd === null ? 1 : -1;
  return (
    a.token.symbol.localeCompare(b.token.symbol, 'en') ||
    a.token.address.localeCompare(b.token.address)
  );
}

/** Native first, then priced rows by USD descending, then unpriced rows by symbol. New array. */
export function sortBalances(rows: BalanceRow[]): BalanceRow[] {
  return [...rows].sort(compareRows);
}

/** Explicit tokens, deduplicated case-insensitively, without the native sentinel. */
function explicitTokens(tokens: Address[]): Address[] {
  const unique = new Map(tokens.map((t) => [t.toLowerCase(), t]));
  return [...unique.values()].filter((t) => !isNative(t));
}

async function candidatesFor(ctx: AppContext, sel: ParsedInput): Promise<Candidates> {
  if (sel.tokens) {
    return { discovery: 'explicit', tokens: explicitTokens(sel.tokens), warnings: [] };
  }
  if (!hasIndexer(ctx, sel.chain)) {
    return { discovery: 'none', tokens: [], warnings: [NO_DISCOVERY_WARNING] };
  }
  const found = await discoverTokens(ctx, sel.chain, sel.address);
  return {
    discovery: 'indexer',
    tokens: found.tokens,
    warnings: found.truncated ? [TRUNCATED_WARNING] : [],
  };
}

function chunks<T>(items: T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / READ_CHUNK_SIZE) }, (_, i) =>
    items.slice(i * READ_CHUNK_SIZE, (i + 1) * READ_CHUNK_SIZE),
  );
}

/** Runs `read` over `items` in chunks of READ_CHUNK_SIZE and merges the resulting maps. */
async function readChunked<V>(
  items: Address[],
  read: (chunk: Address[]) => Promise<Map<Address, V>>,
): Promise<Map<Address, V>> {
  const parts = await Promise.all(chunks(items).map(read));
  return new Map(parts.flatMap((part) => [...part]));
}

interface Holding {
  token: TokenInfo;
  raw: bigint;
}

/** Native plus every readable candidate with a readable balance; `skipped` counts the rest. */
async function readHoldings(
  ctx: AppContext,
  chain: ChainId,
  owner: Address,
  candidates: Address[],
  block: PinnedBlock,
): Promise<{ holdings: Holding[]; skipped: number }> {
  const all: Address[] = [NATIVE_ADDRESS, ...candidates];
  const infos = await readChunked(all, (chunk) => readTokens(ctx, chain, chunk, block));
  const readable = all.filter((a) => infos.get(a));
  const raws = await readChunked(readable, (c) => readBalances(ctx, chain, owner, c, block));
  if (raws.get(NATIVE_ADDRESS) === undefined) {
    throw new AppError('UPSTREAM_ERROR', `Could not read the native balance on ${chain}`);
  }
  const holdings = readable.flatMap((address) => {
    const token = infos.get(address);
    const raw = raws.get(address);
    return token && raw !== undefined ? [{ token, raw }] : [];
  });
  return { holdings, skipped: all.length - holdings.length };
}

function toRow(holding: Holding, price: Price | null | undefined): BalanceRow {
  const { token, raw } = holding;
  const usd = usdValue(raw, token.decimals, price?.usd ?? null);
  return {
    token,
    balance: toAmount(raw, token.decimals),
    usd,
    priceSource: usd === null ? null : 'chainlink',
  };
}

function totalOf(rows: BalanceRow[]): number | null {
  const priced = rows.flatMap((r) => (r.usd === null ? [] : [r.usd]));
  return priced.length === 0 ? null : priced.reduce((sum, usd) => sum + usd, 0);
}

/** Sorted rows capped at native + maxTokens token rows, with the cap warning when it applies. */
function capRows(
  rows: BalanceRow[],
  maxTokens: number,
): { rows: BalanceRow[]; warnings: string[] } {
  const sorted = sortBalances(rows);
  const tokens = sorted.filter((r) => !isNative(r.token.address));
  const kept = [...sorted.filter((r) => isNative(r.token.address)), ...tokens.slice(0, maxTokens)];
  const warnings =
    tokens.length > maxTokens ? [`Showing ${maxTokens} of ${tokens.length} tokens.`] : [];
  return { rows: kept, warnings };
}

export async function getTokenBalances(
  ctx: AppContext,
  input: TokenBalancesInput,
): Promise<ToolOutput<TokenBalancesData>> {
  const sel = parseInput(input);
  const chain: ChainId = sel.chain;
  const block = await pinBlock(ctx, chain);
  const candidates = await candidatesFor(ctx, sel);
  const read = await readHoldings(ctx, chain, sel.address, candidates.tokens, block);
  const keepZero = candidates.discovery === 'explicit';
  const held = read.holdings.filter((h) => keepZero || h.raw !== 0n || isNative(h.token.address));
  const addresses = held.map((h) => h.token.address);
  const prices = await getUsdPrices(ctx, chain, addresses, block);
  const capped = capRows(
    held.map((h) => toRow(h, prices.get(h.token.address))),
    sel.maxTokens ?? DEFAULT_MAX_TOKENS,
  );
  const shown = new Map(
    capped.rows.map((r) => [r.token.address, prices.get(r.token.address) ?? null]),
  );
  const symbols = new Map(capped.rows.map((r) => [r.token.address, r.token.symbol]));
  const skipped =
    read.skipped > 0
      ? [`Skipped ${read.skipped} tokens that are not readable ERC-20 contracts.`]
      : [];
  const warnings = [
    ...candidates.warnings,
    ...skipped,
    ...capped.warnings,
    ...staleWarnings(shown, symbols),
  ];
  const data = {
    address: sel.address,
    discovery: candidates.discovery,
    balances: capped.rows,
    totalUsd: totalOf(capped.rows),
  };
  return ok(chain, block, data, warnings);
}

export function register(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Wallet token balances',
      description: DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => runTool(ctx, TOOL_NAME, args.chain, () => getTokenBalances(ctx, args)),
  );
}
