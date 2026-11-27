import type { ChainId } from '../../src/chains.js';
import type { Config } from '../../src/config.js';
import { type AppContext, createClient, createContext } from '../../src/context.js';

const BASE_CONFIG: Config = {
  transport: 'stdio',
  rpcUrls: {},
  simulationBackend: 'rpc',
  host: '127.0.0.1',
  port: 3000,
  authTokens: [],
  rateLimitRpm: 60,
  logsMaxBlockRange: 10,
  logsMaxRequests: 30,
  logLevel: 'error',
  secrets: [],
};

export interface TestContextOptions {
  /** Indexer URLs per chain (usually the local harness endpoint); replace any Alchemy clients. */
  indexerUrls?: Partial<Record<ChainId, string>>;
}

/**
 * A real AppContext whose chains point at the given (usually local harness) RPC URLs. With
 * `indexerUrls`, the indexer clients point there too, so tests never reach the indexer directly.
 */
export function testContext(
  rpcUrls: Partial<Record<ChainId, string>>,
  overrides: Partial<Config> = {},
  opts: TestContextOptions = {},
): AppContext {
  const ctx = createContext({ ...BASE_CONFIG, rpcUrls, ...overrides });
  if (!opts.indexerUrls) return ctx;
  const entries = Object.entries(opts.indexerUrls) as [ChainId, string][];
  const indexerClients = Object.fromEntries(
    entries.map(([chain, url]) => [chain, createClient(chain, url)]),
  );
  return { ...ctx, indexerClients };
}
