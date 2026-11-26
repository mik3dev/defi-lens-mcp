# Phase 6 — Transaction Simulation

Part of the [development plan](../development-plan.md). Spec: [design.md](../design.md) §4.3, §5.7.

**Outcome:** `simulate_transaction` decodes an unsigned transaction, simulates it on the configured backend, and reports asset changes, transfers, approvals and risk flags. Validated by replaying real mined transactions.

**Depends on:** phase 1 signed off. Spike answers Q1–Q5, Q7 and Q9. This file is revised with the spike's decisions before the phase starts (in particular: whether a `debug_traceCall` tier is added, and whether chain tests for `eth_simulateV1` run on anvil or are forwarded to the provider).

**Branch:** `phase-6-simulation`

---

### Task 6.1: Simulation types and analyzer

**Files:**
- Create: `src/services/simulation/types.ts`, `src/services/simulation/analyze.ts`
- Modify: `src/lib/format.ts` (`toAmount` accepts negative values)
- Test: `test/unit/services/simulation/analyze.test.ts`, `test/unit/lib/format.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type AbiSource = 'builtin' | 'sourcify' | 'etherscan' | 'signature-db';
  export interface SimTx { from: Address; to: Address; data: Hex; value: bigint; gas?: bigint; blockNumber?: bigint }
  export interface SimLog { address: Address; topics: Hex[]; data: Hex }
  export interface NormalizedSim {
    backend: 'rpc' | 'tenderly'; status: 'success' | 'reverted'; revertData: Hex | null;
    gasUsed: bigint | null; blockNumber: bigint; degraded: boolean;
    logs: SimLog[] | null;                                                    // null when degraded
    nativeTransfers: { from: Address; to: Address; value: bigint }[] | null;  // null when degraded
    balanceDiffs: { token: Address; diff: bigint }[] | null;                  // for tx.from; native as NATIVE_ADDRESS; null when degraded
  }
  export interface SimulationBackend { readonly name: 'rpc' | 'tenderly'; simulate(chain: ChainId, tx: SimTx): Promise<NormalizedSim> }
  // analyze.ts
  export interface TransferRecord { standard: 'native' | 'erc20' | 'erc721'; token: Address; from: Address; to: Address; amount?: bigint; tokenId?: bigint }
  export interface ApprovalRecord { standard: 'erc20' | 'erc721' | 'all'; token: Address; owner: Address; spender: Address;
    amount?: bigint; tokenId?: bigint; approved?: boolean; unlimited: boolean }
  export type RiskFlag = 'REVERTS' | 'UNLIMITED_APPROVAL' | 'APPROVAL_FOR_ALL' | 'NET_OUTFLOW_NO_INFLOW' | 'UNVERIFIED_CONTRACT' | 'DEGRADED_SIMULATION';
  export const UNLIMITED_THRESHOLD = 2n ** 96n - 1n;
  export function extractTransfers(sim: NormalizedSim): TransferRecord[];
  export function extractApprovals(sim: NormalizedSim): ApprovalRecord[];
  export function decodeRevert(revertData: Hex | null, abi?: Abi): string | null;
  export function riskFlags(sim: NormalizedSim, from: Address, approvals: ApprovalRecord[],
    target: { hasCode: boolean; abiSource: AbiSource | null }): RiskFlag[];
  ```

**Rules:**
- `Transfer` event with 3 topics is ERC-20 (amount in data); with 4 topics is ERC-721 (`tokenId` in topic 3). Same split for `Approval`. `ApprovalForAll` gives `standard: 'all'`.
- `unlimited` is true for an ERC-20 approval with `amount >= UNLIMITED_THRESHOLD` (covers `uint256` and `uint96` maxima) and for `ApprovalForAll` with `approved === true`.
- Flags: `REVERTS` when reverted. `DEGRADED_SIMULATION` when `sim.degraded`. `UNLIMITED_APPROVAL` when an ERC-20 approval **granted by `from`** is unlimited. `APPROVAL_FOR_ALL` when `from` sets `ApprovalForAll` to true. `NET_OUTFLOW_NO_INFLOW` when `balanceDiffs` has at least one negative diff and no positive one. `UNVERIFIED_CONTRACT` when the target has code and `abiSource` is `null` or `'signature-db'`.
- `decodeRevert`: `Error(string)` → the string, sanitized and truncated to 256 characters; `Panic(uint256)` → `Panic(0x<code>)`; a custom error found in `abi` → `Name(arg, …)`; other non-empty data → `Custom error 0x<selector>`; empty or null → `null`.

