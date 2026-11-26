# Phase 1 — Prices and Token Balances

Part of the [development plan](../development-plan.md). Spec: [design.md](../design.md) §5.0, §5.1, §6 (Prices).

**Outcome:** USD prices from Chainlink available to every tool, token discovery through the indexer, and `get_token_balances` working on four chains.

**Depends on:** phase 0 signed off. Spike answer Q8 (indexer methods on the free tier).

**Branch:** `phase-1-balances-prices`

---

### Task 1.1: Chainlink price reader

**Files:**
- Create: `src/protocols/chainlink/abi.ts`, `src/protocols/chainlink/feeds.ts`, `src/protocols/chainlink/prices.ts`
- Test: `test/unit/protocols/chainlink/prices.test.ts`, `test/chain/prices.test.ts`

**Interfaces:**
- Consumes: `AppContext`, `getClient`, `PinnedBlock`, `CHAINS`, `NATIVE_ADDRESS`.
- Produces:
  ```ts
  export interface FeedConfig { feed: Address; heartbeatSeconds: number; description: string } // description e.g. 'ETH / USD'
  export const FEEDS: Record<ChainId, Record<string, FeedConfig>>; // key: lowercase token address
  export const STALE_GRACE_SECONDS = 600;
  export interface Price { usd: number; stale: boolean }
  export function toPrice(answer: bigint, feedDecimals: number, updatedAt: bigint, now: bigint, heartbeatSeconds: number): Price | null;
  export function getUsdPrices(ctx: AppContext, chain: ChainId, tokens: Address[], block: PinnedBlock): Promise<Map<Address, Price | null>>;
  export function staleWarnings(prices: Map<Address, Price | null>, symbols: Map<Address, string>): string[]; // 'price feed stale: <SYMBOL>'
  ```

