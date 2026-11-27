# Phase 2 validation — Aave v3 positions

- Date: 2026-11-27
- Commit: `0a50514` (branch `phase-2-aave`; `src/` is identical to `90f6e49`; this record is added on top). Gate commits before the re-record: `b82e94e` (longer fork-mode timeout for the Aave chain tests) and `3d95796` (discovery reference wallet asserted untruncated)
- RPC provider and tier: Alchemy free tier, all four chains, for both chain reads (`RPC_URL_*`) and token discovery (`ALCHEMY_API_KEY`). Simulation backend not used in this phase.
- Pinned blocks (`test/fixtures/blocks.ts`, unchanged since phase 0): ethereum `26499763`, base `62611111`, arbitrum `527782324`, polygon `98004500`

## Verification

| Check | Command / link | Result |
|-------|----------------|--------|
| Lint | `pnpm lint` | Pass: `Checked 97 files … No fixes applied.` |
| Types | `pnpm typecheck` | Pass, no output |
| Coverage | `pnpm coverage` | Pass: 36 test files, 396 tests passed, 0 skipped. Statements 97.87 %, branches 95.33 %, functions 98.2 %, lines 98.34 % (thresholds 80/80) |
| Build | `pnpm build` | Pass (`dist/index.js` produced) |
| Fork run and re-record | `RECORD=1 pnpm test:fork` | Pass: `Test Files 11 passed (11)`, `Tests 114 passed (114)`, 56.75 s, no HTTP 429. Two recordings changed: `test/fixtures/rpc/indexer.ethereum.json` and `test/fixtures/rpc/token-balances.ethereum.json`, 7 lines each, all of them `tokenBalance` values in `alchemy_getTokenBalances` answers for the discovery reference wallet: the same four spam tokens as at the phase 1 gate (`0x296a…6e30`, `0x2ea0…1189`, `0xef54…c1e4`, `0x02c9…1a96`) plus three tokens whose current balance moved (`ShibDoge` `0x6adb…928f`, `A7A5` `0x6fa0…0fc9`, `KEI` `0xc011…a842`). The indexer reports current state, not state at the pinned block, so this is expected. No contract address was added or removed, and every pinned-block read, including all eight Aave recordings, is byte for byte unchanged. Committed as `0a50514` (`test: refresh recordings at the phase 2 gate`) |
| Discovery reference wallet not truncated (phase 1 carried item) | `test/chain/indexer.test.ts`, `discovers every priced token the reference wallet holds, untruncated` (added in `3d95796`) | Pass in fork mode and in replay: `truncated` is `false`. The fresh recording holds 14 pages, 1 383 distinct tokens, 329 with a non-zero balance: 71 under `DISCOVERY_CANDIDATE_CAP` (400) and 6 pages under `DISCOVERY_PAGE_LIMIT` (20) |
| Replay from the recordings, no RPC variables | `env -u ALCHEMY_API_KEY -u RPC_URL_ETHEREUM -u RPC_URL_BASE -u RPC_URL_ARBITRUM -u RPC_URL_POLYGON pnpm test` | Pass, after the re-record: `Test Files 36 passed (36)`, `Tests 396 passed (396)`, 0 skipped, 4.9 s |
| Live provider suite | `pnpm test:live` | Not applicable: phase 2 added no live tests (`test/live/` does not exist) |
| Secret scan | Script comparing every `.env` value of 8 characters or more against every tracked and untracked, non-ignored file; prints variable names and counts only. Run before each gate commit. Plus a check for the local home path | 0 secret hits. The only matches are `HOST` (a localhost value) and `TENDERLY_PROJECT` (the public package name `defi-lens-mcp`). 0 home-path hits |
| Docs/README gate item (design §10.4): tool reference and README section | `README.md` | Pending (phase 8): `README.md` does not exist yet. The `get_aave_positions` description is written and appears in `tools/list` (`phase-2/stdio-tools-list.txt`) |
| CI green on the phase pull request | — | Pending: CI runs on the phase pull request |
| Code review of the phase diff | — | Pending: the whole-branch review runs after this record |
| Owner sign-off | — | Pending |

## Validation

