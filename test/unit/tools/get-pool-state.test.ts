import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import type { Address } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../../src/context.js';
import { getPoolState, register } from '../../../src/tools/get-pool-state.js';
import { testContext } from '../../helpers/context.js';
import { type FakeChain, startFakeChain } from '../../helpers/fake-chain.js';
import {
  FACTORY,
  fakeFactory,
  fakePool,
  fakeTokens,
  POOL,
  USDC,
  WETH,
} from '../../helpers/uniswap-fake.js';

const BLOCK_NUMBER = 21_000_000n;

let chain: FakeChain | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await chain?.stop();
  client = undefined;
  chain = undefined;
});

async function fakeContext(sqrtPriceX96?: bigint): Promise<AppContext> {
  chain = await startFakeChain({
    blockNumber: BLOCK_NUMBER,
    contracts: {
      [POOL]: fakePool(sqrtPriceX96 === undefined ? {} : { sqrtPriceX96 }),
      [FACTORY]: fakeFactory(POOL),
      ...fakeTokens(2_500_000_000n, 10n ** 18n),
    },
  });
  return testContext({ ethereum: chain.rpcUrl });
}

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

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content[0]?.text ?? '';
}

describe('getPoolState input rules', () => {
  // No clients configured: any rule that reached the chain would fail with CHAIN_NOT_CONFIGURED.
  const ctx = testContext({});
  const cases: [string, Record<string, unknown>][] = [
    ['pool together with tokenA', { pool: POOL, tokenA: WETH }],
    ['pool together with feeTier', { pool: POOL, feeTier: 500 }],
    ['tokenA without feeTier', { tokenA: WETH, tokenB: USDC }],
    ['tokenA without tokenB', { tokenA: WETH, feeTier: 500 }],
    ['nothing to identify the pool', {}],
    ['the same token twice', { tokenA: WETH, tokenB: WETH.toLowerCase(), feeTier: 500 }],
    ['a malformed address', { pool: '0x1234' }],
    ['a bad checksum', { pool: '0x88E6A0c2dDD26FEEb64F039a2c41296FcB3f5640' }],
    ['a non-integer fee tier', { tokenA: WETH, tokenB: USDC, feeTier: 5.5 }],
  ];

  it.each(cases)('rejects %s with INVALID_INPUT', async (_name, fields) => {
    const input = { chain: 'ethereum', ...fields } as Parameters<typeof getPoolState>[1];
    await expect(getPoolState(ctx, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('getPoolState', () => {
  it('returns the pool state envelope by pool address', async () => {
    const ctx = await fakeContext();
    const out = await getPoolState(ctx, { chain: 'ethereum', pool: POOL });
    expect(out).toMatchObject({
      chain: 'ethereum',
      blockNumber: String(BLOCK_NUMBER),
      blockTimestamp: '1970-01-01T00:00:01.000Z',
      warnings: [],
    });
    expect(out.data).toEqual({
      pool: POOL,
      token0: { address: USDC, symbol: 'USDC', decimals: 6 },
      token1: { address: WETH, symbol: 'WETH', decimals: 18 },
      feeTier: 500,
      tickSpacing: 10,
      sqrtPriceX96: (20_000n * 2n ** 96n).toString(),
      tick: 198_079,
      liquidity: '123456789',
      price0In1: '0.0004',
      price1In0: '2500',
      reserves: {
        amount0: { raw: '2500000000', formatted: '2500', decimals: 6 },
        amount1: { raw: '1000000000000000000', formatted: '1', decimals: 18 },
        usd0: null,
        usd1: null,
      },
      tvlUsd: null,
    });
  });

  it('resolves the pool by tokens and fee tier', async () => {
    const ctx = await fakeContext();
    const lowerWeth = WETH.toLowerCase() as Address;
    const out = await getPoolState(ctx, {
      chain: 'ethereum',
      tokenA: lowerWeth,
      tokenB: USDC,
      feeTier: 500,
    });
    expect(out.data.pool).toBe(POOL);
  });

  it('returns the pool when a token has no symbol()', async () => {
    chain = await startFakeChain({
      blockNumber: BLOCK_NUMBER,
      contracts: {
        [POOL]: fakePool(),
        ...fakeTokens(2_500_000_000n, 10n ** 18n),
        [USDC]: { decimals: 6, balances: { [POOL]: 2_500_000_000n } },
      },
    });
    const ctx = testContext({ ethereum: chain.rpcUrl });
    const out = await getPoolState(ctx, { chain: 'ethereum', pool: POOL });
    expect(out.data.token0).toEqual({ address: USDC, symbol: 'UNKNOWN', decimals: 6 });
    expect(out.data.token1.symbol).toBe('WETH');
  });

  it('warns when the pool is not initialized', async () => {
    const ctx = await fakeContext(0n);
    const out = await getPoolState(ctx, { chain: 'ethereum', pool: POOL });
    expect(out.data.price0In1).toBe('0');
    expect(out.warnings).toEqual([expect.stringContaining('not initialized')]);
  });
});

describe('get_pool_state registration', () => {
  it('advertises a plain-object input schema, an output schema and read-only annotations', async () => {
    const c = await connect(testContext({}));
    const { tools } = await c.listTools();
    const tool = tools.find((t) => t.name === 'get_pool_state');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool?.inputSchema).toMatchObject({ type: 'object' });
    expect(tool?.inputSchema).not.toHaveProperty('anyOf');
    expect(tool?.inputSchema).not.toHaveProperty('oneOf');
    expect(tool?.outputSchema).toMatchObject({ type: 'object' });
    expect(tool?.description).toMatch(/Uniswap v3 only/);
    expect(tool?.description).toMatch(/not a market-wide or USD price/);
  });

  it('returns structured content that satisfies the output schema', async () => {
    const c = await connect(await fakeContext());
    const result = await c.callTool({
      name: 'get_pool_state',
      arguments: { chain: 'ethereum', pool: POOL },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ data: { pool: POOL, feeTier: 500 } });
  });

  it('surfaces a cross-field violation as an INVALID_INPUT tool error', async () => {
    const c = await connect(testContext({}));
    const result = await c.callTool({
      name: 'get_pool_state',
      arguments: { chain: 'ethereum', pool: POOL, tokenA: WETH },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ code: 'INVALID_INPUT', retryable: false });
  });

  it('surfaces a schema violation as a tool error, not a protocol error', async () => {
    const c = await connect(testContext({}));
    const result = await c.callTool({
      name: 'get_pool_state',
      arguments: { chain: 'ethereum', pool: '0x88E6A0c2dDD26FEEb64F039a2c41296FcB3f5640' },
    });
    expect(result.isError).toBe(true);
  });
});
