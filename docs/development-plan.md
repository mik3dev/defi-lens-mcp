# defi-lens-mcp Implementation Plan

**Goal:** Build a read-only MCP server that exposes seven DeFi data tools (balances, Aave v3 positions, Uniswap v3 positions, pool state, swap quotes, large movements, transaction simulation) on Ethereum, Base, Arbitrum and Polygon, over stdio and authenticated Streamable HTTP.

**Architecture:** A walking skeleton first (one tool, both transports, CI), then one tool per phase in dependency order. Tool handlers orchestrate; protocol readers under `src/protocols/` know contracts and math; external services (indexer, simulation, ABI lookup) live under `src/services/`; nothing below `src/tools/` knows about MCP. Every tool reads at one pinned block and returns a common envelope.

**Tech Stack:** TypeScript (strict, ESM), Node.js ≥ 22, pnpm, `@modelcontextprotocol/server` + `/node` + `/express`, viem, Zod v4, Express, Vitest, Biome, Foundry (anvil, cast).

**Spec:** [`docs/design.md`](./design.md). Executors read both; where this plan and the spec disagree, stop and raise it.

## Global Constraints

Every task's requirements implicitly include this section.

- Node.js ≥ 22, ESM only, pnpm. TypeScript `strict: true`, no `any` in `src/`.
- Schemas use `zod/v4`. Every tool has `inputSchema` and `outputSchema` and returns `structuredContent`.
- Read-only: no input field, env variable or code path for private keys, seed phrases or signatures.
- In stdio mode only MCP protocol frames go to stdout. All logging goes to stderr.
- No secret (RPC URL, API key, auth token) in errors, logs or tool output.
- Token symbols/names read on-chain are sanitized before leaving the server.
- Every tool response carries `chain`, `blockNumber`, `blockTimestamp`, `data`, `warnings`. Degraded or partial data is always flagged in `warnings`.
- Token amounts are `{ raw, formatted, decimals }` with string values; never floats.
- USD is `number | null`; `null` when there is no price, never an estimate.
- Supported chains: `ethereum`, `base`, `arbitrum`, `polygon`.
- Error codes: `INVALID_INPUT`, `CHAIN_NOT_CONFIGURED`, `NOT_FOUND`, `INDEXER_NOT_CONFIGURED`, `SIMULATION_UNAVAILABLE`, `UPSTREAM_ERROR`, `UPSTREAM_TIMEOUT`, `RATE_LIMITED`, `INTERNAL`.
- Test-first: the failing test is written and seen failing before the code. Coverage ≥ 80% lines and branches on what CI runs.
- Files stay focused: target 200–400 lines, hard limit 800. Functions under 50 lines. No mutation of inputs.
- Conventional commits (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). One commit per task step that says "Commit".
- All repository content is in English.
- Hardcoded protocol addresses come from the protocol's official deployment page, are recorded with the source URL in a comment, and are checked by an on-chain sanity test. If an address in this plan disagrees with the official page, the official page wins and the deviation is noted in the phase validation document.

## Review Focus

Inputs and conditions the spec implies but does not spell out, most likely first. Each one has a test in the task that owns the code.

1. **Addresses in unexpected casing.** All-lowercase and correctly checksummed addresses are accepted and returned checksummed; mixed-case with a bad checksum, wrong length, or non-hex is `INVALID_INPUT`. → Task 0.4 (`addressSchema`).
2. **Tokens that are not well-behaved ERC-20s.** `symbol()` returning `bytes32` (MKR), `symbol()`/`decimals()` reverting, or an address with no code: the token is decoded where possible, otherwise skipped and counted in a warning; the tool never throws. → Task 0.3 (`readTokens`), Task 1.3.
3. **Wallets with far more items than the caps.** Thousands of spam tokens or hundreds of positions: results are cut at `maxTokens` / `maxPositions`, the cut is reported in `warnings`, and the call finishes inside the tool timeout. → Tasks 1.3, 3.2.
4. **Upstream failing mid-call.** An RPC 429 or timeout during one of several multicalls: the tool returns `UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT` with `retryable: true`, no partial data, no URL or key in the message. → Tasks 0.2 (`toAppError`), 7.2.
5. **Malformed amounts.** `amountIn` that is zero, negative, in scientific notation, has more decimals than the token, or is astronomically large; `tokenIn === tokenOut`: `INVALID_INPUT` with a message naming the problem. → Task 4.3.

## Phases