Tool calls are live (no fork), through the built server over stdio (`node dist/index.js`, built from `src/` at `90f6e49`), with MCP Inspector CLI, at the block shown in each response. All seven calls were made at 19:36 UTC. References come from `cast` 1.5.0 at the response block, with the provider URL passed in the environment (`ETH_RPC_URL`) and never in argv or output (`phase-2/cast-references.txt`). The `cast` reads are independent of the server's code path (no Multicall3, no viem, no oracle conversion) but not of the provider, so the five health factors were read a second time from keyless public RPC endpoints (PublicNode; the official Arbitrum RPC for arbitrum) at the same blocks (`phase-2/public-rpc-references.txt`); all five raw values are identical across the two providers.

| # | Check | Reference source | Reference value | Tool value | Tolerance | Pass |
|---|-------|------------------|-----------------|------------|-----------|------|
| 1a | Health factor, ethereum borrower `0xa18C…fAe5` (reference wallet), block 26508680 | `Pool.getUserAccountData` via `cast --block 26508680`; second provider | `2304934253855713039` = 2.304934 | 2.3049 | ±0.01 (diff −0.00003) | Pass |
| 1b | Health factor, ethereum borrower `0x187a…0c9D`, block 26508680 | same | `1070384818370359535` = 1.070385 | 1.0704 | ±0.01 (diff +0.00002) | Pass |
| 1c | Health factor, base borrower `0x447E…A6C0` (reference wallet), block 63089006 | same, `--block 63089006` | `3215228124632453084` = 3.215228 | 3.2152 | ±0.01 (diff −0.00003) | Pass |
| 1d | Health factor, arbitrum borrower `0x0f66…862b` (reference wallet), block 528095996 | same, `--block 528095996` | `1534435522580256195` = 1.534436 | 1.5344 | ±0.01 (diff −0.00004) | Pass |
| 1e | Health factor, polygon borrower `0xB599…f9f7` (reference wallet), block 98068465 | same, `--block 98068465` | `1536881294664604142` = 1.536881 | 1.5369 | ±0.01 (diff +0.00002) | Pass |
| 2a | Supplied and borrowed per reserve, ethereum `0xa18C…fAe5`, block 26508680 | `AaveProtocolDataProvider.getUserReserveData(asset, user)` via `cast --block 26508680`, one call per reserve | WETH supplied `64632790300311121391`; WBTC supplied `69847129`; LINK supplied `4382237783677893296662`; AAVE supplied `16988412789781472175` (all collateral); USDT variable debt `55532855021`; USDC variable debt `12502069660`; stable debt 0 everywhere | identical raw values and `usedAsCollateral` flags, 6 reserves | exact | Pass |
| 2b | same, base `0x447E…A6C0`, block 63089006 | same | cbBTC supplied `78113071`, WETH supplied `3635340041373945713` (collateral); USDC variable debt `13816365014` | identical, 3 reserves | exact | Pass |
| 2c | same, arbitrum `0x0f66…862b`, block 528095996 | same | WBTC supplied `181868345` (collateral); USDC supplied `442` (collateral) and variable debt `58231043142` | identical, 2 reserves | exact | Pass |
| 2d | same, polygon `0xB599…f9f7`, block 98068465 | same | WBTC supplied `5371668`, WETH supplied `13777318138289377`, WPOL supplied `4402134062547148651742` and variable debt `22006991563737652504070` (collateral); USDC supplied `3` and variable debt `100019348`, wstETH variable debt `146013906923545`, USDT0 supplied `34` (not collateral) | identical, 6 reserves | exact | Pass |
| 3 | Sum of `suppliedUsd` over reserves with `usedAsCollateral` vs `totalCollateralUsd`; sum of `debtUsd` vs `totalDebtUsd` | Captured outputs of 1a–1e and check 4 | ethereum `0xa18C…`: 192 518.484429 / 67 973.791287; ethereum `0x187a…`: 13 688.747609 / 10 742.443086; base: 52 878.202996 / 13 814.786632; arbitrum: 108 955.898616 / 58 225.865820; polygon: 3 585.003596 / 1 809.094934; supplier: 825 530.053505 / 0 | `totalCollateralUsd` / `totalDebtUsd`: 192 518.4844294 / 67 973.7912872; 13 688.7476091 / 10 742.44308617; 52 878.20299585 / 13 814.78663247; 108 955.89861563 / 58 225.86581996; 3 585.0035963 / 1 809.09493355; 825 530.05350524 / 0 | ±0.5 % (every difference below 0.00001 %) | Pass |
| 4 | Supply and no debt shows `healthFactor: null`, note `no debt` | Captured output; `getUserAccountData` via `cast --block 26508680` (debt `0`, health factor `2^256 − 1`) | ethereum `0x83d8…0C0B`: collateral 825 530.05 USD, debt 0 | `healthFactor: null`, `healthFactorNote: "no debt"`, `totalDebtUsd: 0`, no warnings; WETH supplied `494026863254417159404` (collateral) and USDT `4680693` (not collateral), both equal to `getUserReserveData` | exact | Pass |
| 5 | Address that never used Aave returns an empty position, not an error | Captured output; `cast nonce`, `cast code` and `Pool.getUserConfiguration` at block 26508680 | ethereum `0xd012…CAe7`: nonce 0, no code, user configuration bitmap `0`, account data all zero | not `isError`; `reserves: []`, every summary number 0, `eModeCategory: 0`, `healthFactor: null`, `healthFactorNote: "no debt"`, no warnings | exact | Pass |
| 6 | Agent-readability: a desktop client asked "is this wallet at risk of liquidation?" answers from the tool output correctly | Transcript | — | — | — | Pending (owner) |

