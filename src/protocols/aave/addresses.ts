import type { Address } from 'viem';
import type { ChainId } from '../../chains.js';

// PoolAddressesProvider of each Aave v3 market, from the official address book:
// https://github.com/aave-dao/aave-address-book (src/AaveV3<Chain>.sol, POOL_ADDRESSES_PROVIDER);
// listed at https://aave.com/docs/resources/addresses.
// Checked on-chain by test/chain/aave-market.test.ts: the resolved pool's ADDRESSES_PROVIDER()
// equals the address below and the resolved oracle is USD-denominated with 8 decimals.
export const AAVE_V3_ADDRESSES_PROVIDER: Record<ChainId, Address> = {
  ethereum: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
  arbitrum: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
  base: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
  polygon: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
};

/** Display name of the market behind each provider. */
export const AAVE_V3_MARKET_NAME: Record<ChainId, string> = {
  ethereum: 'Aave v3 Core',
  arbitrum: 'Aave v3 Arbitrum',
  base: 'Aave v3 Base',
  polygon: 'Aave v3 Polygon',
};
