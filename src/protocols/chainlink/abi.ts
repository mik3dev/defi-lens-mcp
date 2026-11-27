import { parseAbi } from 'viem';

/** The read functions of a Chainlink AggregatorV3Interface proxy used by the price reader. */
export const aggregatorV3Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);
