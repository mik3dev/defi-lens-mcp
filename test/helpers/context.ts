import type { ChainId } from '../../src/chains.js';
import type { Config } from '../../src/config.js';
import { type AppContext, createContext } from '../../src/context.js';

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

/** A real AppContext whose chains point at the given (usually local harness) RPC URLs. */
export function testContext(
  rpcUrls: Partial<Record<ChainId, string>>,
  overrides: Partial<Config> = {},
): AppContext {
  return createContext({ ...BASE_CONFIG, rpcUrls, ...overrides });
}
