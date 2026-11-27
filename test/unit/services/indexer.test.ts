import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type Address,
  type Chain,
  createPublicClient,
  custom,
  getAddress,
  type PublicClient,
} from 'viem';
import { mainnet, polygon } from 'viem/chains';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChainId } from '../../../src/chains.js';
import type { AppContext } from '../../../src/context.js';
import { AppError } from '../../../src/lib/errors.js';
import {
  DISCOVERY_CANDIDATE_CAP,
  DISCOVERY_PAGE_LIMIT,
  discoverTokens,
  hasIndexer,
} from '../../../src/services/indexer.js';
import { testContext } from '../../helpers/context.js';

const OWNER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const POL_TOKEN = '0x0000000000000000000000000000000000001010';
const ZERO = `0x${'0'.repeat(64)}`;
const ONE = `0x${'0'.repeat(63)}1`;

interface Entry {
  contractAddress: string;
  tokenBalance: string | null;
}

/** Distinct test token address `i`, away from the low precompile/system range (e.g. 0x…1010). */
const token = (i: number): string => `0xa${i.toString(16).padStart(39, '0')}`;
const entries = (from: number, count: number, balance = ONE): Entry[] =>
  Array.from({ length: count }, (_, k) => ({
    contractAddress: token(from + k),
    tokenBalance: balance,
  }));

interface Scripted {
  client: PublicClient;
  calls: unknown[][];
}

