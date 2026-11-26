# defi-lens-mcp — Design

- **Date:** 2026-11-25
- **Status:** Approved by the owner on 2026-11-25
- **Scope of this document:** what gets built and why. The step-by-step development plan lives in [`development-plan.md`](./development-plan.md).

Decisions are tagged **[owner]** when the project owner made them and **[call]** when the author of this document filled them in. Every [call] is open to correction.

---

## 1. Intent

`defi-lens-mcp` is a read-only Model Context Protocol server that gives an AI agent a **verifiable** view of DeFi state on EVM chains: what a wallet holds, what its positions are in Aave v3 and Uniswap v3, what a pool looks like, what a swap would return, which large movements happened recently, and what a transaction would do before anyone signs it.

Why it exists: agents that act on-chain today either hallucinate state or depend on opaque third-party APIs. This server answers from the chain itself, pins every answer to a block, and never holds a key. The differentiating tool is `simulate_transaction`: an agent that can explain what a transaction will do before the user signs it.

Who uses it: AI agents through MCP clients (Claude Desktop, Cursor, Claude Code over stdio) and backend agents calling it as a service over HTTP.

## 2. Goals, non-goals, anti-goals

### Goals

1. Seven MCP tools (section 5) on Ethereum, Base, Arbitrum and Polygon. **[owner]**
2. Read-only by design: no private keys, no signing, no broadcasting. Transactions are only simulated. **[owner]**
3. Every numeric answer is traceable: responses carry the chain, block number and block timestamp they were read at.
4. Two transports: stdio and Streamable HTTP. **[owner]**
5. HTTP transport ships with authentication and rate limiting. **[owner]**
6. Inputs and outputs of every tool are validated with Zod; outputs are published as `outputSchema` and returned as `structuredContent`. **[owner]**
7. Every development phase ends with an explicit verification and validation gate (section 10). **[owner]**

### Non-goals (MVP)

- Building, signing or sending transactions; producing unsigned calldata.
- Uniswap v2 / v4, Aave v2, Aave markets other than the main (Core) market per chain, any other protocol.
- Split routes or a full smart order router. Quotes are single-path, up to two hops.
- Exact-output quotes. **[call]** — exact-input only; exact-output is an additive follow-up.
- Historical USD pricing. USD values use the price at the response block.
- USD prices for tokens with no Chainlink feed (returned as `null`).
- Real-time subscriptions, webhooks, background watchers, any persistent storage.
- OAuth. HTTP auth is static bearer tokens.
- Distributed rate limiting or multi-instance cache. One process, in-memory state.
- Address labeling (exchange names, known whales), NFT valuation.

### Anti-goals (a build that does these has failed even if it "works")

- Returning a number that cannot be tied to a block.
- Returning partial or degraded data without saying so in the response.
- Any code path that accepts, stores or logs a private key or seed phrase.
- Leaking RPC URLs, API keys or auth tokens in errors, logs or tool output.
- Writing anything other than MCP protocol frames to stdout in stdio mode.
- Passing on-chain strings (token names/symbols) to the agent unsanitized.

## 3. Constraints

- **Stack [owner]:** TypeScript, official MCP TypeScript SDK, viem, Zod, Vitest, anvil (Foundry) for fork tests.
- **MCP SDK shape (verified against current docs on 2026-11-25):** the SDK is split into `@modelcontextprotocol/server`, `@modelcontextprotocol/node` and `@modelcontextprotocol/express`; tools are registered with `McpServer.registerTool(name, { description, inputSchema, outputSchema, annotations }, handler)`; schemas use `zod/v4`. Exact versions are pinned when the repo is scaffolded, and the builder re-checks the docs at that moment.
- **Runtime [call]:** Node.js ≥ 22, ESM, pnpm.
- **Stateless tools:** every tool call is independent; nothing survives a restart except configuration.
- **External services:** an EVM JSON-RPC endpoint per chain, Alchemy as the indexer **[call — owner asked for "an indexer", Alchemy chosen because it covers all four chains with one key]**, Chainlink price feeds (on-chain), optionally Tenderly for simulation, Sourcify (and optionally Etherscan) for ABIs.
- **Documentation language [owner]:** English.
- **Provider accounts [owner]:** Alchemy on the **free tier** to start (paid later only if needed); a Tenderly account is available; **no CI secrets for now**.
- **Distribution [owner]:** public open-source repository, MIT license. Published as an npm package and a container image on GHCR in phase 8 **[call]**.

