# Phase 0 validation — Foundation

- Date: 2026-11-26
- Commit: `67f0166` (branch `phase-0-foundation`; this record is added on top)
- RPC provider and tier: Alchemy free tier, all four chains. Simulation backend not exercised in this phase (Tenderly credentials were used only by the spike).
- Pinned blocks (`test/fixtures/blocks.ts`, finalized − 1 000 on 2026-11-26): ethereum `26499763`, base `62611111`, arbitrum `527782324`, polygon `98004500`

## Verification

| Check | Command / link | Result |
|-------|----------------|--------|
| Lint | `pnpm lint` | Pass: `Checked 62 files … No fixes applied.` |
| Types | `pnpm typecheck` | Pass, no output |
| Coverage | `pnpm coverage` | Pass: 22 test files, 203 tests passed, 0 skipped. Statements 96.91 %, branches 94.40 %, functions 97.98 %, lines 97.40 % (thresholds 80/80) |
| Build | `pnpm build` | Pass (`dist/index.js` produced) |
| Fork run and re-record | `RECORD=1 pnpm test:fork` | Pass: `Test Files 4 passed (4)`, `Tests 41 passed (41)`, 18.6 s, no HTTP 429. `git status` was clean afterwards: the recordings were rewritten byte for byte identical to the committed ones, so there is nothing to commit |
| Replay from the recordings, no RPC variables | `env -u ALCHEMY_API_KEY -u RPC_URL_ETHEREUM -u RPC_URL_BASE -u RPC_URL_ARBITRUM -u RPC_URL_POLYGON pnpm test` | Pass: `Test Files 22 passed (22)`, `Tests 201 passed (201)`, 0 skipped, 4.1 s |
| Live provider suite | `pnpm test:live` | Not applicable: phase 0 added no live tests |
| Secret scan | Script comparing every value in the git-ignored `.env` (plus Alchemy URL patterns and the local home path) against `test/fixtures` and `docs/validation`; prints counts only | 0 secret hits. The only match is the non-secret bind address `127.0.0.1` in the HTTP transcripts |
| Docs/README gate item (design §10.4): tool reference and README section | `README.md` | Pending (phase 8): `README.md` does not exist yet; README and tool reference are phase 8 Task 8.1 (`docs/plan/phase-8-release.md`). The design and plan documents under `docs/` exist. |
| CI green on the phase pull request | [PR #1](https://github.com/mik3dev/defi-lens-mcp/pull/1), Actions run 45878759121 | Pass: lint, typecheck, build, coverage and audit green |
| Code review of the phase diff | Whole-branch review `da789a9..df93a24` | Pass: no critical findings; both important findings fixed in `29faf90` and `dead8db` and re-reviewed; remaining minors carried forward |
| Owner sign-off | — | Approved (see the end of this document) |

## Validation

Tool calls are live (no fork), through the built server over stdio (`node dist/index.js`), at the block shown. Price is USDC per WETH. Tolerance for prices is ±0.5 %.

| # | Check | Reference source | Reference value | Tool value | Tolerance | Pass |
|---|-------|------------------|-----------------|------------|-----------|------|
| 1a | `get_pool_state` price, USDC/WETH 0.05 %, ethereum, pool `0x88e6…5640`, block 26501063 | GeckoTerminal API (`/networks/eth/pools/<pool>`) | 1691.41 | 1692.2530 | ±0.5 % (diff +0.050 %) | Pass |
| 1b | same, base, pool `0xd0b5…F224`, block 62630750 | GeckoTerminal API (`/networks/base/pools/<pool>`) | 1694.50 | 1692.1040 | ±0.5 % (diff −0.142 %) | Pass |
| 1c | same, arbitrum, pool `0xC696…E8D0`, block 527795689 | GeckoTerminal API (`/networks/arbitrum/pools/<pool>`) | 1693.27 | 1692.1911 | ±0.5 % (diff −0.064 %) | Pass |
| 1d | same, polygon, native USDC/WETH 0.05 % pool `0xA4D8…28D9`, block 98007371 | GeckoTerminal API (`/networks/polygon_pos/pools/<pool>`) | 1691.72 | 1692.7295 | ±0.5 % (diff +0.060 %) | Pass |
| 2 | `reserves` of the ethereum pool, block 26501063 | `cast call <token> "balanceOf(address)(uint256)" <pool> --block 26501063` against the provider (code path independent of the server) | USDC `12460939088221`, WETH `33391422775579261480067` | USDC `12460939088221`, WETH `33391422775579261480067` | exact | Pass |
| 3 | stdio: list tools and call `get_pool_state` | MCP Inspector CLI | `tools/list` shows `get_pool_state`; `tools/call` returns the pool state | As expected (see Demonstration) | — | Pass |
| 4 | HTTP: 401 without token, success with token | `curl` and MCP Inspector CLI | 401 without or with a wrong token; 200 with the token | 401 / 401 / 200 (`curl`); Inspector fails without token, succeeds with it | exact status | Pass |
| 5 | Key placed in `RPC_URL_ETHEREUM`, RPC made to fail: key absent from the tool error and from stderr | Captured output | 0 occurrences expected | 0 occurrences in stdout, 0 in stderr | exact | Pass |
| 6 | Spike report answers Q1–Q9 with evidence and lists the decisions | `docs/spikes/provider-capabilities.md` | 9 answers, decisions listed | Summary table with Q1–Q9, one section per question with requests and responses, 18 numbered decisions | — | Pass |

Notes on check 1:

- The Uniswap app is JavaScript-rendered and its pool page cannot be read from a script, so the reference is the GeckoTerminal public API, which indexes the same pools. GeckoTerminal quotes pools with base and quote in its own order; the table converts each value to USDC per WETH.
- A second public source, the DexScreener API (`/latest/dex/pairs/<chain>/<pool>`), read within about 30 seconds of the tool calls, returned 1692.2533 (ethereum), 1692.1039 (base), 0.0005909 WETH per USDC, i.e. 1692.33 (arbitrum, four significant digits) and 1692.7295 (polygon). These agree with the tool to 0.01 % or better, which is the expected result: DexScreener reads the pool at the chain head. The larger GeckoTerminal differences (up to 0.14 %) come from the timing gap: its pool price is not read at the same block as the tool, and ETH moved by a few dollars in the gap. The exact lag was not measured. All are far inside the 0.5 % tolerance.
- Polygon: the native USDC/WETH 0.05 % pool (`0xA4D8c89f0c20efbe54cBa9e7e7a7E509056228D9`) exists with active liquidity (about 71 700 USDC and 139.6 WETH, roughly 0.3 M USD), so it was used. The chain tests use the USDC.e/WPOL 0.05 % pool instead (see Deviations). That pool was also called live: block 98007374, price 12.9639 USDC.e per WPOL, pool `0xA374094527e1673A86dE625aa59517c5dE346d32`; DexScreener was not queried for it.
- Base, arbitrum and polygon pools were resolved by `tokenA`, `tokenB`, `feeTier`, which also exercised the CREATE2 pool derivation. Ethereum was called by pool address.

Notes on check 2: the pool's `reserves` come from `balanceOf` through Multicall3 at the pinned response block; the independent check used `cast call` with `--block 26501063` (timestamp `2026-11-26T18:08:23Z`). The explorer API route was not used because `ETHERSCAN_API_KEY` is not configured.

## Demonstration

Client: MCP Inspector CLI mode, `@modelcontextprotocol/inspector` 1.0.6 (`npx -y @modelcontextprotocol/inspector --cli …`, which prints a deprecation notice for v1). Transcripts have the token, API keys, RPC URLs and the home path redacted (`<TOKEN>`, `<REDACTED>`, `~`) and are in `docs/validation/phase-0/`:

| Transport | Calls | Transcript |
|-----------|-------|------------|
| stdio | `tools/list` (one tool, `get_pool_state`, with input and output schemas) | `stdio-tools-list.txt` |
| stdio | `tools/call get_pool_state` chain `ethereum`, pool `0x88e6…5640` | `stdio-get-pool-state.txt` |
| HTTP, `curl` | `/healthz` 200 without auth; `POST /mcp` without token 401; wrong token 401; `initialize`, `tools/list`, `tools/call get_pool_state` with token 200 | `http-curl.txt` |
| HTTP, Inspector | `tools/list` without token: `Failed to connect … Error POSTing to endpoint: {"error":"unauthorized"}`; `tools/list` and `tools/call get_pool_state` with `Authorization: Bearer <TOKEN>` succeed | `http-inspector.txt` |
| stdio, raw JSON-RPC | check 5: failing RPC with a fake key in the URL | `key-leak-check.txt` |

The HTTP server ran on `127.0.0.1:3917` with a throwaway random token passed through the environment; the token appears nowhere in the repository. The graphical Inspector was not run; the owner can add a screenshot from it later. In the check 5 capture, stdout carried only protocol frames.

Check 5 outcome: the tool returned `{"code":"UPSTREAM_ERROR","message":"HTTP request failed.","retryable":false}`, and the one stderr log line shows `URL: [REDACTED]`. The capture predates the fix that makes a network-level failure (no HTTP status) retryable; the recorded `retryable:false` is historical. `FAKEKEY123456789` and the host name appear in neither stream.

## Deviations from the design

1. **Schema violations use the SDK's error text.** Input that fails the tool's input schema (for example a malformed address) returns an `isError` result whose text is the SDK's own `Input validation error: …` message, not the `INVALID_INPUT` JSON envelope (`{code, message, retryable}`). Reason: strict, descriptive input schemas (address pattern, enum, integer bounds) give agents more information, and permissive string fields would lose that in the advertised JSON Schema. Cross-field and semantic checks (for example `pool` combined with `tokenA`, or `tokenA` without `feeTier`) still return `INVALID_INPUT` JSON. The SDK-level error is not written to the `tool call` log line.
2. **Null token reads are not cached.** A token read that comes back as "not a readable ERC-20" is not cached, because an address with no code can gain code later. Readable tokens are cached forever.
3. **Polygon pool tests use USDC.e/WPOL.** The chain tests use the USDC.e/WPOL 0.05 % pool, the deepest WPOL/USDC pool at the time, rather than native USDC.
4. **Chain tests run in CI.** The plan's harness runs the chain tests in replay mode from committed recordings, which is stricter than design §3 and §9 (which expected them to be skipped without secrets). The fork run with re-recording stays mandatory at each gate.
5. **`test:fork` runs test files serially** (`--no-file-parallelism`). Four cold anvil forks in parallel exceed the Alchemy free-tier compute units per second (HTTP 429); serially a cold run takes about 36 s. The same flag keeps the two e2e files from writing the shared `e2e-pool-state` recording at once.
6. **`checksumAddressSchema` added to the shared interfaces.** Output schemas must use it, not `addressSchema`: the latter has a checksum transform, which breaks `tools/list`.
7. **Pool authentication by CREATE2.** A pool is accepted only when its address equals the CREATE2 address derived from the canonical factory, token pair and fee; implementing the pool getters is not enough.
8. **HTTP 429 maps to `UPSTREAM_ERROR` (retryable)**, not `RATE_LIMITED`, per the task brief. 
9. **`TENDERLY_TIMEOUT_MS` default is 60 s.** The planned 20 s was too short: Tenderly rejects a wrong key with HTTP 403 only after about 50 s (3 of 3 probes).
10. **Uniswap addresses** were checked against the official deployment pages on 2026-11-26 (the docs now redirect to `developers.uniswap.org`); all 12 match, so there is no address deviation.
11. **Reference sources swapped in checks 1 and 2.** Check 1 uses the GeckoTerminal API (cross-checked with DexScreener) instead of the Uniswap app, and check 2 uses `cast call balanceOf` at the same block instead of a block explorer. Reason: the Uniswap app is JavaScript-rendered and cannot be read from a script, and no Etherscan key is configured. The check 2 reference is independent of the server's code path but not of the RPC provider.
12. **Inspector version.** Check 3 and 4 used Inspector v1 CLI (the version `npx` resolved; it prints a deprecation notice). Results do not depend on it.

## Open issues carried forward

Phase 7 hardening:

- Host and Origin header checks when `HOST` is not localhost.
- The JSON body is parsed (up to 1 MB) before bearer authentication, so unauthenticated POSTs are parsed before the 401.
- An unsupported content type (415) is mapped to HTTP 500 by the error handler.
- The SDK's `console.warn` calls bypass the server's logger.
- Confirm that `TENDERLY_TIMEOUT_MS` of 60 s is safe against the outer MCP and tool deadlines.
- Rate limiting (`RATE_LIMIT_RPM`, `lib/limiter`) is configured but not wired into the HTTP transport.

Other:

- Tenderly plan quota is unknown (no rate-limit headers; the pricing page says the Free plan has no API access, yet the key works). Owner to confirm the monthly simulation allowance before the phase 6 live suite runs often.
- `get_pool_state` description is accurate for this phase (latest block, Uniswap v3 only, token balances, spot price in both directions, `price0In1` definition, spot price is not a USD price). It does not say that `usd0`, `usd1` and `tvlUsd` are always `null` until prices arrive in phase 1; consider adding that sentence then.
- `src/index.ts`, `src/transports/stdio.ts` and the HTTP wiring in `index.ts` have no automated test (coverage excludes them); they were exercised through the checks above and the spawned-process e2e tests.
- Minor, deferred from review: other docs that quote `pnpm test:fork` may lack the new flag; the `RERECORD_HINT` text is verbose; duplicated `isString`, `isNumber`, `isBigint` and `success` helpers in `erc20/tokens.ts` and `uniswap/pool.ts` could move to a shared module.
- Graphical MCP Inspector demonstration is owner-run and optional.

## Owner sign-off

- [x] Approved by mik3dev on 2026-11-26
