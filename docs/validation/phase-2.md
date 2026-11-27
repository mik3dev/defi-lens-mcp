# Phase 2 validation — Aave v3 positions

- Date: 2026-11-27
- Commit: gated at `0a50514` (branch `phase-2-aave`; `src/` identical to `90f6e49`), with the record (`c8fa82c`) and the review fixes on top: `cba0659`, `6c0aa1d`, `fff76b8`, `1d870c4`. This record is updated in the commit after `1d870c4`, the head of `phase-2-aave`; the gate commands below were re-run at `1d870c4`. Gate commits before the first re-record: `b82e94e` (longer fork-mode timeout for the Aave chain tests) and `3d95796` (discovery reference wallet asserted untruncated)
- RPC provider and tier: Alchemy free tier, all four chains, for both chain reads (`RPC_URL_*`) and token discovery (`ALCHEMY_API_KEY`). Simulation backend not used in this phase.
- Pinned blocks (`test/fixtures/blocks.ts`, unchanged since phase 0): ethereum `26499763`, base `62611111`, arbitrum `527782324`, polygon `98004500`

## Verification

| Check | Command / link | Result |
|-------|----------------|--------|
| Lint | `pnpm lint` | Pass: `Checked 97 files … No fixes applied.` |
| Types | `pnpm typecheck` | Pass, no output |
| Coverage | `pnpm coverage` | Pass at `1d870c4`: 36 test files, 403 tests passed, 0 skipped. Statements 97.86 %, branches 95.33 %, functions 98.19 %, lines 98.33 % (thresholds 80/80). At the gate (`0a50514`): 396 tests, statements 97.87 %, branches 95.33 %, functions 98.2 %, lines 98.34 % |
| Build | `pnpm build` | Pass (`dist/index.js` produced) |
| Fork run and re-record | `RECORD=1 pnpm test:fork` | Pass: `Test Files 11 passed (11)`, `Tests 114 passed (114)`, 56.75 s, no HTTP 429. Two recordings changed: `test/fixtures/rpc/indexer.ethereum.json` and `test/fixtures/rpc/token-balances.ethereum.json`, 7 lines each, all of them `tokenBalance` values in `alchemy_getTokenBalances` answers for the discovery reference wallet: the same four spam tokens as at the phase 1 gate (`0x296a…6e30`, `0x2ea0…1189`, `0xef54…c1e4`, `0x02c9…1a96`) plus three tokens whose current balance moved (`ShibDoge` `0x6adb…928f`, `A7A5` `0x6fa0…0fc9`, `KEI` `0xc011…a842`). The indexer reports current state, not state at the pinned block, so this is expected. No contract address was added or removed, and every pinned-block read, including all ten Aave recordings (4 `aave-market.*`, 4 `aave-positions.*`, `aave-tool.ethereum`, `e2e-aave-positions`), is byte for byte unchanged. Committed as `0a50514` (`test: refresh recordings at the phase 2 gate`) |
| Re-record after the review fixes | `CHAIN_MODE=fork RECORD=1 pnpm vitest run --no-file-parallelism test/chain/aave-positions.test.ts test/chain/aave-tool.test.ts test/e2e/tools.test.ts test/e2e/protocol.stdio.test.ts test/e2e/protocol.http.test.ts` (the three e2e files share `e2e-pool-state`, so they are recorded in one invocation) | Pass: 5 files, 37 tests. The e2e tests spawn `dist/index.js`, which was stale on that first run, so after `pnpm build` the three e2e files were recorded again in one invocation (3 files, 20 tests). Six recordings changed, committed with `cba0659`: `aave-positions.{ethereum,base,arbitrum,polygon}`, `aave-tool.ethereum` and `e2e-aave-positions`. In each, the separate one-call `getAllReservesTokens` multicall is gone and the summary multicall now carries three calls (`getUserAccountData`, `getUserEMode`, `getAllReservesTokens`); every other request and answer is unchanged. The 4 `aave-market.*` recordings, `e2e-pool-state` and `e2e-token-balances` did not change. A second record run of the same five files with the final code (`1d870c4`, rebuilt) changed nothing (5 files, 41 tests) |
| Fork run at `1d870c4` | `pnpm test:fork` (no `RECORD`) | Pass: `Test Files 11 passed (11)`, `Tests 118 passed (118)`, 59.2 s, no HTTP 429 |
| Discovery reference wallet not truncated (phase 1 carried item) | `test/chain/indexer.test.ts`, `discovers every priced token the reference wallet holds, untruncated` (added in `3d95796`) | Pass in fork mode and in replay: `truncated` is `false`. The fresh recording holds 14 pages, 1 383 distinct tokens, 329 with a non-zero balance: 71 under `DISCOVERY_CANDIDATE_CAP` (400) and 6 pages under `DISCOVERY_PAGE_LIMIT` (20) |
| Replay from the recordings, no RPC variables | `env -u ALCHEMY_API_KEY -u RPC_URL_ETHEREUM -u RPC_URL_BASE -u RPC_URL_ARBITRUM -u RPC_URL_POLYGON pnpm test` | Pass at `1d870c4`: `Test Files 36 passed (36)`, `Tests 403 passed (403)`, 0 skipped, 4.8 s (at the gate: 396 tests, 4.9 s) |
| Live provider suite | `pnpm test:live` | Not applicable: phase 2 added no live tests (`test/live/` does not exist) |
| Secret scan | Script comparing every `.env` value of 8 characters or more against every tracked and untracked, non-ignored file; prints variable names and counts only. Run before each gate and review-fix commit. Plus a check for the local home path | 0 secret hits. The only matches are `HOST` (a localhost value) and `TENDERLY_PROJECT` (the public package name `defi-lens-mcp`). 0 home-path hits |
| Docs/README gate item (design §10.4): tool reference and README section | `README.md` | Pending (phase 8): `README.md` does not exist yet. The `get_aave_positions` description is written and appears in `tools/list` (`phase-2/stdio-tools-list.txt`) |
| CI green on the phase pull request | — | Pending: CI runs on the phase pull request |
| Code review of the phase diff | Whole-branch review `437e725..c8fa82c` | No critical findings; both important findings (reserve list cached for an hour could silently miss a new reserve or fail every call after a delisting; half-up rounding could show a liquidatable position as 1.0) fixed in `cba0659` and `6c0aa1d` and re-reviewed; remaining minors listed under Open findings |
| Owner sign-off | — | Pending |

