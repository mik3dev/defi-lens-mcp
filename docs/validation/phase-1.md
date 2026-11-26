# Phase 1 validation — Balances and prices

- Date: 2026-11-26
- Commit: `265ecf5` (branch `phase-1-balances-prices`; `src/` is identical to `39eda92`; this record is added on top)
- RPC provider and tier: Alchemy free tier, all four chains, for both chain reads (`RPC_URL_*`) and token discovery (`alchemy_getTokenBalances`, from `ALCHEMY_API_KEY`). Simulation backend not used in this phase.
- Pinned blocks (`test/fixtures/blocks.ts`, unchanged since phase 0): ethereum `26499763`, base `62611111`, arbitrum `527782324`, polygon `98004500`

## Verification

| Check | Command / link | Result |
|-------|----------------|--------|
| Lint | `pnpm lint` | Pass: `Checked 82 files … No fixes applied.` |
| Types | `pnpm typecheck` | Pass, no output |
| Coverage | `pnpm coverage` | Pass: 30 test files, 324 tests passed, 0 skipped. Statements 97.93 %, branches 95.09 %, functions 98.71 %, lines 98.23 % (thresholds 80/80) |
| Build | `pnpm build` | Pass (`dist/index.js` produced) |
| Fork run and re-record | `RECORD=1 pnpm test:fork` | Pass: `Test Files 8 passed (8)`, `Tests 76 passed (76)`, 41.5 s, no HTTP 429. Two recordings changed: `test/fixtures/rpc/indexer.ethereum.json` and `test/fixtures/rpc/token-balances.ethereum.json`, 4 lines each. In both, the `alchemy_getTokenBalances` answer reports a new `tokenBalance` for the same four spam tokens held by the reference wallet (`0x296a…6e30`, `0x2ea0…1189`, `0xef54…c1e4`, `0x02c9…1a96`). The indexer reports current state, not state at the pinned block, so this is expected. The token set and every pinned-block read are byte for byte unchanged. Committed as `265ecf5` (`test: refresh recordings at the phase 1 gate`) |
| Replay from the recordings, no RPC variables | `env -u ALCHEMY_API_KEY -u RPC_URL_ETHEREUM -u RPC_URL_BASE -u RPC_URL_ARBITRUM -u RPC_URL_POLYGON pnpm test` | Pass, run after the re-record: `Test Files 30 passed (30)`, `Tests 324 passed (324)`, 0 skipped, 4.8 s |
| Live provider suite | `pnpm test:live` | Not applicable: phase 1 added no live tests (`test/live/` does not exist) |
| Secret scan | Script comparing every `.env` value whose name matches `KEY\|TOKEN\|RPC_URL\|TENDERLY` (longer than 8 characters) against every tracked and untracked, non-ignored file; prints variable names only. Plus a grep of the new docs for the Alchemy endpoint host and path patterns and for the local home path | 0 secret hits. The only match is `TENDERLY_PROJECT`, whose value is the public package name `defi-lens-mcp`. 0 hits for the URL and home-path patterns |
| Docs/README gate item (design §10.4): tool reference and README section | `README.md` | Pending (phase 8): `README.md` does not exist yet. The tool descriptions for `get_token_balances` and the updated `get_pool_state` are written and appear in `tools/list` (`phase-1/stdio-tools-list.txt`) |
| CI green on the phase pull request | — | Pending: no pull request yet |
| Code review of the phase diff | — | Pending: the whole-branch review runs after this record |
| Owner sign-off | — | Pending |

## Validation

Tool calls are live (no fork), through the built server over stdio (`node dist/index.js`), at the block shown in each response. Each balance and price check was run with MCP Inspector CLI; check 3 used a raw JSON-RPC client so the server's own log line (with `durationMs`) could be captured. Balance references come from `cast` 1.5.0 at the response block, with the provider URL passed in the environment (`ETH_RPC_URL`) and never in argv or output.

