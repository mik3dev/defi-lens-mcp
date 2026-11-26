# Phase 3 — Uniswap v3 Positions

Part of the [development plan](../development-plan.md). Spec: [design.md](../design.md) §5.3.

**Outcome:** tick and liquidity math in-repo, and `get_uniswap_positions` returning range status, token amounts and unclaimed fees for the positions a wallet holds.

**Depends on:** phase 1 signed off (prices). Uses the Uniswap addresses and pool reader from phase 0.

**Branch:** `phase-3-uniswap-positions`

---

### Task 3.1: Tick and liquidity math

**Files:**
- Modify: `src/protocols/uniswap/math.ts`
- Test: `test/unit/protocols/uniswap/math.test.ts`

**Interfaces:**
- Consumes: `sqrtPriceX96ToPrices` (phase 0).
- Produces:
  ```ts
  export const MIN_TICK = -887272; export const MAX_TICK = 887272;
  export function getSqrtRatioAtTick(tick: number): bigint;       // port of Uniswap TickMath.getSqrtRatioAtTick; throws RangeError outside [MIN_TICK, MAX_TICK]
  export function getAmountsForLiquidity(sqrtPriceX96: bigint, sqrtLowerX96: bigint, sqrtUpperX96: bigint, liquidity: bigint):
    { amount0: bigint; amount1: bigint };                        // port of LiquidityAmounts.getAmountsForLiquidity, rounding down
  export function tickToPrices(tick: number, decimals0: number, decimals1: number): { price0In1: string; price1In0: string };
  export function isInRange(tick: number, tickLower: number, tickUpper: number): boolean; // tickLower <= tick < tickUpper
  ```

- [ ] **Step 1: Write the failing tests.**
  ```ts
  expect(getSqrtRatioAtTick(0)).toBe(79228162514264337593543950336n);
  expect(getSqrtRatioAtTick(MIN_TICK)).toBe(4295128739n);
  expect(getSqrtRatioAtTick(MAX_TICK)).toBe(1461446703485210103287273052203988822378723970342n);
  expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError);
  expect(getSqrtRatioAtTick(-1)).toBeLessThan(getSqrtRatioAtTick(0));
  const lo = getSqrtRatioAtTick(-600), hi = getSqrtRatioAtTick(600), L = 10n ** 18n;
  // price below the range: all token0
  expect(getAmountsForLiquidity(getSqrtRatioAtTick(-1200), lo, hi, L).amount1).toBe(0n);
  expect(getAmountsForLiquidity(getSqrtRatioAtTick(-1200), lo, hi, L).amount0).toBeGreaterThan(0n);
  // price above the range: all token1
  expect(getAmountsForLiquidity(getSqrtRatioAtTick(1200), lo, hi, L).amount0).toBe(0n);
  // in range: both sides, and symmetric range at tick 0 gives equal amounts
  const mid = getAmountsForLiquidity(getSqrtRatioAtTick(0), lo, hi, L);
  expect(mid.amount0).toBe(mid.amount1);
  expect(getAmountsForLiquidity(getSqrtRatioAtTick(0), lo, hi, 0n)).toEqual({ amount0: 0n, amount1: 0n });
  // bounds passed in either order give the same result
  expect(getAmountsForLiquidity(getSqrtRatioAtTick(0), hi, lo, L)).toEqual(mid);
  expect(tickToPrices(0, 18, 18).price0In1).toBe('1');
  expect(isInRange(10, 0, 10)).toBe(false); expect(isInRange(0, 0, 10)).toBe(true);
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/protocols/uniswap/math.test.ts` — fails: functions not exported.
- [ ] **Step 3: Implement** as direct bigint ports of the Solidity libraries, with a comment linking each source file. Exact amounts against real positions are checked in task 3.2.
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `feat: add Uniswap v3 tick and liquidity math`

---

### Task 3.2: Position reader

**Files:**
- Create: `src/protocols/uniswap/positions.ts`
- Test: `test/unit/protocols/uniswap/positions.test.ts`, `test/chain/uniswap-positions.test.ts`

**Interfaces:**
- Consumes: `UNISWAP_V3`, `getSqrtRatioAtTick`, `getAmountsForLiquidity`, `isInRange`, `readTokens`, `getClient`.
- Produces:
  ```ts
  export const POSITION_SCAN_CAP = 200;
  export interface UniPosition { tokenId: bigint; pool: Address; token0: TokenInfo; token1: TokenInfo; feeTier: number;
    tickLower: number; tickUpper: number; currentTick: number; liquidity: bigint; inRange: boolean;
    amount0: bigint; amount1: bigint; fees0: bigint; fees1: bigint }
  export function readPositions(ctx: AppContext, chain: ChainId, owner: Address, block: PinnedBlock,
    opts: { includeClosed: boolean; maxPositions: number }):
    Promise<{ positions: UniPosition[]; totalNfts: number; scanned: number; truncated: boolean }>;
  ```