### What the provider constraints change

- **Free-tier log limits.** Free RPC tiers restrict the block range of `eth_getLogs` severely, so `get_large_movements` in `token` and `pool` modes is budgeted by **number of log requests per call**, not only by time. Two settings govern it: `LOGS_MAX_BLOCK_RANGE` (blocks per request) and `LOGS_MAX_REQUESTS` (requests per tool call). The window actually scanned is `min(requested lookback, range × requests)`, newest first, and the response reports it. Defaults are set for the free tier from the limits measured in the phase 0 spike; a paid tier or another RPC only needs different values, no code change. On fast chains (Arbitrum, Base) the free-tier window will be short, and the tool says so rather than pretending to cover the full lookback.
- **No CI secrets.** CI runs everything that needs no network: lint, typecheck, unit, service-contract tests on recorded fixtures, protocol-level E2E (tool listing, schemas, auth, rate limit, input-validation errors), build, audit. Fork tests, tool-calling E2E and live suites run **locally** and are part of each phase gate, with their output recorded in the validation document. CI reports them as skipped, never as passed. Adding a secret later turns them on in CI without code changes.
- **Tenderly available.** The Tenderly backend is exercised live in the local suite, and phase 6's "both backends agree" check is run for real.

## 4. Approaches considered

### 4.1 Build order

| # | Approach | Trade-off |
|---|----------|-----------|
| 1 | **Walking skeleton, then tools in dependency order, with an early simulation spike** | Each phase ends demonstrable and tested. The differentiator lands last, so a time-boxed spike in phase 0 measures the simulation risk up front. |
| 2 | Risk first: build `simulate_transaction` fully, then the rest | Hardest tool built with no foundation (config, cache, errors, tests); part of it gets redone. |
| 3 | Horizontal layers: all of `lib/`, `chains`, `protocols/`, then all tools, then transports | Nothing usable end to end until late; abstractions are guessed before a tool needs them. |

**Picked: 1 [owner].**

### 4.2 Large-movement detection

| # | Approach | Trade-off |
|---|----------|-----------|
| 1 | **On-demand scan** of `Transfer` logs for a token or `Swap` logs for a pool over a bounded lookback, filtered by USD | Stateless, fits read-only request/response. Window bounded by `eth_getLogs` limits. |
| 2 | **Per-wallet** large transfers through the indexer | Simple, but sees one address, not the market. |
| 3 | Background watcher with subscriptions and MCP notifications | Real time, but stateful and awkward over stdio and in tests. |

**Picked: 1, with 2 as an extra mode of the same tool [owner].** 3 is a non-goal.

### 4.3 Simulation backend

Selected by environment variable **[owner]**: `rpc` (`eth_simulateV1`, with a degraded fallback) or `tenderly`. Two real implementations justify one small backend interface (section 5.7).

### 4.4 Swap routing

Multi-hop **[owner]**. Shape **[call]**: enumerate direct paths and two-hop paths through a short per-chain list of hub tokens, quote each with Uniswap's QuoterV2, return the best. A full router with split routes was dropped as out of proportion for an MVP.

## 5. Tools

### 5.0 Conventions shared by all tools

- **`chain` input:** enum `ethereum | base | arbitrum | polygon`. A chain with no RPC configured returns `CHAIN_NOT_CONFIGURED`.
- **Addresses:** validated and returned checksummed. ENS names are not resolved in the MVP **[call]**.
- **Block pinning:** a tool reads the latest block number once, then performs all its on-chain reads at that block. The response envelope is:

  ```jsonc
  {
    "chain": "ethereum",
    "blockNumber": "21234567",
    "blockTimestamp": "2026-11-25T18:04:11Z",
    "data": { /* tool-specific */ },
    "warnings": []            // human-readable, e.g. "price feed stale", "result truncated"
  }
  ```

