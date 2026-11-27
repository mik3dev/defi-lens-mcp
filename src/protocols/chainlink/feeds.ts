import type { Address } from 'viem';
import { CHAINS, type ChainId, NATIVE_ADDRESS } from '../../chains.js';

export interface FeedConfig {
  feed: Address;
  heartbeatSeconds: number;
  /** The feed's on-chain description(), e.g. 'ETH / USD'; checked by test/chain/prices.test.ts. */
  description: string;
}

type Entry = readonly [token: Address, config: FeedConfig];

function byToken(entries: readonly Entry[]): Record<string, FeedConfig> {
  return Object.fromEntries(entries.map(([token, config]) => [token.toLowerCase(), config]));
}

function feed(feedAddress: Address, heartbeatSeconds: number, description: string): FeedConfig {
  return { feed: feedAddress, heartbeatSeconds, description };
}

// Standard (non-SVR) USD proxies and heartbeats from Chainlink's price feed address pages:
// https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum&page=1
const ETHEREUM = {
  eth: feed('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', 3600, 'ETH / USD'),
  usdc: feed('0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', 82800, 'USDC / USD'),
  usdt: feed('0x3E7d1eAB13ad0104d2750B8863b489D65364e32D', 86400, 'USDT / USD'),
  dai: feed('0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9', 3600, 'DAI / USD'),
  link: feed('0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c', 3600, 'LINK / USD'),
};

// https://docs.chain.link/data-feeds/price-feeds/addresses?network=base&page=1
const BASE = {
  eth: feed('0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 1200, 'ETH / USD'),
  usdc: feed('0x7e860098F58bBFC8648a4311b374B1D669a2bc6B', 86400, 'USDC / USD'),
  usdt: feed('0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9', 86400, 'USDT / USD'),
  dai: feed('0x591e79239a7d679378eC8c847e5038150364C78F', 86400, 'DAI / USD'),
  wbtc: feed('0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E', 1200, 'WBTC / USD'),
  link: feed('0x17CAb8FE31E32f08326e5E27412894e49B0f9D65', 86400, 'LINK / USD'),
};

// https://docs.chain.link/data-feeds/price-feeds/addresses?network=arbitrum&page=1
const ARBITRUM = {
  eth: feed('0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', 1755, 'ETH / USD'),
  usdc: feed('0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3', 255, 'USDC / USD'),
  usdt: feed('0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7', 255, 'USDT / USD'),
  dai: feed('0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB', 86400, 'DAI / USD'),
  wbtc: feed('0xd0C7101eACbB49F3deCcCc166d238410D6D46d57', 86400, 'WBTC / USD'),
  link: feed('0x86E53CF1B870786351Da77A57575e79CB55812CB', 1755, 'LINK / USD'),
};

// https://docs.chain.link/data-feeds/price-feeds/addresses?network=polygon&page=1
// The POL price is served by the feed still named 'MATIC / USD' on Polygon.
const POLYGON = {
  pol: feed('0xAB594600376Ec9fD91F8e885dADF0CE036862dE0', 27, 'MATIC / USD'),
  eth: feed('0xF9680D99D6C9589e2a93a78A04A279e509205945', 27, 'ETH / USD'),
  usdc: feed('0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7', 27, 'USDC / USD'),
  usdt: feed('0x0A6513e40db6EB1b165753AD52E80663aeA50545', 27, 'USDT / USD'),
  dai: feed('0x4746DeC9e833A82EC7C2C1356372CcF2cfcD2F3D', 27, 'DAI / USD'),
  wbtc: feed('0xDE31F8bFBD8c84b5360CFACCa3539B938dd78ae6', 300, 'WBTC / USD'),
  link: feed('0xd9FFdb71EbE7496cC440152d43986Aae0AB76665', 27, 'LINK / USD'),
};

/**
 * Token → Chainlink USD feed per chain, keyed by lowercase token address. Native and wrapped native
 * share a feed; bridged USDC variants (USDC.e, USDbC) use the USDC / USD feed. Ethereum WBTC has no
 * WBTC / USD feed (only WBTC / BTC), so it is unpriced. Token addresses are checked on-chain by
 * test/chain/prices.test.ts.
 */
export const FEEDS: Record<ChainId, Record<string, FeedConfig>> = {
  ethereum: byToken([
    [NATIVE_ADDRESS, ETHEREUM.eth],
    [CHAINS.ethereum.wrappedNative, ETHEREUM.eth],
    ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ETHEREUM.usdc], // USDC
    ['0xdAC17F958D2ee523a2206206994597C13D831ec7', ETHEREUM.usdt], // USDT
    ['0x6B175474E89094C44Da98b954EedeAC495271d0F', ETHEREUM.dai], // DAI
    ['0x514910771AF9Ca656af840dff83E8264EcF986CA', ETHEREUM.link], // LINK
  ]),
  base: byToken([
    [NATIVE_ADDRESS, BASE.eth],
    [CHAINS.base.wrappedNative, BASE.eth],
    ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', BASE.usdc], // USDC
    ['0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', BASE.usdc], // USDbC (bridged USDC)
    ['0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', BASE.usdt], // USDT
    ['0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', BASE.dai], // DAI
    ['0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', BASE.wbtc], // WBTC
    ['0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196', BASE.link], // LINK
  ]),
  arbitrum: byToken([
    [NATIVE_ADDRESS, ARBITRUM.eth],
    [CHAINS.arbitrum.wrappedNative, ARBITRUM.eth],
    ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', ARBITRUM.usdc], // USDC
    ['0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', ARBITRUM.usdc], // USDC.e (bridged USDC)
    ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', ARBITRUM.usdt], // USDT (USD₮0)
    ['0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', ARBITRUM.dai], // DAI
    ['0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', ARBITRUM.wbtc], // WBTC
    ['0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', ARBITRUM.link], // LINK
  ]),
  polygon: byToken([
    [NATIVE_ADDRESS, POLYGON.pol],
    [CHAINS.polygon.wrappedNative, POLYGON.pol], // WPOL
    ['0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', POLYGON.eth], // WETH
    ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', POLYGON.usdc], // USDC
    ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', POLYGON.usdc], // USDC.e (bridged USDC)
    ['0xc2132D05D31c914a87C6611C10748AEb04B58e8F', POLYGON.usdt], // USDT (USDT0)
    ['0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', POLYGON.dai], // DAI
    ['0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', POLYGON.wbtc], // WBTC
    ['0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', POLYGON.link], // LINK
  ]),
};
