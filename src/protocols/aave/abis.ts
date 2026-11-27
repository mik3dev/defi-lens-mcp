import { parseAbi } from 'viem';

export const aaveAddressesProviderAbi = parseAbi([
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPriceOracle() view returns (address)',
]);

export const aavePoolAbi = parseAbi(['function ADDRESSES_PROVIDER() view returns (address)']);

export const aaveOracleAbi = parseAbi(['function BASE_CURRENCY_UNIT() view returns (uint256)']);
