# Phase 0 — Foundation and Walking Skeleton

Part of the [development plan](../development-plan.md). Spec: [design.md](../design.md) §5.0, §5.4, §6, §7, §9, §10.

**Outcome:** a repository where `get_pool_state` works end to end over stdio and authenticated HTTP, with CI, a deterministic chain-test harness, and a written report on what the providers can actually do.

**Owner actions before starting:** local `.env` with `ALCHEMY_API_KEY` and Tenderly credentials; public GitHub repository created and added as `origin`.

**Branch:** `phase-0-foundation`

---

### Task 0.1: Scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `LICENSE` (MIT), `src/config.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Config {
    transport: 'stdio' | 'http';
    rpcUrls: Partial<Record<ChainId, string>>;
    alchemyApiKey?: string;
    simulationBackend: 'rpc' | 'tenderly';
    tenderly?: { account: string; project: string; accessKey: string };
    etherscanApiKey?: string;
    host: string; port: number;
    authTokens: string[]; rateLimitRpm: number;
    cacheTtlSeconds?: number;
    logsMaxBlockRange: number; logsMaxRequests: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    secrets: string[]; // every value that must never appear in output
  }
  export class ConfigError extends Error {}
  export function loadConfig(env: Record<string, string | undefined>): Config;
  ```

- [ ] **Step 1: Scaffold.** `pnpm init`; add dependencies `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`, `express`, `viem`, `zod`; dev dependencies `typescript`, `tsx`, `vitest`, `@vitest/coverage-v8`, `@biomejs/biome`, `@types/node`, `@types/express`, `@modelcontextprotocol/client`. Before installing, confirm the current package names, the stdio transport export and the client package against the MCP TypeScript SDK docs; pin exact versions. `package.json`: `"type": "module"`, `"engines": { "node": ">=22" }`, `"license": "MIT"`, scripts from the plan's command table. `.gitignore`: `node_modules`, `dist`, `coverage`, `.env`. Vitest coverage thresholds: lines 80, branches 80, include `src/**`, exclude `src/index.ts`.
- [ ] **Step 2: Write the failing tests** (`test/unit/config.test.ts`). `T32` below is any 32-character string.
  ```ts
  it('applies defaults', () => {
    const c = loadConfig({ RPC_URL_ETHEREUM: 'https://rpc.example' });
    expect(c).toMatchObject({ transport: 'stdio', host: '127.0.0.1', port: 3000,
      simulationBackend: 'rpc', rateLimitRpm: 60, logLevel: 'info',
      rpcUrls: { ethereum: 'https://rpc.example' } });
  });
  it('derives RPC URLs from the Alchemy key', () => {
    expect(loadConfig({ ALCHEMY_API_KEY: 'k' }).rpcUrls).toEqual({
      ethereum: 'https://eth-mainnet.g.alchemy.com/v2/k',
      base: 'https://base-mainnet.g.alchemy.com/v2/k',
      arbitrum: 'https://arb-mainnet.g.alchemy.com/v2/k',
      polygon: 'https://polygon-mainnet.g.alchemy.com/v2/k' });
  });
  it('lets an explicit RPC URL override the derived one', …); // RPC_URL_BASE wins for base only
  it('fails when no chain is enabled', () => expect(() => loadConfig({})).toThrow(/RPC_URL_/));
  it('fails in http mode without tokens', () =>
    expect(() => loadConfig({ TRANSPORT: 'http', ALCHEMY_API_KEY: 'k' })).toThrow(/MCP_AUTH_TOKENS/));
  it('rejects auth tokens shorter than 32 characters', …); // toThrow(/MCP_AUTH_TOKENS/)
  it('parses a token list', …); // 'T32a, T32b ,' → [T32a, T32b]
  it('fails for tenderly backend without credentials', …); // toThrow(/TENDERLY_/)
  it('fails on a non-numeric PORT', …); // toThrow(/PORT/)
  it('collects secrets', …); // secrets contains the Alchemy key, each token, tenderly key, etherscan key, every RPC URL
  ```
- [ ] **Step 3: Run** `pnpm vitest run test/unit/config.test.ts` — fails: `loadConfig` not defined.
- [ ] **Step 4: Implement `loadConfig`** in `src/config.ts` with one Zod schema. Provisional defaults `LOGS_MAX_BLOCK_RANGE=10` and `LOGS_MAX_REQUESTS=30`; task 0.8 replaces them with measured values. `ConfigError` messages name the variable and never include its value. `.env.example` lists every variable from spec §7 with a comment each.
- [ ] **Step 5: Run** the same command — all pass. `pnpm lint && pnpm typecheck` clean.
- [ ] **Step 6: Commit** `chore: scaffold project and add configuration loading`

---

### Task 0.2: Library foundations

**Files:**
- Create: `src/lib/errors.ts`, `src/lib/format.ts`, `src/lib/sanitize.ts`, `src/lib/cache.ts`, `src/lib/logger.ts`, `src/lib/limiter.ts`
- Test: `test/unit/lib/*.test.ts` (one per file)

**Interfaces:**
- Produces: `AppError`, `toAppError`, `redact`, `Amount`, `toAmount`, `formatRatio`, `usdValue`, `TtlCache` as in the plan's Shared Interfaces, plus:
  ```ts
  export function sanitizeSymbol(value: string): string;
  export interface Logger { debug(msg: string, f?: object): void; info(…): void; warn(…): void; error(…): void }
  export function createLogger(level: Config['logLevel'], secrets: string[], out?: NodeJS.WritableStream): Logger; // default process.stderr
  export function createLimiter(maxConcurrent: number): <T>(fn: () => Promise<T>) => Promise<T>;
  ```

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // format
  expect(toAmount(1500000n, 6)).toEqual({ raw: '1500000', formatted: '1.5', decimals: 6 });
  expect(toAmount(0n, 18).formatted).toBe('0');
  expect(formatRatio(1n, 3n, 6)).toBe('0.333333');
  expect(formatRatio(4n, 1n)).toBe('4');
  expect(formatRatio(1n, 10n ** 12n)).toBe('0.000000000001');
  expect(usdValue(2_500000n, 6, 2)).toBe(5);
  expect(usdValue(1n, 6, null)).toBeNull();
  // sanitize
  expect(sanitizeSymbol('US\u0000DC\n')).toBe('USDC');
  expect(sanitizeSymbol('  WETH ')).toBe('WETH');
  expect(sanitizeSymbol('A'.repeat(40))).toHaveLength(32);
  expect(sanitizeSymbol('')).toBe('UNKNOWN');
  // errors
  expect(redact('fail https://h/v2/SECRETKEY', ['SECRETKEY'])).toBe('fail https://h/v2/[REDACTED]');
  expect(toAppError(new AppError('NOT_FOUND', 'x'))).toMatchObject({ code: 'NOT_FOUND' });
  expect(toAppError(viemTimeoutError)).toMatchObject({ code: 'UPSTREAM_TIMEOUT', retryable: true });
  expect(toAppError(viemHttpError429)).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
  expect(toAppError(new Error('boom https://h/v2/KEY'))).toMatchObject({ code: 'INTERNAL', retryable: false, message: 'Internal error' });
  // cache (vi.useFakeTimers)
  //  get returns the value before ttl and undefined after; 'forever' never expires;
  //  with maxEntries 2, setting a third key evicts the oldest;
  //  two concurrent wrap() calls on one key invoke fn once and both resolve to its value;
  //  a rejected wrap() is not cached.
  // limiter: createLimiter(2) over 5 tasks → observed max concurrency is 2, all 5 resolve.
  // logger: info() writes one JSON line with level, msg, time to the injected stream;
  //  debug() is dropped at level 'info'; a field containing a secret is written as '[REDACTED]';
  //  nothing is written to process.stdout (spy).
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/lib` — fails: modules not found.
- [ ] **Step 3: Implement.** `toAppError` recognizes viem errors by walking `error.walk()` for `TimeoutError` and `HttpRequestError` (status 429 or ≥ 500 → retryable `UPSTREAM_ERROR`); any other viem RPC error → `UPSTREAM_ERROR` non-retryable with viem's `shortMessage`; anything else → `INTERNAL` with the fixed message `Internal error`. `sanitizeSymbol` removes `\p{C}` characters, trims, truncates to 32. No external dependencies for cache, logger or limiter.
- [ ] **Step 4: Run** `pnpm vitest run test/unit/lib` — all pass; lint and typecheck clean.
- [ ] **Step 5: Commit** `feat: add error, formatting, cache, logging and concurrency primitives`

---

### Task 0.3: Chains, clients, chain-test harness, ERC-20 reader

**Files:**
- Create: `src/chains.ts`, `src/context.ts`, `src/lib/blocks.ts`, `src/protocols/erc20/abi.ts`, `src/protocols/erc20/tokens.ts`
- Create: `test/helpers/chain-endpoint.ts`, `test/helpers/context.ts`, `test/fixtures/blocks.ts`
- Test: `test/unit/chains.test.ts`, `test/chain/erc20.test.ts`

**Interfaces:**
- Consumes: `Config`, `AppError`, `TtlCache`, `createLogger`, `sanitizeSymbol`.
- Produces: everything under `src/chains.ts`, `src/context.ts`, `src/lib/blocks.ts`, `src/protocols/erc20/tokens.ts` in Shared Interfaces, plus `createContext(config: Config): AppContext`, `readBalances(ctx, chain, owner: Address, tokens: Address[], block): Promise<Map<Address, bigint>>` (native via `NATIVE_ADDRESS`), and the test helpers:
  ```ts
  // test/helpers/chain-endpoint.ts
  export function hasRpc(): boolean; // CHAIN_MODE=fork and an upstream RPC is configured
  export function chainEndpoint(chain: ChainId, fixture: string): Promise<{ rpcUrl: string; stop(): Promise<void> }>;
  // test/helpers/context.ts
  export function testContext(rpcUrls: Partial<Record<ChainId, string>>, overrides?: Partial<Config>): AppContext;
  // test/fixtures/blocks.ts
  export const PINNED: Record<ChainId, bigint>;
  ```

**Chain metadata (verify each wrapped-native address on-chain in the test below):**

| Chain | chainId | blockTimeSeconds | nativeSymbol | wrappedNative | alchemySubdomain |
|-------|---------|------------------|--------------|---------------|------------------|
| ethereum | 1 | 12 | ETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `eth-mainnet` |
| base | 8453 | 2 | ETH | `0x4200000000000000000000000000000000000006` | `base-mainnet` |
| arbitrum | 42161 | 0.25 | ETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | `arb-mainnet` |
| polygon | 137 | 2 | POL | `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` | `polygon-mainnet` |

`hubTokens` stays `[wrappedNative]` until phase 4 fills it.

**How the chain-test harness works** (this is what lets CI exercise chain-reading code with no secrets):

- `chainEndpoint(chain, fixture)` always returns a local HTTP JSON-RPC URL.
- **Replay mode** (default, used by `pnpm test` and CI): a small in-process HTTP server answers each request from `test/fixtures/rpc/<fixture>.json`, keyed by `method` + canonical JSON of `params`. An unrecorded request fails the test with: `No recording for <method>. Re-record with: RECORD=1 pnpm test:fork`.
- **Fork mode** (`CHAIN_MODE=fork`, used by `pnpm test:fork`): starts `anvil --fork-url <upstream> --fork-block-number <PINNED[chain]>` on a free port and proxies requests to it; with `RECORD=1` the proxy writes the request/response pairs to the fixture file.
- Recordings never contain URLs or headers, so they cannot hold a key.
- Because replay is keyed by request content, production code must issue deterministic requests: **viem clients are created with automatic batching off, and reads are grouped with explicit `client.multicall({ contracts, blockNumber })`.**
- `PINNED` is chosen in this task: for each chain, the latest finalized block minus 1 000 on the day of pinning, recorded with the date in a comment.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // test/unit/chains.test.ts
  it('has metadata for every chain', () => { for (const id of CHAIN_IDS) expect(CHAINS[id].chainId).toBeGreaterThan(0); });
  it('getClient throws for an unconfigured chain', () =>
    expect(() => getClient(testContext({ ethereum: 'http://x' }), 'base')).toThrowError(expect.objectContaining({ code: 'CHAIN_NOT_CONFIGURED' })));

  // test/chain/erc20.test.ts — one describe per chain via describe.each(CHAIN_IDS)
  it('wrapped native token reads as the expected symbol and 18 decimals', …); // WETH / WETH / WETH / WPOL
  it('pinBlock returns the pinned block', …); // number === PINNED[chain], timestamp > 0n
  // ethereum only:
  it('decodes a bytes32 symbol', …); // MKR 0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2 → { symbol: 'MKR', decimals: 18 }
  it('returns null for an address with no code', …); // 0x000000000000000000000000000000000000dEaD → null
  it('returns null for a contract that is not an ERC-20', …); // Multicall3 0xcA11bde05977b3631167028862bE2a173976CA11 → null
  it('resolves the native descriptor without an RPC call', …); // NATIVE_ADDRESS → { symbol: 'ETH', decimals: 18 }
  it('readBalances returns native and token balances', …); // owner = the WETH contract: native balance > 0n; expected exact values from cast, stored in test/fixtures/erc20.ethereum.json
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/chains.test.ts test/chain/erc20.test.ts` — fails: modules not found.
- [ ] **Step 3: Implement** the harness, `createContext` (clients with `http(url, { batch: false })`, viem retry count 2, timeout 15 s, each transport wrapped to increment the per-call upstream request counter described in Shared Interfaces), `pinBlock` (cached per chain as described there), `readTokens` (multicall of `symbol`/`decimals` with `allowFailure`; on a failed `symbol` retry that token with a `bytes32` ABI; results cached `forever` under `token:<chain>:<address>`), `readBalances`.
- [ ] **Step 4: Record and run.** `RECORD=1 pnpm test:fork -- test/chain/erc20.test.ts` — passes against anvil and writes `test/fixtures/rpc/erc20.<chain>.json`. Then `pnpm vitest run test/chain/erc20.test.ts` with no RPC variables set — passes from recordings.
- [ ] **Step 5: Commit** `feat: add chain clients, replayable chain-test harness and ERC-20 reader`

---

### Task 0.4: Tool envelope and `get_pool_state`

**Files:**
- Create: `src/tools/shared.ts`, `src/tools/get-pool-state.ts`, `src/protocols/uniswap/abis.ts`, `src/protocols/uniswap/addresses.ts`, `src/protocols/uniswap/math.ts`, `src/protocols/uniswap/pool.ts`
- Test: `test/unit/tools/shared.test.ts`, `test/unit/protocols/uniswap/math.test.ts`, `test/chain/pool-state.test.ts`

**Interfaces:**
- Consumes: `AppContext`, `getClient`, `pinBlock`, `readTokens`, `readBalances`, `formatRatio`, `toAmount`, `AppError`.
- Produces: everything under `src/tools/shared.ts` in Shared Interfaces, plus:
  ```ts
  // src/protocols/uniswap/addresses.ts
  export const UNISWAP_V3: Record<ChainId, { factory: Address; positionManager: Address; quoterV2: Address }>;
  export const FEE_TIERS = [100, 500, 3000, 10000] as const;
  // src/protocols/uniswap/math.ts
  export function sqrtPriceX96ToPrices(sqrtPriceX96: bigint, decimals0: number, decimals1: number): { price0In1: string; price1In0: string };
  // src/protocols/uniswap/pool.ts
  export interface PoolState { pool: Address; token0: TokenInfo; token1: TokenInfo; feeTier: number; tickSpacing: number;
    sqrtPriceX96: bigint; tick: number; liquidity: bigint; reserve0: bigint; reserve1: bigint }
  export function resolvePool(ctx, chain, sel: { pool?: Address; tokenA?: Address; tokenB?: Address; feeTier?: number }, block): Promise<Address>;
  export function readPoolState(ctx, chain, pool: Address, block): Promise<PoolState>;
  // src/tools/get-pool-state.ts
  export function register(server: McpServer, ctx: AppContext): void;
  export function getPoolState(ctx: AppContext, input: PoolStateInput): Promise<ToolOutput<PoolStateData>>;
  ```

**Uniswap v3 deployments** (confirm against the official Uniswap deployments page; the sanity test is the arbiter):

| Chain | factory | positionManager | quoterV2 |
|-------|---------|-----------------|----------|
| ethereum, arbitrum, polygon | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| base | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |

**Tool contract:**
- Input: `{ chain, pool?, tokenA?, tokenB?, feeTier? }`. The cross-field rule (either `pool`, or all of `tokenA`/`tokenB`/`feeTier`) is checked in the handler, not with a schema refinement, so the advertised JSON Schema stays a plain object. This is the rule for every tool with cross-field constraints.
- Output `data`: `{ pool, token0, token1, feeTier, tickSpacing, sqrtPriceX96: string, tick: number, liquidity: string, price0In1: string, price1In0: string, reserves: { amount0: Amount, amount1: Amount, usd0: number | null, usd1: number | null }, tvlUsd: number | null }`. USD fields are `null` in this phase.
- Annotations `{ readOnlyHint: true, openWorldHint: true }`. Description states: Uniswap v3 only; price is the pool's own spot price, not a market-wide or USD price.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // shared.test.ts
  const A = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
  expect(addressSchema.parse(A)).toBe('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640');           // lowercase accepted, checksummed out
  expect(addressSchema.parse('0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640')).toBeDefined();
  expect(addressSchema.safeParse('0x88E6A0c2dDD26FEEb64F039a2c41296FcB3f5640').success).toBe(false); // bad checksum
  expect(addressSchema.safeParse('0x1234').success).toBe(false);
  expect(addressSchema.safeParse('88e6a0c2ddd26feeb64f039a2c41296fcb3f5640').success).toBe(false);
  expect(ok('ethereum', { number: 5n, timestamp: 1700000000n }, { a: 1 })).toEqual(
    { chain: 'ethereum', blockNumber: '5', blockTimestamp: '2023-11-14T22:13:20.000Z', data: { a: 1 }, warnings: [] });
  // runTool: resolves fn's output as { structuredContent, content: [{ type: 'text', text: JSON }] };
  //  a thrown AppError('NOT_FOUND','no pool') becomes isError with text {"code":"NOT_FOUND","message":"no pool","retryable":false};
  //  a thrown Error containing a configured secret becomes INTERNAL / 'Internal error';
  //  one log line is written with tool, chain, durationMs, upstreamRequests and outcome;
  //  two overlapping runTool calls each report only their own upstream request count;
  //  fn receives an AbortSignal that is not aborted.

  // math.test.ts
  const Q96 = 2n ** 96n;
  expect(sqrtPriceX96ToPrices(Q96, 18, 18)).toEqual({ price0In1: '1', price1In0: '1' });
  expect(sqrtPriceX96ToPrices(2n * Q96, 18, 18)).toEqual({ price0In1: '4', price1In0: '0.25' });
  expect(sqrtPriceX96ToPrices(Q96, 6, 18).price0In1).toBe('0.000000000001');

  // pool-state.test.ts (ethereum, pool USDC/WETH 0.05% = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640)
  //  by pool address: token0.symbol 'USDC', token1.symbol 'WETH', feeTier 500, tickSpacing 10;
  //    sqrtPriceX96, tick, liquidity, reserves equal the values in test/fixtures/pool-state.ethereum.json (from cast at PINNED);
  //    blockNumber === String(PINNED.ethereum).
  //  by tokenA/tokenB/feeTier in either token order: resolves to the same pool.
  //  feeTier 100 for a pair with no such pool → NOT_FOUND.
  //  pool = WETH token address → INVALID_INPUT.
  //  both pool and tokenA given, or tokenA without feeTier → INVALID_INPUT.
  //  describe.each(CHAIN_IDS): positionManager.factory() and quoterV2.factory() equal UNISWAP_V3[chain].factory;
  //    the wrapped-native/USDC 0.05% pool resolves and returns liquidity > 0.
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/tools test/unit/protocols/uniswap test/chain/pool-state.test.ts` — fails: modules not found.
- [ ] **Step 3: Implement.** `readPoolState` does one multicall (`slot0`, `liquidity`, `token0`, `token1`, `fee`, `tickSpacing`, `factory`) and treats any failure or a factory mismatch as `INVALID_INPUT` ("not a Uniswap v3 pool"); then `readTokens` and `readBalances` for the pool address. `resolvePool` calls `factory.getPool`; the zero address is `NOT_FOUND`. Pool immutables cached `forever`.
- [ ] **Step 4: Record and run.** Derive expected values with `cast call` at `PINNED.ethereum`, save them with the commands in `test/fixtures/pool-state.ethereum.json`. `RECORD=1 pnpm test:fork -- test/chain/pool-state.test.ts` passes; then `pnpm test` passes from recordings.
- [ ] **Step 5: Commit** `feat: add tool envelope and get_pool_state`

---

### Task 0.5: Server and stdio transport

**Files:**
- Create: `src/server.ts`, `src/transports/stdio.ts`, `src/index.ts`, `test/helpers/mcp-client.ts`
- Test: `test/e2e/protocol.stdio.test.ts`

**Interfaces:**
- Consumes: `register` from `get-pool-state.ts`, `loadConfig`, `createContext`.
- Produces: `buildServer(ctx: AppContext): McpServer`; `startStdio(ctx): Promise<void>`; test helper `connectStdio(env: Record<string, string>): Promise<{ client: Client; stderr(): string; rawStdout(): string[]; close(): Promise<void> }>` which spawns `node dist/index.js`.

- [ ] **Step 1: Write the failing test.** Server env: `RPC_URL_ETHEREUM` = a `chainEndpoint('ethereum', 'e2e-pool-state')` URL.
  ```ts
  it('lists get_pool_state with schemas and read-only annotation', …);
  //  tools/list contains name 'get_pool_state', non-empty description, inputSchema.type 'object',
  //  outputSchema defined, annotations.readOnlyHint === true.
  it('returns structured content that satisfies the advertised outputSchema', …);
  //  call with the USDC/WETH pool; validate structuredContent with a JSON Schema validator against tools/list outputSchema.
  it('returns a tool error, not a protocol error, for invalid input', …); // { chain: 'ethereum', pool: '0x1234' } → isError true
  it('reports CHAIN_NOT_CONFIGURED for a chain with no RPC', …); // chain 'base'
  it('writes only JSON-RPC frames to stdout', …); // every rawStdout() line parses and has jsonrpc === '2.0'
  it('exits non-zero with a message naming the variable on bad config', …); // empty env → stderr matches /RPC_URL_/
  ```
- [ ] **Step 2: Run** `pnpm build && pnpm vitest run test/e2e/protocol.stdio.test.ts` — fails: `dist/index.js` missing.
- [ ] **Step 3: Implement.** `index.ts`: `loadConfig(process.env)` → on `ConfigError` print the message to stderr and exit 1 → `createContext` → start the transport named by `config.transport`. Server name `defi-lens-mcp`, version read from `package.json`.
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `feat: add MCP server and stdio transport`

---

### Task 0.6: HTTP transport with bearer authentication

**Files:**
- Create: `src/transports/http.ts`
- Modify: `test/helpers/mcp-client.ts` (add `connectHttp(url: string, token?: string)`)
- Test: `test/unit/transports/auth.test.ts`, `test/e2e/protocol.http.test.ts`

**Interfaces:**
- Consumes: `buildServer`, `Config.authTokens`, `Config.host`, `Config.port`.
- Produces:
  ```ts
  export function bearerAuth(tokens: string[]): express.RequestHandler;
  export function createHttpApp(ctx: AppContext): express.Express;
  export function startHttp(ctx: AppContext): Promise<{ port: number; close(): Promise<void> }>;
  ```

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // auth.test.ts — bearerAuth(['T32a','T32b'])
  //  no Authorization header → 401, header 'WWW-Authenticate: Bearer', body { error: 'unauthorized' };
  //  'Bearer wrong' → 401 with the identical body; 'Basic …' → 401;
  //  'Bearer T32b' → next() called.
  // protocol.http.test.ts — startHttp on port 0
  it('serves /healthz without auth', …);            // 200 { status: 'ok' }, body has no chain or config data
  it('rejects /mcp without a token', …);            // 401
  it('rejects /mcp with a wrong token', …);         // 401
  it('lists and calls tools with a valid token', …); // same assertions as the stdio test for list + one call
  it('answers GET and DELETE /mcp with 405', …);
  it('rejects a body over 1 MB', …);                // 413
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/transports test/e2e/protocol.http.test.ts` — fails: module not found.
- [ ] **Step 3: Implement.** Build on the SDK's `createMcpExpressApp` (DNS-rebinding protection on, JSON body limit 1 MB). Stateless: a new `McpServer` and transport per `POST /mcp` request, no session id. `bearerAuth` compares SHA-256 digests with `crypto.timingSafeEqual`. `/healthz` is mounted before the auth middleware.
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `feat: add Streamable HTTP transport with bearer authentication`

---

### Task 0.7: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow.** Triggers: `pull_request`, `push` to `main`. One job on `ubuntu-latest`, Node 22, pnpm with cache: `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm build` → `pnpm coverage` → `pnpm audit --prod --audit-level high`. No secrets referenced. `permissions: contents: read`.
- [ ] **Step 2: Verify.** Push the branch and open the phase pull request; the run is green and its log shows the chain tests executing in replay mode (not skipped) and the coverage summary at or above 80/80.
- [ ] **Step 3: Commit** `ci: add lint, typecheck, test, coverage and audit workflow`

---

### Task 0.8: Provider spike

Time-boxed to one day. Throwaway scripts are not committed; the report is.

**Files:**
- Create: `docs/spikes/provider-capabilities.md`

- [ ] **Step 1: Answer each question with evidence** (the exact request, the response or error text, the date), for each of the four chains where it applies:

  | # | Question | Decision it feeds |
  |---|----------|-------------------|
  | Q1 | Does the Alchemy free tier serve `eth_simulateV1`? | Whether the `rpc` backend is usable by default |
  | Q2 | Does the installed anvil serve `eth_simulateV1` in fork mode? Which version? | Whether phase 6 chain tests can run on the harness or need recordings from the real provider |
  | Q3 | Does viem `simulateCalls` with `traceAssetChanges` and `traceTransfers` work against Q1 and Q2, including at a historical `blockNumber`? | Phase 6 backend design, the `blockNumber` input |
  | Q4 | Is `debug_traceCall` available on the free tier? | Whether to add the intermediate fallback tier |
  | Q5 | Tenderly simulation API: endpoint, auth header, request and response shape for a swap, quotas on the owner's plan. Save one redacted response. | Phase 6 Tenderly backend and its fixture |
  | Q6 | `eth_getLogs` on the free tier: maximum block range, maximum results, exact error text when exceeded, request rate limits | Defaults for `LOGS_MAX_BLOCK_RANGE` / `LOGS_MAX_REQUESTS`, the range-halving logic in phase 5 |
  | Q7 | Can the free tier serve state at `PINNED` and at blocks 100 000 older? How long does a cold anvil fork test run take? | Pinning policy, whether a paid tier is needed |
  | Q8 | Are `alchemy_getTokenBalances` and `alchemy_getAssetTransfers` available on all four chains on the free tier? Pagination shape and page size | Phases 1 and 5 indexer code |
  | Q9 | Sourcify contract-ABI endpoint and a 4-byte signature lookup endpoint: URLs, response shapes, proxy handling | Phase 6 ABI resolution |

- [ ] **Step 2: Write the report**: one section per question with the evidence, then a **Decisions** section listing each default or design detail it settles and each change needed in the phase 5 and phase 6 plan files.
- [ ] **Step 3: Apply the decisions** to `docs/plan/phase-5-large-movements.md`, `docs/plan/phase-6-simulation.md` and the `.env.example` defaults.
- [ ] **Step 4: Commit** `docs: add provider capability spike report`

---

### Task 0.9: Phase gate

**Files:**
- Create: `docs/validation/phase-0.md`

- [ ] **Step 1: Run the gate steps** from the development plan's Phase Gate section.
- [ ] **Step 2: Manual validation checklist** (record each row in the validation document):

  | # | Check | Reference |
  |---|-------|-----------|
  | 1 | `get_pool_state` price for USDC/WETH 0.05% on each of the four chains, called live (not on a fork) | Uniswap app pool page, ±0.5% |
  | 2 | `reserves` of the Ethereum pool | Token balances of the pool address on a block explorer at the response block |
  | 3 | stdio demonstration: list tools and call `get_pool_state` from MCP Inspector | Transcript saved |
  | 4 | HTTP demonstration: 401 without token, success with token, using `curl` and MCP Inspector | Transcript saved |
  | 5 | Server started over stdio with a key in `RPC_URL_ETHEREUM`, RPC made to fail (bad host): the key does not appear in the tool error or in stderr | Captured output |
  | 6 | Spike report answers Q1–Q9 with evidence and lists the decisions | `docs/spikes/provider-capabilities.md` |

- [ ] **Step 3: Commit** `docs: add phase 0 validation record`
- [ ] **Step 4: Owner review and sign-off.** Merge the pull request after approval.
