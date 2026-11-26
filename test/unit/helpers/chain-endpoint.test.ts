import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chainEndpoint, hasRecording, hasRpc } from '../../helpers/chain-endpoint.js';

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
