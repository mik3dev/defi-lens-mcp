import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getClient, NATIVE_ADDRESS } from '../../src/chains.js';
import type { AppContext } from '../../src/context.js';
import { pinBlock } from '../../src/lib/blocks.js';
import { FEEDS } from '../../src/protocols/chainlink/feeds.js';
import { readBalances } from '../../src/protocols/erc20/tokens.js';
import { discoverTokens } from '../../src/services/indexer.js';
import { PINNED } from '../fixtures/blocks.js';
import { DISCOVERY_WALLET } from '../fixtures/wallets.js';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { testContext } from '../helpers/context.js';

const chain = 'ethereum';
const { owner, pricedTokens } = DISCOVERY_WALLET;
const priced = Object.values(pricedTokens);

describe('indexer token discovery on ethereum', () => {
  let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;

  beforeAll(async () => {
    endpoint = await chainEndpoint(chain, `indexer.${chain}`);
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

  it('the reference wallet is an EOA holding native and at least 3 priced tokens at the pinned block', async () => {
    const c = fresh();
    const block = await pinBlock(c, chain);
    expect(block.number).toBe(PINNED[chain]);
    expect(priced.length).toBeGreaterThanOrEqual(3);
    for (const token of priced) expect(FEEDS[chain][token.toLowerCase()]).toBeDefined();
    const code = await getClient(c, chain).getCode({ address: owner, blockNumber: block.number });
    expect(code ?? '0x').toBe('0x');
    const balances = await readBalances(c, chain, owner, [NATIVE_ADDRESS, ...priced], block);
    for (const token of [NATIVE_ADDRESS, ...priced] as Address[]) {
      expect(balances.get(token)).toBeGreaterThan(0n);
    }
  });

  // alchemy_getTokenBalances is not block-pinned (current state): assert only the stable part.
  it('discovers every priced token the reference wallet holds', async () => {
    const { tokens } = await discoverTokens(fresh(), chain, owner);
    expect(tokens).toEqual(expect.arrayContaining(priced));
  });
});