| Phase | File | Delivers | Depends on | Rough effort |
|-------|------|----------|------------|--------------|
| 0 | [phase-0-foundation.md](./plan/phase-0-foundation.md) | Repo, CI, config, chains, both transports with bearer auth, `get_pool_state`, provider spike | — | 3 days |
| 1 | [phase-1-balances-prices.md](./plan/phase-1-balances-prices.md) | Chainlink prices, indexer token discovery, `get_token_balances` | 0 | 2 days |
| 2 | [phase-2-aave.md](./plan/phase-2-aave.md) | `get_aave_positions` | 1 | 1.5 days |
| 3 | [phase-3-uniswap-positions.md](./plan/phase-3-uniswap-positions.md) | Tick/liquidity math, `get_uniswap_positions` | 1 | 2.5 days |
| 4 | [phase-4-swap-quote.md](./plan/phase-4-swap-quote.md) | `get_swap_quote` (multi-hop) | 3 | 2.5 days |
| 5 | [phase-5-large-movements.md](./plan/phase-5-large-movements.md) | `get_large_movements` (token, pool, wallet) | 1 | 2.5 days |
| 6 | [phase-6-simulation.md](./plan/phase-6-simulation.md) | `simulate_transaction` (rpc + Tenderly backends) | 1 | 4 days |
| 7 | [phase-7-hardening.md](./plan/phase-7-hardening.md) | Rate limit, upstream protection, security review | 6 | 2 days |
| 8 | [phase-8-release.md](./plan/phase-8-release.md) | README, tool reference, Docker image, npm package, v0.1.0 | 7 | 2 days |

Effort figures are rough single-developer estimates for sizing only. Phases run in order; each one starts only after the previous phase's gate is signed off by the owner.

Later phases are planned against the design as it stands. The phase 0 spike can change details in phases 5 and 6 (log budgets, simulation tiers, test strategy for `eth_simulateV1`); when it does, the affected phase file is updated before that phase starts and the change is listed in the phase 0 validation document.

## File Structure

```
src/
  index.ts                 entrypoint: loadConfig → createContext → start the chosen transport
  server.ts                buildServer(ctx): McpServer — registers every tool, nothing else
  config.ts                loadConfig(env): Config — one Zod schema, fails fast
  context.ts               AppContext type and createContext(config)
  chains.ts                chain metadata, viem clients, getClient
  transports/
    stdio.ts               startStdio(ctx)
    http.ts                createHttpApp(ctx), startHttp(ctx): bearer auth, rate limit, /mcp, /healthz
  tools/
    shared.ts              common schemas (chain, address, amount, usd, token, envelope), ok(), runTool()
    get-pool-state.ts
    get-token-balances.ts
    get-aave-positions.ts
    get-uniswap-positions.ts
    get-swap-quote.ts
    get-large-movements.ts
    simulate-transaction.ts
  protocols/
    erc20/        abi.ts, tokens.ts (readTokens, readBalances)
    chainlink/    abi.ts, feeds.ts (feed map), prices.ts (getUsdPrices)
    uniswap/      abis.ts, addresses.ts, math.ts, pool.ts, positions.ts, paths.ts, quoter.ts, swaps.ts
    aave/         abis.ts, addresses.ts, market.ts, positions.ts
  services/
    indexer.ts             Alchemy: discoverTokens, getAssetTransfers
    logs.ts                scanLogs — budgeted, newest-first log scanning
    abi.ts                 resolveAbi, decodeCall
    simulation/   types.ts, analyze.ts, rpc.ts, tenderly.ts, index.ts
  lib/
    errors.ts  format.ts  sanitize.ts  cache.ts  logger.ts  limiter.ts  blocks.ts
test/
  unit/        pure logic, no I/O; mirrors src/ paths
  chain/       readers and tools against chain state: replayed from recordings by default, live anvil fork in fork mode
  contract/    recorded HTTP responses of non-RPC services (Tenderly, Sourcify, Etherscan) replayed offline
  e2e/         a real MCP client against the built server, stdio and HTTP
  live/        opt-in, real providers, LIVE=1
  fixtures/    blocks.ts (pinned blocks), rpc/ and http/ recordings, expected values with the cast command that produced them
  helpers/     chain-endpoint.ts, context.ts, mcp-client.ts, replay-fetch.ts
docs/
  design.md  development-plan.md  plan/  validation/  spikes/  tools.md (phase 8)
.github/workflows/  ci.yml  release.yml (phase 8)
```

## Shared Interfaces

Defined in phase 0 and used by every later phase. Later tasks rely on these exact names.

