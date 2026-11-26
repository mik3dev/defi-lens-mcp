# Phase 8 — Documentation and Release

Part of the [development plan](../development-plan.md). Spec: [design.md](../design.md) §3 (Distribution), §8 (trust model), §10.

**Outcome:** someone who has never seen the project can install it from npm or run the container, connect a client, and understand what each tool returns and what it does not. Version 0.1.0 is published.

**Depends on:** phase 7 signed off.

**Owner actions before starting:** npm access token added as the `NPM_TOKEN` repository secret; npm package name `defi-lens-mcp` confirmed available (otherwise choose a scoped name and tell the builder).

**Branch:** `phase-8-release`

---

### Task 8.1: README and tool reference

**Files:**
- Create: `README.md`, `docs/tools.md`, `CHANGELOG.md`
- Test: `test/unit/docs.test.ts`

**Interfaces:**
- Consumes: `buildServer` (to list registered tools), the config schema's variable names.

**README sections, in this order:**
1. What it is, in two sentences, and the seven tools in a table (name, what it answers).
2. **Read-only by design:** never holds keys, never signs, never sends; transactions are only simulated.
3. Quick start: stdio with `npx`, with one Alchemy key.
4. Client setup: Claude Desktop, Cursor, Claude Code — one copy-paste block each.
5. Running as a service: HTTP mode, bearer tokens, rate limit, TLS in front, Docker command.
6. Configuration table: every environment variable, default, and what it does.
7. What the answers mean: the response envelope, block pinning, amounts, USD and `null`, warnings.
8. Limits and honesty notes: supported chains and protocols; indexer used for discovery; free-tier log windows; single-path quotes; simulation caveats; what is disclosed to third parties.
9. Development: commands, the chain-test replay harness, how to re-record.
10. License (MIT) and link to `SECURITY.md`.

**`docs/tools.md`:** one section per tool with a heading equal to the tool name: purpose, input fields with types and defaults, output fields, error codes it can return, warnings it can emit, one real request/response example taken from the recorded fixtures, and its known limits.

- [ ] **Step 1: Write the failing test.**
  ```ts
  it('documents every registered tool in the README table and in docs/tools.md', …); // each tool name is a table cell in README.md and a heading in docs/tools.md
  it('documents no tool that is not registered', …);
  it('documents every environment variable in the README and .env.example', …);      // names taken from the config schema
  it('documents every error code', …);                                              // each ErrorCode appears in docs/tools.md
  it('every relative link in README.md and docs/*.md resolves to a file', …);
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/unit/docs.test.ts` — fails: `README.md` not found.
- [ ] **Step 3: Write** `README.md`, `docs/tools.md` and `CHANGELOG.md` (Keep a Changelog format, one `0.1.0` entry listing the seven tools, both transports, both simulation backends).
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `docs: add README, tool reference and changelog`

---

### Task 8.2: npm package

**Files:**
- Modify: `package.json`, `src/index.ts` (shebang `#!/usr/bin/env node`)
- Test: `test/e2e/package.test.ts`

**`package.json` fields:** `"bin": { "defi-lens-mcp": "dist/index.js" }`, `"files": ["dist", "README.md", "LICENSE"]`, `"prepack": "pnpm build"`, `description`, `keywords`, `repository`, `homepage`, `bugs`, `"version": "0.1.0"`, `"publishConfig": { "access": "public", "provenance": true }`.

- [ ] **Step 1: Write the failing test.**
  ```ts
  it('packs only the built output and docs', …); // `npm pack --dry-run --json`: every path is under dist/ or is README.md, LICENSE, package.json; no test/, src/, .env, docs/, fixtures
  it('the packed tarball runs as a CLI', …);     // pack to a temp dir, `npm install` the tarball there, spawn `npx defi-lens-mcp` with a replay RPC URL, connect over stdio, tools/list returns seven tools
  it('prints a configuration error and exits 1 with no environment', …);
  ```
- [ ] **Step 2: Run** `pnpm vitest run test/e2e/package.test.ts` — fails: no `bin` entry.
- [ ] **Step 3: Implement** the `package.json` fields and the shebang; make sure the build keeps the file executable.
- [ ] **Step 4: Run** the same command — all pass.
- [ ] **Step 5: Commit** `chore: prepare npm package`

---

### Task 8.3: Container image

