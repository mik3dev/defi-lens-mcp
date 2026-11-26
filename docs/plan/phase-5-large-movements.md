# Phase 5 — Large Movements

Part of the [development plan](../development-plan.md). Spec: [design.md](../design.md) §3 (provider constraints), §4.2, §5.6.

**Outcome:** `get_large_movements` finds large token transfers, large pool swaps, and large transfers of one wallet over a bounded recent window, and reports honestly how much of the window it covered.

**Depends on:** phase 1 signed off. Spike answers Q6 (log limits and error text) and Q8 (asset-transfer method) are applied below; see [the spike report](../spikes/provider-capabilities.md), decisions 12–15.

**Free-tier facts this phase is built on (spike, 2026-11-26):** Alchemy free tier accepts `eth_getLogs` over at most 10 blocks, counted inclusively (`toBlock − fromBlock + 1 ≤ 10`), on all four chains; no result-count cap was reached; 30 parallel requests were not throttled. With the defaults (10 × 30 = 300 blocks) one call covers about 60 min on Ethereum, 10 min on Base and Polygon, and 75 s on Arbitrum.

**Branch:** `phase-5-large-movements`

---

### Task 5.1: Budgeted log scanning

**Files:**
- Create: `src/services/logs.ts`
- Test: `test/unit/services/logs.test.ts`

**Interfaces:**
- Consumes: `Config.logsMaxBlockRange`, `Config.logsMaxRequests`.
- Produces:
  ```ts
  export const MAX_LOGS_SCANNED = 20_000;
  export interface ScanBudget { maxBlockRange: number; maxRequests: number; maxLogs: number }
  export interface ScanReport { requestedFromBlock: bigint; fromBlock: bigint; toBlock: bigint;
    requests: number; logsScanned: number; truncated: boolean }
  export function lookbackToFromBlock(latest: bigint, lookbackMinutes: number, blockTimeSeconds: number): bigint;
  export function isLogRangeError(e: unknown): boolean; // see "Range errors" below
  export function scanLogs<T>(fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
    range: { fromBlock: bigint; toBlock: bigint }, budget: ScanBudget): Promise<{ logs: T[]; report: ScanReport }>;
  ```

**Scan rules:** newest first, in windows of `maxBlockRange` blocks. When `fetchRange` throws a range error, halve the window (minimum 1 block) and retry the same span; the failed call counts as a request and the smaller window stays in effect. Stop when `fromBlock` is reached, when `requests === maxRequests`, or when `logsScanned >= maxLogs`. On an early stop `truncated` is true and `report.fromBlock` is the oldest block actually covered. Any other error propagates.

**Range errors** (spike Q6): `isLogRangeError` is true for JSON-RPC code −32600 whose message (viem: `details` of the `InvalidRequestRpcError` / `RpcRequestError` chain) matches `/block range/i` — Alchemy's exact text is `Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x1945aa9, 0x1945ab2]. Upgrade to PAYG for expanded block range.` (HTTP 400). It also matches, for any code, the common texts of other providers: `/query returned more than \d+ results/i`, `/exceed(s|ed)? (the )?max(imum)? block range/i`, `/block range (is )?too (large|wide)/i`. HTTP 429 (`Your app has exceeded its compute units per second capacity…`) is not a range error: it propagates and becomes `RATE_LIMITED`. With the default range the Alchemy free tier never returns a range error; halving exists for other providers and lower limits.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  expect(lookbackToFromBlock(1000n, 60, 12)).toBe(700n);
  expect(lookbackToFromBlock(100n, 60, 12)).toBe(0n);
  expect(lookbackToFromBlock(1_000_000n, 60, 0.25)).toBe(985_600n);
  // scanLogs, range 0–99, fake fetchRange recording its calls and returning one log per call
  it('walks newest first in full windows', …);    // budget {10, 100, 1000}: calls [90,99],[80,89],…,[0,9]; truncated false; fromBlock 0n; requests 10
  it('stops at the request budget', …);           // budget {10, 3, 1000}: calls [90,99],[80,89],[70,79]; truncated true; fromBlock 70n
  it('stops at the log budget', …);               // each call returns 5 logs, maxLogs 10: 2 calls; truncated true; fromBlock 80n
  it('halves the window on a range error', …);    // first call throws a range error: calls [90,99],[95,99],[90,94],[85,89]…; requests counts the failed call
  it('never shrinks below one block', …);
  it('propagates other errors', …);               // including an HTTP 429 compute-units error
  it('reports requestedFromBlock unchanged', …);
  // isLogRangeError: true for the recorded Alchemy error (as a raw object and as viem's InvalidRequestRpcError);
  //   false for "Unsupported method: … on ETH_MAINNET" (also −32600) and for a 429
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/services/logs.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `feat: add budgeted newest-first log scanning`

