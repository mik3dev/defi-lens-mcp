# Provider capability spike

Phase 0, task 0.8. All probes ran on **2026-11-26** against the Alchemy free tier (one key, four chains), the configured Tenderly project, Sourcify and public signature databases, with anvil 1.5.0-stable (commit `1c57854`) and viem 2.58.6. The scripts were throwaway and are not in the repository; the requests below are reproduced with secrets redacted.

Notation: `<ALCHEMY_URL:chain>` is `https://<sub>.g.alchemy.com/v2/<ALCHEMY_KEY>` with `<sub>` = `eth-mainnet`, `base-mainnet`, `arb-mainnet`, `polygon-mainnet`. Pinned blocks are those of `test/fixtures/blocks.ts`: ethereum `26499763`, base `62611111`, arbitrum `527782324`, polygon `98004500`. Test accounts: `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (sender), `0x…dEaD` (receiver).

The Tenderly response saved for phase 6 is [`tenderly-simulate-swap.json`](tenderly-simulate-swap.json).

## Summary

| # | Question | Answer |
|---|----------|--------|
| Q1 | Alchemy free tier serves `eth_simulateV1`? | **Yes**, on all four chains, at `latest` and at historical blocks, with `traceTransfers` |
| Q2 | anvil serves `eth_simulateV1` in fork mode? | **Yes** (1.5.0-stable), at the fork block and at locally mined blocks. Blocks **before** the fork block fail when state overrides are used, and viem's asset tracing always uses them |
| Q3 | viem `simulateCalls` with `traceAssetChanges` + `traceTransfers`, historical `blockNumber`? | **Yes** on Alchemy (all four chains, up to 100 000 blocks back). On anvil only at or after the fork block |
| Q4 | `debug_traceCall` on the free tier? | **No** (nor `trace_call`) on all four chains |
| Q5 | Tenderly simulation API | **Works**: endpoint, header and shapes recorded. Quotas could not be read from the API (see Q5) |
| Q6 | `eth_getLogs` limits | **10 blocks** per request on all four chains (inclusive count). No result cap was reached. A burst of 30 parallel requests was not throttled |
| Q7 | Historical state on the free tier; cold fork run time | **Yes**: archive state at `PINNED`, `PINNED − 100 000` and `PINNED − 1 000 000` on all four chains. A cold fork run passes in 36 s when test files run serially. With parallel files it hits HTTP 429 and fails |
| Q8 | `alchemy_getTokenBalances` / `alchemy_getAssetTransfers` on all four chains | **Yes**, both. `internal` transfers are not supported on Arbitrum |
| Q9 | Sourcify ABI and 4-byte endpoints | **Yes**: Sourcify v2 returns ABI and proxy resolution in one call. The signature database is at `api.4byte.sourcify.dev` |

---

## Q1 — `eth_simulateV1` on the Alchemy free tier

**Request** (each chain, `POST <ALCHEMY_URL:chain>`):

```json
{"jsonrpc":"2.0","id":1,"method":"eth_simulateV1","params":[
  {"blockStateCalls":[{"calls":[{"from":"0xd8dA…6045","to":"0x…dEaD","value":"0x1"}]}],
   "traceTransfers":true,"validation":false},
  "latest"]}
