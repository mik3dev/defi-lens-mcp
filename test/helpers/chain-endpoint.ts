import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHAIN_IDS, type ChainId } from '../../src/chains.js';
import { loadConfig } from '../../src/config.js';
import { PINNED } from '../fixtures/blocks.js';
import { startAnvil } from './anvil.js';
import { readRecording } from './rpc-recording.js';
import { type Endpoint, startProxyServer, startReplayServer } from './rpc-server.js';

const ROOT = new URL('../../', import.meta.url);
const ENV_FILE = fileURLToPath(new URL('.env', ROOT));

function isForkMode(): boolean {
  return process.env.CHAIN_MODE === 'fork';
}

/**
 * Vitest does not load .env; fork mode needs the upstream variables from it. Idempotent: variables
 * already in the environment win, so repeated loads change nothing.
 */
function loadDotEnv(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

/** Upstream RPC URL for `chain` by the loadConfig rules. Never log or record the result. */
function upstreamFor(chain: ChainId): string | undefined {
  try {
    return loadConfig(process.env).rpcUrls[chain];
  } catch {
    return undefined;
  }
}

export function recordingPath(fixture: string): string {
  return fileURLToPath(new URL(`test/fixtures/rpc/${fixture}.json`, ROOT));
}

export function hasRecording(fixture: string): boolean {
  return existsSync(recordingPath(fixture));
}

/** CHAIN_MODE=fork and an upstream RPC is configured. */
export function hasRpc(): boolean {
  if (!isForkMode()) return false;
  loadDotEnv();
  return CHAIN_IDS.some((chain) => upstreamFor(chain) !== undefined);
}

async function forkEndpoint(chain: ChainId, fixture: string): Promise<Endpoint> {
  loadDotEnv();
  const upstream = upstreamFor(chain);
  if (!upstream) {
    throw new Error(
      `No upstream RPC for ${chain}: set RPC_URL_${chain.toUpperCase()} or ALCHEMY_API_KEY`,
    );
  }
  const block = PINNED[chain];
  if (block === 0n) throw new Error(`PINNED.${chain} is not set in test/fixtures/blocks.ts`);
  // anvil forks from a local forwarder so the upstream URL never appears in argv or anvil output.
  const forwarder = await startProxyServer(upstream);
  const stack: Endpoint[] = [forwarder];
  try {
    const anvil = await startAnvil({ forkUrl: forwarder.rpcUrl, forkBlockNumber: block });
    stack.unshift(anvil);
    const recordTo = process.env.RECORD === '1' ? recordingPath(fixture) : undefined;
    const proxy = await startProxyServer(anvil.rpcUrl, { recordTo });
    stack.unshift(proxy);
    return { rpcUrl: proxy.rpcUrl, stop: () => stopAll(stack) };
  } catch (e) {
    await stopAll(stack);
    throw e;
  }
}

async function stopAll(endpoints: Endpoint[]): Promise<void> {
  const results = await Promise.allSettled(endpoints.map((e) => e.stop()));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * Local JSON-RPC URL for chain tests. Replay mode (default): answers from
 * test/fixtures/rpc/<fixture>.json. Fork mode (CHAIN_MODE=fork): anvil forked at PINNED[chain]
 * behind a proxy that, with RECORD=1, rewrites that fixture on stop().
 */
export async function chainEndpoint(chain: ChainId, fixture: string): Promise<Endpoint> {
  if (isForkMode()) return forkEndpoint(chain, fixture);
  return startReplayServer(await readRecording(recordingPath(fixture)));
}