Notes on checks 1 and 2:

- Wallet selection. The four reference wallets of `test/fixtures/wallets.ts` (`AAVE_WALLETS.borrower`, found at the pinned blocks) still held positions live, checked with `getUserAccountData` at the latest block before the calls, so they were reused for 1a and 1c–1e. The second ethereum borrower, `0x187a2F53544271D0B81f4b59449e036E36b80c9D`, was found the same way the fixtures were: `cast logs` of the Pool's `Borrow` event in 10-block windows just before the calls (event at block 26508671, `onBehalfOf`). It was the first candidate that was an EOA with a debt; its health factor near 1 also makes it the subject of check 6. The no-debt supplier (check 4) and the never-used address (check 5) are `AAVE_WALLETS.supplierEthereum` and `AAVE_WALLETS.unusedEthereum`, both re-checked at the response block.
- The tool rounds the health factor to 4 decimals; every difference above is that rounding. The other summary fields (`totalCollateralUsd`, `totalDebtUsd`, `availableBorrowsUsd`, `ltv`, `liquidationThreshold`, `eModeCategory` against `Pool.getUserEMode`) also equal the `cast` values exactly for all seven calls.
- Check 2 is stricter than planned: raw amounts at the same block instead of the app's display precision. The ethereum `0x187a…` call (WETH supplied `8191838703501966726`, USDC variable debt `10743017193`) and the supplier call also matched exactly, so every reserve of all seven responses was checked (21 reserves).

Notes on check 3:

- The collateral sum takes only reserves with `usedAsCollateral: true`, as the protocol does. Polygon shows why that matters: USDC (3 units) and USDT0 (34 units) are supplied but not collateral, and leaving them out is what makes the sums agree. Arbitrum's 442-unit USDC supply is collateral and is counted. The sums agree to floating-point precision because the tool and `getUserAccountData` use the same oracle prices at the same block.

Notes on check 6 (for the owner):

- Prompt to use in the desktop client, with the server configured over stdio: **"Is 0x187a2F53544271D0B81f4b59449e036E36b80c9D at risk of liquidation on Aave v3 Ethereum?"**
- What a correct answer contains: it calls `get_aave_positions` with `chain: "ethereum"` and that address, and answers from the returned `healthFactor` (1.0704 at block 26508680; it will have moved by the time of the run). At that block the position was 8.19 WETH of collateral against 10 743 USDC of variable debt, liquidation threshold 0.84: close to liquidation, which happens at a health factor below 1, about a 6.6 % fall in the WETH oracle price (to about 1 561 USD from 1 671 USD). If the position has changed, the answer should follow the new tool output, not these numbers. Save the transcript or screenshots under `docs/validation/phase-2/`.

## Demonstration

