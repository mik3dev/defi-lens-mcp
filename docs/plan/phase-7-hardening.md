# Phase 7 — Hardening

Part of the [development plan](../development-plan.md). Spec: [design.md](../design.md) §6 (Upstream protection, Transports), §8.

**Outcome:** the HTTP service resists abuse, upstream providers are protected from the server, and the security properties the design claims are each pinned by a test and confirmed by a review.

**Depends on:** phase 6 signed off (all seven tools exist, so sweeps cover everything).

**Branch:** `phase-7-hardening`

---

### Task 7.1: HTTP rate limiting

**Files:**
- Modify: `src/transports/http.ts`, `package.json` (add `express-rate-limit`)
- Test: `test/e2e/protocol.http.test.ts`, `test/unit/transports/rate-limit.test.ts`

**Interfaces:**
- Consumes: `Config.rateLimitRpm`, `bearerAuth`.
- Produces: `tokenRateLimit(rpm: number): express.RequestHandler`; `authFailureLimit(): express.RequestHandler`.

**Rules:**
- Order on `/mcp`: `authFailureLimit` → `bearerAuth` → `tokenRateLimit` → handler.
- `tokenRateLimit`: fixed 60-second window, `rpm` requests per token, keyed by the SHA-256 of the token (the token itself is never used as a key or logged). Over budget → `429`, header `Retry-After` in seconds, body `{ "error": "rate_limited" }`.
- `authFailureLimit`: counts only requests that end in `401`, per client IP, 20 per minute → `429`. Slows token guessing.
- `/healthz` is not rate limited by token.
- Each token has its own budget; one token exhausting its budget does not affect another.

- [ ] **Step 1: Write the failing tests** (server started with `RATE_LIMIT_RPM=5`, two tokens).
  ```ts
  it('allows requests up to the budget and rejects the next', …); // 5 × 200, 6th → 429 with Retry-After between 1 and 60 and body { error: 'rate_limited' }
  it('keeps budgets separate per token', …);                       // token A exhausted, token B still 200
  it('restores the budget after the window', …);                   // fake timers +60 s → 200
  it('limits repeated authentication failures per IP', …);         // 20 × 401, 21st → 429; a valid token from the same IP is also 429 until the window passes
  it('does not count successful requests toward the auth-failure limit', …);
  it('never rate limits /healthz by token', …);
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/transports/rate-limit.test.ts test/e2e/protocol.http.test.ts` — fails: sixth request returns 200.
- [ ] **Step 3: Implement** with `express-rate-limit` (in-memory store).
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `feat: add per-token rate limiting and auth-failure throttling`

---

### Task 7.2: Upstream protection and tool timeouts

**Files:**
- Modify: `src/config.ts`, `src/context.ts`, `src/tools/shared.ts`, `.env.example`
- Test: `test/unit/config.test.ts`, `test/unit/tools/shared.test.ts`, `test/unit/upstream.test.ts`

**Interfaces:**
- Consumes: `createLimiter`, `toAppError`.
- Produces: `Config.toolTimeoutMs` (env `TOOL_TIMEOUT_MS`, default 30 000, range 1 000–120 000); `Config.maxUpstreamConcurrency` (env `MAX_UPSTREAM_CONCURRENCY`, default 8, range 1–64). `createContext` wraps every viem transport request and `ctx.fetch` in one shared limiter. `runTool` enforces the timeout.

