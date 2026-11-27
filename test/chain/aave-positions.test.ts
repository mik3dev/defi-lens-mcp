import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_IDS, type ChainId } from '../../src/chains.js';
import type { AppContext } from '../../src/context.js';
import { resolveMarket } from '../../src/protocols/aave/market.js';
import { type AavePosition, readAavePosition } from '../../src/protocols/aave/positions.js';
import { PINNED } from '../fixtures/blocks.js';
import { AAVE_WALLETS } from '../fixtures/wallets.js';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { testContext } from '../helpers/context.js';

// The ethereum borrower's read covers every reserve of the market (68) in one multicall; through a
// cold anvil fork cache that takes longer than the default fork timeout. Replay timing is unchanged.
const COLD_FORK_TIMEOUT_MS = 180_000;
if (process.env.CHAIN_MODE === 'fork') vi.setConfig({ testTimeout: COLD_FORK_TIMEOUT_MS });

/** Raw values derived independently with `cast call … --block <pinned>` (see `commands`). */
interface ExpectedWallet {
  user: Address;
  accountData: {
    totalCollateralBase: string;
    totalDebtBase: string;
    availableBorrowsBase: string;
    currentLiquidationThreshold: string;
    ltv: string;
    healthFactor: string;
  };
  eModeCategory: number;
  reserves: {
    asset: Address;
    supplied: string;
    stableDebt: string;
    variableDebt: string;
    usedAsCollateral: boolean;
    price: string;
  }[];
}

interface ExpectedPositions {
  block: string;
  market: { pool: Address; dataProvider: Address; oracle: Address };
  wallets: Record<string, ExpectedWallet>;
  commands: string[];
}

const MAX_UINT256 = (2n ** 256n - 1n).toString();

function expected(chain: ChainId): ExpectedPositions {
  const url = new URL(`../fixtures/aave-positions.${chain}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ExpectedPositions;
}

/** Independent conversions of the raw cast values. */
const usd = (raw: string): number => Number(raw) / 1e8;
const fraction = (bps: string): number => Number(bps) / 1e4;
/** Truncated (not rounded) to 4 decimal places, in integer arithmetic. */
const health = (raw: string): number | null =>
  raw === MAX_UINT256 ? null : Number(BigInt(raw) / 10n ** 14n) / 1e4;

function expectSummary(position: AavePosition, wallet: ExpectedWallet): void {
  const a = wallet.accountData;
  expect(position.summary).toEqual({
    totalCollateralUsd: usd(a.totalCollateralBase),
    totalDebtUsd: usd(a.totalDebtBase),
    availableBorrowsUsd: usd(a.availableBorrowsBase),
    ltv: fraction(a.ltv),
    liquidationThreshold: fraction(a.currentLiquidationThreshold),
    healthFactor: health(a.healthFactor),
    eModeCategory: wallet.eModeCategory,
  });
}

function expectReserves(position: AavePosition, wallet: ExpectedWallet): void {
  const actual = position.reserves.map((r) => ({
    asset: r.token.address,
    supplied: r.supplied.toString(),
    stableDebt: r.stableDebt.toString(),
    variableDebt: r.variableDebt.toString(),
    usedAsCollateral: r.usedAsCollateral,
    priceUsd: r.priceUsd,
  }));
  const wanted = wallet.reserves.map(({ price, ...rest }) => ({ ...rest, priceUsd: usd(price) }));
  expect(actual).toEqual(wanted);
}

describe.each(CHAIN_IDS)('aave v3 positions on %s', (chain) => {
  let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;
  let ctx: AppContext;
  const block = { number: PINNED[chain], timestamp: 0n };
  const fixture = expected(chain);
  const borrower = fixture.wallets.borrower as ExpectedWallet;

  beforeAll(async () => {
    endpoint = await chainEndpoint(chain, `aave-positions.${chain}`);
  }, 120_000);

  // A fresh context (and cache) per test: no test depends on reads another test cached.
  beforeEach(() => {
    if (!endpoint) throw new Error(`No chain endpoint for ${chain}`);
    ctx = testContext({ [chain]: endpoint.rpcUrl });
  });

  afterAll(async () => {
    await endpoint?.stop();
  });

  it('fixture matches the pinned block, the market and the reference wallet', async () => {
    expect(fixture.block).toBe(PINNED[chain].toString());
    expect(await resolveMarket(ctx, chain, block)).toEqual(fixture.market);
    expect(borrower.user).toBe(AAVE_WALLETS.borrower[chain]);
  });

  it('borrower: summary equals getUserAccountData at the pinned block', async () => {
    const position = await readAavePosition(ctx, chain, borrower.user, block);
    expectSummary(position, borrower);
    expect(typeof position.summary.healthFactor).toBe('number');
    expect(position.summary.totalDebtUsd).toBeGreaterThan(0);
  });

  it('borrower: each reserve equals getUserReserveData', async () => {
    const position = await readAavePosition(ctx, chain, borrower.user, block);
    expect(position.reserves.length).toBeGreaterThan(0);
    expectReserves(position, borrower);
  });

  if (chain === 'ethereum') {
    const supplier = fixture.wallets.supplier as ExpectedWallet;
    const unused = fixture.wallets.unused as ExpectedWallet;

    it('supplier with no debt: healthFactor is null and totalDebtUsd is 0', async () => {
      expect(supplier.user).toBe(AAVE_WALLETS.supplierEthereum);
      const position = await readAavePosition(ctx, chain, supplier.user, block);
      expect(position.summary.healthFactor).toBeNull();
      expect(position.summary.totalDebtUsd).toBe(0);
      expectSummary(position, supplier);
      expectReserves(position, supplier);
    });

    it('address with no position: zero summary and empty reserves', async () => {
      expect(unused.user).toBe(AAVE_WALLETS.unusedEthereum);
      const position = await readAavePosition(ctx, chain, unused.user, block);
      expect(position).toEqual({
        summary: {
          totalCollateralUsd: 0,
          totalDebtUsd: 0,
          availableBorrowsUsd: 0,
          ltv: 0,
          liquidationThreshold: 0,
          healthFactor: null,
          eModeCategory: 0,
        },
        reserves: [],
      });
    });
  }
});