- [ ] **Step 1: Write the failing tests.** Logs are built in the test with viem's `encodeEventTopics` / `encodeAbiParameters`.
  ```ts
  // format
  expect(toAmount(-1500000n, 6)).toEqual({ raw: '-1500000', formatted: '-1.5', decimals: 6 });
  // extractTransfers
  //  one ERC-20 Transfer log → [{ standard: 'erc20', token, from, to, amount }]
  //  one ERC-721 Transfer log → [{ standard: 'erc721', tokenId }]
  //  nativeTransfers [{ from, to, value: 5n }] → [{ standard: 'native', token: NATIVE_ADDRESS, amount: 5n }]
  //  a log with the Transfer topic but 2 topics is ignored; degraded sim → []
  // extractApprovals
  //  Approval(owner, spender, 2n**256n − 1n) → unlimited true;  Approval(…, 2n**96n − 1n) → unlimited true;  Approval(…, 1000n) → false
  //  ApprovalForAll(owner, operator, true) → { standard: 'all', approved: true, unlimited: true }; with false → unlimited false
  // decodeRevert
  expect(decodeRevert(encodeErrorString('ERC20: transfer amount exceeds balance'))).toBe('ERC20: transfer amount exceeds balance');
  expect(decodeRevert('0x4e487b710000000000000000000000000000000000000000000000000000000000000011')).toBe('Panic(0x11)');
  expect(decodeRevert('0xdeadbeef')).toBe('Custom error 0xdeadbeef');
  expect(decodeRevert('0x')).toBeNull();
  //  an Error(string) containing control characters is returned sanitized
  // riskFlags
  //  reverted → ['REVERTS'];  degraded → includes 'DEGRADED_SIMULATION'
  //  unlimited approval with owner === from → 'UNLIMITED_APPROVAL';  with owner !== from → not flagged
  //  diffs [−5] → 'NET_OUTFLOW_NO_INFLOW';  diffs [−5, +3] → not flagged;  diffs null → not flagged
  //  target { hasCode: true, abiSource: null } and 'signature-db' → 'UNVERIFIED_CONTRACT';  { hasCode: false, abiSource: null } → not flagged
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/services/simulation test/unit/lib/format.test.ts` — fails: modules not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `feat: add simulation result model and analyzer`

---

### Task 6.2: ABI resolution and call decoding

**Files:**
- Create: `src/services/abi.ts`, `test/helpers/replay-fetch.ts`
- Test: `test/contract/abi.test.ts`, `test/unit/services/abi.test.ts`

**Interfaces:**
- Consumes: `AbiSource` (task 6.1), `AppContext.fetch`, `AppContext.cache`, `getClient`, `readTokens`, `sanitizeSymbol`, protocol ABIs and addresses from earlier phases.
- Produces:
  ```ts
  export interface DecodedCall { functionName: string; signature: string; args: { name: string; type: string; value: string }[]; abiSource: AbiSource }
  export function resolveAbi(ctx: AppContext, chain: ChainId, address: Address): Promise<{ abi: Abi; source: AbiSource } | null>;
  export function decodeCall(ctx: AppContext, chain: ChainId, to: Address, data: Hex): Promise<DecodedCall | null>;
  export function formatArg(value: unknown): string;
  // test/helpers/replay-fetch.ts
  export function replayFetch(fixture: string): typeof fetch; // serves test/fixtures/http/<fixture>.json; records when RECORD=1 and LIVE=1; never stores headers or query keys
  ```