```ts
// src/chains.ts
export const CHAIN_IDS = ['ethereum', 'base', 'arbitrum', 'polygon'] as const;
export type ChainId = (typeof CHAIN_IDS)[number];
export const NATIVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export interface ChainMeta {
  id: ChainId; chainId: number; viemChain: Chain;
  blockTimeSeconds: number; nativeSymbol: string;
  wrappedNative: Address; hubTokens: Address[]; alchemySubdomain: string;
}
export const CHAINS: Record<ChainId, ChainMeta>;
export function getClient(ctx: AppContext, chain: ChainId): PublicClient; // throws AppError('CHAIN_NOT_CONFIGURED')

// src/context.ts
export interface AppContext {
  config: Config;
  clients: Partial<Record<ChainId, PublicClient>>;
  indexerClients: Partial<Record<ChainId, PublicClient>>; // empty without ALCHEMY_API_KEY
  cache: TtlCache;
  logger: Logger;
  fetch: typeof fetch; // injectable for contract tests
}

// src/lib/errors.ts
export type ErrorCode = 'INVALID_INPUT' | 'CHAIN_NOT_CONFIGURED' | 'NOT_FOUND' | 'INDEXER_NOT_CONFIGURED'
  | 'SIMULATION_UNAVAILABLE' | 'UPSTREAM_ERROR' | 'UPSTREAM_TIMEOUT' | 'RATE_LIMITED' | 'INTERNAL';
export class AppError extends Error {
  constructor(code: ErrorCode, message: string, opts?: { retryable?: boolean; cause?: unknown });
  readonly code: ErrorCode; readonly retryable: boolean;
}
export function toAppError(e: unknown): AppError;
export function redact(text: string, secrets: string[]): string;

// src/lib/format.ts
export interface Amount { raw: string; formatted: string; decimals: number }
export function toAmount(raw: bigint, decimals: number): Amount;
export function formatRatio(numerator: bigint, denominator: bigint, significant?: number): string; // default 12
export function usdValue(raw: bigint, decimals: number, price: number | null): number | null;

// src/lib/blocks.ts
export interface PinnedBlock { number: bigint; timestamp: bigint }
export function pinBlock(ctx: AppContext, chain: ChainId): Promise<PinnedBlock>;
// The pinned block is cached for CACHE_TTL_SECONDS (default: the chain's block time). Every volatile cache key
// includes the block number, so a cached value is only ever reused for the block it was read at.

// src/lib/cache.ts
export class TtlCache {
  constructor(maxEntries: number);
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number | 'forever'): void;
  wrap<T>(key: string, ttlMs: number | 'forever', fn: () => Promise<T>): Promise<T>; // dedups concurrent callers
}

// src/protocols/erc20/tokens.ts
export interface TokenInfo { address: Address; symbol: string; decimals: number }
export function readTokens(ctx: AppContext, chain: ChainId, addresses: Address[], block: PinnedBlock):
  Promise<Map<Address, TokenInfo | null>>; // null = not a readable ERC-20; NATIVE_ADDRESS resolves to the native descriptor

// src/tools/shared.ts
export const chainSchema: z.ZodEnum;          // CHAIN_IDS
export const addressSchema: z.ZodType<Address>; // validates, outputs checksummed (input schemas only)
export const checksumAddressSchema: z.ZodType<Address>; // no transform; use it in OUTPUT schemas, because transforms break tools/list
export const amountSchema, tokenSchema, usdSchema; // match Amount, TokenInfo, { usd, priceSource }
export function envelope<T extends z.ZodType>(data: T): z.ZodObject; // { chain, blockNumber, blockTimestamp, data, warnings }
export interface ToolOutput<T> { chain: ChainId; blockNumber: string; blockTimestamp: string; data: T; warnings: string[] }
export function ok<T>(chain: ChainId, block: PinnedBlock, data: T, warnings?: string[]): ToolOutput<T>;
export function runTool<T>(ctx: AppContext, tool: string, chain: ChainId,
  fn: (signal: AbortSignal) => Promise<ToolOutput<T>>): Promise<CallToolResult>;
// runTool: logs one line (tool, chain, durationMs, upstreamRequests, outcome), converts any throw through toAppError into
// { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, retryable }) }] }.
// upstreamRequests is counted per call: runTool opens an AsyncLocalStorage scope and the transport wrapper
// installed by createContext increments its counter. The signal is aborted on timeout from phase 7 on.
```

Each tool file exports `register(server: McpServer, ctx: AppContext): void`. `server.ts` calls each `register` and does nothing else.

## How Tasks Are Written and Executed

Every task follows the same cycle; the task lists what is specific to it.

1. **Tests (red):** write the listed tests, run the given command, see them fail for the stated reason.
2. **Implement:** write the listed signatures in the listed files, the minimum that makes the tests pass.
3. **Verify (green):** run the given command; the stated output means it passed. Then `pnpm lint && pnpm typecheck`.
4. **Commit:** with the given message.

Each task block has **Files**, **Interfaces** (what it consumes from earlier tasks and what it produces for later ones), then the steps. A task implementer sees only their task plus the Shared Interfaces above.