## Validation

Tool calls are live (no fork), through the built server over stdio (`node dist/index.js`), with MCP Inspector CLI, at the block shown in each response. Checks 1–4 were re-run after the review fixes with the server built from `src/` at `1d870c4`; those six calls were made at 19:56 UTC. Check 5 is from the gate run (server built from `90f6e49`, 19:36 UTC, block 26508680); the fixes do not change its result (the reserve list read moved into the summary multicall, and an address with no debt has no health factor to truncate). References come from `cast` 1.5.0 at the response block, with the provider URL passed in the environment (`ETH_RPC_URL`) and never in argv or output (`phase-2/cast-references.txt`). The `cast` reads are independent of the server's code path (no Multicall3, no viem, no oracle conversion) but not of the provider, so the five health factors of the re-run were read a second time from keyless public RPC endpoints (PublicNode; the official Arbitrum RPC for arbitrum) at the same blocks (`phase-2/public-rpc-references.txt`); all five raw values are identical across the two providers.

| # | Check | Reference source | Reference value | Tool value | Tolerance | Pass |
|---|-------|------------------|-----------------|------------|-----------|------|
| 1a | Health factor, ethereum borrower `0xa18C…fAe5` (reference wallet), block 26508781 | `Pool.getUserAccountData` via `cast --block 26508781`; second provider | `2290670324009190169` = 2.290670 | 2.2906 | ±0.01 (diff −0.00007) | Pass |
| 1b | Health factor, ethereum borrower `0x187a…0c9D`, block 26508781 | same | `1070383582237992956` = 1.070384 | 1.0703 | ±0.01 (diff −0.00008) | Pass |
| 1c | Health factor, base borrower `0x447E…A6C0` (reference wallet), block 63095130 | same, `--block 63095130` | `3211306600112531382` = 3.211307 | 3.2113 | ±0.01 (diff −0.00001) | Pass |
| 1d | Health factor, arbitrum borrower `0x0f66…862b` (reference wallet), block 528099711 | same, `--block 528099711` | `1531789923025756098` = 1.531790 | 1.5317 | ±0.01 (diff −0.00009) | Pass |
| 1e | Health factor, polygon borrower `0xB599…f9f7` (reference wallet), block 98069281 | same, `--block 98069281` | `1535116048762593670` = 1.535116 | 1.5351 | ±0.01 (diff −0.00002) | Pass |
| 2a | Supplied and borrowed per reserve, ethereum `0xa18C…fAe5`, block 26508781 | `AaveProtocolDataProvider.getUserReserveData(asset, user)` via `cast --block 26508781`, one call per reserve | WETH supplied `64632822640264522635`; WBTC supplied `69847129`; LINK supplied `4382237807515209805632`; AAVE supplied `16988412789781472175` (all collateral); USDT variable debt `56032942522`; USDC variable debt `12502090354`; stable debt 0 everywhere | identical raw values and `usedAsCollateral` flags, 6 reserves | exact | Pass |
| 2b | same, base `0x447E…A6C0`, block 63095130 | same | cbBTC supplied `78113071`, WETH supplied `3635341925922543119` (collateral); USDC variable debt `13816393821` | identical, 3 reserves | exact | Pass |
| 2c | same, arbitrum `0x0f66…862b`, block 528099711 | same | WBTC supplied `181868346` (collateral); USDC supplied `442` (collateral) and variable debt `58231141112` | identical, 2 reserves | exact | Pass |
| 2d | same, polygon `0xB599…f9f7`, block 98069281 | same | WBTC supplied `5371668`, WETH supplied `13777320012295791`, WPOL supplied `4402135324004268405019` and variable debt `22007012752309734270915` (collateral); USDC supplied `3` and variable debt `100019595`, wstETH variable debt `146013921932110`, USDT0 supplied `34` (not collateral) | identical, 6 reserves | exact | Pass |
| 3 | Sum of `suppliedUsd` over reserves with `usedAsCollateral` vs `totalCollateralUsd`; sum of `debtUsd` vs `totalDebtUsd` | Captured outputs of 1a–1e and check 4 | ethereum `0xa18C…`: 192 764.618656 / 68 473.354976; ethereum `0x187a…`: 13 688.754458 / 10 742.460867; base: 52 813.819035 / 13 814.815436; arbitrum: 108 768.225117 / 58 225.963781; polygon: 3 577.981393 / 1 807.615325; supplier: 825 530.466571 / 0 | `totalCollateralUsd` / `totalDebtUsd`: 192 764.61865598 / 68 473.35497583; 13 688.75445846 / 10 742.46086722; 52 813.81903513 / 13 814.81543617; 108 768.22511739 / 58 225.96378125; 3 577.98139249 / 1 807.6153249; 825 530.46657116 / 0 | ±0.5 % (every difference below 0.00001 %) | Pass |
| 4 | Supply and no debt shows `healthFactor: null`, note `no debt` | Captured output; `getUserAccountData` via `cast --block 26508781` (debt `0`, health factor `2^256 − 1`) | ethereum `0x83d8…0C0B`: collateral 825 530.47 USD, debt 0 | `healthFactor: null`, `healthFactorNote: "no debt"`, `totalDebtUsd: 0`, no warnings; WETH supplied `494027110447918513369` (collateral) and USDT `4680698` (not collateral), both equal to `getUserReserveData` | exact | Pass |
| 5 | Address that never used Aave returns an empty position, not an error | Captured output; `cast nonce`, `cast code` and `Pool.getUserConfiguration` at block 26508680 | ethereum `0xd012…CAe7`: nonce 0, no code, user configuration bitmap `0`, account data all zero | not `isError`; `reserves: []`, every summary number 0, `eModeCategory: 0`, `healthFactor: null`, `healthFactorNote: "no debt"`, no warnings | exact | Pass |
| 6 | Agent-readability: a desktop client asked "is this wallet at risk of liquidation?" answers from the tool output correctly | Transcript | — | — | — | Pending (owner) |

