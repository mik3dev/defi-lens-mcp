# Phase 4 — Swap Quotes

Part of the [development plan](../development-plan.md). Spec: [design.md](../design.md) §4.4, §5.5.

**Outcome:** `get_swap_quote` returns the best single-path exact-input quote on Uniswap v3, over direct and two-hop routes, with price impact and alternatives.

**Depends on:** phase 3 signed off.

**Branch:** `phase-4-swap-quote`

---

### Task 4.1: Hub tokens and path enumeration

**Files:**
- Create: `src/protocols/uniswap/paths.ts`
- Modify: `src/chains.ts` (fill `hubTokens`)
- Test: `test/unit/protocols/uniswap/paths.test.ts`, `test/chain/hub-tokens.test.ts`

**Interfaces:**
- Consumes: `FEE_TIERS`, `CHAINS`.
- Produces:
  ```ts
  export interface SwapPath { tokens: Address[]; fees: number[] } // tokens.length === fees.length + 1
  export interface PoolKey { token0: Address; token1: Address; fee: number } // token0 < token1 by address
  export function poolKeyId(key: PoolKey): string;                           // `${token0}-${token1}-${fee}`, lowercase
  export function enumeratePaths(tokenIn: Address, tokenOut: Address, hubs: Address[], feeTiers: readonly number[]): SwapPath[];
  export function poolKeysOf(paths: SwapPath[]): PoolKey[];                  // distinct
  export function encodePath(path: SwapPath): Hex;                           // packed: token, uint24 fee, token, …
  ```

