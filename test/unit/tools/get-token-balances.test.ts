import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import {
  type Address,
  createPublicClient,
  custom,
  encodeAbiParameters,
  getAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import { afterEach, describe, expect, it } from 'vitest';
import { NATIVE_ADDRESS } from '../../../src/chains.js';
import type { AppContext } from '../../../src/context.js';
import { toAmount } from '../../../src/lib/format.js';
import { FEEDS } from '../../../src/protocols/chainlink/feeds.js';
import {
  type BalanceRow,
  getTokenBalances,
  register,
  sortBalances,
} from '../../../src/tools/get-token-balances.js';
import { testContext } from '../../helpers/context.js';
import { type FakeChain, type FakeContract, startFakeChain } from '../../helpers/fake-chain.js';

const BLOCK_NUMBER = 21_000_000n;
const NOW = 10_000n;
const OWNER: Address = '0x3333333333333333333333333333333333333333';
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const AAA: Address = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const ZZZ: Address = '0x1111111111111111111111111111111111111111';
const EMPTY: Address = '0x4444444444444444444444444444444444444444';
const DEAD: Address = '0x000000000000000000000000000000000000dEaD';
const NOSYM: Address = '0x5555555555555555555555555555555555555555';
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const LATEST_ROUND_DATA: Hex = '0xfeaf968c';
const GET_ETH_BALANCE: Hex = '0x4d2301cc';
const ONE_ETH = 10n ** 18n;
const NO_DISCOVERY =
  'Token discovery unavailable: set ALCHEMY_API_KEY or pass "tokens". Returning native balance only.';

let chain: FakeChain | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await chain?.stop();
  client = undefined;
  chain = undefined;
});

function feedOf(token: Address): Address {
  const config = FEEDS.ethereum[token.toLowerCase()];
  if (!config) throw new Error(`no feed for ${token}`);
  return config.feed;
}

function feed(answer: bigint, updatedAt: bigint): FakeContract {
  const round = encodeAbiParameters(
    [
      { type: 'uint80' },
      { type: 'int256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint80' },
    ],
    [1n, answer, updatedAt, updatedAt, 1n],
  );
  return { decimals: 8, raw: { [LATEST_ROUND_DATA]: round } };
}

const erc20 = (symbol: string, decimals: number, balance: bigint): FakeContract => ({
  symbol,
  decimals,
  balances: { [OWNER]: balance },
});

/** ETH at 2000 USD (stale), USDC at 1 USD; AAA, ZZZ unpriced; EMPTY holds nothing. */
const WALLET: Record<Address, FakeContract> = {
  [feedOf(NATIVE_ADDRESS)]: feed(2000n * 10n ** 8n, NOW - 5_000n),
  [feedOf(USDC)]: feed(10n ** 8n, NOW),
  [USDC]: erc20('USDC', 6, 5_000_000n),
  [AAA]: erc20('AAA', 18, 7n),
  [ZZZ]: erc20('ZZZ', 18, 9n),
  [EMPTY]: erc20('EMPTY', 18, 0n),
  [NOSYM]: { decimals: 6, balances: { [OWNER]: 1n } },
};

async function fakeContext(
  contracts: Record<Address, FakeContract> = WALLET,
  fallback?: FakeContract,
): Promise<AppContext> {
  chain = await startFakeChain({
    blockNumber: BLOCK_NUMBER,
    timestamp: NOW,
    contracts,
    ethBalances: { [OWNER]: 3n * ONE_ETH },
    fallback,
  });
  return testContext({ ethereum: chain.rpcUrl });
}

/** Distinct generated token address `i`. */
const generated = (i: number): Address => getAddress(`0xa${i.toString(16).padStart(39, '0')}`);