**Rules:**
- One limiter per process, shared by all chains, the indexer clients and `ctx.fetch`.
- `runTool` races the handler against `toolTimeoutMs`; on timeout the result is `UPSTREAM_TIMEOUT`, retryable, message `The request took longer than <n> seconds.`, and an `AbortSignal` passed to the handler is aborted so in-flight work stops scheduling new requests.
- viem transports keep retry count 2 with backoff for 429 and 5xx (set in phase 0). After retries are exhausted the tool fails as a whole: no partial data is returned.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  // config: defaults 30000 and 8; TOOL_TIMEOUT_MS=500 → ConfigError naming the variable; MAX_UPSTREAM_CONCURRENCY=0 → ConfigError
  // upstream
  it('never exceeds maxUpstreamConcurrency across chains and fetch', …); // 20 concurrent requests over two clients and ctx.fetch, limit 3 → observed max 3
  // shared — runTool
  it('returns UPSTREAM_TIMEOUT when the handler outlives the timeout', …); // fake timers; retryable true; message has the seconds
  it('aborts the handler signal on timeout', …);
  // Review Focus 4 — a tool that issues three multicalls where the second answers HTTP 429 on every retry:
  it('fails as a whole on an upstream 429 mid-call', …);
  //  result isError with code 'UPSTREAM_ERROR', retryable true; structuredContent absent; no data from the first multicall in the text;
  //  the RPC URL (which contains a key) and the key itself do not appear in the result or in the log lines
  it('fails as a whole on an upstream timeout mid-call', …); // code 'UPSTREAM_TIMEOUT'
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/config.test.ts test/unit/tools/shared.test.ts test/unit/upstream.test.ts` — fails: config fields missing.
- [ ] **Step 3: Implement.** Handlers have received the `AbortSignal` since phase 0; `runTool` now aborts it on timeout, and each handler checks it between upstream steps (`signal.throwIfAborted()`).
- [ ] **Step 4: Run** `pnpm test` — all pass.
- [ ] **Step 5: Commit** `feat: add upstream concurrency limit and tool timeouts`

---

### Task 7.3: Security property sweep

One test file per property the design claims (§8), each running across all seven tools so a future tool cannot silently miss one.

**Files:**
- Test: `test/unit/security/schemas.test.ts`, `test/unit/security/secrets.test.ts`, `test/e2e/security.stdio.test.ts`, `test/e2e/security.http.test.ts`
- Modify: source files only where a test exposes a gap

- [ ] **Step 1: Write the tests.**
  ```ts
  // schemas — iterates tools/list of a built server
  it('lists exactly the seven tools', …); // get_token_balances, get_aave_positions, get_uniswap_positions, get_pool_state, get_swap_quote, get_large_movements, simulate_transaction
  it('no tool input has a key-like field', …);            // no property name matching /key|secret|mnemonic|seed|signature|private|password/i, at any depth
  it('every tool is annotated read-only', …);             // readOnlyHint true, destructiveHint not true
  it('every tool has an outputSchema with the envelope fields', …); // chain, blockNumber, blockTimestamp, data, warnings
  it('every numeric and array input has an upper bound', …);        // maximum / maxItems / maxLength present in the JSON Schema
  // secrets — context built with recognisable secrets: RPC URL key 'RPCSECRET', Alchemy key, auth token, Tenderly key, Etherscan key
  it('no secret appears in any tool error', …);  // for each tool: make its first upstream call fail with an error whose message embeds the URL → result text has no secret
  it('no secret appears in any log line', …);    // capture the logger stream across the same failures
  it('config errors never echo values', …);
  // e2e stdio
  it('stdout stays pure JSON-RPC while tools fail', …);  // call every tool against an unreachable RPC; every stdout line parses as JSON-RPC
  it('a hostile token symbol never reaches the client unsanitized', …); // replay fixture whose symbol() returns control characters and 200 characters → output symbol has no control characters, length ≤ 32
  // e2e http
  it('rejects a request whose Host header is not allowed', …); // DNS-rebinding protection → 403
  it('does not disclose the server stack', …);                 // no X-Powered-By header
  it('sends no CORS headers by default', …);
  it('binds to 127.0.0.1 unless HOST is set', …);
  ```
- [ ] **Step 2: Run** `pnpm build && pnpm vitest run test/unit/security test/e2e/security.stdio.test.ts test/e2e/security.http.test.ts`. Note every failing test; each is a real gap.
- [ ] **Step 3: Fix each gap** in the owning source file with the smallest change, re-running the failing test after each fix.
- [ ] **Step 4: Run** `pnpm test` — all pass.
- [ ] **Step 5: Commit** `test: pin security properties across all tools` (plus `fix:` commits for any gap closed)

---

### Task 7.4: Security review and CI scanning

**Files:**
- Create: `SECURITY.md`
- Modify: `.github/workflows/ci.yml` (secret-scanning job over the full history)

- [ ] **Step 1: Add secret scanning to CI** as a separate job using a maintained secret-scanning action over the full git history; no repository secrets required. Verify by pushing: the job is green, and a throwaway local branch with a fake key in a file makes the scanner fail (do not push that branch).
- [ ] **Step 2: Run a security review of the whole codebase** against this checklist, recording each item's result:

  | Area | What to confirm |
  |------|-----------------|
  | Key material | No code path, field or env variable for private keys or signatures |
  | Input validation | Every tool input validated by Zod; cross-field rules enforced in handlers; bounds on every limit |
  | Outbound requests | Only configured RPC URLs and the fixed hosts (Alchemy, Tenderly, Sourcify, Etherscan, signature database); no user-supplied URL or host is ever fetched; hex input cannot alter a URL |
  | Untrusted text | Token symbols, revert strings and decoded string arguments sanitized and length-capped before leaving the server |
  | Secrets | Redaction at the logger and in `toAppError`; recordings in `test/fixtures` contain no keys |
  | HTTP | Auth mandatory, constant-time comparison, rate limits, body limit, localhost default, DNS-rebinding protection, no CORS |
  | Resource use | Caps on tokens, positions, paths, logs, transfers; tool timeout; concurrency limit; cache size bound |
  | Dependencies | `pnpm audit --prod` clean at high severity; lockfile committed; no unused dependencies |
  | Supply chain | CI workflow permissions minimal; actions pinned to a version |

- [ ] **Step 3: Fix every critical and high finding**, each with a test that fails before the fix. List medium and low findings in the validation document with a decision for each.
- [ ] **Step 4: Write `SECURITY.md`**: how to report a vulnerability; the trust model (read-only, what is read from the chain, what comes from third parties, what is disclosed to them when simulating); the deployment guidance for HTTP (TLS in front, token length and rotation, localhost default).
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm coverage && pnpm build` — green.
- [ ] **Step 6: Commit** `docs: add security policy` and `ci: add secret scanning`