Notes on checks 1 and 2:

- Wallet selection (made for the gate run at block 26508680 and reused unchanged for the re-run). The four reference wallets of `test/fixtures/wallets.ts` (`AAVE_WALLETS.borrower`, found at the pinned blocks) still held positions live, checked with `getUserAccountData` at the latest block before the calls, so they were reused for 1a and 1c–1e. The second ethereum borrower, `0x187a2F53544271D0B81f4b59449e036E36b80c9D`, was found the same way the fixtures were: `cast logs` of the Pool's `Borrow` event in 10-block windows just before the calls (event at block 26508671, `onBehalfOf`). It was the first candidate that was an EOA with a debt; its health factor near 1 also makes it the subject of check 6. The no-debt supplier (check 4) and the never-used address (check 5) are `AAVE_WALLETS.supplierEthereum` and `AAVE_WALLETS.unusedEthereum`, both re-checked at the response block.
- The tool truncates the health factor to 4 decimals (since `6c0aa1d`; it rounded half up at the gate run); every difference above is that truncation, so each is negative and smaller than 0.0001. 1b shows the change: half-up rounding would have given 1.0704. The other summary fields (`totalCollateralUsd`, `totalDebtUsd`, `availableBorrowsUsd`, `ltv`, `liquidationThreshold`, `eModeCategory` against `Pool.getUserEMode`) also equal the `cast` values exactly for all six re-run calls, as they did for the seven gate calls.
- Check 2 is stricter than planned: raw amounts at the same block instead of the app's display precision. It was not in the re-run's scope but is re-checked because it reads the same transcripts. The ethereum `0x187a…` call (WETH supplied `8191842802407192863`, USDC variable debt `10743034975`) and the supplier call also matched exactly, so every reserve of the six re-run responses was checked (21 reserves).