| # | Check | Reference source | Reference value | Tool value | Tolerance | Pass |
|---|-------|------------------|-----------------|------------|-----------|------|
| 1a | `get_token_balances` ethereum, `0x40B3…E489` (reference wallet), discovery, block 26502012 | `cast balance` / `cast call balanceOf --block 26502012` | ETH `1220494875405186557374578`, USDC `10005273`, USDT `10000000`, LINK `8412221515202863353762730` | identical raw values | exact | Pass |
| 1b | same, base, `0xe780…e245`, discovery, block 62687734 | `cast … --block 62687734` | ETH `7390000000000`, USDC `25724364`, USDT `25685020`, WETH `18` | identical raw values | exact | Pass |
| 1c | same, arbitrum, `0xB38e…891D`, explicit `tokens`, block 527830590 | `cast … --block 527830590` | ETH `3000335004946680345`, USDC `2534086971`, USD₮0 `3000101`, WBTC `287`, WETH `9188120000000000` | identical raw values | exact | Pass |
| 1d | same, polygon, `0x40B3…E489`, discovery, block 98014970 | `cast … --block 98014970` | POL `89474420883951140`, USDC `3480000`, USDT0 `30000`, spam token `0xAE2A…9b0D` `50000000000000000000` | identical raw values | exact | Pass |
| 2a | ETH/USD (ethereum native row, `usd / formatted`), block 26502012 | CoinGecko simple price API (DefiLlama coins API as second source) | 1702.8073 (DefiLlama 1703.0415) | 1701.40 | ±0.5 % (diff −0.083 %; −0.096 %) | Pass |
| 2b | WBTC/USD, arbitrum WBTC row, block 527830590 | CoinGecko `wrapped-bitcoin` (DefiLlama `arbitrum:0x2f2a…5B0f`) | 60810.22 (60814.39) | 60778.06 | ±0.5 % (diff −0.053 %; −0.060 %) | Pass |
| 2c | USDC/USD, ethereum USDC row, block 26502012 | CoinGecko `usd-coin` (DefiLlama) | 0.999591 (0.999849) | 0.999870 | ±0.5 % (diff +0.028 %; +0.002 %) | Pass |
| 2d | POL/USD, polygon native row, block 98014970 | CoinGecko `polygon-ecosystem-token` (DefiLlama) | 0.077453 (0.077456) | 0.077503 | ±0.5 % (diff +0.065 %; +0.060 %) | Pass |
| 3 | Spam-heavy wallet returns within the tool timeout with truncation warnings | Captured output and duration | warnings present; well under 30 s | polygon `0xe780…e245` (more than 2 000 non-zero tokens): 3 061 ms server-side (3 073 ms round trip), 29 upstream requests, warnings `More tokens exist than were scanned.` and `Showing 50 of 400 tokens.`. Ethereum `0x28C6…1d60` with `maxTokens: 200`: 3 235 ms, 31 upstream requests, `More tokens exist than were scanned.` and `Showing 200 of 400 tokens.` | 30 s (planned `TOOL_TIMEOUT_MS` default, phase 7); MCP client request timeout 60 s | Pass |
| 4 | Server without `ALCHEMY_API_KEY`, explicit RPC URLs | Captured output | native only with the discovery warning; explicit `tokens` still read | Without `tokens`: `discovery: "none"`, one row (ETH `1220494875405186557374578`), warning `Token discovery unavailable: set ALCHEMY_API_KEY or pass "tokens". Returning native balance only.`. With `tokens` [USDC, USDT, LINK]: `discovery: "explicit"`, 4 rows with the same raw values as 1a, no warning | exact text | Pass |
| 5 | Symbols with invisible characters or more than 32 code points are returned sanitized | Raw `symbol()` via `cast call … --block 527831493`, decoded to code points; unit tests | `U<U+200C>SDT`; `<U+206D>U<U+206F><U+0405><U+206B>D<U+200E><U+0422><U+2064>`; `Airdrop(s) to be claimed at https://t.ly/drops` (46 code points) | `USDT`; `UЅDТ` (U+0055 U+0405 U+0044 U+0422); `Airdrop(s) to be claimed at http` (32 code points) | exact | Pass |
| 6 | `get_pool_state` TVL, ethereum USDC/WETH 0.05 % pool `0x88e6…5640`, block 26502014 | GeckoTerminal API `reserve_in_usd` (DefiLlama yields API `tvlUsd` as second source) | 69 156 299.97 (69 192 781) | 69 128 966.10 (`usd0` 12 961 474.52 + `usd1` 56 167 491.57) | ±2 % (diff −0.040 %; −0.092 %) | Pass |

