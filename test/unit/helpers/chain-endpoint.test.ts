import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chainEndpoint,
  hasRecording,
  hasRpc,
  MISSING_INDEXER_KEY,
  startForkProxy,
} from '../../helpers/chain-endpoint.js';
import { readRecording } from '../../helpers/rpc-recording.js';
import { type Endpoint, startRpcServer } from '../../helpers/rpc-server.js';

// Fork mode loads the repo .env; never let the real one into this worker's environment.
const loadEnvFile = vi.fn();
const initialEnvKeys = Object.keys(process.env).sort();
beforeEach(() => {
  vi.spyOn(process, 'loadEnvFile').mockImplementation(loadEnvFile);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('chain endpoint selection', () => {
  it('reports no RPC outside fork mode even when an upstream is configured', () => {
    vi.stubEnv('CHAIN_MODE', '');
    vi.stubEnv('RPC_URL_ETHEREUM', 'https://rpc.invalid');
    expect(hasRpc()).toBe(false);
  });

  it('reports an RPC in fork mode when an upstream is configured', () => {
    vi.stubEnv('CHAIN_MODE', 'fork');
    vi.stubEnv('RPC_URL_ETHEREUM', 'https://rpc.invalid');
    expect(hasRpc()).toBe(true);
  });

  it('never loads the real .env into the unit-test worker', () => {
    vi.stubEnv('CHAIN_MODE', 'fork');
    hasRpc();
    vi.unstubAllEnvs();
    expect(Object.keys(process.env).sort()).toEqual(initialEnvKeys);
  });

  it('detects missing recordings', () => {
    expect(hasRecording('does-not-exist')).toBe(false);
  });

  it('fails in replay mode when the recording is missing', async () => {
    vi.stubEnv('CHAIN_MODE', '');
    await expect(chainEndpoint('ethereum', 'does-not-exist')).rejects.toThrow(
      /Record with: RECORD=1 pnpm test:fork \(runs test files serially to stay under provider rate limits\)/,
    );
  });
});

async function post(url: string, method: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: ['0xab'] }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

/** A fake upstream that answers every request with its own name and remembers the methods it saw. */
async function fakeUpstream(name: string): Promise<Endpoint & { methods: string[] }> {
  const methods: string[] = [];
  const ep = await startRpcServer((req) => {
    methods.push(req.method);
    return { result: name };
  });
  return { ...ep, methods };
}

describe('fork proxy routing', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fork-proxy-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends alchemy_ methods to the indexer upstream and everything else to anvil', async () => {
    const anvil = await fakeUpstream('anvil');
    const indexer = await fakeUpstream('indexer');
    const file = join(dir, 'rec.json');
    const proxy = await startForkProxy(anvil.rpcUrl, indexer.rpcUrl, file);
    try {
      expect((await post(proxy.rpcUrl, 'eth_blockNumber')).result).toBe('anvil');
      expect((await post(proxy.rpcUrl, 'alchemy_getTokenBalances')).result).toBe('indexer');
      expect((await post(proxy.rpcUrl, 'eth_call')).result).toBe('anvil');
    } finally {
      await proxy.stop();
      await anvil.stop();
      await indexer.stop();
    }
    expect(anvil.methods).toEqual(['eth_blockNumber', 'eth_call']);
    expect(indexer.methods).toEqual(['alchemy_getTokenBalances']);
    const recorded = await readRecording(file);
    expect(recorded.map((e) => e.method).sort()).toEqual([
      'alchemy_getTokenBalances',
      'eth_blockNumber',
      'eth_call',
    ]);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('127.0.0.1');
  });

  it('fails alchemy_ methods with a clear message and no recording when no key is set', async () => {
    const anvil = await fakeUpstream('anvil');
    const file = join(dir, 'rec.json');
    const proxy = await startForkProxy(anvil.rpcUrl, undefined, file);
    let stopError: unknown;
    try {
      expect((await post(proxy.rpcUrl, 'eth_blockNumber')).result).toBe('anvil');
      const res = await post(proxy.rpcUrl, 'alchemy_getTokenBalances');
      expect(res).toMatchObject({ error: { message: MISSING_INDEXER_KEY } });
    } finally {
      stopError = await proxy.stop().catch((e: unknown) => e);
      await anvil.stop();
    }
    expect(stopError).toBeInstanceOf(Error);
    expect((stopError as Error).message).toBe(MISSING_INDEXER_KEY);
    expect(MISSING_INDEXER_KEY).toMatch(/ALCHEMY_API_KEY/);
    const recorded = await readRecording(file);
    expect(recorded.map((e) => e.method)).toEqual(['eth_blockNumber']);
  });

  it('does not fail on stop when no alchemy_ method was requested without a key', async () => {
    const anvil = await fakeUpstream('anvil');
    const proxy = await startForkProxy(anvil.rpcUrl, undefined);
    try {
      expect((await post(proxy.rpcUrl, 'eth_chainId')).result).toBe('anvil');
    } finally {
      await expect(proxy.stop()).resolves.toBeUndefined();
      await anvil.stop();
    }
  });
});