**Resolution order** (first that can decode the selector wins):
1. **Built-in:** the Uniswap position manager, Uniswap SwapRouter02 (address per chain from the official deployments page, sanity-checked on-chain) and Aave pool at their known addresses; the ERC-20 ABI when the selector is a standard ERC-20 function and `readTokens` recognises the address as a token.
2. **Sourcify** for `(chainId, address)`.
3. **Etherscan**, only when `ETHERSCAN_API_KEY` is set.
4. **Signature database** lookup of the 4-byte selector → decoded from the text signature, argument names empty, `abiSource: 'signature-db'`.

Endpoints and response shapes are those recorded in spike answer Q9.

**Rules:**
- Empty `data` or a `to` with no code → `null`, with no lookups.
- Proxy handling, one level: when a resolved ABI does not contain the selector, read the EIP-1967 implementation slot (`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`) with `getStorageAt`; if it holds an address, resolve that address's ABI and decode with it.
- A failing or slow ABI service is not an error: 5-second timeout each, fall through to the next source. All sources failing → `null`.
- Cache: found ABIs `forever`, misses for 10 minutes.
- `formatArg`: bigint → decimal string; address → checksummed; bytes → hex, cut to 66 characters followed by `…(<n> bytes)` when longer; string → sanitized, max 256 characters; arrays and tuples → JSON of formatted members. The serialized `args` of one call are capped at 4 KB; beyond that the remaining args are replaced by one entry `{ name: '…', type: 'truncated', value: '<n> more arguments' }`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit — formatArg
  expect(formatArg(10n ** 18n)).toBe('1000000000000000000');
  expect(formatArg('0x' + 'ab'.repeat(100))).toMatch(/^0x(ab){32}…\(100 bytes\)$/);
  expect(formatArg('evil\u0000name')).toBe('evilname');
  //  empty data → null and ctx.fetch not called;  to without code → null and ctx.fetch not called
  //  ERC-20 transfer(address,uint256) on a recognised token → abiSource 'builtin', functionName 'transfer', args [to, amount] by name
  //  args over 4 KB are truncated with the marker entry
  // contract — replayFetch fixtures
  it('decodes with a Sourcify ABI', …);                                   // verified contract → abiSource 'sourcify', named args
  it('falls back to the signature database when no ABI is published', …); // abiSource 'signature-db'
  it('skips Etherscan without a key and uses it with one', …);
  it('resolves through an EIP-1967 proxy', …);
  it('returns null when every source fails or times out', …);             // fetch rejects / never resolves (fake timers)
  it('caches a found ABI', …);                                            // second call makes no HTTP request
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/services/abi.test.ts test/contract/abi.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Record and run.** `RECORD=1 LIVE=1 pnpm vitest run test/contract/abi.test.ts`, check the recordings contain no key, then `pnpm test`. Both pass.
- [ ] **Step 5: Commit** `feat: add ABI resolution and call decoding`

---

### Task 6.3: RPC simulation backend

**Files:**
- Create: `src/services/simulation/rpc.ts`
- Test: `test/unit/services/simulation/rpc.test.ts`, `test/chain/simulation-rpc.test.ts`