```

The same request was sent at block `PINNED − 100 000` (hex block number instead of `latest`).

**Responses** (HTTP 200 for every chain and block):

| Chain | `latest` | `PINNED − 100 000` | `calls[0]` |
|-------|----------|--------------------|------------|
| ethereum | ok | ok | `status 0x1`, `gasUsed 0x5208`, one log from `0xeeee…eeee` (`Transfer`, 3 topics): the native-transfer pseudo-log |
| base | ok | ok | same |
| arbitrum | ok | ok | same |
| polygon | ok | ok | same, plus a second log from `0x…1010` with 4 topics (topic0 `0xe6497e3e…`, Polygon's native `LogTransfer` event) |

**Error format for unsupported methods** (needed by `isSimulateUnsupported`). Alchemy does **not** use −32601. Trimmed responses:

```text
eth_doesNotExist (ethereum) → HTTP 400 {"code":-32600,"message":"Unsupported method: eth_doesNotExist on ETH_MAINNET"}
debug_traceCall (all chains) → HTTP 400 {"code":-32600,"message":"debug_traceCall is not available on the Free tier - upgrade to Pay As You Go, or Enterprise for access."}
```

Through viem these surface as `InvalidRequestRpcError` (code −32600), with cause `RpcRequestError` (HTTP 400). The provider text is in `details`.

## Q2 — anvil fork mode

anvil `1.5.0-stable`, forked from a local forwarder (the upstream URL never reaches argv), `--fork-block-number PINNED`, `--no-storage-caching` for a cold start.

| Probe (ethereum unless noted) | Result |
|-------------------------------|--------|
| anvil ready (cold) | 1 455 ms, after 43 upstream requests. Base: 1 327 ms |
| raw `eth_simulateV1` at `latest` with `traceTransfers` | ok, `status 0x1`, native pseudo-log present, 407 ms |
| raw `eth_simulateV1` at `PINNED − 10`, no state overrides | ok. anvil forwards it upstream: `eth_simulateV1` appears in the forwarder's log |
| viem `simulateCalls` + `traceAssetChanges` at `latest` (= `PINNED`) | ok, swap traced (see Q3), 2 909 ms cold |
| viem `simulateCalls` + `traceAssetChanges` at `blockNumber: PINNED − 10` | **error** `CallExecutionError`, details: `Evm override error: not available on past forked blocks` |
| viem, explicit `blockNumber: PINNED` (the fork block) | ok |
| after `anvil_mine ["0x5"]`: `blockNumber: PINNED + 2` and `blockNumber: PINNED` | both ok |
| base fork, viem ETH transfer with `traceAssetChanges` | ok |

Upstream method counts for the whole ethereum session (start plus 4 simulations): `eth_getAccountInfo 23, eth_getStorageAt 14, eth_getBalance 10, eth_getTransactionCount 10, eth_getCode 10, eth_simulateV1 3, eth_getBlockByNumber 1, eth_chainId 1, eth_gasPrice 1, eth_call 1`.

**Block numbering differs between backends.** For a simulation on top of base block N, Alchemy reports the simulated block as N + 1. anvil reports N when N is its latest block, and N + 1 for older blocks. viem's own source notes that "clients disagree on simulated numbering".

## Q3 — viem `simulateCalls` with asset and transfer tracing

Call: `simulateCalls(client, { account, calls, blockNumber?, traceAssetChanges: true, traceTransfers: true })`, `http(url, { batch: false })`.

Swap used: SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, `exactInputSingle(WETH → USDC, fee 500, recipient = sender, amountIn 0.1 ETH, min 0)` with `value = 0.1 ETH`.

| Target | Block | Result | JSON-RPC requests | Time |
|--------|-------|--------|-------------------|------|
| Alchemy ethereum | `latest` | success, gas 119 755. Changes: ETH −0.1, USDC +169.004672 | 6 | 1 382 ms |
| Alchemy ethereum | `PINNED − 10` | success, gas 119 771. ETH −0.1, USDC +170.113349 | 5 | 350 ms |
| Alchemy ethereum | `PINNED − 100 000` | success, gas 119 793. ETH −0.1, USDC +200.176539 | 5 | 351 ms |
| Alchemy base / arbitrum / polygon | `latest` and `PINNED − 100 000` (arbitrum, polygon) | ETH transfer: success, gas 21 000, one change of −1 wei | 5 | ≈ 1.3 s |
| anvil ethereum | `latest` = `PINNED` | success, gas 119 771. ETH −0.1, USDC +170.156848 | 6 | 2 909 ms (cold) |
| anvil ethereum | `PINNED − 10` | error: `Evm override error: not available on past forked blocks` | — | — |
| Alchemy ethereum, USDC `transfer` above balance | `PINNED` | `status 'failure'`, gas 36 085. `data` holds `Error("ERC20: transfer amount exceeds balance")`. Asset changes ETH 0, USDC 0 | 5 | — |

Observations:

- Logs for the swap: native pseudo-log (sender → router), USDC `Transfer`, native pseudo-log (router → WETH), WETH `Deposit`, WETH `Transfer`, pool `Swap`.
- The ETH change is exactly −0.1: with validation off the gas fee is not charged, so asset changes exclude gas.
- An omitted `blockNumber` costs one extra `eth_blockNumber` request (6 instead of 5).
- viem labels the native asset `ETH` on Polygon too, so the server must map `0xeeee…` to the chain's own native descriptor.
- Gas agrees across backends for the same state: 119 771 on Alchemy, anvil and Tenderly; 36 085 for the revert on Alchemy and Tenderly.

## Q4 — `debug_traceCall`

| Chain | `debug_traceCall` (`callTracer` and `prestateTracer` diff mode) | `trace_call` |
|-------|-------------------------------------------------------------|--------------|
| ethereum | HTTP 400 `{"code":-32600,"message":"debug_traceCall is not available on the Free tier - upgrade to Pay As You Go, or Enterprise for access."}` | HTTP 400 `trace_call is not available on the Free tier - upgrade to Pay As You Go, or Enterprise for access.` |
| base | same | same |
| arbitrum | same | HTTP 400 `trace_call is not available on the ARB_MAINNET. …` |
| polygon | first attempt HTTP 429 (compute units per second, see Q6); retried: same Free-tier error | same as ethereum |

## Q5 — Tenderly simulation API

**Endpoint:** `POST https://api.tenderly.co/api/v1/account/<TENDERLY_ACCOUNT>/project/<TENDERLY_PROJECT>/simulate`. **Auth header:** `X-Access-Key: <TENDERLY_ACCESS_KEY>`. Content type JSON.