**Algorithm (decisions the tests do not determine):**
1. `positionManager.balanceOf(owner)` → `totalNfts`.
2. Scan newest first: indices `totalNfts-1` down, at most `POSITION_SCAN_CAP`, via multicall of `tokenOfOwnerByIndex` then `positions(tokenId)`.
3. Unless `includeClosed`, drop positions with zero liquidity and zero `tokensOwed`. Keep the first `maxPositions`. `truncated` is true when NFTs were left unscanned or kept positions exceeded `maxPositions`.
4. Pools: `factory.getPool` for the distinct `(token0, token1, fee)` triples, then `slot0` for each, in two multicalls.
5. Unclaimed fees: **one** `eth_call` with `from = owner` to the position manager's own `multicall(bytes[])`, carrying a `collect({ tokenId, recipient: owner, amount0Max: 2^128-1, amount1Max: 2^128-1 })` per kept position. The position manager's `multicall` preserves `msg.sender`, which Multicall3 would not.
6. Amounts with `getAmountsForLiquidity` at the pool's current `sqrtPriceX96`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit — fake chain client
  it('scans at most POSITION_SCAN_CAP NFTs, newest first', …); // balanceOf 5 000 → tokenOfOwnerByIndex called for indices 4999…4800 only; truncated true
  it('drops closed positions unless includeClosed', …);
  it('cuts at maxPositions and reports truncation', …);
  it('returns an empty result for an owner with no NFTs without further calls', …);
  // chain (ethereum) — reference wallet with at least one in-range and one out-of-range open position
  it('amounts equal a simulated full decreaseLiquidity', …);   // amount0/amount1 === fixture (cast call decreaseLiquidity from owner at PINNED)
  it('fees equal a simulated collect', …);                     // fees0/fees1 === fixture (cast call collect from owner at PINNED, max amounts)
  it('flags range status from the pool tick', …);              // inRange true for one, false for the other; out-of-range position has exactly one zero amount
  it('address with no positions returns an empty list', …);
  // chain (describe.each other chains): one wallet with one open position; amounts equal fixture.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/protocols/uniswap/positions.test.ts test/chain/uniswap-positions.test.ts` — fails: module not found.
- [ ] **Step 3: Implement** following the algorithm.
- [ ] **Step 4: Find reference wallets, record, run.** Take owners from recent `IncreaseLiquidity` events of the position manager before the pinned block (`ownerOf(tokenId)` at the pinned block must be an EOA). Derive expected amounts and fees with `cast call --from <owner> --block <PINNED>`, store with the commands. Record, then `pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add Uniswap v3 position reader`

---

### Task 3.3: `get_uniswap_positions`

**Files:**
- Create: `src/tools/get-uniswap-positions.ts`
- Modify: `src/server.ts` (register), `test/e2e/tools.test.ts` (add row)
- Test: `test/unit/tools/get-uniswap-positions.test.ts`, `test/chain/uniswap-positions-tool.test.ts`

**Interfaces:**
- Consumes: `readPositions`, `tickToPrices`, `sqrtPriceX96ToPrices`, `getUsdPrices`, `staleWarnings`, `usdValue`, `toAmount`.
- Produces: `getUniswapPositions(ctx, input)`, `register(server, ctx)`, pure mapper `toPositionData(p: UniPosition, prices: Map<Address, Price | null>): PositionData`.

**Tool contract:**
- Input: `{ chain, address, includeClosed?: boolean (default false), maxPositions?: integer 1–100 (default 50) }`.
- Output `data`: `{ address, totalNfts, positions: PositionData[], totalValueUsd: number | null }` where `PositionData` is
  `{ tokenId: string, pool, token0, token1, feeTier, tickLower, tickUpper, currentTick, inRange, priceLower, priceUpper, priceCurrent, amount0: Amount, amount1: Amount, unclaimedFees0: Amount, unclaimedFees1: Amount, valueUsd: number | null, unclaimedFeesUsd: number | null }`. Prices are token1 per token0, decimal-adjusted. `valueUsd` and `unclaimedFeesUsd` are `null` unless both tokens are priced.
- Positions sorted by `valueUsd` descending, unpriced last by `tokenId` descending.
- Warnings, exact text: `Showing <n> of <m> open positions.` · `Scanned the newest 200 of <totalNfts> position NFTs.` · stale-price warnings.
- Description states: Uniswap v3 only; only positions held directly by the address (positions staked in other contracts are not found); out-of-range positions earn no fees.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit — toPositionData
  it('formats range and current prices from ticks', …);          // tickLower 0, 18/18 decimals → priceLower '1'; priceUpper > priceLower
  it('computes valueUsd only when both tokens are priced', …);
  it('serialises tokenId as a string', …);
  // chain: reference wallet through the tool — positions consistent with task 3.2 fixtures, sorted by valueUsd, envelope pinned.
  // e2e: tools.test.ts row for get_uniswap_positions.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/tools/get-uniswap-positions.test.ts test/chain/uniswap-positions-tool.test.ts` — fails: module not found.
- [ ] **Step 3: Implement** the mapper and the tool.
- [ ] **Step 4: Record and run.** Record, then `pnpm build && pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add get_uniswap_positions`

---

### Task 3.4: Phase gate

**Files:**
- Create: `docs/validation/phase-3.md`

- [ ] **Step 1: Run the gate steps** from the development plan.
- [ ] **Step 2: Manual validation checklist:**

  | # | Check | Reference |
  |---|-------|-----------|
  | 1 | Live positions of two wallets on Ethereum and one on Base or Arbitrum: token amounts | Uniswap app position page; exact to displayed precision |
  | 2 | Range status and min/max/current price of the same positions | Uniswap app |
  | 3 | Unclaimed fees of the same positions | Uniswap app, ±1% |
  | 4 | A wallet with more than 200 position NFTs returns within the timeout with the scan warning | Captured output and duration |
  | 5 | A wallet with only closed positions returns none by default and lists them with `includeClosed: true` | Captured output |
  | 6 | Agent-readability: ask a desktop client "which of this wallet's positions are out of range?" | Transcript |

- [ ] **Step 3: Commit** `docs: add phase 3 validation record`
- [ ] **Step 4: Owner review and sign-off.**
