import { readFileSync } from 'node:fs';
import { type Address, isAddressEqual } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAIN_IDS, CHAINS, type ChainId, NATIVE_ADDRESS } from '../../src/chains.js';
import type { AppContext } from '../../src/context.js';
import { type BalanceRow, getTokenBalances } from '../../src/tools/get-token-balances.js';
import { PINNED } from '../fixtures/blocks.js';
import { DISCOVERY_WALLET } from '../fixtures/wallets.js';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { testContext } from '../helpers/context.js';

/** One expected row, derived independently with `cast` at the pinned block (see `commands`). */
interface ExpectedRow {
  address: Address;
  symbol: string;
  decimals: number;
  raw: string;
  formatted?: string;
  price?: string;
}

interface Expected {
  block: string;
  owner: Address;
  rows: ExpectedRow[];
  commands: string[];
}

function expected(chain: ChainId): Expected {
  const url = new URL(`../fixtures/token-balances.${chain}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Expected;
}

function rowOf(rows: BalanceRow[], address: Address): BalanceRow | undefined {
  return rows.find((r) => isAddressEqual(r.token.address, address));
}

const tokensOf = (rows: ExpectedRow[]): Address[] =>
  rows.map((r) => r.address).filter((a) => !isAddressEqual(a, NATIVE_ADDRESS));

describe.each(CHAIN_IDS)('get_token_balances on %s', (chain) => {
  const fixture = `token-balances.${chain}`;
  const want = expected(chain);
  let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;

  beforeAll(async () => {
    endpoint = await chainEndpoint(chain, fixture);
  }, 120_000);

  afterAll(async () => {
    await endpoint?.stop();
  });

  // A fresh context per test; chain reads and indexer requests share the local endpoint, which in
  // fork mode forwards alchemy_* methods to the indexer and everything else to anvil.
  const fresh = (): AppContext => {
    if (!endpoint) throw new Error('endpoint not started');
    return testContext(
      { [chain]: endpoint.rpcUrl },
      {},
      { indexerUrls: { [chain]: endpoint.rpcUrl } },
    );
  };

  it('reads native and wrapped native for explicit tokens, matching cast', async () => {
    const wrapped = CHAINS[chain].wrappedNative;
    const out = await getTokenBalances(fresh(), {
      chain,
      address: want.owner,
      tokens: [wrapped],
    });
    expect(out.blockNumber).toBe(PINNED[chain].toString());
    expect(want.block).toBe(PINNED[chain].toString());
    expect(out.data.discovery).toBe('explicit');
    for (const address of [NATIVE_ADDRESS, wrapped] as Address[]) {
      const wanted = want.rows.find((r) => isAddressEqual(r.address, address));
      expect(rowOf(out.data.balances, address)?.balance.raw).toBe(wanted?.raw);
      expect(rowOf(out.data.balances, address)?.token.symbol).toBe(wanted?.symbol);
    }
  });

  // A plain conditional, not runIf: the other chains must not report skipped tests.
  if (chain === 'ethereum')
    describe('ethereum reference wallet', () => {
      it('explicit tokens match cast balances and Chainlink prices at the pinned block', async () => {
        expect(want.owner).toBe(DISCOVERY_WALLET.owner);
        const out = await getTokenBalances(fresh(), {
          chain,
          address: want.owner,
          tokens: tokensOf(want.rows),
        });
        expect(out.blockNumber).toBe(want.block);
        expect(out.data.balances).toHaveLength(want.rows.length);
        for (const wanted of want.rows) {
          const got = rowOf(out.data.balances, wanted.address);
          expect(got?.balance.raw).toBe(wanted.raw);
          expect(got?.token).toEqual({
            address: wanted.address,
            symbol: wanted.symbol,
            decimals: wanted.decimals,
          });
          expect(got?.usd).toBe(Number(wanted.formatted) * Number(wanted.price));
          expect(got?.priceSource).toBe('chainlink');
        }
        const total = out.data.balances.reduce((sum, r) => sum + (r.usd ?? 0), 0);
        expect(out.data.totalUsd).toBe(total);
        expect(out.warnings).toEqual([]);
      });

      it('discovery contains every token from the explicit test', async () => {
        const out = await getTokenBalances(fresh(), { chain, address: want.owner });
        expect(out.data.discovery).toBe('indexer');
        expect(out.blockNumber).toBe(want.block);
        for (const wanted of want.rows) {
          expect(rowOf(out.data.balances, wanted.address)?.balance.raw).toBe(wanted.raw);
        }
      });
    });
});