Notes on check 3:

- The collateral sum takes only reserves with `usedAsCollateral: true`, as the protocol does. Polygon shows why that matters: USDC (3 units) and USDT0 (34 units) are supplied but not collateral, and leaving them out is what makes the sums agree. Arbitrum's 442-unit USDC supply is collateral and is counted. The sums agree to floating-point precision because the tool and `getUserAccountData` use the same oracle prices at the same block.

Notes on check 6 (for the owner):

- Prompt to use in the desktop client, with the server configured over stdio: **"Is 0x187a2F53544271D0B81f4b59449e036E36b80c9D at risk of liquidation on Aave v3 Ethereum?"**
- What a correct answer contains: it calls `get_aave_positions` with `chain: "ethereum"` and that address, and answers from the returned `healthFactor` (1.0703 at block 26508781; it will have moved by the time of the run). At that block the position was 8.19 WETH of collateral against 10 743 USDC of variable debt, liquidation threshold 0.84: close to liquidation, which happens at a health factor below 1, about a 6.6 % fall in the WETH oracle price (to about 1 561 USD from 1 671 USD). If the position has changed, the answer should follow the new tool output, not these numbers. Save the transcript or screenshots under `docs/validation/phase-2/`.

## Demonstration

Client: MCP Inspector CLI mode, `@modelcontextprotocol/inspector` 1.0.7 (`npx -y @modelcontextprotocol/inspector --cli …`), over stdio against `node dist/index.js`. The Inspector's v1 deprecation notice is removed from the transcripts. Transcripts have API keys, RPC URLs and the home path redacted (`<REDACTED>`, `~`) and are in `docs/validation/phase-2/`:

| Calls | Transcript |
|-------|------------|
| `tools/list`: `get_aave_positions`, `get_pool_state`, `get_token_balances`, with input and output schemas and the `get_aave_positions` description (re-captured at `1d870c4`, the commit that revised the description) | `stdio-tools-list.txt` |
| `tools/call get_aave_positions`, borrowers (checks 1–3; re-run at `1d870c4`) | `stdio-aave-ethereum-borrower-1.txt`, `stdio-aave-ethereum-borrower-2.txt`, `stdio-aave-base-borrower.txt`, `stdio-aave-arbitrum-borrower.txt`, `stdio-aave-polygon-borrower.txt` |
| `tools/call get_aave_positions`, supplier with no debt (check 4; re-run at `1d870c4`) | `stdio-aave-ethereum-supplier-no-debt.txt` |
| `tools/call get_aave_positions`, address that never used Aave (check 5; gate run) | `stdio-aave-ethereum-unused.txt` |
| `cast` references at the response blocks (checks 1, 2, 4, 5) | `cast-references.txt` |
| Health factors from a second provider (check 1) | `public-rpc-references.txt` |

Phase 2 did not change the HTTP transport, so no HTTP demonstration was run; the e2e suite lists the new tool over both transports (`test/e2e/protocol.http.test.ts`, `test/e2e/protocol.stdio.test.ts`). The desktop-client run is check 6, pending with the owner.

## Deviations from the design

1. **Reference source swapped in checks 1 and 2.** The design names the Aave app. The app is JavaScript-rendered and cannot be read from a script, so the reference is the protocol's own view functions (`Pool.getUserAccountData`, `AaveProtocolDataProvider.getUserReserveData`) read with `cast` at the response block, with the health factors confirmed on a second, keyless provider. A block-explorer reading was not added: explorers show current state rather than state at the response block, and the Etherscan API rejected the configured key. This reference is stricter than the app (raw values at the same block instead of rounded values read moments apart).
2. **`stableDebt` is always zero in practice.** Aave v3.2 removed stable-rate borrowing; the field is kept because the design lists it and the data provider still returns it.
3. **Longer fork-mode timeout for the Aave chain tests.** The ethereum reference borrower's read covers all 68 reserves of the market in one multicall; through a cold anvil fork cache that took longer than the 60 s fork timeout. `test/chain/aave-positions.test.ts` and `test/chain/aave-tool.test.ts` raise it to 180 s in fork mode only (`b82e94e`); replay timing is unchanged. The gate's fork run started with a warm cache, so it did not exercise the longer limit.
4. **Inspector version.** As in phases 0 and 1, the Inspector CLI resolved by `npx` was v1 (1.0.7). Results do not depend on it.
5. **Per-reserve USD is flat, with one price source for the response.** Each reserve carries plain `suppliedUsd` and `debtUsd` numbers (`null` without an oracle price), and the data has one top-level `priceSource: "aave-oracle"`, unlike the `{ usd, priceSource }` object of spec §5.0 used by the phase 1 tools. Every USD value in this response comes from the same source, the market's Aave oracle, so it is stated once instead of on every value.
6. **`toAaveData` takes a subject argument.** The plan specifies `toAaveData(position, market)`. The final mapper is `toAaveData(position, subject)`: the market (pool, data provider, oracle) now comes with the position (`readAavePosition` returns it, `fff76b8`), and `subject` (`{ chain, address }`) supplies the market name and the address, which the mapper cannot derive from the position.
7. **The health factor is truncated to 4 decimals, not rounded.** Half-up rounding turned a raw health factor from 0.99995e18 up to just below 1e18 into 1.0, which hid the below-1 liquidation warning. Truncation (`6c0aa1d`) means a liquidatable position never reads as 1.0. The plan's unit value changed accordingly: `parseHealthFactor(987654321000000000n)` is 0.9876, not 0.9877.