**Request** (swap, the same transaction as Q3):

```json
{"network_id":"1","from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
 "to":"0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45","input":"0x04e45aaf…","value":"100000000000000000",
 "gas":500000,"gas_price":"0","block_number":26499762,
 "save":false,"save_if_fails":false,"simulation_type":"quick"}
```

Simulations sent (4 in total, plus one rejected credential check):

| # | Request | Result |
|---|---------|--------|
| 1 | swap, `simulation_type: "full"`, `block_number: PINNED` | HTTP 200, 1 964 ms, **5.0 MB** (4.8 MB of it is `contracts`, i.e. verified source code) |
| 2 | swap, `"quick"`, `block_number: 26499762` | HTTP 200, 587 ms, **65 KB**. Has `status`, `gas_used`, `transaction_info.logs[].raw`, `asset_changes`, `balance_diff` and `call_trace.output`; `contracts` empty. Saved, trimmed, as [`tenderly-simulate-swap.json`](tenderly-simulate-swap.json) |
| 3 | USDC `transfer` above balance, `"quick"`, `block_number: PINNED` | HTTP 200, `transaction.status: false`, `error_message: "ERC20: transfer amount exceeds balance"`, `gas_used 36085`. Revert bytes in `transaction.transaction_info.call_trace.output` (`0x08c379a0…`) |
| 4 | base (`network_id: "8453"`) ETH transfer of 1 wei, `"quick"`, `block_number: latest + 1` (`62622974`) | HTTP 200, `status true`, `gas_used 21000`, one `NativeCurrency` asset change. Without `gas_price: "0"`, `balance_diff` also shows the sender paying the fee and the OP fee vaults `0x4200…0019` / `0x4200…001A` receiving it |
| — | wrong access key | **HTTP 403** after **50 s**: `{"error":{"id":"…","slug":"insufficient_permissions","message":"Insufficient permissions"}}` |

**Response shape (fields the backend needs):**

- `transaction.status` (boolean) and `transaction.gas_used` (number). `simulation.block_number` and `transaction.block_number` give the block simulated in.
- `transaction.transaction_info.logs[]`: `{ name, inputs, raw: { address, topics[], data } }`. In quick mode `name` is empty and `inputs` is null; only `raw` is reliable.
- `transaction.transaction_info.asset_changes[]`: `{ token_info: { standard: "ERC20" | "NativeCurrency" | …, contract_address?, symbol, decimals }, type: "Transfer" | "Mint" | "Burn", from?, to?, raw_amount, … }`.
- `transaction.transaction_info.balance_diff[]`: `{ address, original, dirty, is_miner }`, native balance before and after, decimal strings.
- `transaction.error_message` and `transaction.transaction_info.call_trace.output` on revert.

**Block semantics (measured).** `block_number: B` with the default `transaction_index: 0` runs the transaction at the **start** of block B, on the state after B − 1. Tenderly's API reference says the same (`transaction_index` defaults to 0, "before its other transactions"). Evidence: the pool swapped in block 26499762 (log index 810). The quick swap at `block_number 26499762` received 170 156 845 USDC raw (`0x0a24632d`), the same as viem on Alchemy at `blockNumber 26499761`. Alchemy at `blockNumber 26499762` gave 170 156 848. So eth_simulateV1's "on top of N" equals Tenderly's `block_number N + 1`. Simulation #4 shows that `N + 1` is accepted when N is the head (a pending block).

