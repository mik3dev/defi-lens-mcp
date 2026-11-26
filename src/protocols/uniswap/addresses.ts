import type { Address } from 'viem';
import type { ChainId } from '../../chains.js';

export interface UniswapV3Deployment {
  factory: Address;
  positionManager: Address;
  quoterV2: Address;
}

// Checked on-chain by test/chain/pool-state.test.ts (periphery factory() equals `factory`).
export const UNISWAP_V3: Record<ChainId, UniswapV3Deployment> = {
  // Source: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
  ethereum: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  },
  // Source: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments
  base: {
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  },
  // Source: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments
  arbitrum: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  },
  // Source: https://developers.uniswap.org/docs/protocols/v3/deployments/v3-polygon-deployments
  polygon: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  },
};

/** Fee tiers enabled on every supported chain, in hundredths of a basis point. */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