---

### Task 7.5: Phase gate

**Files:**
- Create: `docs/validation/phase-7.md`

- [ ] **Step 1: Run the gate steps** from the development plan.
- [ ] **Step 2: Manual validation checklist** (against a locally running HTTP server with real providers):

  | # | Check | Expected |
  |---|-------|----------|
  | 1 | Burst of 200 requests with a valid token and `RATE_LIMIT_RPM=60` | 60 succeed, the rest get `429` with `Retry-After`; server stays responsive; upstream request count stays bounded |
  | 2 | 50 requests with wrong tokens, then one with a valid token | `401` then `429`; nothing in the logs reveals a valid token |
  | 3 | 20 concurrent worst-case calls (two-hop quote, large-movement scan) on the free tier | No more than `MAX_UPSTREAM_CONCURRENCY` upstream requests in flight; calls either succeed or fail with a retryable error; no crash |
  | 4 | A tool call with the RPC unplugged mid-call | `UPSTREAM_ERROR` or `UPSTREAM_TIMEOUT` within the tool timeout, no partial data |
  | 5 | `grep` of a full session's stderr and of every recorded fixture for each configured secret | No match |
  | 6 | Request with a foreign `Host` header | `403` |
  | 7 | Security review table complete, critical and high findings closed | `docs/validation/phase-7.md` |

- [ ] **Step 3: Commit** `docs: add phase 7 validation record`
- [ ] **Step 4: Owner review and sign-off.**