Branching: one branch per phase (`phase-N-<name>`), one pull request per phase into `main`, merged after the owner signs the gate.

## Test Layout and Commands

| Command | Runs | Needs |
|---------|------|-------|
| `pnpm lint` | Biome check | — |
| `pnpm typecheck` | `tsc --noEmit` | — |
| `pnpm test` | unit + chain (replay) + contract + e2e | — |
| `pnpm coverage` | same as `test`, with thresholds 80/80 | — |
| `pnpm test:fork` | chain + e2e against live anvil forks (`CHAIN_MODE=fork`); `RECORD=1` rewrites the recordings | `ALCHEMY_API_KEY` or `RPC_URL_*`, anvil |
| `pnpm test:live` | live provider suite | `LIVE=1`, real keys |
| `pnpm build` | `tsc -p tsconfig.build.json` → `dist/` | — |

- **Chain tests run in two modes from the same test files** (harness built in task 0.3). In fork mode they run against anvil forked at the block pinned in `test/fixtures/blocks.ts` and can record every JSON-RPC exchange. In replay mode, the default, a local JSON-RPC server answers from those recordings. CI therefore executes the chain-reading code and its assertions with no secrets.
- This is stricter than spec §3 and §9, which expected these tests to be skipped in CI. Recordings can go stale against the code but not against the chain, so the fork run stays mandatory at every phase gate and is the source of truth; a test that issues a request with no recording fails with an instruction to re-record.
- Requests must be deterministic for replay: viem clients run with automatic batching off, and reads are grouped with explicit `multicall` at the pinned block.
- Expected values are derived independently with `cast call … --block <pinned>` and stored in `test/fixtures/` together with the exact command that produced them. Assertions on raw on-chain values are exact equality.
- "Now" for staleness checks is the pinned block's timestamp, never the wall clock, so chain tests are deterministic.
- The live suite uses `describe.skipIf(!process.env.LIVE)`; it reports as skipped, never as passed, when not requested.

## Phase Gate

The last task of every phase is its gate (spec §10). The builder runs it and writes `docs/validation/phase-N.md`; the owner reviews and signs; the next phase does not start before that.

Gate steps, identical in every phase:

- [ ] `pnpm lint && pnpm typecheck && pnpm coverage && pnpm build` — all green, coverage ≥ 80/80.
- [ ] `RECORD=1 pnpm test:fork` (and `pnpm test:live` when the phase added live tests) — green; paste the summary into the validation document. Then `pnpm test` again with no RPC variables set — green from the fresh recordings; commit any recording that changed.
- [ ] CI green on the phase pull request.
- [ ] Code review of the phase diff; critical and high findings fixed, the rest listed.
- [ ] Manual validation checklist of the phase executed and recorded (table below).
- [ ] Demonstration from a real MCP client over stdio (MCP Inspector or a desktop client); over HTTP too when the phase touches HTTP.
- [ ] Tool descriptions and docs for the phase written; deviations from the spec recorded with their reason.
- [ ] Owner sign-off recorded.

Validation document template:

```markdown
# Phase N validation — <name>

- Date: · Commit: · RPC provider and tier: · Pinned blocks:

## Verification
| Check | Command / link | Result |
|-------|----------------|--------|

## Validation
| # | Check | Reference source | Reference value | Tool value | Tolerance | Pass |
|---|-------|------------------|-----------------|------------|-----------|------|

## Demonstration
Client, transport, calls made, where the transcript or screenshots are.

## Deviations from the design
## Open issues carried forward
## Owner sign-off
- [ ] Approved by ______ on ______
```

Tolerances for manual validation against reference UIs (the reference is read at a slightly different moment than the tool's block):

| Quantity | Tolerance |
|----------|-----------|
| Token balances, position amounts, ticks | exact at the same block; otherwise explain the difference |
| USD prices and values | ±0.5% |
| Aave health factor | ±0.01 |
| Uniswap unclaimed fees | ±1% (accrue every block) |
| Swap quote vs Uniswap app | ±0.5% for the same route; a better app price through a split route is recorded, not a failure |
| Simulation replay vs mined transaction | exact asset changes; gas within ±5% |

## Owner Actions

Things only the owner can do; each phase file repeats the ones it needs.

| When | Action |
|------|--------|
| Before phase 0 | Put `ALCHEMY_API_KEY` (free tier) and Tenderly credentials in a local `.env` (git-ignored). Create the public GitHub repository and add it as `origin`. |
| End of every phase | Review `docs/validation/phase-N.md`, approve or send back. |
| Before phase 8 | Create an npm access token and add it as the `NPM_TOKEN` repository secret; confirm the npm package name is available. |
| Any time | Decide whether to add an RPC secret to CI or move to a paid RPC tier, based on the phase 0 spike report. |
