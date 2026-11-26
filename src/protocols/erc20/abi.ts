import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
]);

/** Legacy tokens (e.g. MKR) return `symbol` as bytes32; same selector, different return type. */
export const erc20Bytes32Abi = parseAbi(['function symbol() view returns (bytes32)']);

/** Multicall3 helper used to read native balances inside the same multicall as token balances. */
export const multicall3EthBalanceAbi = parseAbi([
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