- **Amounts:** `{ "raw": "<integer string>", "formatted": "<decimal string>", "decimals": n }`. No floats for token amounts.
- **USD:** `{ "usd": number | null, "priceSource": "chainlink" | null }`. `null` means no feed; never a guess.
- **Token descriptors:** `{ address, symbol, decimals }`. Symbols are read on-chain, stripped of control characters and truncated to 32 characters, because they are attacker-controlled text that an LLM will read.
- **Batching:** reads go through Multicall3 at the pinned block.
- **Tool annotations:** `readOnlyHint: true`, `openWorldHint: true`.
- **Tool descriptions** are written for an LLM reader: what the tool answers, when to use it, what it does not cover.
- **Errors:** returned as `isError: true` with `{ code, message, retryable }`. Codes: `INVALID_INPUT`, `CHAIN_NOT_CONFIGURED`, `NOT_FOUND`, `INDEXER_NOT_CONFIGURED`, `SIMULATION_UNAVAILABLE`, `UPSTREAM_ERROR`, `UPSTREAM_TIMEOUT`, `RATE_LIMITED`, `INTERNAL`. Messages are sanitized of URLs and keys.

### 5.1 `get_token_balances`

Native and ERC-20 balances of an address on one chain.

- **Input:** `chain`, `address`, optional `tokens` (explicit list of token addresses), optional `maxTokens` (default 50).
- **How:** native balance from the RPC. Token discovery through Alchemy (`alchemy_getTokenBalances`); when `tokens` is given, discovery is skipped and the indexer is not needed. The indexer is used **only to discover which tokens to look at** — balances, symbols and decimals are then re-read on-chain at the pinned block, so the answer is verifiable.
- **Output:** list of `{ token, balance, usd }`, native first, then priced tokens by USD value descending, then unpriced. `warnings` notes truncation at `maxTokens`.
- **Edge cases:** no indexer key and no `tokens` → native balance only plus a warning; tokens whose `symbol()`/`decimals()` revert are skipped and counted in a warning.

### 5.2 `get_aave_positions`

Aave v3 position of an address in the chain's main market.

- **Input:** `chain`, `address`.
- **How:** one hardcoded `PoolAddressesProvider` per chain; Pool, data provider and oracle addresses are resolved from it. Account summary from `Pool.getUserAccountData`; per-reserve supply/debt from the protocol data provider via multicall; reserve prices from the Aave oracle.
- **Output:** `summary` (total collateral USD, total debt USD, available borrows USD, LTV, liquidation threshold, health factor, e-mode category) and `reserves[]` with non-zero supplied or borrowed amounts (`token`, `supplied`, `variableDebt`, `stableDebt`, `usedAsCollateral`, USD values).
- **Edge cases:** no debt → `healthFactor: null` with `"healthFactorNote": "no debt"` (the contract returns max uint). No position → empty reserves, not an error. USD here comes from the Aave oracle, the same number the protocol uses for liquidations; `priceSource` says `"aave-oracle"`.

### 5.3 `get_uniswap_positions`

Uniswap v3 liquidity positions held directly by an address.

- **Input:** `chain`, `address`, optional `includeClosed` (default false), optional `maxPositions` (default 50).
- **How:** enumerate NFTs on the NonfungiblePositionManager (`balanceOf`, `tokenOfOwnerByIndex`, `positions`); read each pool's `slot0`; compute token amounts from liquidity and price range with an in-repo bigint implementation of Uniswap's tick/liquidity math **[call — avoids pulling the Uniswap SDK and its transitive dependencies for ~100 lines of well-specified math; verified against on-chain values in tests]**; unclaimed fees by simulating `collect` with max amounts as the owner.
- **Output:** per position: `tokenId`, `pool`, `token0`, `token1`, `feeTier`, `tickLower`, `tickUpper`, `currentTick`, `inRange`, `priceLower`/`priceUpper`/`priceCurrent` (token1 per token0), `amount0`, `amount1`, `unclaimedFees0`, `unclaimedFees1`, USD values.
- **Limits stated in the tool description:** positions staked in third-party contracts are not owned by the wallet and are not found.

### 5.4 `get_pool_state`

Price, liquidity and current tick of a Uniswap v3 pool.