---

### Task 5.2: Movement decoding and ranking

**Files:**
- Create: `src/protocols/erc20/transfers.ts`, `src/protocols/uniswap/swaps.ts`, `src/tools/movements.ts`
- Test: `test/unit/tools/movements.test.ts`, `test/unit/protocols/uniswap/swaps.test.ts`

**Interfaces:**
- Consumes: `TokenInfo`, `PoolState`, `Price`, `usdValue`.
- Produces:
  ```ts
  // src/tools/movements.ts
  export interface MovementLeg { token: TokenInfo; amount: bigint; direction?: 'sold' | 'bought' } // direction only for swaps, from the trader's side
  export interface Movement { kind: 'transfer' | 'swap'; txHash: Hash; blockNumber: bigint; logIndex: number;
    from: Address; to: Address; legs: MovementLeg[]; usd: number | null }
  export type Threshold = { minUsd: number } | { minAmount: bigint };
  export function rankMovements(movements: Movement[], threshold: Threshold, limit: number): Movement[];
  // src/protocols/erc20/transfers.ts
  export function fetchTransferLogs(ctx, chain, token: Address): (from: bigint, to: bigint) => Promise<Log[]>;
  export function transferMovements(logs: Log[], token: TokenInfo, price: number | null): Movement[];
  // src/protocols/uniswap/swaps.ts
  export function fetchSwapLogs(ctx, chain, pool: Address): (from: bigint, to: bigint) => Promise<Log[]>;
  export function swapMovements(logs: Log[], pool: PoolState, price0: number | null, price1: number | null): Movement[];
  ```