Notes on check 1:

- One wallet per chain, native plus at least three tokens. Ethereum, base and polygon used indexer discovery (the default); arbitrum used explicit `tokens`, because that wallet holds more than 1 300 non-zero tokens: discovery is truncated at the 400-candidate cap and is not guaranteed to reach a given token (see the truncation observation below). The explicit call also gave the WBTC price for check 2b.
- The `cast` reference is independent of the server's code path (no Multicall3, no viem) but not of the RPC provider. A block-explorer page was not used: explorers show the current balance, not the balance at the response block, and no `ETHERSCAN_API_KEY` is configured.
- The check 4 calls (blocks 26502040 and 26502041) returned the same raw values for the same wallet.

Notes on check 2:

- The tool does not return a price field; the price is `usd / balance.formatted` of the row. For ETH that gives 1701.40, consistent with an 8-decimal Chainlink answer of `170140000000`.
- The Chainlink data-feeds pages (`data.chain.link/feeds/…`) answered scripted requests with HTTP 429 and a "Vercel Security Checkpoint" page, so they could not serve as the reference. Reading the same aggregator through `cast` would not be independent. The reference is therefore the CoinGecko simple price API, cross-checked with the DefiLlama coins API. Both were fetched at 21:18:55–56 UTC, within about 30 s of the tool calls (CoinGecko `last_updated_at` 21:18:33–21:18:44 UTC). All differences are under 0.1 %. Raw responses: `phase-1/references.txt`.
- WBTC was checked on arbitrum: Ethereum has no Chainlink WBTC / USD feed and ethereum WBTC is unpriced (see Deviations).
- POL is priced from the Polygon feed whose on-chain `description()` is still `MATIC / USD` (see Deviations).

Notes on check 3:

- Both are high-activity addresses holding large numbers of airdropped tokens: polygon `0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245` more than 2 000 non-zero tokens, ethereum `0x28C6c06298d514Db089934071355E5743bf21d60` more than 1 400 (counted directly with `alchemy_getTokenBalances`, 25 pages). Discovery stops at `DISCOVERY_CANDIDATE_CAP` (400), sets `truncated`, and the tool then caps the rows at `maxTokens`.
- There is no server-side tool timeout yet (phase 7 adds `TOOL_TIMEOUT_MS`, planned default 30 s). Both calls finished in about a tenth of that.
- Observation: because the indexer returns tokens roughly in contract-address order and discovery stops at 400, a spam-heavy wallet's priced tokens can fall outside the scanned set. For `0x28C6…1d60` the only priced row was native ETH (`totalUsd` 1 375.36). The result is flagged by `More tokens exist than were scanned.`, so it is not silent. Passing `tokens` reads any token regardless of the cap. Recorded under Open findings for the review.

Notes on check 5:

- No live symbol with C0/C1 control characters (`\p{Cc}`) or U+2028/U+2029 was found. Raw `symbol()` values of the first 400-odd discovered tokens of six wallets (about 2 570 tokens across the four chains) were scanned for `[\p{C}\p{Zl}\p{Zp}]` and length. The only unsafe characters found were format characters (`\p{Cf}`: U+200C, U+200E and U+2060–U+206F) in fake "USDT"/"USDC" tokens on arbitrum and base. Two of them are in the live call above (`phase-1/stdio-sanitized-symbols.txt`, raw values in `phase-1/cast-symbols.txt`). Long symbols (33–46 code points) are common; besides the arbitrum token above, the ethereum reference wallet's `$ EthCRV.com - Visit to claim bonus rewards` (43 code points) comes back as `$ EthCRV.com - Visit to claim bo` in `phase-1/stdio-balances-ethereum.txt`.
- Control characters, U+2028/U+2029 and surrogate-pair-safe truncation are covered by the unit tests in `test/unit/lib/sanitize.test.ts`: `strips control characters`, `truncates to 32`, `truncates by code points without splitting a surrogate pair`, `strips line and paragraph separators`, `falls back to UNKNOWN` (plus `trims`). `pnpm vitest run --reporter=verbose test/unit/lib/sanitize.test.ts`: 6 passed.
- Observation: stripping invisible characters makes `U<U+200C>SDT` read as `USDT`, the same symbol as the real token. Such tokens have no Chainlink feed, so they come back with `usd: null`, and their address differs. Cyrillic look-alikes (`UЅDТ`) are letters and are kept. Recorded under Open findings for the review.

Notes on check 6:

- The Uniswap app is JavaScript-rendered and cannot be read from a script, so the reference is the GeckoTerminal public API, which reports the pool's reserve value in USD with its own prices (WETH 1702.48, USDC 0.99781 at fetch time). The tool uses Chainlink prices at the response block (ETH 1701.40, USDC 0.99987).
- Second source: the DefiLlama yields API lists one Ethereum Uniswap v3 USDC-WETH 0.05 % pool (identified by its underlying tokens and fee tier, which determine the canonical pool), `tvlUsd` 69 192 781, fetched at 21:24:30 UTC.

## Demonstration

Client: MCP Inspector CLI mode, `@modelcontextprotocol/inspector` 1.0.6 (`npx -y @modelcontextprotocol/inspector --cli …`), over stdio against `node dist/index.js`. The Inspector's v1 deprecation notice is removed from the transcripts. Transcripts have API keys, RPC URLs and the home path redacted (`<REDACTED>`, `~`) and are in `docs/validation/phase-1/`:

| Calls | Transcript |
|-------|------------|
| `tools/list`: `get_pool_state` and `get_token_balances`, with input and output schemas and the updated `get_pool_state` description | `stdio-tools-list.txt` |
| `tools/call get_token_balances`, one per chain (checks 1 and 2) | `stdio-balances-ethereum.txt`, `stdio-balances-base.txt`, `stdio-balances-arbitrum.txt`, `stdio-balances-polygon.txt` |
| `tools/call get_pool_state`, ethereum USDC/WETH 0.05 % (check 6) | `stdio-pool-state.txt` |
| `tools/call get_token_balances` with spam tokens (check 5) | `stdio-sanitized-symbols.txt` |
| Server without `ALCHEMY_API_KEY`: native only, and explicit `tokens` (check 4) | `stdio-no-indexer-native-only.txt`, `stdio-no-indexer-explicit-tokens.txt` |
| Raw JSON-RPC client with the server's stderr log line (check 3) | `spam-wallet-polygon.txt`, `spam-wallet-ethereum.txt` |
| `cast` references at the response blocks (checks 1 and 5) | `cast-balances.txt`, `cast-symbols.txt` |
| Public API reference values (checks 2 and 6) | `references.txt` |

The calls in this phase do not depend on the transport; phase 1 did not change HTTP, so no HTTP demonstration was run. In the raw client captures, stdout carried only protocol frames and stderr only the server's JSON log line.

## Deviations from the design

