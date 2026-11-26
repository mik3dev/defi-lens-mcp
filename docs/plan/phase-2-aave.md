# Phase 2 — Aave v3 Positions

Part of the [development plan](../development-plan.md). Spec: [design.md](../design.md) §5.2.

**Outcome:** `get_aave_positions` returns the account summary and per-reserve breakdown for the main Aave v3 market on four chains.

**Depends on:** phase 1 signed off.

**Branch:** `phase-2-aave`

---

### Task 2.1: Market resolution

**Files:**
- Create: `src/protocols/aave/abis.ts`, `src/protocols/aave/addresses.ts`, `src/protocols/aave/market.ts`
- Test: `test/chain/aave-market.test.ts`

**Interfaces:**
- Consumes: `AppContext`, `getClient`, `PinnedBlock`.
- Produces:
  ```ts
  export const AAVE_V3_ADDRESSES_PROVIDER: Record<ChainId, Address>;
  export interface AaveMarket { pool: Address; dataProvider: Address; oracle: Address }
  export function resolveMarket(ctx: AppContext, chain: ChainId, block: PinnedBlock): Promise<AaveMarket>; // cached forever per chain
  ```

**PoolAddressesProvider per chain** (confirm against Aave's official deployed-contracts page; the sanity test is the arbiter):

| Chain | PoolAddressesProvider |
|-------|-----------------------|
| ethereum | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` |
| arbitrum, polygon | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` |
| base | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` |

- [ ] **Step 1: Write the failing test** (`describe.each(CHAIN_IDS)`).
  ```ts
  it('resolves pool, data provider and oracle to non-zero addresses', …);
  it('the pool points back at the provider', …);            // pool.ADDRESSES_PROVIDER() === AAVE_V3_ADDRESSES_PROVIDER[chain]
  it('the oracle is denominated in USD with 8 decimals', …); // oracle.BASE_CURRENCY_UNIT() === 100000000n
  it('resolves once and serves later calls from cache', …);  // second call issues no RPC request
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/chain/aave-market.test.ts` — fails: module not found.
- [ ] **Step 3: Implement** `resolveMarket` with one multicall of `getPool`, `getPoolDataProvider`, `getPriceOracle` on the provider.
- [ ] **Step 4: Record and run.** Record, then `pnpm test`. Both pass.
- [ ] **Step 5: Commit** `feat: add Aave v3 market resolution`

---

### Task 2.2: Position reader

**Files:**
- Create: `src/protocols/aave/positions.ts`
- Test: `test/unit/protocols/aave/positions.test.ts`, `test/chain/aave-positions.test.ts`

**Interfaces:**
- Consumes: `resolveMarket`, `readTokens`, `getClient`.
- Produces:
  ```ts
  export function baseToUsd(value: bigint): number;               // 8-decimal base currency
  export function parseHealthFactor(raw: bigint): number | null;  // maxUint256 → null; otherwise raw / 1e18, 4 decimal places
  export function bpsToFraction(bps: bigint): number;
  export interface AaveReservePosition { token: TokenInfo; supplied: bigint; variableDebt: bigint; stableDebt: bigint;
    usedAsCollateral: boolean; priceUsd: number }
  export interface AavePosition {
    summary: { totalCollateralUsd: number; totalDebtUsd: number; availableBorrowsUsd: number; ltv: number;
      liquidationThreshold: number; healthFactor: number | null; eModeCategory: number };
    reserves: AaveReservePosition[]; // only reserves with a non-zero supplied or debt amount
  }
  export function readAavePosition(ctx: AppContext, chain: ChainId, user: Address, block: PinnedBlock): Promise<AavePosition>;
  ```

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit
  expect(baseToUsd(123456789000n)).toBe(1234.56789);
  expect(parseHealthFactor(2n ** 256n - 1n)).toBeNull();
  expect(parseHealthFactor(1_500000000000000000n)).toBe(1.5);
  expect(parseHealthFactor(987654321000000000n)).toBe(0.9877);
  expect(bpsToFraction(8250n)).toBe(0.825);
  // chain (ethereum) — three reference wallets recorded in test/fixtures/wallets.ts
  it('borrower: summary equals getUserAccountData at the pinned block', …); // each summary field === fixture (cast); healthFactor is a number
  it('borrower: each reserve equals getUserReserveData', …);                // supplied / variableDebt / usedAsCollateral === fixture
  it('supplier with no debt: healthFactor is null and totalDebtUsd is 0', …);
  it('address with no position: zero summary and empty reserves', …);
  // chain (describe.each other chains): one borrower per chain, summary equals fixture.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/protocols/aave test/chain/aave-positions.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.** Sequence at the pinned block: (1) `pool.getUserAccountData(user)` and `pool.getUserEMode(user)`; (2) `dataProvider.getAllReservesTokens()` — cached for one hour; (3) one multicall of `dataProvider.getUserReserveData(asset, user)` over all reserves; (4) for reserves with a non-zero amount, `oracle.getAssetsPrices(assets)` and `readTokens`.
- [ ] **Step 4: Find reference wallets, record, run.** Borrowers: take users from recent `Borrow` events of the pool before the pinned block and keep one whose `getUserAccountData` shows non-zero collateral and debt. Supplier-only: from `Supply` events, one with zero debt. Derive expected values with `cast call`, store with the commands. Record, then `pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add Aave v3 position reader`

---

### Task 2.3: `get_aave_positions`

**Files:**
- Create: `src/tools/get-aave-positions.ts`
- Modify: `src/server.ts` (register), `test/e2e/tools.test.ts` (add the tool's row)
- Test: `test/unit/tools/get-aave-positions.test.ts`, `test/chain/aave-tool.test.ts`

**Interfaces:**
- Consumes: `readAavePosition`, `toAmount`, `runTool`, `ok`.
- Produces: `getAavePositions(ctx, input): Promise<ToolOutput<AavePositionsData>>`, `register(server, ctx)`, and the pure mapper `toAaveData(position: AavePosition, market: AaveMarket): AavePositionsData`.

**Tool contract:**
- Input: `{ chain, address }`.
- Output `data`:
  ```jsonc
  {
    "address": "0x…", "market": { "name": "Aave v3 Core", "pool": "0x…" }, "priceSource": "aave-oracle",
    "summary": { "totalCollateralUsd": 0, "totalDebtUsd": 0, "availableBorrowsUsd": 0, "ltv": 0.8,
                 "liquidationThreshold": 0.825, "healthFactor": 1.5, "healthFactorNote": null, "eModeCategory": 0 },
    "reserves": [ { "token": {…}, "supplied": Amount, "suppliedUsd": 0, "variableDebt": Amount, "stableDebt": Amount,
                    "debtUsd": 0, "usedAsCollateral": true } ]
  }
  ```
- `healthFactorNote` is `"no debt"` when `healthFactor` is `null`, otherwise `null`.
- Warning when `healthFactor < 1`: `Health factor is below 1: the position can be liquidated.`
- Reserves sorted by `suppliedUsd + debtUsd` descending.
- Description states: main Aave v3 market only; USD values use Aave's own oracle, the prices the protocol liquidates on; a health factor below 1 means liquidatable.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit — toAaveData
  it('sets healthFactorNote to "no debt" when healthFactor is null', …);
  it('computes suppliedUsd and debtUsd from amounts and priceUsd', …); // 2 WETH at 2000 → 4000; 500 USDC variable + 100 stable at 1 → 600
  it('sorts reserves by total USD exposure', …);
  // chain: the three ethereum wallets through the tool — envelope pinned, values consistent with task 2.2 fixtures;
  //  borrower with healthFactor < 1, if one exists at the pinned block, yields the liquidation warning (otherwise covered in unit with a mapper input).
  // e2e: tools.test.ts row { tool: 'get_aave_positions', args: { chain: 'ethereum', address: <borrower> } }.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/tools/get-aave-positions.test.ts test/chain/aave-tool.test.ts` — fails: module not found.
- [ ] **Step 3: Implement** the mapper and the tool.
- [ ] **Step 4: Record and run.** Record, then `pnpm build && pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add get_aave_positions`

---

### Task 2.4: Phase gate

**Files:**
- Create: `docs/validation/phase-2.md`

- [ ] **Step 1: Run the gate steps** from the development plan.
- [ ] **Step 2: Manual validation checklist:**

  | # | Check | Reference |
  |---|-------|-----------|
  | 1 | Live health factor for two borrower wallets on Ethereum and one on each other chain | Aave app (view the address) or `getUserAccountData` on a block explorer; ±0.01 |
  | 2 | Supplied and borrowed amounts per reserve for one wallet per chain | Aave app; exact to displayed precision |
  | 3 | Internal consistency: sum of `suppliedUsd` over collateral reserves vs `totalCollateralUsd`; sum of `debtUsd` vs `totalDebtUsd` | ±0.5% |
  | 4 | Wallet with supply and no debt shows `healthFactor: null`, note `no debt` | Captured output |
  | 5 | Address that never used Aave returns an empty position, not an error | Captured output |
  | 6 | Agent-readability: ask a desktop client "is this wallet at risk of liquidation?" and confirm it answers from the tool output correctly | Transcript |

- [ ] **Step 3: Commit** `docs: add phase 2 validation record`
- [ ] **Step 4: Owner review and sign-off.**
