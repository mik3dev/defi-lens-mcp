import { z } from 'zod/v4';
import { CHAIN_IDS, type ChainId } from './chains.js';

export interface Config {
  transport: 'stdio' | 'http';
  rpcUrls: Partial<Record<ChainId, string>>;
  alchemyApiKey?: string;
  simulationBackend: 'rpc' | 'tenderly';
  tenderly?: { account: string; project: string; accessKey: string };
  etherscanApiKey?: string;
  host: string;
  port: number;
  authTokens: string[];
  rateLimitRpm: number;
  cacheTtlSeconds?: number;
  logsMaxBlockRange: number;
  logsMaxRequests: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  secrets: string[]; // every value that must never appear in output
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const MIN_TOKEN_LENGTH = 32;

// Alchemy network subdomain per chain.
const ALCHEMY_SUBDOMAINS: Record<ChainId, string> = {
  ethereum: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arb-mainnet',
  polygon: 'polygon-mainnet',
};

const RPC_ENV: Record<ChainId, string> = {
  ethereum: 'RPC_URL_ETHEREUM',
  base: 'RPC_URL_BASE',
  arbitrum: 'RPC_URL_ARBITRUM',
  polygon: 'RPC_URL_POLYGON',
};

const text = z.string().min(1);
const integer = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));

const tokenList = z.string().transform((raw, ctx) => {
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.some((t) => t.length < MIN_TOKEN_LENGTH)) {
    ctx.addIssue({
      code: 'custom',
      message: `each token must be at least ${MIN_TOKEN_LENGTH} characters`,
    });
    return z.NEVER;
  }
  return tokens;
});

const envSchema = z.object({
  TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  RPC_URL_ETHEREUM: text.optional(),
  RPC_URL_BASE: text.optional(),
  RPC_URL_ARBITRUM: text.optional(),
  RPC_URL_POLYGON: text.optional(),
  ALCHEMY_API_KEY: text.optional(),
  SIMULATION_BACKEND: z.enum(['rpc', 'tenderly']).default('rpc'),
  TENDERLY_ACCOUNT: text.optional(),
  TENDERLY_PROJECT: text.optional(),
  TENDERLY_ACCESS_KEY: text.optional(),
  ETHERSCAN_API_KEY: text.optional(),
  HOST: text.default('127.0.0.1'),
  PORT: integer(1, 65535).default(3000),
  MCP_AUTH_TOKENS: tokenList.default([]),
  RATE_LIMIT_RPM: integer(1).default(60),
  CACHE_TTL_SECONDS: integer(1).optional(),
  LOGS_MAX_BLOCK_RANGE: integer(1).default(10),
  LOGS_MAX_REQUESTS: integer(1).default(30),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

type Env = z.output<typeof envSchema>;

function withoutEmpty(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => (entry[1] ?? '') !== ''),
  );
}

function parseEnv(env: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(withoutEmpty(env));
  if (result.success) return result.data;
  // Report variable names only; values can be secrets.
  const names = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? 'environment')))];
  throw new ConfigError(`Invalid configuration for: ${names.join(', ')}`);
}

function resolveRpcUrls(env: Env): Partial<Record<ChainId, string>> {
  const urls: Partial<Record<ChainId, string>> = {};
  for (const chain of CHAIN_IDS) {
    const explicit = env[RPC_ENV[chain] as keyof Env] as string | undefined;
    if (explicit) urls[chain] = explicit;
    else if (env.ALCHEMY_API_KEY) {
      urls[chain] = `https://${ALCHEMY_SUBDOMAINS[chain]}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`;
    }
  }
  return urls;
}

function resolveTenderly(env: Env): Config['tenderly'] {
  if (env.SIMULATION_BACKEND !== 'tenderly') return undefined;
  const {
    TENDERLY_ACCOUNT: account,
    TENDERLY_PROJECT: project,
    TENDERLY_ACCESS_KEY: accessKey,
  } = env;
  if (!account || !project || !accessKey) {
    throw new ConfigError(
      'SIMULATION_BACKEND=tenderly requires TENDERLY_ACCOUNT, TENDERLY_PROJECT and TENDERLY_ACCESS_KEY',
    );
  }
  return { account, project, accessKey };
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = parseEnv(env);
  const rpcUrls = resolveRpcUrls(parsed);
  if (Object.keys(rpcUrls).length === 0) {
    throw new ConfigError(
      'No chain enabled: set ALCHEMY_API_KEY or at least one RPC_URL_* variable',
    );
  }
  if (parsed.TRANSPORT === 'http' && parsed.MCP_AUTH_TOKENS.length === 0) {
    throw new ConfigError('MCP_AUTH_TOKENS is required when TRANSPORT=http');
  }
  const tenderly = resolveTenderly(parsed);
  const secrets = [
    parsed.ALCHEMY_API_KEY,
    ...parsed.MCP_AUTH_TOKENS,
    tenderly?.accessKey,
    parsed.ETHERSCAN_API_KEY,
    ...Object.values(rpcUrls),
  ].filter((s): s is string => Boolean(s));

  return {
    transport: parsed.TRANSPORT,
    rpcUrls,
    alchemyApiKey: parsed.ALCHEMY_API_KEY,
    simulationBackend: parsed.SIMULATION_BACKEND,
    tenderly,
    etherscanApiKey: parsed.ETHERSCAN_API_KEY,
    host: parsed.HOST,
    port: parsed.PORT,
    authTokens: parsed.MCP_AUTH_TOKENS,
    rateLimitRpm: parsed.RATE_LIMIT_RPM,
    cacheTtlSeconds: parsed.CACHE_TTL_SECONDS,
    logsMaxBlockRange: parsed.LOGS_MAX_BLOCK_RANGE,
    logsMaxRequests: parsed.LOGS_MAX_REQUESTS,
    logLevel: parsed.LOG_LEVEL,
    secrets: [...new Set(secrets)],
  };
}