1. **Ethereum WBTC is unpriced.** Chainlink has no WBTC / USD feed on Ethereum (only WBTC / BTC), so ethereum WBTC is returned with `usd: null`. The WBTC price was validated on arbitrum (check 2b), where the WBTC / USD feed exists (base and polygon have one too).
2. **POL uses the Polygon `MATIC / USD` feed.** Chainlink's POL price on Polygon is still served by the feed whose `description()` is `MATIC / USD` (`0xAB59…2dE0`). Native POL and WPOL are priced from it (check 2d matches the POL market price within 0.07 %).
3. **Reference sources swapped in checks 1, 2 and 6.** Check 1 uses `cast` at the response block instead of a block explorer (explorers show current balances; no Etherscan key). Check 2 uses the CoinGecko and DefiLlama price APIs instead of the Chainlink data-feeds page (blocked for scripted requests by a bot checkpoint; reading the same aggregator would not be independent). Check 6 uses GeckoTerminal and DefiLlama instead of the Uniswap app (JavaScript-rendered).
4. **Discovery is not block-pinned.** `alchemy_getTokenBalances` reports current holdings and cannot be pinned to a block. Discovery therefore reflects the token set at request time, while every balance, symbol, decimals and price is read on-chain at the response block. A token received after the indexer answered is missed, and a token emptied in between is read as zero and dropped. The same property is why the fork run refreshed two recordings (see Verification).
5. **`DISCOVERY_PAGE_LIMIT` (20 pages) bounds discovery** in addition to `DISCOVERY_CANDIDATE_CAP` (400 candidates). A wallet with thousands of zero-balance entries, or a provider that keeps returning a `pageKey`, would otherwise page without end. Hitting either bound sets `More tokens exist than were scanned.`.
6. **Inspector version.** As in phase 0, the Inspector CLI resolved by `npx` was v1 (1.0.6). Results do not depend on it.

## Carried forward from phase 0

Every minor finding that phase 0 handed to this phase (`docs/plan/phase-1-balances-prices.md`, "Carried forward from phase 0") is closed:

| Item | Status | Commit |
|------|--------|--------|
| `usdValue` guards NaN, negative and non-finite prices | Closed (Task 1.1) | `9cffb8a` fix: reject invalid prices in usdValue |
| `sanitizeSymbol` truncation can split a surrogate pair; U+2028/U+2029 survive | Closed (Task 1.3); evidence in check 5 | `5aae50e` fix: truncate sanitized symbols by code point and strip line separators |
| Cache treats a cached `undefined` as a miss | Closed (Task 1.1) | `371875d` fix: treat a cached undefined as a hit in TtlCache |
| `readTokens` not deduplicated across concurrent calls | Closed (Task 1.3) | `322fc39` fix: share in-flight token metadata reads between concurrent calls |
| `runTool` logs `ok` before building the success result | Closed (Task 1.1) | `66a8d98` fix: log the tool call after the success result is built |
| Duplicated multicall result guards | Closed (Task 1.1): extracted to `src/lib/multicall.ts` | `7df2355` refactor: extract multicall result guards |
| `get_pool_state` returns `NOT_FOUND` when a token lacks `symbol()` | Closed (Task 1.4): placeholder symbol | `0a328b5` fix: fall back to a placeholder symbol for tokens without symbol() |
| `get_pool_state` USD fields always `null`; description silent about it | Closed (Task 1.4): USD reserves and TVL from Chainlink; description updated (see `stdio-tools-list.txt`) | `39eda92` feat: add USD reserves and TVL to get_pool_state |
| Spike doc lines 133, 325, 332 mention a process step | Closed (this task): reworded as plain facts | `903b633` docs: reword spike notes as plain facts |

The phase 7 hardening items and the other open issues listed in `docs/validation/phase-0.md` stay with their phases and are not affected by this phase.

## Open findings

_To be filled after the whole-branch review of the phase diff._

Observations from this validation, for the review to classify:

- Discovery truncation can hide a spam-heavy wallet's priced tokens (check 3 notes); flagged by the warning, but `totalUsd` then covers only the scanned tokens.
- Sanitized look-alike symbols (`USDT` from `U<U+200C>SDT`) are indistinguishable by symbol from the real token (check 5 notes).

## Owner sign-off

- [ ] Approved by mik3dev on <date>