/** Indexer listing `count` tokens with balance 1, 100 per page; counts the requests. */
function fakeIndexer(count: number): { client: PublicClient; requests: () => number } {
  let requests = 0;
  const indexer = createPublicClient({
    chain: mainnet,
    transport: custom(
      {
        async request({ params }: { method: string; params: unknown[] }) {
          requests += 1;
          const page = Number((params[2] as { pageKey?: string } | undefined)?.pageKey ?? 0);
          const from = page * 100;
          const tokenBalances = Array.from({ length: Math.min(100, count - from) }, (_, k) => ({
            contractAddress: generated(from + k),
            tokenBalance: '0x1',
          }));
          return from + 100 < count
            ? { tokenBalances, pageKey: String(page + 1) }
            : { tokenBalances };
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;
  return { client: indexer, requests: () => requests };
}

/** Indexer returning a fixed list of contracts with balance 1. */
function listingIndexer(tokens: Address[]): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: custom({
      async request() {
        return { tokenBalances: tokens.map((t) => ({ contractAddress: t, tokenBalance: '0x1' })) };
      },
    }),
  }) as PublicClient;
}

const withIndexer = (ctx: AppContext, indexer: PublicClient): AppContext => ({
  ...ctx,
  indexerClients: { ethereum: indexer },
});

function row(address: Address, symbol: string, usd: number | null): BalanceRow {
  return {
    token: { address, symbol, decimals: 18 },
    balance: toAmount(1n, 18),
    usd,
    priceSource: usd === null ? null : 'chainlink',
  };
}

const symbols = (rows: BalanceRow[]) => rows.map((r) => r.token.symbol);

describe('sortBalances', () => {
  it('sorts native first, then priced by USD, then unpriced by symbol', () => {
    const rows = [
      row(ZZZ, 'ZZZ', null),
      row(USDC, 'USDC', 5),
      row(AAA, 'aaa', null),
      row(NATIVE_ADDRESS, 'ETH', 1),
      row(EMPTY, 'BIG', 900),
      row(NOSYM, 'BBB', null),
    ];
    expect(symbols(sortBalances(rows))).toEqual(['ETH', 'BIG', 'USDC', 'aaa', 'BBB', 'ZZZ']);
  });

  it('does not mutate its input', () => {
    const rows = Object.freeze([row(ZZZ, 'ZZZ', null), row(NATIVE_ADDRESS, 'ETH', null)]);
    const sorted = sortBalances(rows as BalanceRow[]);
    expect(symbols([...rows])).toEqual(['ZZZ', 'ETH']);
    expect(symbols(sorted)).toEqual(['ETH', 'ZZZ']);
    expect(sorted).not.toBe(rows);
  });
});

describe('getTokenBalances input rules', () => {
  const ctx = testContext({});
  const tooMany = Array.from({ length: 101 }, (_, i) => generated(i));
  const cases: [string, Record<string, unknown>][] = [
    ['a malformed address', { address: '0x1234' }],
    ['a malformed token', { address: OWNER, tokens: ['0x1234'] }],
    ['more than 100 tokens', { address: OWNER, tokens: tooMany }],
    ['maxTokens 0', { address: OWNER, maxTokens: 0 }],
    ['maxTokens 201', { address: OWNER, maxTokens: 201 }],
    ['a fractional maxTokens', { address: OWNER, maxTokens: 1.5 }],
  ];

  it.each(cases)('rejects %s with INVALID_INPUT', async (_name, fields) => {
    const input = { chain: 'ethereum', ...fields } as Parameters<typeof getTokenBalances>[1];
    await expect(getTokenBalances(ctx, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('getTokenBalances', () => {
  it('returns native only with a warning when there is no indexer and no tokens', async () => {
    const ctx = await fakeContext();
    const out = await getTokenBalances(ctx, { chain: 'ethereum', address: OWNER });
    expect(out.chain).toBe('ethereum');
    expect(out.blockNumber).toBe(BLOCK_NUMBER.toString());
    expect(out.data.discovery).toBe('none');
    expect(out.data.address).toBe(OWNER);
    expect(out.data.balances).toEqual([
      {
        token: { address: NATIVE_ADDRESS, symbol: 'ETH', decimals: 18 },
        balance: { raw: (3n * ONE_ETH).toString(), formatted: '3', decimals: 18 },
        usd: 6000,
        priceSource: 'chainlink',
      },
    ]);
    expect(out.data.totalUsd).toBe(6000);
    expect(out.warnings).toEqual([NO_DISCOVERY, 'price feed stale: ETH']);
  });

  it('prices, sorts and totals explicit tokens', async () => {
    const ctx = await fakeContext();
    const out = await getTokenBalances(ctx, {
      chain: 'ethereum',
      address: OWNER,
      tokens: [ZZZ, AAA, USDC],
    });
    expect(out.data.discovery).toBe('explicit');
    expect(symbols(out.data.balances)).toEqual(['ETH', 'USDC', 'AAA', 'ZZZ']);
    const usdc = out.data.balances[1];
    expect(usdc).toEqual({
      token: { address: USDC, symbol: 'USDC', decimals: 6 },
      balance: { raw: '5000000', formatted: '5', decimals: 6 },
      usd: 5,
      priceSource: 'chainlink',
    });
    expect(out.data.balances[2]).toMatchObject({ usd: null, priceSource: null });
    expect(out.data.totalUsd).toBe(6005);
  });

  it('returns null totalUsd when no row is priced', async () => {
    const ctx = await fakeContext({ [AAA]: WALLET[AAA] as FakeContract });
    const out = await getTokenBalances(ctx, { chain: 'ethereum', address: OWNER, tokens: [AAA] });
    expect(out.data.balances.every((r) => r.usd === null)).toBe(true);
    expect(out.data.totalUsd).toBeNull();
    expect(out.warnings).toEqual([]);
  });

  it('keeps zero balances for explicit tokens', async () => {
    const ctx = await fakeContext();
    const out = await getTokenBalances(ctx, { chain: 'ethereum', address: OWNER, tokens: [EMPTY] });
    expect(out.data.balances[1]).toMatchObject({
      token: { symbol: 'EMPTY' },
      balance: { raw: '0', formatted: '0' },
    });
  });

  it('deduplicates explicit tokens case-insensitively and ignores the native sentinel', async () => {
    const ctx = await fakeContext();
    const out = await getTokenBalances(ctx, {
      chain: 'ethereum',
      address: OWNER,
      tokens: [AAA, AAA.toLowerCase() as Address, NATIVE_ADDRESS.toLowerCase() as Address],
    });
    expect(symbols(out.data.balances)).toEqual(['ETH', 'AAA']);
  });

  it('skips unreadable tokens and counts them', async () => {
    const ctx = await fakeContext();
    const out = await getTokenBalances(ctx, {
      chain: 'ethereum',
      address: OWNER,
      tokens: [AAA, DEAD, NOSYM],
    });
    expect(symbols(out.data.balances)).toEqual(['ETH', 'AAA']);
    expect(out.warnings).toContain('Skipped 2 tokens that are not readable ERC-20 contracts.');
  });

  it('caps explicit tokens at maxTokens and says so', async () => {
    const ctx = await fakeContext();
    const out = await getTokenBalances(ctx, {
      chain: 'ethereum',
      address: OWNER,
      tokens: [ZZZ, AAA, USDC],
      maxTokens: 2,
    });
    expect(symbols(out.data.balances)).toEqual(['ETH', 'USDC', 'AAA']);
    expect(out.warnings).toContain('Showing 2 of 3 tokens.');
    expect(out.data.totalUsd).toBe(6005);
  });

  it('does not call the indexer when tokens are given', async () => {
    const indexer = fakeIndexer(10);
    const ctx = withIndexer(await fakeContext(), indexer.client);
    const out = await getTokenBalances(ctx, { chain: 'ethereum', address: OWNER, tokens: [AAA] });
    expect(out.data.discovery).toBe('explicit');
    expect(indexer.requests()).toBe(0);
  });

  it('drops discovered tokens whose balance at the pinned block is zero', async () => {
    const ctx = withIndexer(await fakeContext(), listingIndexer([EMPTY, AAA, DEAD]));
    const out = await getTokenBalances(ctx, { chain: 'ethereum', address: OWNER });
    expect(out.data.discovery).toBe('indexer');
    expect(symbols(out.data.balances)).toEqual(['ETH', 'AAA']);
    expect(out.warnings).toEqual([
      'Skipped 1 tokens that are not readable ERC-20 contracts.',
      'price feed stale: ETH',
    ]);
  });

  it('caps a wallet with thousands of discovered tokens', async () => {
    const indexer = fakeIndexer(5_000);
    const ctx = withIndexer(await fakeContext({}, erc20('SPAM', 18, 1n)), indexer.client);
    const out = await getTokenBalances(ctx, { chain: 'ethereum', address: OWNER });
    expect(out.data.balances).toHaveLength(51);
    expect(out.data.balances[0]?.token.address).toBe(NATIVE_ADDRESS);
    expect(out.warnings).toContain('Showing 50 of 400 tokens.');
    expect(out.warnings).toContain('More tokens exist than were scanned.');
    const tokenReads = new Set(chain?.callTargets.filter((t) => t.toLowerCase().startsWith('0xa')));
    expect(tokenReads.size).toBeLessThanOrEqual(400);
  });

  it('fails when the native balance cannot be read', async () => {
    const ctx = await fakeContext({ [MULTICALL3]: { raw: { [GET_ETH_BALANCE]: '0x' } } });
    await expect(
      getTokenBalances(ctx, { chain: 'ethereum', address: OWNER }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});

describe('get_token_balances over MCP', () => {
  async function connect(ctx: AppContext): Promise<Client> {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    register(server, ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const c = new Client({ name: 'test-client', version: '0.0.0' });
    await c.connect(clientTransport);
    client = c;
    return c;
  }

  it('is listed read-only with a description covering discovery, pricing and spam', async () => {
    const c = await connect(testContext({}));
    const { tools } = await c.listTools();
    const tool = tools.find((t) => t.name === 'get_token_balances');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema.type).toBe('object');
    expect(tool?.outputSchema).toBeDefined();
    expect(tool?.description).toMatch(/indexer/i);
    expect(tool?.description).toMatch(/on-chain/i);
    expect(tool?.description).toMatch(/usd: null/);
    expect(tool?.description).toMatch(/spam/i);
  });

  it('returns structured content', async () => {
    const c = await connect(await fakeContext());
    const result = await c.callTool({
      name: 'get_token_balances',
      arguments: { chain: 'ethereum', address: OWNER, tokens: [USDC] },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      chain: 'ethereum',
      data: { discovery: 'explicit', totalUsd: 6005 },
    });
  });

  it('returns a tool error for an unconfigured chain', async () => {
    const c = await connect(testContext({}));
    const result = await c.callTool({
      name: 'get_token_balances',
      arguments: { chain: 'base', address: OWNER },
    });
    expect(result.isError).toBe(true);
    const [first] = result.content as { type: string; text: string }[];
    expect(JSON.parse(first?.text ?? '{}')).toMatchObject({ code: 'CHAIN_NOT_CONFIGURED' });
  });
});