- **Input:** `chain`, and either `pool` (address) or `tokenA` + `tokenB` + `feeTier`.
- **Output:** `pool`, `token0`, `token1`, `feeTier`, `tickSpacing`, `sqrtPriceX96`, `tick`, `liquidity` (in-range), `price0In1`, `price1In0` (decimal-adjusted), `reserves` (the pool's balance of each token, with USD), `tvlUsd` when both tokens are priced.
- **Edge cases:** pair/fee with no pool → `NOT_FOUND`; address that is not a v3 pool → `INVALID_INPUT`.

This is the walking-skeleton tool for phase 0: one contract, no indexer, no pricing dependency for the core fields. Its USD fields are `null` until phase 1 adds prices.

### 5.5 `get_swap_quote`

Best single-path quote for an exact-input swap on Uniswap v3.

- **Input:** `chain`, `tokenIn`, `tokenOut`, `amountIn` (decimal string in token units), optional `slippageBps` (default 50).
- **How:** candidate paths = direct (`tokenIn → tokenOut`, each fee tier) plus two-hop (`tokenIn → hub → tokenOut`) through a per-chain hub list (wrapped native, USDC, USDT, DAI, WBTC; exact list per chain is the builder's). Paths whose pools do not exist or have zero liquidity are pruned with one multicall before quoting. Remaining paths are quoted with QuoterV2 through chunked multicalls with failures allowed. Native token input/output is treated as the wrapped token.
- **Output:** `best` route (`path` of tokens and fee tiers, `amountOut`, `minAmountOut` after slippage, `executionPrice`, `priceImpactPct` versus the pools' mid price, `gasEstimate`, USD in/out) and up to three `alternatives`. `routesEvaluated` reports how many paths were quoted.
- **Edge cases:** no route → `NOT_FOUND`. Quote is informational; the tool description says it is not an executable order and that split routes or other venues may give a better price.

### 5.6 `get_large_movements`

Large transfers or swaps over a bounded recent window.

- **Input:** `chain`, `mode`, and per mode:
  - `mode: "token"` — `token`: ERC-20 `Transfer` events of that token.
  - `mode: "pool"` — `pool`: Uniswap v3 `Swap` events of that pool.
  - `mode: "wallet"` — `address`: native and ERC-20 transfers from/to that address, through the indexer (`alchemy_getAssetTransfers`).
  - common: threshold as `minUsd` or `minAmount` (token units; required when the token has no price feed), `lookbackMinutes` (default 60, max 1440), `limit` (default 20, max 100).
- **How:** the lookback is converted to a block range with the chain's average block time. Logs are fetched newest-first in chunks of `LOGS_MAX_BLOCK_RANGE`, halving the chunk when the provider rejects the range, up to `LOGS_MAX_REQUESTS` requests (section 3). USD uses the Chainlink price at the response block for the whole window (documented simplification). A hard cap on logs scanned also protects the RPC quota.
- **Output:** `movements[]` sorted by USD (or amount) descending: `txHash`, `blockNumber`, `timestamp`, `kind` (`transfer` | `swap`), `from`, `to`, `token`/`amounts`, `usd`; and `scan`: `{ fromBlock, toBlock, logsScanned, truncated }`.
- **Edge cases:** cap reached → `truncated: true` plus a warning saying the window was only partly scanned and which part. `wallet` mode without an indexer key → `INDEXER_NOT_CONFIGURED`.
- **Source labeling:** `token` and `pool` modes are read from chain logs (`"source": "chain"`). `wallet` mode is the one place where returned data, not just discovery, comes from the indexer; its response says `"source": "indexer"`.
- **Scan is newest-first:** when the cap cuts the window short, the most recent part is the part that was scanned.

### 5.7 `simulate_transaction`

Decode a transaction, simulate it, and report what would change — before signing.

- **Input:** `chain`, `from`, `to`, optional `data`, `value`, `gas`, optional `blockNumber` (default latest). The transaction is unsigned; there is no field for a signature or key.
- **`blockNumber` [call]:** this is the only tool that accepts a historical block. It lets an agent (and the phase 6 validation) replay a transaction against past state. Old blocks need an archive-capable RPC; when the provider cannot serve the block the tool returns `UPSTREAM_ERROR` with a message saying so. The other six tools always read at latest.
- **Output:**
  - `status`: `success` | `reverted`, with decoded `revertReason` when available.
  - `gasUsed`.
  - `decodedCall`: `{ contract, functionName, args, abiSource }` where `abiSource` is `builtin` | `sourcify` | `etherscan` | `signature-db` | `null`. A signature-database match is flagged as unverified, since selectors collide.
  - `assetChanges[]` for `from`: `{ token, diff, usd }` (native and ERC-20).
  - `transfers[]`: every native/ERC-20/ERC-721 transfer in the transaction (`from`, `to`, `token`, amount or tokenId).
  - `approvals[]`: every `Approval` / `ApprovalForAll` set by the transaction, with `unlimited: true` where the allowance is max.
  - `riskFlags[]`: plain signals an agent should surface — `REVERTS`, `UNLIMITED_APPROVAL`, `APPROVAL_FOR_ALL`, `NET_OUTFLOW_NO_INFLOW`, `UNVERIFIED_CONTRACT`, `DEGRADED_SIMULATION`.
  - `backend`: which backend produced the result.
- **Backends** (`SIMULATION_BACKEND`):
  - `rpc` (default): viem's `simulateCalls` with asset-change and transfer tracing, which uses `eth_simulateV1`. If the RPC does not support `eth_simulateV1`, fall back to `eth_call` + `eth_estimateGas`: status, revert reason and gas only, `assetChanges: null`, `DEGRADED_SIMULATION` flag and a warning. Whether an intermediate `debug_traceCall` tier is worth adding is decided by the phase 0 spike.
  - `tenderly`: Tenderly's simulation API. Requires account, project and access key. No silent fallback to `rpc` when Tenderly fails; the error is returned.
  - Both backends are normalized to one internal result shape (status, gas, logs, native transfers, balance diffs), and `transfers`, `approvals` and `riskFlags` are derived from that shape by shared code, so the two backends cannot drift apart in what they report.
- **ABI resolution order:** built-in ABIs (ERC-20, Aave Pool, Uniswap routers and position manager) → Sourcify → Etherscan (only if a key is configured) → 4-byte signature database. Results are cached.
- **Known limits, stated in the tool description:** ERC-1155 balances and tokens that change balances without `Transfer` events (some rebasing tokens) are not reflected in `assetChanges`; simulation runs against the latest block and the real outcome can differ; transaction contents are sent to the configured RPC, and to Tenderly/Sourcify/Etherscan when those are used.

## 6. Architecture

```
src/
  index.ts           # entrypoint: load config, pick transport, start
  server.ts          # builds the McpServer and registers the tools
  config.ts          # env parsing and validation (Zod), fails fast at startup
  chains.ts          # per-chain viem clients, block time, wrapped native, hub tokens
  transports/
    stdio.ts
    http.ts          # Express app, bearer auth, rate limit, /mcp route, /healthz
  tools/             # one file per tool: Zod schemas + handler
  protocols/
    aave/            # ABIs, addresses, readers
    uniswap/         # ABIs, addresses, tick/liquidity math, path enumeration
    chainlink/       # feed map per chain, price reader with staleness check
    erc20/
  services/
    indexer.ts       # Alchemy token discovery and asset transfers
    simulation/      # backend interface, rpc backend, tenderly backend, normalizer
    abi.ts           # ABI resolution chain
  lib/               # cache, errors, formatting, sanitizing, logging, concurrency
test/
  unit/              # no network
  fork/              # anvil forks at pinned blocks
  e2e/               # real MCP client against the built server, stdio and HTTP
  fixtures/
docs/
.github/workflows/
```

The owner's proposed layout is kept; `transports/` and `services/` are added **[call]** so `server.ts` stays a registration file and the non-protocol external services (indexer, simulation, ABI lookup) have a home.

### How a call flows

`transport → McpServer (Zod input validation) → tool handler → protocol readers / services → viem client (multicall, pinned block) → format → Zod output validation → structuredContent`.

Tool handlers contain orchestration only. Protocol readers know contracts and math. Nothing below `tools/` knows about MCP.

### Cross-cutting pieces

- **Config:** all environment variables parsed by one Zod schema at startup; an invalid or incomplete configuration stops the process with a message naming the variable. See section 7.
- **Chains:** a chain is enabled when it has an RPC URL. If `ALCHEMY_API_KEY` is set and a chain has no explicit RPC URL, the Alchemy RPC URL for that chain is derived, so a single key is enough to run everything **[call]**.
- **Prices:** a curated map of token → Chainlink USD feed per chain (native, wrapped native, major stables, WBTC, and the main Aave collateral assets). Reader checks feed decimals and `updatedAt`; a price older than the feed's expected heartbeat is still returned but adds a `"price feed stale"` warning.
- **Cache:** in-memory with TTL and a size bound. Volatile entries are stored with the block they were read at, and a response assembled from cache reports that block, so caching never breaks block pinning. Immutable data (token metadata, pool addresses, ABIs) is cached for the process lifetime; volatile data (prices, pool state) for roughly one block time. TTLs are configurable.
- **Upstream protection:** per-tool timeout, bounded retries with backoff on rate-limit responses, a global cap on concurrent upstream requests, hard caps on logs scanned and positions/tokens returned.
- **Logging:** structured, to stderr only. One line per tool call: tool, chain, duration, upstream request count, outcome code. Secrets are redacted at the logger.

### Transports

- **stdio:** for desktop clients. No auth (the client spawns the process).
- **Streamable HTTP:** stateless mode (a server and transport per request, no session IDs), since tools hold no state. Built on the SDK's Express integration, which includes DNS-rebinding protection.
  - **Auth:** `Authorization: Bearer <token>`, checked against `MCP_AUTH_TOKENS` with a constant-time comparison. The server **refuses to start in HTTP mode with no token configured**. Missing/invalid token → 401.
  - **Rate limit:** per token, fixed requests-per-minute budget (`RATE_LIMIT_RPM`, default 60) → 429 with `Retry-After`.
  - Binds to `127.0.0.1` by default; exposing it is an explicit `HOST` setting. Request body size limit. `/healthz` is unauthenticated and returns no chain data.
  - TLS is terminated by whatever sits in front (reverse proxy / platform); documented in the README.

## 7. Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `TRANSPORT` | `stdio` or `http` | `stdio` |
| `RPC_URL_ETHEREUM`, `RPC_URL_BASE`, `RPC_URL_ARBITRUM`, `RPC_URL_POLYGON` | JSON-RPC endpoint per chain | derived from `ALCHEMY_API_KEY` if set |
| `ALCHEMY_API_KEY` | Indexer (token discovery, wallet transfers) and default RPC | — |
| `SIMULATION_BACKEND` | `rpc` or `tenderly` | `rpc` |
| `TENDERLY_ACCOUNT`, `TENDERLY_PROJECT`, `TENDERLY_ACCESS_KEY` | Required when backend is `tenderly` | — |
| `ETHERSCAN_API_KEY` | Optional extra ABI source | — |
| `HOST`, `PORT` | HTTP bind | `127.0.0.1`, `3000` |
| `MCP_AUTH_TOKENS` | Comma-separated bearer tokens; required for HTTP | — |
| `RATE_LIMIT_RPM` | Requests per minute per token | `60` |
| `CACHE_TTL_SECONDS` | TTL for volatile data | per-chain block time |
| `LOGS_MAX_BLOCK_RANGE` | Blocks per `eth_getLogs` request | free-tier value from the phase 0 spike |
| `LOGS_MAX_REQUESTS` | `eth_getLogs` requests per tool call | set in phase 5 |
| `LOG_LEVEL` | `debug` … `error` | `info` |

At least one chain must end up enabled or startup fails. A `.env.example` documents all of it; `.env` is git-ignored.

## 8. Security

- No key material anywhere: no input field, env variable or code path for private keys or signatures. A test asserts no tool schema contains such a field.
- All inputs validated by Zod at the tool boundary; addresses and hex data checked for shape and length; numeric bounds on every limit/lookback.
- Outbound requests go only to configured RPC URLs and a fixed list of hosts (Alchemy, Tenderly, Sourcify, Etherscan). No user-supplied URL is ever fetched.
- On-chain strings are sanitized before they reach the agent (section 5.0).
- Secrets redacted from logs and error messages; a test feeds an RPC URL containing a key through the error path and asserts it does not appear.
- HTTP: auth mandatory, rate limit, localhost bind by default, body size limit, DNS-rebinding protection.
- Dependency audit and secret scanning in CI.
- The README states the trust model: what is read from the chain, what comes from third parties (token discovery, ABIs, Tenderly), and that transaction contents are disclosed to those services when simulating.

## 9. Testing strategy

Development is test-first: for each behavior, a failing test is written before the code. Coverage threshold is 80% lines/branches, enforced in CI.

| Layer | What it proves | How |
|-------|----------------|-----|
| **Unit** | Pure logic is correct | Vitest, no network: tick/liquidity math against known vectors, price formatting, path enumeration and pruning, log filtering and ranking, simulation-result normalization and risk flags from fixture logs, schemas, cache, rate limiter, sanitizing, config parsing. |
| **Fork integration** | Tools return correct on-chain values | Anvil fork per chain at a **pinned block**. Each tool is called for reference wallets/pools and compared with expected values that were derived **independently** (raw `cast call` reads at the same block), with the command recorded next to the fixture. Anvil's fork cache is kept in CI so runs are deterministic and cheap. |
| **Service contract** | Indexer / Tenderly / ABI clients parse real responses | Recorded HTTP fixtures of real responses, replayed offline. A small opt-in live suite (needs real keys) runs on demand and on a schedule, not on every PR, to catch upstream drift. |
| **E2E protocol** | The server behaves as an MCP server | A real MCP client connects to the built server over stdio (subprocess) and HTTP: lists tools, checks schemas and annotations, calls every tool, validates `structuredContent` against `outputSchema`; HTTP checks 401 without token, 429 over budget, success with token. |
| **Manual validation** | The answers match what a human sees elsewhere | Per-phase checklist comparing tool output against reference UIs at the same moment (Aave app, Uniswap app, a block explorer, Tenderly dashboard) and a run through MCP Inspector / a desktop client. Evidence saved under `docs/validation/`. |

**Refined in the development plan (2026-11-25):** chain-reading tests run from the same files in two modes — against a live anvil fork locally, and replayed from recorded JSON-RPC responses in CI. CI therefore executes that code and its assertions without secrets instead of skipping it. The local fork run remains mandatory at every phase gate.

CI on every PR, with no secrets (section 3): lint, typecheck, unit, service-contract, protocol-level E2E, coverage threshold, build, dependency audit, secret scanning. Fork integration, tool-calling E2E and the live suite need an RPC and run locally; CI reports them as skipped, not passed. The coverage threshold is measured on the layers CI can run, so pure logic is kept out of network-bound code.

## 10. Verification and validation per phase

Every phase closes with the same gate. The builder runs the gate and records the evidence; **the owner reviews it and approves before the next phase starts [owner]**. A phase is not done until all of it holds:

1. **Verification (built it right):** CI green; the local-only suites (fork integration, tool-calling E2E, live) green with their output recorded; coverage ≥ 80%; lint and typecheck clean; code review done with critical/high findings fixed.
2. **Validation (built the right thing):** the phase's manual validation checklist executed and recorded in `docs/validation/phase-N.md` — each item states the reference source, the value observed there, the value the tool returned, and the tolerance used.
3. **Demonstration:** the phase's tools exercised from a real MCP client over stdio; HTTP checked once the phase touches it.
4. **Documentation:** tool reference and README section for the phase written; any deviation from this design recorded with its reason.
5. **Regression:** the full suite, not only the new tests, is green.
6. **Owner sign-off:** approval recorded in the phase's validation document.

Phase outline (detailed in the development plan):

| Phase | Delivers | Key validation |
|-------|----------|----------------|
| 0 | Repo, CI, config, chains, both transports with bearer auth, `get_pool_state` end to end, **provider spike** | Pool price vs Uniswap app; spike report answering: whether Alchemy free tier supports `eth_simulateV1` on each of the four chains, whether anvil supports it in fork mode, Tenderly response shape and quotas, whether a `debug_traceCall` tier is needed, the real free-tier `eth_getLogs` range and rate limits per chain, whether free tier serves historical state for pinned-block forks |
| 1 | Chainlink prices, Alchemy indexer, `get_token_balances` | Balances vs block explorer; USD vs Chainlink data page |
| 2 | `get_aave_positions` | Health factor and amounts vs Aave app for reference wallets |
| 3 | Uniswap math, `get_uniswap_positions` | Amounts, range status and unclaimed fees vs Uniswap app |
| 4 | `get_swap_quote` (multi-hop) | Quote vs Uniswap app within tolerance for direct and two-hop pairs |
| 5 | `get_large_movements` (token, pool, wallet modes) | Returned movements vs block explorer for the same window; truncation behavior |
| 6 | `simulate_transaction` (both backends, decoding, risk flags) | Simulated asset changes vs the real outcome of already-mined transactions replayed at their parent block; rpc vs Tenderly agree on the same transaction |
| 7 | HTTP hardening: rate limit, upstream protection, security review | Abuse tests (no token, bad token, burst), secret-leak tests, security review findings closed |
| 8 | README, tool reference, client setup guides, Docker image, npm package, v0.1.0 | Clean-machine install following only the README, on a desktop client (stdio) and as a service (HTTP) |

Phase 6's replay check is the strongest validation in the project: take real mined transactions (a swap, an Aave supply, an approval, a reverting call), simulate each at the block before it was mined, and compare with what actually happened.

## 11. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `eth_simulateV1` not available on a provider/chain, or not in anvil fork mode | `simulate_transaction` degraded or untestable locally | Phase 0 spike measures it before any design depends on it; Tenderly backend; degraded mode is explicit; recorded fixtures if anvil cannot serve it |
| `eth_getLogs` limits on busy tokens | Large-movement scan slow or truncated | Adaptive chunking, hard cap, `truncated` reported honestly, short default lookback |
| Multi-hop quoting fans out to many calls | Slow quotes, RPC quota | Prune non-existent/empty pools first, chunked multicall, short cache |
| Hardcoded protocol addresses wrong or changed | Wrong or failing answers | Minimal hardcoding (one Aave provider address per chain, Uniswap deployment set), sourced from official docs with links, and sanity-checked on-chain in fork tests |
| Chainlink feed missing or stale | Missing or misleading USD | `null` instead of guessing; staleness warning |
| Token symbol/name used for prompt injection | Agent manipulated by on-chain text | Sanitizing and truncation; documented as untrusted |
| MCP SDK API changes | Rework | Versions pinned; SDK surface confined to `server.ts` and `transports/` |
| Free tier cannot serve pinned historical blocks or runs out of quota during fork tests | Fork tests fail or are slow | Measured in the phase 0 spike; pin recent blocks; anvil's on-disk fork cache so each state slot is fetched once; move to a paid tier only if the spike shows it is needed |
| Free-tier log range makes large-movement windows short on fast chains | Tool less useful than its inputs suggest | Request budget with honest `scan` reporting; settings, not code, change when the tier changes |
| Network-bound tests are not in CI | Regressions in chain-reading code slip through a PR | Local run is mandatory at every phase gate with recorded output; CI shows them as skipped; a CI secret can be added later with no code change |

## 12. Decisions log

**Owner decisions:** seven tools including large-movement detection; four chains; stack and repo layout; stdio + HTTP; indexer for token discovery; simulation backend chosen by environment variable; multi-hop quotes; USD via Chainlink; HTTP auth + rate limit; build order option 1; large movements as on-demand scan plus wallet mode; verification and validation at every phase, with owner approval before the next phase starts; documentation in English; Alchemy free tier to start; Tenderly account available; no CI secrets for now; public repository under the MIT license.

**Author calls (correct any of these):** Alchemy as the indexer; indexer used for discovery only with balances re-read on-chain; block pinning and response envelope; exact-input quotes only; two-hop maximum through hub tokens; in-repo Uniswap math instead of the Uniswap SDK; Aave main market only, read through the protocol data provider; `lookbackMinutes` instead of a block count; current-price USD for the whole lookback window; `rpc` backend built on viem `simulateCalls` with `eth_call` degraded fallback; no silent fallback from Tenderly; ABI resolution order; static bearer tokens, mandatory for HTTP; stateless HTTP; localhost bind by default; deriving RPC URLs from the Alchemy key; Node ≥ 22 with pnpm; added `transports/` and `services/` directories; no ENS resolution; optional `blockNumber` on `simulate_transaction` only; log scanning budgeted by request count, newest first; npm package and GHCR image as release artifacts.

## 13. Left to the builder

- Exact dependency versions; lint/format and logging libraries; build tooling.
- File split inside each directory.
- Hub token list, Chainlink feed map and block-time constants per chain.
- Cache TTLs, timeouts, chunk sizes, concurrency caps and scan caps (sensible defaults, all configurable).
- Pinned blocks and reference wallets/pools/transactions for fixtures.
- Exact wording of tool descriptions and warnings.
- Whether to add the `debug_traceCall` tier, based on the spike.
