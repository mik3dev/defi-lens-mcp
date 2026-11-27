import type { Address } from 'viem';
import type { ChainId } from '../../src/chains.js';

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

/**
 * Reference wallets for Aave v3 positions (test/chain/aave-positions.test.ts); expected values are in
 * test/fixtures/aave-positions.<chain>.json. Each was found with `cast logs` over the market's Pool in
 * 10-block windows (the provider's eth_getLogs range limit) just before the pinned block, keeping the
 * first candidate whose `getUserAccountData` at the pinned block fit the role:
 *
 * - borrower.ethereum: `Borrow` onBehalfOf in blocks 26_499_663–26_499_762 (event at 26_499_689); an EOA
 *   with six reserves (four collateral, two variable debts) and e-mode category 40.
 * - supplierEthereum: `Supply` onBehalfOf in blocks 26_499_713–26_499_762 (event at 26_499_761); an EOA
 *   with collateral and zero debt, plus a small supply not used as collateral.
 * - unusedEthereum: a freshly generated random address (no code, nonce 0, zero account data).
 * - borrower.base: `Borrow` onBehalfOf in blocks 62_610_961–62_611_110 (event at 62_611_058).
 * - borrower.arbitrum: `Borrow` onBehalfOf in blocks 527_782_024–527_782_323 (event at 527_782_316).
 * - borrower.polygon: `Borrow` onBehalfOf in blocks 98_004_350–98_004_499 (event at 98_004_492).
 */
export const AAVE_WALLETS: {
  borrower: Record<ChainId, Address>;
  supplierEthereum: Address;
  unusedEthereum: Address;
} = {
  borrower: {
    ethereum: '0xa18Ce9B63ac6cb0b30ed3FC97522688e432aFAe5',
    base: '0x447E34965cefA772543Df4BEd60A2ad2FA96A6C0',
    arbitrum: '0x0f66E3fb1CE72fA42ACc2122B3A232BeeEbd862b',
    polygon: '0xB5999125353DD94a5Be96B3b23B32D0aBC19f9f7',
  },
  supplierEthereum: '0x83d8b74721fa3B0b7FdfC1F93238a8A0dEF50C0B',
  unusedEthereum: '0xd0123bfa0Bc20306fbecDa51FD802f796042CAe7',
};