**Rules:**
- A swap's `from` is the event's `sender`, `to` its `recipient`. A positive `amount0`/`amount1` in the event means the pool received that token, so the trader **sold** it; a negative one means the trader **bought** it. Legs carry absolute amounts.
- A swap's `usd` is the value of the sold leg when that token is priced, otherwise the bought leg's, otherwise `null`.
- `minAmount` compares against `legs[0].amount`: the transferred amount for transfers, the **token0** amount for swaps.
- `rankMovements`: keep movements meeting the threshold (a `minUsd` threshold drops movements with `usd === null`); sort by `usd` descending (by `legs[0].amount` for a `minAmount` threshold); ties by `blockNumber` then `logIndex` descending; take `limit`. Returns a new array.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // transferMovements: a Transfer log of 2_500000 raw USDC (6 decimals) at price 1 → usd 2.5, legs [{ token, amount: 2500000n }]
  // swapMovements: amount0 = +1_000000000000000000n (token0 18 dec, price 2000), amount1 = −2_000_000000n (token1 6 dec, price 1)
  //   → legs [{ token0, 10n**18n, 'sold' }, { token1, 2_000_000000n, 'bought' }], usd 2000
  // swapMovements with token0 unpriced → usd from token1 leg; both unpriced → null
  // rankMovements({ minUsd: 100 }): drops usd 99.99 and usd null, keeps usd 100, sorted desc, limit respected
  // rankMovements({ minAmount: 5n }): compares legs[0].amount, sorted by it desc
  // ties resolve to the newer movement first; input array not mutated
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/tools/movements.test.ts test/unit/protocols/uniswap/swaps.test.ts` — fails: modules not found.
- [ ] **Step 3: Implement.** `fetchTransferLogs` and `fetchSwapLogs` return closures over `client.getLogs` filtered by address and event, ready to pass to `scanLogs`.
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `feat: add transfer and swap movement decoding and ranking`

---

### Task 5.3: Indexer asset transfers

**Files:**
- Modify: `src/services/indexer.ts`
- Test: `test/unit/services/indexer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface IndexedTransfer { txHash: Hash; blockNumber: bigint; uniqueId: string; from: Address; to: Address;
    token: Address; rawAmount: bigint } // token is NATIVE_ADDRESS for native transfers
  export const ASSET_TRANSFER_MAX_PAGES = 5;
  export function getAssetTransfers(ctx: AppContext, chain: ChainId, address: Address, fromBlock: bigint, toBlock: bigint):
    Promise<{ transfers: IndexedTransfer[]; truncated: boolean }>; // throws INDEXER_NOT_CONFIGURED without a client
  ```

- [ ] **Step 1: Write the failing tests** (scripted `custom` transport).
  ```ts
  it('queries both directions and merges without duplicates', …); // one request with fromAddress, one with toAddress; a self-transfer appearing in both is returned once (by uniqueId)
  it('requests native and ERC-20 categories within the block range, newest first', …); // params: category ['external','erc20'], order 'desc', hex fromBlock/toBlock, excludeZeroValue true
  it('follows pageKey up to the page cap and reports truncation', …); // 5 pages then stop; truncated true
  it('maps a native transfer to NATIVE_ADDRESS', …);
  it('skips entries with no raw value', …);
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/services/indexer.test.ts` — fails: `getAssetTransfers` not exported.
- [ ] **Step 3: Implement** with `alchemy_getAssetTransfers`, using the request and response shape recorded in spike answer Q8:
  ```jsonc
  // params[0], once with fromAddress and once with toAddress; pageKey added for later pages
  { "fromBlock": "0x…", "toBlock": "0x…", "fromAddress": "0x…", "category": ["external", "erc20"],
    "order": "desc", "excludeZeroValue": true, "withMetadata": false }   // maxCount omitted: default page of 1000
  // result
  { "transfers": [ { "blockNum": "0x19449db", "uniqueId": "0x…:log:617", "hash": "0x…", "from": "0x…", "to": "0x…",
      "value": 1, "asset": "HEX", "category": "erc20",
      "rawContract": { "value": "0x5f5e100", "address": "0x2b59…", "decimal": "0x8" } } ],
    "pageKey": "…" }                                                     // absent on the last page
  ```
  Rules from the spike: these two categories work on all four chains; never request `internal` (Arbitrum rejects it with −32602). `rawAmount` comes from `rawContract.value` (hex), never from the float `value`; an entry whose `rawContract.value` is null is skipped. `rawContract.address === null` (category `external`, `uniqueId` `<hash>:external`) is a native transfer → `NATIVE_ADDRESS`. Decimals come from `readTokens` on-chain, not from `rawContract.decimal`.
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `feat: add indexer asset transfers`

---

### Task 5.4: `get_large_movements`

**Files:**
- Create: `src/tools/get-large-movements.ts`
- Modify: `src/server.ts` (register), `test/e2e/tools.test.ts` (add one row per mode)
- Test: `test/unit/tools/get-large-movements.test.ts`, `test/chain/large-movements.test.ts`

**Interfaces:**
- Consumes: tasks 5.1–5.3, `readPoolState`, `readTokens`, `getUsdPrices`, `parseAmount`, `pinBlock`, `CHAINS`.
- Produces: `parseMovementQuery(input): MovementQuery` (pure, throws `INVALID_INPUT`), `getLargeMovements(ctx, input)`, `register(server, ctx)`.

**Tool contract:**
- Input (flat object; cross-field rules checked in `parseMovementQuery`): `{ chain, mode: 'token' | 'pool' | 'wallet', token?, pool?, address?, minUsd?: number > 0, minAmount?: string, lookbackMinutes?: integer 1–1440 (default 60), limit?: integer 1–100 (default 20) }`.
- Rules: the field matching `mode` is required and the other two must be absent. Exactly one of `minUsd` / `minAmount`. `wallet` mode accepts only `minUsd`. `minUsd` on a token (or a pool with both tokens) lacking a price feed → `INVALID_INPUT` "No USD price feed for <SYMBOL>: use minAmount".
- Output `data`:
  ```jsonc
  {
    "mode": "token", "source": "chain",            // "indexer" for wallet mode
    "subject": { "token": TokenInfo },             // or { "pool": {…token0, token1, feeTier} } or { "address": "0x…" }
    "threshold": { "minUsd": 1000000 },
    "movements": [ { "kind": "transfer", "txHash": "0x…", "blockNumber": "…", "timestamp": "ISO", "from": "0x…", "to": "0x…",
                     "legs": [ { "token": TokenInfo, "amount": Amount, "direction": "sold" } ], "usd": 1234567.8 } ],
    "scan": { "requestedFromBlock": "…", "fromBlock": "…", "toBlock": "…", "requests": 12, "logsScanned": 3400, "truncated": false },
    "priceNote": "USD values use prices at block <n> for the whole window."
  }
  ```
- Block timestamps are fetched only for the blocks of the returned movements and cached `forever`.
- Wallet mode: `getAssetTransfers` over the same block range, token metadata re-read on-chain with `readTokens`, prices from Chainlink; transfers of unpriced or unreadable tokens cannot be evaluated against `minUsd` and are counted.
- Warnings, exact text: `Scanned blocks <fromBlock>–<toBlock> of the requested <requestedFromBlock>–<toBlock>: scan budget reached. Shorten lookbackMinutes or raise LOGS_MAX_REQUESTS.` · `<n> transfers of tokens without a USD price were not evaluated.` · `More transfers exist than the indexer page limit; older ones in the window were not evaluated.` · stale-price warnings.
- Description states: on-demand scan of a recent window, not a live feed; the window may be cut short and `scan` says by how much; USD uses current prices; `minAmount` in pool mode refers to the pool's token0; wallet mode data comes from an indexer.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // parseMovementQuery
  //  mode 'token' without token → INVALID_INPUT; mode 'token' with pool also set → INVALID_INPUT
  //  neither minUsd nor minAmount → INVALID_INPUT; both → INVALID_INPUT
  //  mode 'wallet' with minAmount → INVALID_INPUT
  //  defaults: lookbackMinutes 60, limit 20
  // tool unit (fake clients)
  //  minUsd on an unpriced token → INVALID_INPUT naming the symbol
  //  budget reached → data.scan.truncated true and the scan-budget warning with the right block numbers
  //  wallet mode without indexer → INDEXER_NOT_CONFIGURED
  //  wallet mode counts unpriced transfers in the warning
  // chain (ethereum) — windows and thresholds recorded in the fixture so the result set is small
  it('token mode equals an independent filter of the same logs', …); // set of (txHash, logIndex) and amounts === fixture (cast logs over the same range, filtered by amount)
  it('pool mode equals an independent filter of the same Swap logs', …); // USDC/WETH 0.05% pool
  it('wallet mode returns the reference wallet transfers above the threshold', …); // explicit range ending at PINNED; source 'indexer'
  it('reports the scanned range and it lies within the requested range', …);
  // chain (arbitrum): token mode with the default lookback is truncated by the budget and says so.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/tools/get-large-movements.test.ts test/chain/large-movements.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.** The log-setting defaults are settled by the spike and already in `src/config.ts` and `.env.example`: `LOGS_MAX_BLOCK_RANGE=10` (the free-tier limit) and `LOGS_MAX_REQUESTS=30` (a 30-request burst was not throttled; ~160 ms per sequential request, so a full budget is about 5 s).
- [ ] **Step 4: Record and run.** Derive fixtures with `cast logs`, record, then `pnpm build && pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add get_large_movements`

---

### Task 5.5: Phase gate

**Files:**
- Create: `docs/validation/phase-5.md`

- [ ] **Step 1: Run the gate steps** from the development plan.
- [ ] **Step 2: Manual validation checklist:**

  | # | Check | Reference |
  |---|-------|-----------|
  | 1 | Live token mode, a mid-volume token on Ethereum, 30-minute window: every returned transfer exists with the same amount | Block explorer token-transfer list for the scanned block range |
  | 2 | No transfer above the threshold in the scanned range is missing | Same explorer list, sorted by amount |
  | 3 | Live pool mode on the USDC/WETH pool: returned swaps and their direction | Explorer event log or a pool analytics page |
  | 4 | Live wallet mode for an active wallet | Explorer transfers of the address in the window |
  | 5 | Free-tier coverage table: for each chain, the window actually scanned with default settings for a busy token, requests made and wall time | Server logs; recorded as a table and compared with the spike's prediction (≈ 60 min Ethereum, 10 min Base and Polygon, 75 s Arbitrum). This is the evidence for whether a paid tier is worth it |
  | 6 | Truncated result on Arbitrum or Base carries `truncated: true`, the warning, and correct block numbers | Captured output |
  | 7 | Agent-readability: ask a desktop client "any USDC transfers over $1M in the last half hour?" and check it relays the truncation when there is one | Transcript |

- [ ] **Step 3: Commit** `docs: add phase 5 validation record`
- [ ] **Step 4: Owner review and sign-off.**
