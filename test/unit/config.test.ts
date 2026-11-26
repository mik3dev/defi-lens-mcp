import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const T32A = 'a'.repeat(32);
const T32B = 'b'.repeat(32);
const base = { RPC_URL_ETHEREUM: 'https://rpc.example' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      transport: 'stdio',
      host: '127.0.0.1',
      port: 3000,
      simulationBackend: 'rpc',
      rateLimitRpm: 60,
      logLevel: 'info',
      logsMaxBlockRange: 10,
      logsMaxRequests: 30,
      authTokens: [],
      rpcUrls: { ethereum: 'https://rpc.example' },
    });
    expect(c.cacheTtlSeconds).toBeUndefined();
    expect(c.tenderly).toBeUndefined();
  });

  it('derives RPC URLs from the Alchemy key', () => {
    expect(loadConfig({ ALCHEMY_API_KEY: 'k' }).rpcUrls).toEqual({
      ethereum: 'https://eth-mainnet.g.alchemy.com/v2/k',
      base: 'https://base-mainnet.g.alchemy.com/v2/k',
      arbitrum: 'https://arb-mainnet.g.alchemy.com/v2/k',
      polygon: 'https://polygon-mainnet.g.alchemy.com/v2/k',
    });
  });

  it('lets an explicit RPC URL override the derived one', () => {
    const c = loadConfig({ ALCHEMY_API_KEY: 'k', RPC_URL_BASE: 'https://base.example' });
    expect(c.rpcUrls.base).toBe('https://base.example');
    expect(c.rpcUrls.ethereum).toBe('https://eth-mainnet.g.alchemy.com/v2/k');
  });

  it('treats empty strings as unset', () => {
    const c = loadConfig({ ...base, ALCHEMY_API_KEY: '', PORT: '', CACHE_TTL_SECONDS: '' });
    expect(c.alchemyApiKey).toBeUndefined();
    expect(c.port).toBe(3000);
    expect(Object.keys(c.rpcUrls)).toEqual(['ethereum']);
  });

  it('fails when no chain is enabled', () => {
    expect(() => loadConfig({})).toThrow(/RPC_URL_/);
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('fails in http mode without tokens', () => {
    expect(() => loadConfig({ TRANSPORT: 'http', ALCHEMY_API_KEY: 'k' })).toThrow(
      /MCP_AUTH_TOKENS/,
    );
  });

  it('rejects auth tokens shorter than 32 characters', () => {
    expect(() => loadConfig({ ...base, MCP_AUTH_TOKENS: 'short' })).toThrow(/MCP_AUTH_TOKENS/);
  });

  it('parses a token list', () => {
    const c = loadConfig({ ...base, MCP_AUTH_TOKENS: `${T32A}, ${T32B} ,` });
    expect(c.authTokens).toEqual([T32A, T32B]);
  });

  it('accepts http mode with tokens', () => {
    const c = loadConfig({ ...base, TRANSPORT: 'http', MCP_AUTH_TOKENS: T32A });
    expect(c.transport).toBe('http');
  });

  it('fails for tenderly backend without credentials', () => {
    expect(() => loadConfig({ ...base, SIMULATION_BACKEND: 'tenderly' })).toThrow(/TENDERLY_/);
  });

  it('builds tenderly config when complete', () => {
    const c = loadConfig({
      ...base,
      SIMULATION_BACKEND: 'tenderly',
      TENDERLY_ACCOUNT: 'acc',
      TENDERLY_PROJECT: 'proj',
      TENDERLY_ACCESS_KEY: 'tkey',
    });
    expect(c.tenderly).toEqual({ account: 'acc', project: 'proj', accessKey: 'tkey' });
  });

  it('fails on a non-numeric PORT', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('fails on an out-of-range PORT', () => {
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });

  it('fails on an invalid enum value', () => {
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ ...base, TRANSPORT: 'ws' })).toThrow(/TRANSPORT/);
  });

  it('parses numeric options', () => {
    const c = loadConfig({
      ...base,
      CACHE_TTL_SECONDS: '5',
      RATE_LIMIT_RPM: '10',
      LOGS_MAX_BLOCK_RANGE: '2000',
      LOGS_MAX_REQUESTS: '7',
    });
    expect(c).toMatchObject({
      cacheTtlSeconds: 5,
      rateLimitRpm: 10,
      logsMaxBlockRange: 2000,
      logsMaxRequests: 7,
    });
  });

  it('never includes variable values in error messages', () => {
    const secret = 'sekret-value';
    try {
      loadConfig({ ...base, PORT: secret });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain(secret);
    }
    try {
      loadConfig({ ...base, MCP_AUTH_TOKENS: secret });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('collects secrets', () => {
    const c = loadConfig({
      ALCHEMY_API_KEY: 'alchemy-key',
      RPC_URL_BASE: 'https://base.example/key123',
      MCP_AUTH_TOKENS: `${T32A},${T32B}`,
      SIMULATION_BACKEND: 'tenderly',
      TENDERLY_ACCOUNT: 'acc',
      TENDERLY_PROJECT: 'proj',
      TENDERLY_ACCESS_KEY: 'tender-key',
      ETHERSCAN_API_KEY: 'scan-key',
    });
    expect(c.secrets).toEqual(
      expect.arrayContaining([
        'alchemy-key',
        T32A,
        T32B,
        'tender-key',
        'scan-key',
        'https://base.example/key123',
        'https://eth-mainnet.g.alchemy.com/v2/alchemy-key',
      ]),
    );
    expect(new Set(c.secrets).size).toBe(c.secrets.length);
  });
});
