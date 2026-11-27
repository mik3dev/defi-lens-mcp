import { parseAbi } from 'viem';

export const aaveAddressesProviderAbi = parseAbi([
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPriceOracle() view returns (address)',
]);

export const aavePoolAbi = parseAbi([
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getUserEMode(address user) view returns (uint256)',
]);

// The data provider keeps the stable-debt fields on markets that removed stable borrowing (they read 0).
export const aaveDataProviderAbi = parseAbi([
  'struct TokenData { string symbol; address tokenAddress; }',
  'function getAllReservesTokens() view returns (TokenData[])',
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
]);

export const aaveOracleAbi = parseAbi([
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
  'function getAssetsPrices(address[] assets) view returns (uint256[])',
]);
