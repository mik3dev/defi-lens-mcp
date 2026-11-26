import type { Address, Chain, PublicClient } from 'viem';
import { arbitrum, base, mainnet, polygon } from 'viem/chains';
import type { AppContext } from './context.js';
import { AppError } from './lib/errors.js';

export const CHAIN_IDS = ['ethereum', 'base', 'arbitrum', 'polygon'] as const;
export type ChainId = (typeof CHAIN_IDS)[number];

/** Sentinel address that stands for the chain's native currency. */
export const NATIVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export interface ChainMeta {
  id: ChainId;
  chainId: number;
  viemChain: Chain;
  blockTimeSeconds: number;
  nativeSymbol: string;
  wrappedNative: Address;
  hubTokens: Address[];
  alchemySubdomain: string;
}

function meta(
  id: ChainId,
  viemChain: Chain,
  blockTimeSeconds: number,
  nativeSymbol: string,
  wrappedNative: Address,
  alchemySubdomain: string,
): ChainMeta {
  return {
    id,
    chainId: viemChain.id,
    viemChain,
    blockTimeSeconds,
    nativeSymbol,
    wrappedNative,
    hubTokens: [wrappedNative], // filled in phase 4
    alchemySubdomain,
  };
}

// Wrapped-native addresses are checked on-chain by test/chain/erc20.test.ts.
export const CHAINS: Record<ChainId, ChainMeta> = {
  ethereum: meta(
    'ethereum',
    mainnet,
    12,
    'ETH',
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    'eth-mainnet',
  ),
  base: meta('base', base, 2, 'ETH', '0x4200000000000000000000000000000000000006', 'base-mainnet'),
  arbitrum: meta(
    'arbitrum',
    arbitrum,
    0.25,
    'ETH',
    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    'arb-mainnet',
  ),
  polygon: meta(
    'polygon',
    polygon,
    2,
    'POL',
    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    'polygon-mainnet',
  ),
};

/** Alchemy RPC URL for a chain. The result contains the key: treat it as a secret. */
export function alchemyUrl(chain: ChainId, apiKey: string): string {
  return `https://${CHAINS[chain].alchemySubdomain}.g.alchemy.com/v2/${apiKey}`;
}

export function getClient(ctx: AppContext, chain: ChainId): PublicClient {
  const client = ctx.clients[chain];
  if (!client) {
    throw new AppError(
      'CHAIN_NOT_CONFIGURED',
      `Chain ${chain} is not configured: set RPC_URL_${chain.toUpperCase()} or ALCHEMY_API_KEY`,
    );
  }
  return client;
}