**Files:**
- Create: `Dockerfile`, `.dockerignore`

**Image requirements:** multi-stage build on the Node 22 slim/alpine image; final stage contains production dependencies and `dist/` only; runs as a non-root user; `ENV TRANSPORT=http HOST=0.0.0.0 PORT=3000`; `EXPOSE 3000`; `HEALTHCHECK` against `/healthz`; no secrets baked in.

- [ ] **Step 1: Write the Dockerfile and `.dockerignore`** (`node_modules`, `.env`, `test`, `docs`, `coverage`, `.git`).
- [ ] **Step 2: Verify.** Run each command and confirm the stated result:
  ```bash
  docker build -t defi-lens-mcp:dev .                      # builds
  docker run --rm defi-lens-mcp:dev id -u                  # prints a non-zero uid
  docker run --rm defi-lens-mcp:dev                        # exits 1, message names RPC_URL_ / MCP_AUTH_TOKENS
  docker run -d --name dl -p 3000:3000 --env-file .env -e MCP_AUTH_TOKENS=<32+ chars> defi-lens-mcp:dev
  curl -s localhost:3000/healthz                           # {"status":"ok"}
  curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/mcp   # 401
  docker inspect --format '{{.State.Health.Status}}' dl    # healthy
  docker history --no-trunc defi-lens-mcp:dev | grep -ci alchemy      # 0
  ```
  Then connect MCP Inspector to `http://localhost:3000/mcp` with the token and call one tool.
- [ ] **Step 3: Commit** `chore: add container image`

---

### Task 8.4: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `README.md` (install commands use the published names)

**Workflow:** triggered by a tag `v*.*.*`. Job 1 repeats the CI checks. Job 2 (needs job 1): verifies the tag equals `package.json` version, then `npm publish` with provenance using `NPM_TOKEN` (`permissions: id-token: write, contents: read`). Job 3 (needs job 1): builds the image and pushes `ghcr.io/<owner>/defi-lens-mcp:<version>` and `:latest` using `GITHUB_TOKEN` (`permissions: packages: write`). Job 4: creates the GitHub release with the changelog entry as notes.

- [ ] **Step 1: Write the workflow.**
- [ ] **Step 2: Verify without publishing.** Lint the workflow file with a workflow linter; run the tag/version check script locally with a matching and a mismatching tag (exit 0 and exit 1); run `npm publish --dry-run`.
- [ ] **Step 3: Commit** `ci: add release workflow`

---

### Task 8.5: Phase gate and release

**Files:**
- Create: `docs/validation/phase-8.md`

- [ ] **Step 1: Run the gate steps** from the development plan.
- [ ] **Step 2: Clean-machine validation.** On a machine or container with only Node 22 and no clone of the repository, following **only the README**:

  | # | Check | Expected |
  |---|-------|----------|
  | 1 | Install and run over stdio from the packed tarball (before publishing) with one Alchemy key | A desktop client lists seven tools |
  | 2 | Call each of the seven tools from that client with the examples in `docs/tools.md` | Each returns a result matching the documented shape |
  | 3 | Run the container in HTTP mode and connect with a bearer token | Tools listed; `401` without the token |
  | 4 | Every README command, copied verbatim | Works without edits other than inserting keys |
  | 5 | A reader new to the project explains, from the README alone, what the server can and cannot do and why it is safe to connect to a wallet-holding agent | Their summary matches the design's intent; gaps are fixed in the README |
  | 6 | End-to-end agent session: "Check this wallet's balances and Aave health, quote swapping 1 ETH to USDC, then simulate that approval and tell me if it is safe" | The agent completes it using the tools, citing block numbers and surfacing warnings and risk flags |

- [ ] **Step 3: Commit** `docs: add phase 8 validation record`
- [ ] **Step 4: Owner review and sign-off.** Merge the pull request.
- [ ] **Step 5: Release.** After the owner confirms: tag `v0.1.0` on `main` and push the tag. Publishing to npm and GHCR is public and cannot be undone, so the tag is pushed only on the owner's explicit go-ahead.
- [ ] **Step 6: Post-release check.** `npx defi-lens-mcp@0.1.0` on a clean machine lists seven tools; `docker pull ghcr.io/<owner>/defi-lens-mcp:0.1.0` runs and answers `/healthz`; the GitHub release shows the changelog. Record the three results in `docs/validation/phase-8.md`.
