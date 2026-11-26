import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAIN_IDS, CHAINS, type ChainId, NATIVE_ADDRESS } from '../../src/chains.js';
import type { AppContext } from '../../src/context.js';
import { pinBlock } from '../../src/lib/blocks.js';
import { readBalances, readTokens } from '../../src/protocols/erc20/tokens.js';
import { PINNED } from '../fixtures/blocks.js';
import { chainEndpoint, hasRecording, hasRpc } from '../helpers/chain-endpoint.js';
import { testContext } from '../helpers/context.js';

const WRAPPED_SYMBOL: Record<ChainId, string> = {
  ethereum: 'WETH',
  base: 'WETH',
  arbitrum: 'WETH',
  polygon: 'WPOL',
};
const MKR: Address = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2';
const DEAD: Address = '0x000000000000000000000000000000000000dEaD';
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Expected balances derived independently with `cast` at PINNED.ethereum (see `commands`). */
interface ExpectedBalances {
  block: string;
  owner: Address;
  balances: Record<Address, string>;
  commands: string[];
}

function expectedBalances(): ExpectedBalances {
  const url = new URL('../fixtures/erc20.ethereum.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ExpectedBalances;
}

describe.each(CHAIN_IDS)('erc20 on %s', (chain) => {
  const fixture = `erc20.${chain}`;

  describe.skipIf(!hasRpc() && !hasRecording(fixture))('at the pinned block', () => {
    let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;
    let ctx: AppContext;

    beforeAll(async () => {
      endpoint = await chainEndpoint(chain, fixture);
      ctx = testContext({ [chain]: endpoint.rpcUrl });
    }, 120_000);

    afterAll(async () => {
      await endpoint?.stop();
    });

    it('wrapped native token reads as the expected symbol and 18 decimals', async () => {
      const wrapped = CHAINS[chain].wrappedNative;
      const tokens = await readTokens(ctx, chain, [wrapped], await pinBlock(ctx, chain));
      expect(tokens.get(wrapped)).toEqual({
        address: wrapped,
        symbol: WRAPPED_SYMBOL[chain],
        decimals: 18,
      });
    });

    it('pinBlock returns the pinned block', async () => {
      const block = await pinBlock(ctx, chain);
      expect(block.number).toBe(PINNED[chain]);
      expect(block.timestamp).toBeGreaterThan(0n);
    });

    describe.runIf(chain === 'ethereum')('ethereum only', () => {
      it('decodes a bytes32 symbol', async () => {
        const tokens = await readTokens(ctx, chain, [MKR], await pinBlock(ctx, chain));
        expect(tokens.get(MKR)).toEqual({ address: MKR, symbol: 'MKR', decimals: 18 });
      });

      it('returns null for an address with no code', async () => {
        const tokens = await readTokens(ctx, chain, [DEAD], await pinBlock(ctx, chain));
        expect(tokens.get(DEAD)).toBeNull();
      });

      it('returns null for a contract that is not an ERC-20', async () => {
        const tokens = await readTokens(ctx, chain, [MULTICALL3], await pinBlock(ctx, chain));
        expect(tokens.get(MULTICALL3)).toBeNull();
      });

      it('resolves the native descriptor without an RPC call', async () => {
        const tokens = await readTokens(ctx, chain, [NATIVE_ADDRESS], await pinBlock(ctx, chain));
        expect(tokens.get(NATIVE_ADDRESS)).toEqual({
          address: NATIVE_ADDRESS,
          symbol: 'ETH',
          decimals: 18,
        });
      });

      it('readBalances returns native and token balances', async () => {
        const expected = expectedBalances();
        const block = await pinBlock(ctx, chain);
        expect(expected.block).toBe(block.number.toString());
        const tokens = Object.keys(expected.balances) as Address[];
        const balances = await readBalances(ctx, chain, expected.owner, tokens, block);
        expect(balances.get(NATIVE_ADDRESS)).toBeGreaterThan(0n);
        for (const token of tokens) {
          expect(balances.get(token)).toBe(BigInt(expected.balances[token] ?? ''));
        }
      });
    });
  });
});