## Open issues carried forward

From phase 1: the item handed to this phase, "assert `truncated === false` for the discovery reference wallet at the next re-record", is closed by `3d95796` and passes after the re-record (see Verification). The phase 7 hardening items and the other open findings listed in `docs/validation/phase-1.md` stay with their phases and are not affected by this phase.

The base block-time finding observed during the gate is listed under Open findings (#3).

## Open findings

From the whole-branch review of the phase diff (`437e725..c8fa82c`). Closed by this phase: the reserve list cached for an hour (`cba0659`), the health factor rounded half up (`6c0aa1d`), the market resolved separately by the tool (`fff76b8`), and a tool description that referred to a `usd: null` field the tool does not have and did not state coverage or units (`1d870c4`). Still open:

| # | Finding | Impact and workaround | Owner | Fix option |
|---|---------|-----------------------|-------|------------|
| 1 | One reverting Aave price feed fails the whole call | The oracle is read with one batched `getAssetsPrices` call over the held reserves. If the feed of any one of them reverts, the call fails with `UPSTREAM_ERROR` and a valid health factor, read from `getUserAccountData`, is lost with it. No workaround in the tool | Phase 7 (hardening) | Read each asset with `getAssetPrice` and `allowFailure`; a failed read gives `null` USD for that reserve plus a warning |
| 2 | Aave market addresses, including the oracle, are cached for the process lifetime | A governance `setPriceOracle` (or a pool or data provider change in the addresses provider) leaves a long-running server reading the old oracle until it restarts. Workaround: restart the server | Phase 7 | Cache the market with a long finite TTL instead of `forever` |
| 3 | `CHAINS.base.blockTimeSeconds` is 2, but base produces a block about every 0.2 s | 477 895 blocks between the pinned block and block 63089006, 95 579 s apart. That constant is the default TTL of the pinned block and of Chainlink prices, so on base a response can lag the chain head by about ten blocks. Every value in a response is still read at the block it reports, so the data stays consistent | Phase 7 | Set the base block time from observed production, or derive the TTL from measured block spacing |

Remaining deferred minors, one line each:

- Tests build a `PinnedBlock` with timestamp `0n`. Owner: phase 7.
- The `getUserReserveData` sweep is stored as a template in the fixtures; the exact commands are in `docs/validation/phase-2/cast-references.txt`. Owner: phase 7.
- `UPSTREAM_ERROR` unit tests assert the code only, not the message. Owner: phase 7.
- Chain tests skip the token symbol and decimals check. Owner: phase 7.
- The fake `respond` helpers in unit tests decode calldata without a guard. Owner: phase 7.
- Ethereum-only chain tests sit behind a plain `if` inside `describe.each`. Owner: phase 7 (cosmetic).
- The `aave-tool` chain test asserts `suppliedUsd` only as ≥ 0, and the no-debt supplier test does not assert `suppliedUsd > 0`. Owner: phase 7.
- Placement of the `exposure` helper in `src/tools/get-aave-positions.ts`. Owner: cosmetic.
- `public-rpc-references.txt` names keyless public RPC URLs. Note only.
- The 180 s fork `testTimeout` does not raise `hookTimeout`. Owner: phase 7.
- Check 3 gives a bound (every difference below 0.00001 %) instead of per-wallet percentages. Bound given.
- The 180 s timeout has not been exercised on a cold anvil cache. Owner: phase 7.

## Owner sign-off

- [ ] Approved by ______ on ______