Client: MCP Inspector CLI mode, `@modelcontextprotocol/inspector` 1.0.7 (`npx -y @modelcontextprotocol/inspector --cli …`), over stdio against `node dist/index.js`. The Inspector's v1 deprecation notice is removed from the transcripts. Transcripts have API keys, RPC URLs and the home path redacted (`<REDACTED>`, `~`) and are in `docs/validation/phase-2/`:

| Calls | Transcript |
|-------|------------|
| `tools/list`: `get_aave_positions`, `get_pool_state`, `get_token_balances`, with input and output schemas and the `get_aave_positions` description | `stdio-tools-list.txt` |
| `tools/call get_aave_positions`, borrowers (checks 1–3) | `stdio-aave-ethereum-borrower-1.txt`, `stdio-aave-ethereum-borrower-2.txt`, `stdio-aave-base-borrower.txt`, `stdio-aave-arbitrum-borrower.txt`, `stdio-aave-polygon-borrower.txt` |
| `tools/call get_aave_positions`, supplier with no debt (check 4) | `stdio-aave-ethereum-supplier-no-debt.txt` |
| `tools/call get_aave_positions`, address that never used Aave (check 5) | `stdio-aave-ethereum-unused.txt` |
| `cast` references at the response blocks (checks 1, 2, 4, 5) | `cast-references.txt` |
| Health factors from a second provider (check 1) | `public-rpc-references.txt` |

Phase 2 did not change the HTTP transport, so no HTTP demonstration was run; the e2e suite lists the new tool over both transports (`test/e2e/protocol.http.test.ts`, `test/e2e/protocol.stdio.test.ts`). The desktop-client run is check 6, pending with the owner.

## Deviations from the design

1. **Reference source swapped in checks 1 and 2.** The design names the Aave app. The app is JavaScript-rendered and cannot be read from a script, so the reference is the protocol's own view functions (`Pool.getUserAccountData`, `AaveProtocolDataProvider.getUserReserveData`) read with `cast` at the response block, with the health factors confirmed on a second, keyless provider. A block-explorer reading was not added: explorers show current state rather than state at the response block, and the Etherscan API rejected the configured key. This reference is stricter than the app (raw values at the same block instead of rounded values read moments apart).
2. **The reserve list is cached per chain for 1 h, not per block.** Every other volatile read is keyed by block number. `getAllReservesTokens` changes only through governance, so it is read at the first caller's block and reused for up to 1 h. A reserve listed within that hour is missing from `reserves` until the cache expires (its value is still in the summary totals, which come from `getUserAccountData`).
3. **`stableDebt` is always zero in practice.** Aave v3.2 removed stable-rate borrowing; the field is kept because the design lists it and the data provider still returns it.
4. **Longer fork-mode timeout for the Aave chain tests.** The ethereum reference borrower's read covers all 68 reserves of the market in one multicall; through a cold anvil fork cache that took longer than the 60 s fork timeout. `test/chain/aave-positions.test.ts` and `test/chain/aave-tool.test.ts` raise it to 180 s in fork mode only (`b82e94e`); replay timing is unchanged. The gate's fork run started with a warm cache, so it did not exercise the longer limit.
5. **Inspector version.** As in phases 0 and 1, the Inspector CLI resolved by `npx` was v1 (1.0.7). Results do not depend on it.

## Open issues carried forward

From phase 1: the item handed to this phase, "assert `truncated === false` for the discovery reference wallet at the next re-record", is closed by `3d95796` and passes after the re-record (see Verification). The phase 7 hardening items and the other open findings listed in `docs/validation/phase-1.md` stay with their phases and are not affected by this phase.

Observed during the gate, not fixed here:

- **Base block time.** `CHAINS.base.blockTimeSeconds` is 2, but base now produces a block about every 0.2 s (477 895 blocks between the pinned block and block 63089006, 95 579 s apart). That constant is the default TTL of the pinned block and of Chainlink prices, so on base a response can lag the chain head by about ten blocks. Every value in a response is still read at the block it reports, so the data stays consistent. Owner: phase 7 (hardening).

## Open findings

_To be completed after the whole-branch review of the phase diff._

## Owner sign-off

- [ ] Approved by ______ on ______