/** An indexer client whose alchemy_getTokenBalances returns `pages` in order, linked by pageKey `p<n>`. */
function scriptedIndexer(pages: Entry[][], chain: Chain = mainnet): Scripted {
  const calls: unknown[][] = [];
  const client = createPublicClient({
    chain,
    transport: custom(
      {
        async request({ method, params }: { method: string; params: unknown[] }) {
          if (method !== 'alchemy_getTokenBalances') throw new Error(`unexpected ${method}`);
          calls.push(params);
          const opts = params[2] as { pageKey?: string } | undefined;
          const index = opts?.pageKey ? Number(opts.pageKey.slice(1)) : 0;
          const next = index + 1 < pages.length ? { pageKey: `p${index + 1}` } : {};
          return { address: params[0], tokenBalances: pages[index], ...next };
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;
  return { client, calls };
}

function failingIndexer(error: Error | (() => unknown)): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: custom(
      {
        async request() {
          if (typeof error === 'function') return error();
          throw error;
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;
}

function withIndexer(chain: ChainId, client: PublicClient): AppContext {
  return { ...testContext({}), indexerClients: { [chain]: client } };
}

async function caught(p: Promise<unknown>): Promise<AppError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
}

describe('hasIndexer', () => {
  it('reports whether a chain has an indexer client', () => {
    const ctx = withIndexer('base', scriptedIndexer([[]]).client);
    expect(hasIndexer(ctx, 'base')).toBe(true);
    expect(hasIndexer(ctx, 'ethereum')).toBe(false);
  });
});

describe('discoverTokens', () => {
  it('merges pages until pageKey is absent', async () => {
    const { client, calls } = scriptedIndexer([entries(0, 3), entries(3, 3)]);
    const result = await discoverTokens(withIndexer('ethereum', client), 'ethereum', OWNER);
    expect(result).toEqual({
      tokens: Array.from({ length: 6 }, (_, i) => getAddress(token(i))),
      truncated: false,
    });
    expect(calls).toEqual([
      [OWNER, 'erc20'],
      [OWNER, 'erc20', { pageKey: 'p1' }],
    ]);
  });

  it('drops zero balances', async () => {
    const page = [
      ...entries(0, 2),
      ...entries(2, 1, ZERO),
      { contractAddress: token(3), tokenBalance: '0x0' },
    ];
    const { client } = scriptedIndexer([page]);
    const { tokens } = await discoverTokens(withIndexer('ethereum', client), 'ethereum', OWNER);
    expect(tokens).toEqual([getAddress(token(0)), getAddress(token(1))]);
  });

  it('drops entries whose balance the provider could not read', async () => {
    const { client } = scriptedIndexer([
      [...entries(0, 1), { contractAddress: token(1), tokenBalance: null }],
    ]);
    const { tokens } = await discoverTokens(withIndexer('ethereum', client), 'ethereum', OWNER);
    expect(tokens).toEqual([getAddress(token(0))]);
  });

  it('excludes the native POL token contract on polygon', async () => {
    const page = [...entries(0, 1), { contractAddress: POL_TOKEN, tokenBalance: ONE }];
    const { client } = scriptedIndexer([page], polygon);
    const { tokens } = await discoverTokens(withIndexer('polygon', client), 'polygon', OWNER);
    expect(tokens).toEqual([getAddress(token(0))]);
  });

  it('keeps 0x…1010 on chains where it is not the native token', async () => {
    const { client } = scriptedIndexer([[{ contractAddress: POL_TOKEN, tokenBalance: ONE }]]);
    const { tokens } = await discoverTokens(withIndexer('ethereum', client), 'ethereum', OWNER);
    expect(tokens).toEqual([getAddress(POL_TOKEN)]);
  });

  it('stops at the candidate cap and reports truncation', async () => {
    const pages = Array.from({ length: 50 }, (_, p) => entries(p * 100, 100));
    const { client, calls } = scriptedIndexer(pages);
    const result = await discoverTokens(withIndexer('ethereum', client), 'ethereum', OWNER);
    expect(DISCOVERY_CANDIDATE_CAP).toBe(400);
    expect(result.tokens).toHaveLength(400);
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it('cuts a page that crosses the cap and reports truncation without another request', async () => {
    const { client, calls } = scriptedIndexer([entries(0, 350), entries(350, 100)]);
    const result = await discoverTokens(withIndexer('ethereum', client), 'ethereum', OWNER);
    expect(result.tokens).toEqual(Array.from({ length: 400 }, (_, i) => getAddress(token(i))));
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('reports no truncation when exactly the cap is found on the last page', async () => {
    const { client } = scriptedIndexer([entries(0, 400)]);
    const result = await discoverTokens(withIndexer('ethereum', client), 'ethereum', OWNER);
    expect(result.tokens).toHaveLength(400);
    expect(result.truncated).toBe(false);
  });

  it('stops after the page limit and reports truncation', async () => {
    const pages = Array.from({ length: DISCOVERY_PAGE_LIMIT + 5 }, (_, p) => entries(p, 1, ZERO));
    const { client, calls } = scriptedIndexer(pages);
    const result = await discoverTokens(withIndexer('ethereum', client), 'ethereum', OWNER);
    expect(result).toEqual({ tokens: [], truncated: true });
    expect(calls).toHaveLength(DISCOVERY_PAGE_LIMIT);
  });

  it('returns each token once', async () => {
    const { client } = scriptedIndexer([entries(0, 2), entries(1, 2)]);
    const { tokens } = await discoverTokens(withIndexer('ethereum', client), 'ethereum', OWNER);
    expect(tokens).toEqual([0, 1, 2].map((i) => getAddress(token(i))));
  });

  it('throws INDEXER_NOT_CONFIGURED without a client', async () => {
    const e = await caught(discoverTokens(testContext({}), 'base', OWNER));
    expect(e.code).toBe('INDEXER_NOT_CONFIGURED');
    expect(e.message).toMatch(/base/);
    expect(e.retryable).toBe(false);
  });

  it('maps a provider error to UPSTREAM_ERROR', async () => {
    const ctx = withIndexer('ethereum', failingIndexer(new Error('provider exploded')));
    const e = await caught(discoverTokens(ctx, 'ethereum', OWNER));
    expect(e.code).toBe('UPSTREAM_ERROR');
  });

  it('maps a malformed provider response to UPSTREAM_ERROR', async () => {
    const ctx = withIndexer(
      'ethereum',
      failingIndexer(() => ({ tokenBalances: 'nope' })),
    );
    const e = await caught(discoverTokens(ctx, 'ethereum', OWNER));
    expect(e.code).toBe('UPSTREAM_ERROR');
    expect(e.message).toMatch(/indexer/i);
  });

  describe('over HTTP', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await close?.();
      close = undefined;
    });

    async function serveStatus(status: number): Promise<string> {
      const server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'busy' } }),
        );
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      close = () => new Promise((r) => server.close(() => r()));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    it('maps an upstream 429 to a retryable UPSTREAM_ERROR', async () => {
      const url = await serveStatus(429);
      const ctx = testContext({}, {}, { indexerUrls: { arbitrum: url } });
      const e = await caught(discoverTokens(ctx, 'arbitrum', OWNER));
      expect(e.code).toBe('UPSTREAM_ERROR');
      expect(e.retryable).toBe(true);
    });
  });
});