**Quotas.** No `X-Tdly-Limit` / `X-Tdly-Remaining` / `X-Tdly-Reset-Timestamp` headers came back on any response, although the API reference documents them. The documented limits are 400 requests/minute per access key and a burst limit of 250/minute ([API reference](https://docs.tenderly.co/api-reference/simulator/simulate-transaction)). The monthly simulation quota of the account's plan is not exposed by this endpoint. Tenderly's [pricing page](https://tenderly.co/pricing) says the Free plan has "No API access", yet this key's API calls succeed, so the account has API access on whatever plan it is on. **Provisional:** treat the monthly quota as unknown and keep live Tenderly runs to about 20 simulations or fewer.

## Q6 — `eth_getLogs` limits

**Block range.** Request: `eth_getLogs [{ address: <USDC on chain>, topics: [Transfer], fromBlock, toBlock }]`, with `toBlock = PINNED`.

| Chain | 10 blocks (`to − 9 … to`) | 11 blocks |
|-------|---------------------------|-----------|
| ethereum | HTTP 200, 805 ms, 757 logs | HTTP 400 (text below) |
| base | HTTP 200, 450 ms, 62 logs | HTTP 400 |
| arbitrum | HTTP 200, 483 ms, 3 logs | HTTP 400 |
| polygon | HTTP 200, 478 ms, 141 logs | HTTP 400 |

Exact error (ethereum; other chains differ only in the suggested hex range):

```json
{"code":-32600,"message":"Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x1945aa9, 0x1945ab2]. Upgrade to PAYG for expanded block range."}
```

The limit counts blocks inclusively: `toBlock − fromBlock + 1 ≤ 10`. The suggested range keeps `fromBlock` and shortens `toBlock`. Through viem the error is `InvalidRequestRpcError` (code −32600), with cause `RpcRequestError` (HTTP 400) and the text in `details`.

**Result size.** No cap was hit. Unfiltered `eth_getLogs` over 10 blocks returned: ethereum 6 714 logs (4.6 MB, 881 ms), base 834 (0.6 MB), arbitrum 278 (0.2 MB), polygon 8 556 (6.8 MB, 1 315 ms).

**Request rate.** Ten sequential requests (10-block USDC windows, ethereum) took 2 370 ms: 756 ms for the first, ~160 ms each after that. A burst of 30 parallel requests finished in 893 ms with **30 OK and 0 throttled**. Throttling seen elsewhere in the spike:

```text
HTTP 429 {"code":429,"message":"Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message. If not, check out https://docs.alchemy.com/reference/throughput"}
```

This came from back-to-back `debug_traceCall` requests on Polygon. Through anvil, the forked RPC reported `Max retries exceeded HTTP error 429 with empty body` (see Q7).

**Window covered per tool call with defaults** (10 blocks × 30 requests = 300 blocks): ethereum ≈ 60 min, base ≈ 10 min, polygon ≈ 10 min, arbitrum ≈ 75 s.

## Q7 — Historical state and cold fork runs

**State at old blocks** (Alchemy, each chain): `eth_call` of USDC `totalSupply()`, plus `eth_getBalance` and `eth_getStorageAt(USDC, 0x0)`, at the given block.

| Chain | `PINNED` | `PINNED − 100 000` | `PINNED − 1 000 000` |
|-------|----------|--------------------|----------------------|
| ethereum | ok | ok (`26399763`) | ok (`25499763`) |
| base | ok | ok | ok |
| arbitrum | ok | ok | ok |
| polygon | ok | ok | ok |

All three methods answered at every block. An anvil fork at ethereum `PINNED − 100 000` (cold) was ready in 1 443 ms after 55 upstream requests, and `eth_call` returned the same total supply as the direct query.

**Cold fork test run** (`CHAIN_MODE=fork vitest run test/chain test/e2e`, 41 tests, `HOME` pointed at an empty directory so anvil's RPC cache `~/.foundry/cache/rpc` starts empty):

| Run | Wall time | Result |
|-----|-----------|--------|
| cold, parallel files (default), attempt 1 | 63 s | 5 tests failed: `anvil exited with code 1: Error: failed to create genesis` / `failed to fetch network chain ID` |
| cold, parallel files, attempt 2 | 75 s | 1 suite failed: `failed to get fork block` · `Max retries exceeded HTTP error 429 with empty body` |
| cold, `--no-file-parallelism` | **36 s** | 41/41 passed, no 429 |
| warm cache, parallel files | **20 s** | 41/41 passed |

Four cold forks starting at once (each sends 40–55 upstream requests) exceed the free tier's compute-units-per-second limit.

## Q8 — Alchemy indexer methods

**`alchemy_getTokenBalances`.** Request `[<address>, "erc20"]`, then `[<address>, "erc20", { pageKey }]` and `[<address>, "erc20", { maxCount: 5 }]`.

| Chain | Page 1 | Page 2 | `maxCount 5` |
|-------|--------|--------|--------------|
| ethereum | 100 tokens, `pageKey` | 100, `pageKey` | 5, `pageKey` |
| base | 100, `pageKey` | 99, `pageKey` | 5, `pageKey` |
| arbitrum | 99, `pageKey` | 100, `pageKey` | 5, `pageKey` |
| polygon | 93, `pageKey` | 97, `pageKey` | 5, `pageKey` |

The response is `{ address, tokenBalances: [{ contractAddress, tokenBalance: <32-byte hex> }], pageKey? }`. Pages hold **up to 100** entries and can be shorter while more pages follow. Entries **include zero balances**. On Polygon the list includes `0x0000000000000000000000000000000000001010`, the native POL token's ERC-20 interface.

**`alchemy_getAssetTransfers`.** Request:

```json
[{"fromBlock":"<PINNED − 1 000 000, hex>","toBlock":"<PINNED, hex>","toAddress":"<address>",
  "category":["external","erc20"],"order":"desc","excludeZeroValue":true,"withMetadata":false,"maxCount":"0x5"}]
```

| Chain | `["external","erc20"]` | `pageKey` page 2 | `["internal"]` |
|-------|------------------------|------------------|----------------|
| ethereum | 5 entries + `pageKey` | 5, older blocks (desc order kept) | ok (5) |
| base | 5 + `pageKey` | 5, older | ok (0 entries) |
| arbitrum | 1, no `pageKey` | — | HTTP 200 error `{"code":-32602,"message":"The 'internal' category is not supported for this network. Check the Alchemy documentation for supported networks."}` |
| polygon | 5 + `pageKey` | 3, older | ok (0) |

The response is `{ transfers: [...], pageKey? }`. Each entry, ethereum sample:

```json
{"blockNum":"0x19449db","uniqueId":"0x95fd…0781:log:617","hash":"0x95fd…0781","from":"0xd65a…8426","to":"0xd8da…6045",
 "value":1,"erc721TokenId":null,"erc1155Metadata":[],"tokenId":null,"asset":"HEX","category":"erc20",
 "rawContract":{"value":"0x5f5e100","address":"0x2b59…eb39","decimal":"0x8"},"metadata":null}
```

- A native entry has `category "external"`, `uniqueId "<hash>:external"` and `rawContract.address null`.
- `value` is a float (`1e-12` was seen), so only `rawContract.value` is exact.
- `erc1155Metadata` is `[]` or `null`.

Page size: with the default and `maxCount "0x3e8"`, 1 000 entries plus a `pageKey`. `maxCount "0x7d0"` was accepted and returned all 1 050 matching entries with no `pageKey`, which is undocumented behaviour.

## Q9 — ABI and signature endpoints

**Sourcify v2:** `GET https://sourcify.dev/server/v2/contract/{chainId}/{address}?fields=abi,proxyResolution`.

| Contract | Result |
|----------|--------|
| SwapRouter02, chain 1, `fields=abi` | 200, 629 ms. Keys `abi, matchId, creationMatch, runtimeMatch, verifiedAt, match, chainId, address`; `match: "match"`; 41 ABI entries |
| USDC proxy, chain 1, `fields=abi,proxyResolution` | 200. `abi` holds only the proxy's functions (`upgradeTo, upgradeToAndCall, implementation, changeAdmin, admin`). `proxyResolution: {"isProxy":true,"proxyType":"ZeppelinOSProxy","implementations":[{"address":"0x43506849D7C04F9138D1A2050bbF3A0c054402dd","name":"FiatTokenV2_2"}]}` |
| Aave v3 Pool, chain 1, `fields=proxyResolution` | 200. `proxyType "EIP1967Proxy"`, implementation `0x4295Fe69…2fCb` (`PoolInstance`), `match "exact_match"` |
| USDC proxy, chain 8453 | 200. `match "exact_match"`, `ZeppelinOSProxy`, implementation `0x2Ce6311d…D779` |
| An EOA, chain 1 | **404** `{"match":null,"creationMatch":null,"runtimeMatch":null,"chainId":"1","address":"0xd8dA…6045"}` |

USDC (Ethereum and Base) is a **ZeppelinOS** proxy: its implementation is not in the EIP-1967 slot. Sourcify's `proxyResolution` resolves both kinds.

**Signature databases** (`GET`, generic User-Agent):

| Endpoint | Result |
|----------|--------|
| `https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=0xa9059cbb,0x04e45aaf&filter=true` | 200, 454 ms: `{"ok":true,"result":{"function":{"0x04e45aaf":[{"name":"exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))","filtered":false,"hasVerifiedContract":true}],"0xa9059cbb":[{"name":"transfer(address,uint256)",…}]},"event":{}}}` |
| same, `function=0xdeadbeef` | 200: `[{"name":"CodeIsLawZ95677371()",…,"hasVerifiedContract":true}]`, a vanity collision |
| `https://api.openchain.xyz/signature-database/v1/lookup?function=0xa9059cbb&filter=true` | 200, same shape (legacy host, still answering) |
| `https://www.4byte.directory/api/v1/signatures/?hex_signature=0xa9059cbb` | 200: `{"count":6,"next":null,"results":[…]}`, newest first. The real `transfer(address,uint256)` is last; five junk collisions come before it |

---

## Decisions

### Simulation (phase 6)

1. **`rpc` stays the default backend** (`SIMULATION_BACKEND=rpc`). The Alchemy free tier serves `eth_simulateV1` with transfer tracing on all four chains, at historical blocks too. (Q1, Q3)
2. **No `debug_traceCall` tier.** It is not on the free tier (Q4). The fallback stays `eth_call` + `eth_estimateGas`. This settles the open item in design §5.7 and §13; the spec left it to the spike, so no spec change.
3. **`isSimulateUnsupported`** matches either:
   - JSON-RPC code −32601, or
   - code −32600 whose message or `details` matches `/Unsupported method|is not available on/i` (Alchemy's texts in Q1).

   It must not match the `eth_getLogs` range error, which also uses −32600; the text is the discriminator. (Q1)
4. **`SimTx.blockNumber = N` means "on top of block N"** (the state after N), as in `eth_simulateV1`.
   - The rpc backend always passes an explicit `blockNumber`: the request's, or else the pinned latest block. This saves a request and keeps replay deterministic.
   - `NormalizedSim.blockNumber` is that N, never the provider's simulated block number, which differs between Alchemy (N + 1) and anvil. (Q2, Q3)
5. **Tenderly backend request.**
   - `simulation_type: "quick"`: 65 KB against 5 MB for `full`, with every needed field. (Q5)
   - `gas_price: "0"`, `save: false`, `save_if_fails: false`.
   - `network_id` as a decimal string, `value` as a decimal string.
   - `block_number: N + 1` with the default `transaction_index` 0, which equals "on top of N" (measured; works when N is the head).
6. **Tenderly response mapping.**
   - `status` ← `transaction.status`; `gasUsed` ← `transaction.gas_used`.
   - Logs ← `transaction_info.logs[].raw`.
   - Native transfers ← `asset_changes` with `token_info.standard === "NativeCurrency"`.
   - `balanceDiffs` of `tx.from`: native from `balance_diff` (`dirty − original`), ERC-20 netted from `asset_changes` `raw_amount` by `from` / `to`.
   - On revert, `revertData` ← `transaction_info.call_trace.output`.
   - A wrong key returns **403** `insufficient_permissions`; Tenderly took 50 s to send it in the spike, past the 20 s timeout. (Q5)
7. **Asset changes exclude the gas fee on both backends.** viem runs with validation off; Tenderly gets `gas_price "0"`. This keeps the backends comparable and is stated in the tool description. (Q3, Q5)
8. **Native asset identity.** viem's `assetChanges` entry for `0xeeee…` is mapped to `NATIVE_ADDRESS` and the chain's native descriptor; viem's `ETH` label is wrong on Polygon. Polygon's `LogTransfer` log from `0x…1010` is not an ERC-20 `Transfer` and is ignored by topic. (Q1, Q3)
9. **Phase 6 chain tests run on the anvil harness.** anvil 1.5.0 serves `eth_simulateV1`, state overrides and viem asset tracing at the fork block and at locally mined blocks, but not with overrides at blocks before the fork block.
   - The "explicit historical block" chain test therefore calls `anvil_mine` and then simulates at `blockNumber: PINNED`.
   - Simulations at pre-fork blocks are covered by the live replay suite against the provider. (Q2)
10. **ABI resolution** (Q9):
    - Sourcify v2 `GET https://sourcify.dev/server/v2/contract/{chainId}/{address}?fields=abi,proxyResolution` (404 = not verified).
    - Proxies: use `proxyResolution.implementations[0].address` first; read the EIP-1967 slot only when Sourcify has no record. The EIP-1967 slot alone misses USDC, a ZeppelinOS proxy.
    - Signature database: `https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=<selector>&filter=true`.
    - A signature candidate is accepted only if decoding the calldata with it and re-encoding gives the same bytes. Collisions exist even for `0xdeadbeef`.
    - Both hosts are Sourcify's, so the outbound host list of design §8 is unchanged.
    - 4byte.directory is not used: it ranks junk collisions first.
11. **Replay transactions (phase 6.6) need no age constraint**: the free tier serves archive state far beyond 100 000 blocks on all four chains. The rpc backend simulates at `receipt.blockNumber − 1`, which Tenderly receives as `block_number = receipt.blockNumber`. (Q7)

### Logs and indexer (phase 5)

12. **`LOGS_MAX_BLOCK_RANGE` default 10** (no longer provisional): the measured free-tier limit, counted inclusively, on all four chains. (Q6)
13. **`LOGS_MAX_REQUESTS` default 30** (no longer provisional). A 30-request parallel burst was not throttled, and sequential requests take ~160 ms, so a full budget costs about 5 s of wall time. Coverage with defaults: ethereum ≈ 60 min, base and polygon ≈ 10 min, arbitrum ≈ 75 s. (Q6)
14. **`isLogRangeError`** matches code −32600 with a message or `details` matching `/block range/i`, which is Alchemy's text. It also matches the common texts of other providers:
    - `query returned more than \d+ results`
    - `exceed(s|ed)? (the )?max(imum)? block range`
    - `block range (is )?too (large|wide)`

    With the default range the Alchemy free tier never triggers it. The halving logic stays for other providers and lower limits. HTTP 429 maps to `RATE_LIMITED`, not to a range error. (Q6)
15. **`alchemy_getAssetTransfers`** (Q8):
    - `category: ["external","erc20"]` works on all four chains; `internal` must not be requested because Arbitrum rejects it.
    - Use the default page size (1 000), following `pageKey`.
    - Amounts come from `rawContract.value` (hex), never from the float `value`.
    - `rawContract.address === null` means native.
    - `uniqueId` is `<hash>:log:<n>` or `<hash>:external`.
    - Decimals come from on-chain `readTokens`, not from `rawContract.decimal`.
16. **`alchemy_getTokenBalances` notes for phase 1** (not edited here: outside this task's files):
    - Pages hold up to 100 entries and may be shorter while a `pageKey` follows.
    - Zero balances are returned and must be filtered.
    - On Polygon, `0x…1010` must be excluded so native POL is not counted twice. (Q8)

### Test harness

17. **Cold fork runs need serial test files.** Four cold anvil forks starting in parallel exceed the free tier's compute units per second (HTTP 429, failed runs); serially a cold run takes 36 s and passes; warm runs take 20 s. Proposed follow-up, outside this task's files: run `test:fork` with `--no-file-parallelism`, or give anvil `--compute-units-per-second` / `--retries` in `test/helpers/anvil.ts`. (Q7)
18. **No paid tier is needed** for phases 5 and 6. The free tier's only material limit is the 10-block log window, which the request budget and the honest `truncated` report already handle. (Q6, Q7)

### Plan and config changes applied

- `docs/plan/phase-5-large-movements.md`: decisions 12–15 (range error text, budget defaults, asset-transfer request and response shape).
- `docs/plan/phase-6-simulation.md`: decisions 2–11 (no trace tier, unsupported detection, block semantics, Tenderly request and mapping, gas exclusion, native identity, harness historical test, ABI endpoints and proxy rule, replay constraint).
- `.env.example`: log-setting comments no longer say provisional; the simulation backend comment states the measured support.

**Spec changes proposed:** none. Every decision fills a detail the spec left to the spike or to the plans; `docs/design.md` is unchanged.