**Interfaces:**
- Consumes: `SimTx`, `NormalizedSim`, `SimulationBackend`, `getClient`, `toAppError`.
- Produces: `createRpcBackend(ctx: AppContext): SimulationBackend`; `isSimulateUnsupported(e: unknown): boolean` (JSON-RPC code −32601, or the provider's error text recorded in spike Q1).

**Behaviour:**
- Primary path: viem `simulateCalls({ account: tx.from, calls: [{ to, data, value, gas }], blockNumber, traceAssetChanges: true, traceTransfers: true })`. Map `results[0]` status, gas and logs; native-transfer pseudo-logs (emitted from the `0xEeee…` address) become `nativeTransfers` and are removed from `logs`; `assetChanges` become `balanceDiffs`.
- Degraded path, when `isSimulateUnsupported`: `client.call` (a revert yields `status: 'reverted'` and its data) plus `client.estimateGas` on success; result has `degraded: true`, `logs`, `nativeTransfers`, `balanceDiffs` all `null`. The "unsupported" verdict is cached per chain for 10 minutes.
- Any other failure → thrown as `UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT`. A block the provider cannot serve → `UPSTREAM_ERROR` "The RPC provider cannot serve state at block <n>."

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit — scripted custom transport
  it('maps a successful simulation', …);            // status success, gasUsed, logs without the native pseudo-log, nativeTransfers, balanceDiffs
  it('maps a reverted simulation', …);              // status reverted, revertData present, degraded false
  it('falls back to call + estimateGas when eth_simulateV1 is unsupported', …); // degraded true, traces null, gasUsed set
  it('degraded fallback reports a revert', …);
  it('remembers that a chain does not support simulation', …); // second simulate issues no eth_simulateV1 request
  it('does not degrade on other upstream errors', …);          // HTTP 500 → rejects with UPSTREAM_ERROR
  // chain (ethereum) — on the harness per spike Q2
  it('plain ETH transfer', …);        // one nativeTransfer, balanceDiffs [{ NATIVE_ADDRESS, −value }]
  it('ERC-20 transfer from a large holder', …); // one Transfer log, diff −amount for the token
  it('transfer above balance reverts', …);
  it('simulates at an explicit historical block', …); // blockNumber = PINNED − 10n → result.blockNumber matches
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/services/simulation/rpc.test.ts test/chain/simulation-rpc.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Record and run.** Record, then `pnpm test`. Both pass.
- [ ] **Step 5: Commit** `feat: add RPC simulation backend with degraded fallback`

---

### Task 6.4: Tenderly simulation backend

**Files:**
- Create: `src/services/simulation/tenderly.ts`, `src/services/simulation/index.ts`
- Test: `test/contract/simulation-tenderly.test.ts`, `test/live/simulation-tenderly.test.ts`

**Interfaces:**
- Consumes: `Config.tenderly`, `AppContext.fetch`, `SimTx`, `NormalizedSim`.
- Produces: `createTenderlyBackend(ctx: AppContext): SimulationBackend`; `getBackend(ctx: AppContext): SimulationBackend` (by `config.simulationBackend`; built once per context).

**Behaviour:** one POST to Tenderly's simulate endpoint for the configured account and project, authenticated with the access-key header, full simulation, not saved; request and response field names as recorded in spike answer Q5. The response is mapped to `NormalizedSim` (raw logs, native transfers, balance diffs of `tx.from`). 20-second timeout. **No fallback to the RPC backend.** Failures: 401/403 → `SIMULATION_UNAVAILABLE` "Tenderly rejected the configured credentials."; 429 → `UPSTREAM_ERROR` retryable; other statuses → `UPSTREAM_ERROR`. The access key never appears in an error.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // contract — replayFetch fixtures seeded from the spike's redacted response
  it('sends the transaction, network id and block number', …); // request body fields; access-key header present; URL contains account and project
  it('maps a successful swap simulation', …);  // status success; logs include the Transfer events; balanceDiffs for from match the fixture
  it('maps a reverted simulation', …);
  it('maps 401 to SIMULATION_UNAVAILABLE without leaking the key', …);
  it('maps 429 to a retryable UPSTREAM_ERROR', …);
  it('times out after 20 seconds', …);         // fake timers → UPSTREAM_TIMEOUT
  it('getBackend returns the backend named by the config', …);
  // live (LIVE=1): simulates a plain ETH transfer on ethereum and gets status success.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/contract/simulation-tenderly.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test`, then `LIVE=1 pnpm test:live -- simulation-tenderly`. Both pass.
- [ ] **Step 5: Commit** `feat: add Tenderly simulation backend`

---

### Task 6.5: `simulate_transaction`

**Files:**
- Create: `src/tools/simulate-transaction.ts`
- Modify: `src/server.ts` (register), `test/e2e/tools.test.ts` (add row)
- Test: `test/unit/tools/simulate-transaction.test.ts`, `test/chain/simulate-transaction.test.ts`

**Interfaces:**
- Consumes: `getBackend`, `extractTransfers`, `extractApprovals`, `riskFlags`, `decodeRevert`, `decodeCall`, `resolveAbi`, `readTokens`, `getUsdPrices`, `toAmount`, `usdValue`, `pinBlock`.
- Produces: `simulateTransaction(ctx, input)`, `register(server, ctx)`, pure mapper `toSimulationData(…)`.

**Tool contract:**
- Input: `{ chain, from, to, data?: hex string (default "0x", max 131 072 bytes), value?: string (wei, decimal digits, default "0"), gas?: string (decimal digits), blockNumber?: string (decimal digits) }`.
- Output `data`:
  ```jsonc
  {
    "backend": "rpc", "simulatedAtBlock": "…", "status": "success", "revertReason": null, "gasUsed": "…",
    "decodedCall": { "contract": "0x…", "functionName": "approve", "signature": "approve(address,uint256)",
                     "args": [ { "name": "spender", "type": "address", "value": "0x…" } ], "abiSource": "builtin" },
    "assetChanges": [ { "token": TokenInfo, "diff": Amount, "usd": -1500.2 } ],   // null when degraded
    "transfers":  [ { "standard": "erc20", "token": TokenInfo, "from": "0x…", "to": "0x…", "amount": Amount } ],
    "approvals":  [ { "standard": "erc20", "token": TokenInfo, "owner": "0x…", "spender": "0x…", "amount": Amount, "unlimited": true } ],
    "riskFlags": [ "UNLIMITED_APPROVAL" ]
  }
  ```
- The envelope's `blockNumber` is the latest block the prices and token metadata were read at; `simulatedAtBlock` is the block the transaction ran against.
- Tokens that `readTokens` cannot read are reported as `{ address, symbol: 'UNKNOWN', decimals: 0 }`. ERC-721 entries carry `tokenId` instead of `amount`.
- `transfers` and `approvals` are capped at 100 entries each.
- Warnings, exact text: `Simulation backend could not trace asset changes: only status and gas are reported.` · `Simulated against historical block <n>; USD values use current prices.` · `Showing the first 100 of <n> transfers.` (same for approvals) · stale-price warnings.
- Description states: simulates an unsigned transaction, never signs or sends; runs against one block and the real outcome can differ; ERC-1155 balances and tokens that move without `Transfer` events are not reflected; transaction contents are sent to the configured RPC and, depending on configuration, to Tenderly and ABI services; what each risk flag means.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // unit
  it('accepts no key-like input', …); // Object.keys(inputSchema.shape) matches none of /key|secret|mnemonic|seed|signature|private/i
  it('rejects data that is not hex, odd-length hex, or over the size limit', …); // INVALID_INPUT
  it('rejects a non-decimal value, gas or blockNumber', …);                      // '0x10', '-1', '1.5' → INVALID_INPUT
  it('maps a degraded simulation', …); // assetChanges null, riskFlags contains DEGRADED_SIMULATION, the degraded warning present
  it('caps transfers at 100 with a warning', …);
  it('reports unreadable tokens as UNKNOWN', …);
  it('adds the historical-block warning when blockNumber is given', …);
  // chain (ethereum)
  it('plain ETH transfer between EOAs', …);  // decodedCall null; transfers [native]; assetChanges [ETH −value]; riskFlags ['NET_OUTFLOW_NO_INFLOW']
  it('ERC-20 approve of max uint', …);       // decodedCall.functionName 'approve', abiSource 'builtin'; approvals[0].unlimited; riskFlags contains 'UNLIMITED_APPROVAL'
  it('ERC-20 transfer above balance', …);    // status 'reverted'; revertReason non-null; riskFlags contains 'REVERTS'
  it('swap through the Uniswap router from a funded holder', …); // assetChanges has one negative and one positive diff; no NET_OUTFLOW flag
  // e2e: tools.test.ts row for simulate_transaction (plain ETH transfer).
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/tools/simulate-transaction.test.ts test/chain/simulate-transaction.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.** Flow: validate → pin latest block → `getBackend(ctx).simulate` → in parallel `decodeCall` and `getCode(to)` → `extractTransfers` / `extractApprovals` → read token metadata and prices for every token involved → `riskFlags` → `toSimulationData`.
- [ ] **Step 4: Record and run.** Record, then `pnpm build && pnpm test`. All pass.
- [ ] **Step 5: Commit** `feat: add simulate_transaction`

---

### Task 6.6: Replay validation suite

The strongest check in the project: simulate transactions that were really mined and compare with what happened.

**Files:**
- Create: `test/live/simulation-replay.test.ts`, `test/fixtures/replay-transactions.ts`

**Interfaces:**
- Consumes: `simulateTransaction`, both backends.

**Selection of transactions** (recorded in the fixture with hash, chain, and why it was chosen): on Ethereum — a Uniswap swap, an Aave supply, an ERC-20 `approve`, a transaction that reverted on-chain; on one L2 — a Uniswap swap. Each must be the first transaction in its block that touches the sender's balances and the pools or reserves involved, so that state at the parent block equals the state the transaction actually saw. If the provider cannot serve state that old (spike Q7), pick transactions from the most recent blocks it can serve and note the constraint.

- [ ] **Step 1: Write the suite** (`describe.skipIf(!process.env.LIVE)`). For each fixture transaction, fetch it and its receipt, simulate `{ from, to, data, value, blockNumber: receipt.blockNumber − 1 }`, and assert:
  ```ts
  //  status equals the receipt status
  //  for a successful tx: the set of ERC-20 Transfer events involving `from` in the simulation equals the receipt's (token, from, to, amount) — exact
  //  assetChanges for `from` equal the net of those transfers plus the native value sent — exact
  //  gasUsed within ±5% of receipt.gasUsed
  //  for the reverted tx: status 'reverted' and riskFlags contains 'REVERTS'
  //  for the approve tx: approvals equal the receipt's Approval event
  //  with SIMULATION_BACKEND=rpc and =tenderly: status, transfers, approvals and assetChanges are identical between backends
  ```
- [ ] **Step 2: Run** `LIVE=1 pnpm test:live -- simulation-replay` — passes for both backends. Any mismatch is investigated to a root cause before the gate; a mismatch explained by intra-block ordering means the transaction was badly chosen and is replaced.
- [ ] **Step 3: Commit** `test: add mined-transaction replay validation for simulation`

---

### Task 6.7: Phase gate

**Files:**
- Create: `docs/validation/phase-6.md`

- [ ] **Step 1: Run the gate steps** from the development plan, including `pnpm test:live`.
- [ ] **Step 2: Manual validation checklist:**

  | # | Check | Reference |
  |---|-------|-----------|
  | 1 | Replay suite results for every fixture transaction on both backends | The mined receipts; exact asset changes, gas ±5% |
  | 2 | The same swap simulated on `rpc` and on `tenderly` | Each other, and the Tenderly dashboard simulation of the same transaction |
  | 3 | Decoding of a call to a verified contract, a proxy, and an unverified contract | Block explorer "decoded input" view; `abiSource` and `UNVERIFIED_CONTRACT` as expected |
  | 4 | Degraded mode: server pointed at an RPC without `eth_simulateV1` (or with the method blocked) | Output shows status and gas, `assetChanges: null`, the flag and the warning |
  | 5 | Tenderly with a wrong key | `SIMULATION_UNAVAILABLE`, no key in output or logs, no silent switch to `rpc` |
  | 6 | A token with a hostile symbol appearing in a simulated transfer is sanitized | Captured output |
  | 7 | Agent-readability: give a desktop client an unlimited-approval transaction and ask "is this safe to sign?"; it should surface the approval and the spender | Transcript |

- [ ] **Step 3: Commit** `docs: add phase 6 validation record`
- [ ] **Step 4: Owner review and sign-off.**