**Hub tokens per chain** (addresses from each issuer's official page, source URL in a comment): wrapped native, USDC, USDT, DAI, WBTC; plus bridged USDC on Arbitrum and Polygon.

**Enumeration order (deterministic):** direct paths by fee ascending; then, for each hub in list order that is neither `tokenIn` nor `tokenOut`, every `(fee1, fee2)` pair, `fee1` ascending then `fee2` ascending.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  const [A, B, H1, H2] = fourDistinctAddresses;
  expect(enumeratePaths(A, B, [], FEE_TIERS)).toHaveLength(4);
  expect(enumeratePaths(A, B, [H1, H2], FEE_TIERS)).toHaveLength(4 + 2 * 16);
  expect(enumeratePaths(A, B, [A, H1], FEE_TIERS)).toHaveLength(4 + 16);        // a hub equal to tokenIn is skipped
  expect(enumeratePaths(A, B, [H1], FEE_TIERS)[0]).toEqual({ tokens: [A, B], fees: [100] });
  expect(enumeratePaths(A, B, [H1], FEE_TIERS)[4]).toEqual({ tokens: [A, H1, B], fees: [100, 100] });
  expect(encodePath({ tokens: [A, B], fees: [500] })).toBe(concat([A, '0x0001f4', B]).toLowerCase());
  expect(size(encodePath({ tokens: [A, H1, B], fees: [500, 3000] }))).toBe(66);
  expect(poolKeysOf(enumeratePaths(A, B, [H1], FEE_TIERS))).toHaveLength(12);   // 3 pairs × 4 tiers
  //  every PoolKey has token0 < token1
  // chain — describe.each(CHAIN_IDS): every hub token reads as the expected symbol and decimals.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/protocols/uniswap/paths.test.ts test/chain/hub-tokens.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Record and run.** Record, then `pnpm test`. Both pass.
- [ ] **Step 5: Commit** `feat: add swap path enumeration and hub tokens`

---

### Task 4.2: Pool pruning, quoting and price impact

**Files:**
- Create: `src/protocols/uniswap/quoter.ts`
- Modify: `src/protocols/uniswap/abis.ts` (QuoterV2 `quoteExactInput`, declared `view` in our ABI so it can go through `multicall`; the contract function is non-view but is safe to `eth_call`)
- Test: `test/unit/protocols/uniswap/quoter.test.ts`, `test/chain/quoter.test.ts`

**Interfaces:**
- Consumes: `SwapPath`, `PoolKey`, `poolKeyId`, `encodePath`, `UNISWAP_V3`.
- Produces:
  ```ts
  export interface LivePool { pool: Address; key: PoolKey; sqrtPriceX96: bigint; liquidity: bigint }
  export function findLivePools(ctx: AppContext, chain: ChainId, keys: PoolKey[], block: PinnedBlock): Promise<Map<string, LivePool>>; // exists and liquidity > 0
  export function prunePaths(paths: SwapPath[], live: Map<string, LivePool>): SwapPath[];
  export const QUOTE_CHUNK_SIZE = 10;
  export interface PathQuote { path: SwapPath; amountOut: bigint; gasEstimate: bigint }
  export function quotePaths(ctx: AppContext, chain: ChainId, paths: SwapPath[], amountIn: bigint, block: PinnedBlock): Promise<PathQuote[]>; // reverting paths omitted
  export function midPriceOut(path: SwapPath, live: Map<string, LivePool>, amountIn: bigint): bigint;
  export function priceImpactPct(amountOut: bigint, midOut: bigint): number; // (1 − amountOut / midOut) × 100, 4 decimal places, floor 0
  ```

**`midPriceOut` definition:** convert `amountIn` hop by hop at each pool's current price with no slippage, applying each hop's fee. For a hop where the input is `token0`: `out = in × sqrtPriceX96² / 2^192`; where it is `token1`: `out = in × 2^192 / sqrtPriceX96²`; then `out × (1 000 000 − fee) / 1 000 000`. Price impact therefore excludes the pool fee, as the Uniswap interface reports it.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit
  const Q96 = 2n ** 96n;
  //  one hop, sqrtPriceX96 = Q96, fee 3000, input is token0, amountIn 1_000_000n → midPriceOut 997_000n
  //  same pool, input is token1 → 997_000n
  //  sqrtPriceX96 = 2 × Q96, input token0, fee 500, amountIn 1_000_000n → 3_998_000n
  //  two hops through pools at price 1 with fees 500 and 3000, amountIn 1_000_000n → 996_501n
  expect(priceImpactPct(990n, 1000n)).toBe(1);
  expect(priceImpactPct(1000n, 1000n)).toBe(0);
  expect(priceImpactPct(1001n, 1000n)).toBe(0);
  //  prunePaths keeps a two-hop path only when both of its pools are live
  //  quotePaths with 25 paths issues 3 multicalls (fake client) and omits the paths whose call failed
  // chain (ethereum)
  it('finds the live WETH/USDC pools', …);                       // 500 and 3000 tiers present; liquidity equals fixture
  it('direct quote equals QuoterV2 called alone', …);            // WETH→USDC 1 WETH, fee 500: amountOut === fixture (cast call quoteExactInput at PINNED)
  it('two-hop quote equals QuoterV2 called alone', …);           // builder-chosen path recorded in the fixture
  it('omits a path through a non-existent pool', …);
  // chain — describe.each other chains: wrapped native → USDC direct quote equals fixture.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/protocols/uniswap/quoter.test.ts test/chain/quoter.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.** `findLivePools`: one multicall of `factory.getPool` for all keys, then one multicall of `slot0` + `liquidity` for the non-zero pools. `quotePaths`: multicalls of `QUOTE_CHUNK_SIZE` with `allowFailure: true` at the pinned block, chunks issued sequentially.
- [ ] **Step 4: Record and run.** Derive fixture values with `cast call`, record, then `pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add live pool discovery, path quoting and price impact`

---

### Task 4.3: Amount parsing and `get_swap_quote`

**Files:**
- Create: `src/tools/get-swap-quote.ts`
- Modify: `src/lib/format.ts` (`parseAmount`), `src/server.ts` (register), `test/e2e/tools.test.ts` (add row)
- Test: `test/unit/lib/format.test.ts`, `test/unit/tools/get-swap-quote.test.ts`, `test/chain/swap-quote.test.ts`

**Interfaces:**
- Consumes: everything from tasks 4.1 and 4.2, `readTokens`, `getUsdPrices`, `usdValue`, `toAmount`, `formatRatio`, `CHAINS`, `NATIVE_ADDRESS`.
- Produces:
  ```ts
  export function parseAmount(value: string, decimals: number, field: string): bigint; // throws AppError('INVALID_INPUT')
  export function minAmountOut(amountOut: bigint, slippageBps: number): bigint;        // amountOut × (10 000 − bps) / 10 000
  export function rankQuotes(quotes: PathQuote[]): PathQuote[];                         // amountOut desc, then fewer hops, then lower gas
  export function getSwapQuote(ctx: AppContext, input: SwapQuoteInput): Promise<ToolOutput<SwapQuoteData>>;
  export function register(server: McpServer, ctx: AppContext): void;
  ```

**Tool contract:**
- Input: `{ chain, tokenIn, tokenOut, amountIn: string (decimal, token units), slippageBps?: integer 0–5000 (default 50) }`. `NATIVE_ADDRESS` is accepted for either token and quoted as the wrapped native token.
- Output `data`: `{ tokenIn, tokenOut, amountIn: Amount, amountInUsd, slippageBps, wrappedNativeUsed: boolean, routesEvaluated: number, best: Route, alternatives: Route[] (max 3) }` with `Route = { hops: [{ tokenIn: TokenInfo, tokenOut: TokenInfo, feeTier: number, pool: Address }], amountOut: Amount, minAmountOut: Amount, amountOutUsd: number | null, executionPrice: string (tokenOut per tokenIn), priceImpactPct: number, gasEstimate: string }`.
- Errors: `tokenIn` equals `tokenOut` after wrapping → `INVALID_INPUT` "tokenIn and tokenOut are the same token"; a token that `readTokens` cannot read → `INVALID_INPUT` naming it; no live path, or every quote failed → `NOT_FOUND` "No Uniswap v3 route with liquidity from <IN> to <OUT>".
- Warning when `priceImpactPct > 5`: `High price impact: <x>%.`
- Description states: Uniswap v3 only, single path of at most two hops, exact input only; informational, not an executable order; ranking is by output amount and does not subtract gas; an aggregator or split route may give a better price.
- Flow: pin block → read tokens → `parseAmount` → `enumeratePaths` with the chain's hubs → `findLivePools` → `prunePaths` → `quotePaths` → `rankQuotes` → build routes. `routesEvaluated` is the number of paths quoted after pruning.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // parseAmount
  expect(parseAmount('1.5', 6, 'amountIn')).toBe(1500000n);
  expect(parseAmount('1', 18, 'amountIn')).toBe(10n ** 18n);
  for (const bad of ['0', '0.0', '-1', '1e18', '', ' ', 'abc', '1.', '.5', '1,5', '0x10'])
    expect(() => parseAmount(bad, 6, 'amountIn')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => parseAmount('1.1234567', 6, 'amountIn')).toThrow(/more than 6 decimal places/);
  expect(() => parseAmount('1' + '0'.repeat(40), 18, 'amountIn')).toThrow(/too large/); // raw ≥ 2^128
  expect(() => parseAmount('0', 6, 'amountIn')).toThrow(/greater than zero/);
  // tool unit
  expect(minAmountOut(1_000_000n, 50)).toBe(995_000n);
  expect(minAmountOut(1_000_000n, 0)).toBe(1_000_000n);
  //  rankQuotes: higher amountOut first; equal amountOut → fewer hops first; does not mutate its input
  // chain (ethereum)
  it('best WETH→USDC route equals the best independent quote', …);  // best.amountOut.raw === max over the fixture's per-path cast quotes; alternatives sorted, length ≤ 3
  it('native input quotes as wrapped native', …);                   // same amountOut as WETH input; wrappedNativeUsed true
  it('finds a two-hop route when no direct pool has liquidity', …); // fixture pair: best.hops.length === 2
  it('applies slippage to minAmountOut', …);                        // slippageBps 100 → amountOut × 0.99 exactly
  it('same token in and out → INVALID_INPUT', …);                   // including NATIVE_ADDRESS vs wrapped native
  it('unreadable token → INVALID_INPUT', …);
  it('token with no v3 liquidity → NOT_FOUND', …);                  // builder-chosen ERC-20 recorded in the fixture
  // e2e: tools.test.ts row for get_swap_quote.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/lib/format.test.ts test/unit/tools/get-swap-quote.test.ts test/chain/swap-quote.test.ts` — fails: `parseAmount` not exported.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Record and run.** Record, then `pnpm build && pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add get_swap_quote`

---

### Task 4.4: Phase gate

**Files:**
- Create: `docs/validation/phase-4.md`

- [ ] **Step 1: Run the gate steps** from the development plan.
- [ ] **Step 2: Manual validation checklist:**

  | # | Check | Reference |
  |---|-------|-----------|
  | 1 | Live quote, liquid direct pair (1 WETH → USDC) on each chain | Uniswap app restricted to v3 where possible; ±0.5% for the same route. A better app price through another route is recorded with the route |
  | 2 | Live quote for a pair that needs two hops, on Ethereum and one L2 | Uniswap app; route shown and output ±0.5% |
  | 3 | Large trade (price impact above 5%): impact and warning present | Uniswap app price impact, ±0.5 percentage points |
  | 4 | Number of RPC requests and wall time for a worst-case quote (both tokens non-hub) on the free tier | Server log line; recorded, with a note if it approaches the rate limit |
  | 5 | Pair with no liquidity returns `NOT_FOUND` with a readable message | Captured output |
  | 6 | Agent-readability: ask a desktop client "how much USDC would I get for 2 ETH on Base, and through which pools?" | Transcript |

- [ ] **Step 3: Commit** `docs: add phase 4 validation record`
- [ ] **Step 4: Owner review and sign-off.**

---

## Carried forward from phase 0

Minor findings from the phase 0 whole-branch review that this phase owns. Fold each into the task that touches the code; record any left open in this phase's validation document.

- Native sentinel: `tokenA = 0xEeee…` in `get_pool_state` returns `NOT_FOUND` without saying to use the wrapped native token. Map it to wrapped native or add a description hint, together with the swap-quote native handling.
