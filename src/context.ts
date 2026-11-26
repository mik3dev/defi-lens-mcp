import { AsyncLocalStorage } from 'node:async_hooks';
import { createPublicClient, http, type PublicClient } from 'viem';
import { alchemyUrl, CHAIN_IDS, CHAINS, type ChainId } from './chains.js';
import type { Config } from './config.js';
import { TtlCache } from './lib/cache.js';
import { createLogger, type Logger } from './lib/logger.js';

export interface AppContext {
  config: Config;
  clients: Partial<Record<ChainId, PublicClient>>;
  indexerClients: Partial<Record<ChainId, PublicClient>>; // empty without ALCHEMY_API_KEY
  cache: TtlCache;
  logger: Logger;
  fetch: typeof fetch; // injectable for contract tests
}

/** Per-tool-call scope; runTool opens it, the RPC transports count every HTTP request into it. */
export const requestScope = new AsyncLocalStorage<{ upstreamRequests: number }>();

const CACHE_MAX_ENTRIES = 10_000;
const RPC_RETRY_COUNT = 2;
const RPC_TIMEOUT_MS = 15_000;

function countUpstreamRequest(): void {
  const store = requestScope.getStore();
  if (store) store.upstreamRequests += 1;
}

function createClient(chain: ChainId, url: string): PublicClient {
  return createPublicClient({
    chain: CHAINS[chain].viemChain,
    // batch off: one JSON-RPC request per HTTP request, so requests are deterministic and replayable.
    transport: http(url, {
      batch: false,
      retryCount: RPC_RETRY_COUNT,
      timeout: RPC_TIMEOUT_MS,
      onFetchRequest: countUpstreamRequest,
    }),
  }) as PublicClient;
}

function clientsFor(urls: [ChainId, string][]): Partial<Record<ChainId, PublicClient>> {
  return Object.fromEntries(urls.map(([chain, url]) => [chain, createClient(chain, url)]));
}

export function createContext(config: Config): AppContext {
  const rpcUrls = Object.entries(config.rpcUrls) as [ChainId, string][];
  const { alchemyApiKey } = config;
  const indexerUrls: [ChainId, string][] = alchemyApiKey
    ? CHAIN_IDS.map((chain) => [chain, alchemyUrl(chain, alchemyApiKey)])
    : [];
  return {
    config,
    clients: clientsFor(rpcUrls),
    indexerClients: clientsFor(indexerUrls),
    cache: new TtlCache(CACHE_MAX_ENTRIES),
    logger: createLogger(config.logLevel, config.secrets),
    fetch: globalThis.fetch,
  };
}
