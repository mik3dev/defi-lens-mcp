import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { AaveMarket } from '../../../src/protocols/aave/market.js';
import type {
  AavePosition,
  AaveReservePosition,
  AaveSummary,
} from '../../../src/protocols/aave/positions.js';
import { aaveWarnings, toAaveData } from '../../../src/tools/get-aave-positions.js';

const USER: Address = '0x3333333333333333333333333333333333333333';
const MARKET: AaveMarket = {
  pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  dataProvider: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD',
  oracle: '0x54586bE62E3c3580375aE3723C145253060Ca0C2',
};
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI: Address = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

const SUMMARY: AaveSummary = {
  totalCollateralUsd: 4000,
  totalDebtUsd: 600,
  availableBorrowsUsd: 2000,
  ltv: 0.8,
  liquidationThreshold: 0.825,
  healthFactor: 5.5,
  eModeCategory: 0,
};

function reserve(
  address: Address,
  symbol: string,
  decimals: number,
  amounts: Partial<AaveReservePosition>,
): AaveReservePosition {
  return {
    token: { address, symbol, decimals },
    supplied: 0n,
    variableDebt: 0n,
    stableDebt: 0n,
    usedAsCollateral: false,
    priceUsd: 1,
    ...amounts,
  };
}

const position = (reserves: AaveReservePosition[], summary = SUMMARY): AavePosition => ({
  summary,
  reserves,
});
const map = (p: AavePosition) => toAaveData(p, MARKET, { chain: 'ethereum', address: USER });

describe('toAaveData', () => {
  it('describes the market and price source', () => {
    const data = map(position([]));
    expect(data.address).toBe(USER);
    expect(data.market).toEqual({ name: 'Aave v3 Core', pool: MARKET.pool });
    expect(data.priceSource).toBe('aave-oracle');
  });

  it('sets healthFactorNote to "no debt" when healthFactor is null', () => {
    const data = map(position([], { ...SUMMARY, healthFactor: null }));
    expect(data.summary.healthFactor).toBeNull();
    expect(data.summary.healthFactorNote).toBe('no debt');
  });

  it('leaves healthFactorNote null when there is a health factor', () => {
    expect(map(position([])).summary.healthFactorNote).toBeNull();
  });

  it('computes suppliedUsd and debtUsd from amounts and priceUsd', () => {
    const data = map(
      position([
        reserve(WETH, 'WETH', 18, { supplied: 2n * 10n ** 18n, priceUsd: 2000 }),
        reserve(USDC, 'USDC', 6, { variableDebt: 500_000_000n, stableDebt: 100_000_000n }),
      ]),
    );
    const [weth, usdc] = data.reserves;
    expect(weth?.suppliedUsd).toBe(4000);
    expect(weth?.debtUsd).toBe(0);
    expect(usdc?.suppliedUsd).toBe(0);
    expect(usdc?.debtUsd).toBe(600);
    expect(usdc?.variableDebt).toEqual({ raw: '500000000', formatted: '500', decimals: 6 });
    expect(usdc?.stableDebt).toEqual({ raw: '100000000', formatted: '100', decimals: 6 });
  });

  it('sorts reserves by total USD exposure', () => {
    const data = map(
      position([
        reserve(USDC, 'USDC', 6, { supplied: 10_000_000n }),
        reserve(WETH, 'WETH', 18, { supplied: 10n ** 18n, priceUsd: 2000 }),
        reserve(DAI, 'DAI', 18, { variableDebt: 500n * 10n ** 18n, supplied: 10n ** 18n }),
      ]),
    );
    expect(data.reserves.map((r) => r.token.symbol)).toEqual(['WETH', 'DAI', 'USDC']);
  });

  it('reports null USD for a reserve with no oracle price and treats it as 0 when sorting', () => {
    const data = map(
      position([
        reserve(DAI, 'DAI', 18, { supplied: 10n ** 18n, priceUsd: 0 }),
        reserve(USDC, 'USDC', 6, { supplied: 1_000_000n }),
      ]),
    );
    expect(data.reserves.map((r) => r.token.symbol)).toEqual(['USDC', 'DAI']);
    expect(data.reserves[1]?.suppliedUsd).toBeNull();
    expect(data.reserves[1]?.debtUsd).toBeNull();
  });
});

describe('aaveWarnings', () => {
  it('is empty for a healthy position', () => {
    expect(aaveWarnings(position([reserve(USDC, 'USDC', 6, { supplied: 1n })]))).toEqual([]);
  });

  it('warns when the health factor is below 1', () => {
    const warnings = aaveWarnings(position([], { ...SUMMARY, healthFactor: 0.97 }));
    expect(warnings).toEqual(['Health factor is below 1: the position can be liquidated.']);
  });

  it('does not warn at exactly 1 or with no debt', () => {
    expect(aaveWarnings(position([], { ...SUMMARY, healthFactor: 1 }))).toEqual([]);
    expect(aaveWarnings(position([], { ...SUMMARY, healthFactor: null }))).toEqual([]);
  });

  it('names each reserve token with no oracle price', () => {
    const warnings = aaveWarnings(
      position([
        reserve(DAI, 'DAI', 18, { supplied: 1n, priceUsd: 0 }),
        reserve(USDC, 'USDC', 6, { supplied: 1n }),
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(DAI);
    expect(warnings[0]).not.toContain(USDC);
  });
});
