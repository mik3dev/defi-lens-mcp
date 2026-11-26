import { isAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { alchemyUrl, CHAIN_IDS, CHAINS, getClient, NATIVE_ADDRESS } from '../../src/chains.js';
import { testContext } from '../helpers/context.js';

describe('chains', () => {
  it('has metadata for every chain', () => {
    for (const id of CHAIN_IDS) expect(CHAINS[id].chainId).toBeGreaterThan(0);
  });

  it('keeps metadata consistent with the viem chain and the chain table', () => {
    const expected = {
      ethereum: [1, 12, 'ETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'eth-mainnet'],
      base: [8453, 2, 'ETH', '0x4200000000000000000000000000000000000006', 'base-mainnet'],
      arbitrum: [42161, 0.25, 'ETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'arb-mainnet'],
      polygon: [137, 2, 'POL', '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 'polygon-mainnet'],
    } as const;
    for (const id of CHAIN_IDS) {
      const m = CHAINS[id];
      const [chainId, blockTime, symbol, wrapped, subdomain] = expected[id];
      expect(m).toMatchObject({
        id,
        chainId,
        blockTimeSeconds: blockTime,
        nativeSymbol: symbol,
        wrappedNative: wrapped,
        alchemySubdomain: subdomain,
        hubTokens: [wrapped],
      });
      expect(m.viemChain.id).toBe(chainId);
      expect(isAddress(m.wrappedNative)).toBe(true);
    }
  });

  it('exposes the native sentinel address', () => {
    expect(NATIVE_ADDRESS).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
    expect(isAddress(NATIVE_ADDRESS)).toBe(true);
  });

  it('builds Alchemy URLs from the chain subdomain', () => {
    expect(alchemyUrl('arbitrum', 'k')).toBe('https://arb-mainnet.g.alchemy.com/v2/k');
  });

  it('getClient returns the configured client', () => {
    const ctx = testContext({ ethereum: 'http://x' });
    expect(getClient(ctx, 'ethereum')).toBe(ctx.clients.ethereum);
  });

  it('getClient throws for an unconfigured chain', () =>
    expect(() => getClient(testContext({ ethereum: 'http://x' }), 'base')).toThrowError(
      expect.objectContaining({ code: 'CHAIN_NOT_CONFIGURED' }),
    ));
});
