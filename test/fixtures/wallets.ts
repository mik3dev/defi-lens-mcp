import type { Address } from 'viem';

/**
 * Reference wallet for token discovery on ethereum (test/chain/indexer.test.ts).
 *
 * `0x40B3…E489` is a publicly labelled exchange custody address (an EOA, no code) chosen because, at
 * PINNED.ethereum, it holds native ETH and four ERC-20s that have a Chainlink USD feed in
 * src/protocols/chainlink/feeds.ts (WETH, USDC, USDT, LINK), and because its full non-zero token
 * list (about 330 entries when chosen) stays under DISCOVERY_CANDIDATE_CAP, so discovery is not
 * truncated before it reaches the priced tokens. Most well-known addresses hold more than 1 000
 * airdropped tokens and would be truncated. Ethereum WBTC is unpriced and not counted.
 *
 * alchemy_getTokenBalances reports current state, not state at the pinned block, so the chain test
 * only asserts that the discovered set contains these tokens; their balances at the pinned block
 * are checked separately through anvil.
 */
export const DISCOVERY_WALLET: { owner: Address; pricedTokens: Record<string, Address> } = {
  owner: '0x40B38765696e3d5d8d9d834D8AaD4bB6e418E489',
  pricedTokens: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  },
};