**Feed coverage required on every chain** (addresses and heartbeats from Chainlink's data-feeds page, source URL in a comment): native token and wrapped native (same feed), USDC, USDT, DAI, WBTC, LINK, WETH where the native token is not ETH, and the bridged USDC variant where one exists (maps to the USDC/USD feed). Tokens outside the map have no price.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit
  expect(toPrice(2000_00000000n, 8, 1000n, 1100n, 3600)).toEqual({ usd: 2000, stale: false });
  expect(toPrice(2000_00000000n, 8, 1000n, 1000n + 3600n + 600n, 3600)).toEqual({ usd: 2000, stale: false }); // at the edge
  expect(toPrice(2000_00000000n, 8, 1000n, 1000n + 3600n + 601n, 3600)).toEqual({ usd: 2000, stale: true });
  expect(toPrice(0n, 8, 1000n, 1100n, 3600)).toBeNull();
  expect(toPrice(-1n, 8, 1000n, 1100n, 3600)).toBeNull();
  expect(toPrice(1_000000000000000000n, 18, 1000n, 1100n, 3600)?.usd).toBe(1);
  // chain — describe.each(CHAIN_IDS)
  it('every configured feed reports the expected description', …); // feed.description() === FeedConfig.description
  it('prices native and wrapped native identically', …);
  it('returns null for a token with no feed', …);                   // Multicall3 address → null
  it('prices a stablecoin near 1', …);                              // USDC usd between 0.98 and 1.02
  // ethereum only:
  it('matches the feed answer at the pinned block', …);             // ETH usd === value in test/fixtures/prices.ethereum.json (cast latestRoundData at PINNED)
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/protocols/chainlink test/chain/prices.test.ts` — fails: modules not found.
- [ ] **Step 3: Implement.** `getUsdPrices` does one multicall of `latestRoundData` for the distinct feeds involved, at the pinned block, with `now = block.timestamp`. Feed decimals are read once and cached `forever`. Prices are cached under `price:<chain>:<feed>:<blockNumber>` for the chain's block time (or `CACHE_TTL_SECONDS`), so a cached price is only reused for the block it was read at.
- [ ] **Step 4: Record and run.** `RECORD=1 pnpm test:fork -- test/chain/prices.test.ts`, then `pnpm test`. Both pass.
- [ ] **Step 5: Commit** `feat: add Chainlink USD price reader`

---

### Task 1.2: Indexer token discovery

**Files:**
- Create: `src/services/indexer.ts`
- Modify: `src/context.ts` (build `indexerClients` from `alchemyApiKey`), `test/helpers/chain-endpoint.ts` (in fork mode, forward methods starting with `alchemy_` to the upstream provider instead of anvil, and record them), `test/helpers/context.ts` (`indexerUrls` option)
- Test: `test/unit/services/indexer.test.ts`, `test/chain/indexer.test.ts`

**Interfaces:**
- Consumes: `AppContext.indexerClients`, `AppError`.
- Produces:
  ```ts
  export function hasIndexer(ctx: AppContext, chain: ChainId): boolean;
  export const DISCOVERY_CANDIDATE_CAP = 400;
  export function discoverTokens(ctx: AppContext, chain: ChainId, owner: Address):
    Promise<{ tokens: Address[]; truncated: boolean }>; // throws AppError('INDEXER_NOT_CONFIGURED') without a client
  ```

- [ ] **Step 1: Write the failing tests.** Unit tests use a viem client with a `custom` transport returning scripted pages of `alchemy_getTokenBalances`.
  ```ts
  it('merges pages until pageKey is absent', …);             // 2 pages of 3 → 6 tokens, truncated false
  it('drops zero balances', …);                              // tokenBalance '0x0…0' excluded
  it('excludes the native POL token contract on polygon', …); // 0x0000…1010 in the page → not in tokens (native POL is read separately)
  it('stops at the candidate cap and reports truncation', …); // pages totalling 5 000 → tokens.length === 400, truncated true, no further page requested
  it('throws INDEXER_NOT_CONFIGURED without a client', …);
  it('maps a provider error to UPSTREAM_ERROR', …);
  // chain (ethereum): a reference wallet holding at least 3 ERC-20s with a price feed is discovered with all of them.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/services/indexer.test.ts test/chain/indexer.test.ts` — fails: module not found.
- [ ] **Step 3: Implement** `discoverTokens` with `alchemy_getTokenBalances(owner, 'erc20', { pageKey })`, using the request and pagination shape recorded in spike answer Q8: the result is `{ address, tokenBalances: [{ contractAddress, tokenBalance }], pageKey? }`. Pages hold up to 100 entries and can be shorter while a `pageKey` still follows. Zero balances are returned and must be filtered out. On Polygon the list includes `0x0000000000000000000000000000000000001010`, the ERC-20 interface of native POL, which must be excluded so native POL is not counted twice.
- [ ] **Step 4: Record and run.** Pick the reference wallet (an EOA with native balance and ≥ 3 priced tokens at `PINNED.ethereum`), note it in `test/fixtures/wallets.ts` with why it was chosen. Record, then `pnpm test`. Both pass.
- [ ] **Step 5: Commit** `feat: add indexer token discovery`

---

### Task 1.3: `get_token_balances`

**Files:**
- Create: `src/tools/get-token-balances.ts`
- Modify: `src/server.ts` (register)
- Test: `test/unit/tools/get-token-balances.test.ts`, `test/chain/token-balances.test.ts`, `test/e2e/tools.test.ts` (new; one generic "every registered tool" suite, extended each phase)

**Interfaces:**
- Consumes: `discoverTokens`, `hasIndexer`, `readTokens`, `readBalances`, `getUsdPrices`, `staleWarnings`, `usdValue`, `toAmount`, `runTool`, `ok`.
- Produces:
  ```ts
  export interface BalanceRow { token: TokenInfo; balance: Amount; usd: number | null; priceSource: 'chainlink' | null }
  export function sortBalances(rows: BalanceRow[]): BalanceRow[]; // native first, priced by usd desc, unpriced by symbol asc; returns a new array
  export function getTokenBalances(ctx: AppContext, input: TokenBalancesInput): Promise<ToolOutput<TokenBalancesData>>;
  export function register(server: McpServer, ctx: AppContext): void;
  ```

**Tool contract:**
- Input: `{ chain, address, tokens?: Address[] (max 100), maxTokens?: integer 1–200, default 50 }`.
- Output `data`: `{ address, discovery: 'indexer' | 'explicit' | 'none', balances: BalanceRow[], totalUsd: number | null }`. `totalUsd` sums priced rows; `null` when no row is priced.
- Rules: native balance always included. With `tokens`, the indexer is not called and zero balances are kept (the caller asked for them). With discovery, tokens whose on-chain balance at the pinned block is zero are dropped. Tokens that `readTokens` returns `null` for are skipped.
- Warnings, exact text: `Token discovery unavailable: set ALCHEMY_API_KEY or pass "tokens". Returning native balance only.` · `Skipped <n> tokens that are not readable ERC-20 contracts.` · `Showing <maxTokens> of <n> tokens.` · `More tokens exist than were scanned.` (discovery truncated) · stale-price warnings.
- Description states: discovery comes from an indexer, balances are read on-chain; unpriced tokens have `usd: null`; spam tokens may appear.
- On-chain reads are chunked in multicalls of 100.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit
  it('sorts native first, then priced by USD, then unpriced by symbol', …);
  it('does not mutate its input', …);
  it('caps a wallet with thousands of discovered tokens', …);
  //  fake indexer yields 5 000 tokens, fake chain client answers every token as readable with balance 1:
  //  balances.length === 51 (native + 50), warnings include 'Showing 50 of' and 'More tokens exist than were scanned.',
  //  the chain client received at most 400 token reads.
  it('returns native only with a warning when there is no indexer and no tokens', …); // discovery 'none'
  it('skips unreadable tokens and counts them', …);
  it('keeps zero balances for explicit tokens', …);
  // chain (ethereum, reference wallet, explicit tokens list): each balance.raw and native raw equal test/fixtures/token-balances.ethereum.json;
  //  usd === formatted × fixture price; blockNumber === PINNED.
  // chain (ethereum, discovery): contains every token from the explicit test.
  // chain (describe.each other chains): native + wrapped native explicit read returns without error and matches cast.
  // e2e tools.test.ts: for every tool in tools/list — has description, object inputSchema, outputSchema, readOnlyHint true;
  //  a table of { tool, validArgs, fixture } drives one successful call each, validated against its outputSchema.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/tools/get-token-balances.test.ts test/chain/token-balances.test.ts` — fails: module not found.
- [ ] **Step 3: Implement** the tool following the contract above.
- [ ] **Step 4: Record and run.** `RECORD=1 pnpm test:fork`, then `pnpm build && pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add get_token_balances`

---

### Task 1.4: USD values in `get_pool_state`

**Files:**
- Modify: `src/tools/get-pool-state.ts`, `test/chain/pool-state.test.ts`

- [ ] **Step 1: Extend the chain test.** For the Ethereum USDC/WETH pool: `reserves.usd0` and `usd1` are numbers equal to `formatted × fixture price`; `tvlUsd === usd0 + usd1`. For a pool with one unpriced token (builder picks one, records it in the fixture): that side's USD is `null` and `tvlUsd` is `null`.
- [ ] **Step 2: Run** `pnpm vitest run test/chain/pool-state.test.ts` — fails: USD fields are `null`.
- [ ] **Step 3: Implement** with `getUsdPrices` and `usdValue`; add stale-price warnings.
- [ ] **Step 4: Record and run.** Record, then `pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add USD reserves and TVL to get_pool_state`

---

### Task 1.5: Phase gate

**Files:**
- Create: `docs/validation/phase-1.md`

- [ ] **Step 1: Run the gate steps** from the development plan.
- [ ] **Step 2: Manual validation checklist:**

  | # | Check | Reference |
  |---|-------|-----------|
  | 1 | Live `get_token_balances` for one wallet per chain: native and three token balances | Block explorer token holdings for the address; exact at the response block |
  | 2 | USD price of ETH, WBTC, USDC, POL in the live response | Chainlink data-feeds page, ±0.5% |
  | 3 | A known spam-heavy wallet returns within the tool timeout with truncation warnings | Captured output and duration |
  | 4 | Server started without `ALCHEMY_API_KEY` but with an explicit RPC URL: native-only result with the discovery warning; explicit `tokens` still works | Captured output |
  | 5 | A token symbol containing control characters or over 32 characters is returned sanitized (use a known spam token or the unit-test evidence) | Captured output |
  | 6 | `get_pool_state` TVL for the Ethereum USDC/WETH pool | Uniswap app pool page, ±2% (the app's TVL uses its own pricing) |

- [ ] **Step 3: Commit** `docs: add phase 1 validation record`
- [ ] **Step 4: Owner review and sign-off.**
