import { readFileSync } from 'node:fs';
import type { Address } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { getAavePositions } from '../../src/tools/get-aave-positions.js';
import { PINNED } from '../fixtures/blocks.js';
import { AAVE_WALLETS } from '../fixtures/wallets.js';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { testContext } from '../helpers/context.js';

/** Raw values from test/fixtures/aave-positions.ethereum.json (derived with `cast`, see its `commands`). */
interface ExpectedWallet {
  user: Address;
  accountData: { totalCollateralBase: string; totalDebtBase: string; healthFactor: string };
  reserves: {
    asset: Address;
    supplied: string;
    stableDebt: string;
    variableDebt: string;
    price: string;
  }[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/aave-positions.ethereum.json', import.meta.url), 'utf8'),
) as { market: { pool: Address }; wallets: Record<string, ExpectedWallet> };

const usd = (raw: string): number => Number(raw) / 1e8;

describe('get_aave_positions on ethereum', () => {
  let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;
  let ctx: AppContext;

  beforeAll(async () => {
    endpoint = await chainEndpoint('ethereum', 'aave-tool.ethereum');
  }, 120_000);

  beforeEach(() => {
    if (!endpoint) throw new Error('No chain endpoint for ethereum');
    ctx = testContext({ ethereum: endpoint.rpcUrl });
  });

  afterAll(async () => {
    await endpoint?.stop();
  });

  it('borrower: envelope is pinned and values are consistent with the position fixture', async () => {
    const wallet = fixture.wallets.borrower as ExpectedWallet;
    const out = await getAavePositions(ctx, {
      chain: 'ethereum',
      address: AAVE_WALLETS.borrower.ethereum,
    });
    expect(out.chain).toBe('ethereum');
    expect(out.blockNumber).toBe(PINNED.ethereum.toString());
    expect(out.blockTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.warnings).toEqual([]);
    expect(out.data.address).toBe(wallet.user);
    expect(out.data.market).toEqual({ name: 'Aave v3 Core', pool: fixture.market.pool });
    expect(out.data.priceSource).toBe('aave-oracle');
    expect(out.data.summary.totalCollateralUsd).toBe(usd(wallet.accountData.totalCollateralBase));
    expect(out.data.summary.totalDebtUsd).toBe(usd(wallet.accountData.totalDebtBase));
    expect(out.data.summary.healthFactorNote).toBeNull();
    expect(out.data.summary.healthFactor).toBeGreaterThan(1);

    const byToken = new Map(out.data.reserves.map((r) => [r.token.address, r]));
    expect(byToken.size).toBe(wallet.reserves.length);
    for (const expected of wallet.reserves) {
      const row = byToken.get(expected.asset);
      expect(row?.supplied.raw).toBe(expected.supplied);
      expect(row?.variableDebt.raw).toBe(expected.variableDebt);
      expect(row?.stableDebt.raw).toBe(expected.stableDebt);
      expect(row?.suppliedUsd).toBeGreaterThanOrEqual(0);
    }
    const totals = out.data.reserves.map((r) => (r.suppliedUsd ?? 0) + (r.debtUsd ?? 0));
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it('supplier with no debt: healthFactor is null with the "no debt" note', async () => {
    const out = await getAavePositions(ctx, {
      chain: 'ethereum',
      address: AAVE_WALLETS.supplierEthereum,
    });
    expect(out.data.summary.healthFactor).toBeNull();
    expect(out.data.summary.healthFactorNote).toBe('no debt');
    expect(out.data.reserves.every((r) => r.debtUsd === 0)).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it('address with no position: empty reserves and a zero summary', async () => {
    const out = await getAavePositions(ctx, {
      chain: 'ethereum',
      address: AAVE_WALLETS.unusedEthereum,
    });
    expect(out.data.reserves).toEqual([]);
    expect(out.data.summary.totalCollateralUsd).toBe(0);
    expect(out.data.summary.healthFactorNote).toBe('no debt');
  });
});
