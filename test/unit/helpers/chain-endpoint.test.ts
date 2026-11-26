import { afterEach, describe, expect, it, vi } from 'vitest';
import { chainEndpoint, hasRecording, hasRpc } from '../../helpers/chain-endpoint.js';

afterEach(() => {
  vi.unstubAllEnvs();
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

  it('detects missing recordings', () => {
    expect(hasRecording('does-not-exist')).toBe(false);
  });

  it('fails in replay mode when the recording is missing', async () => {
    vi.stubEnv('CHAIN_MODE', '');
    await expect(chainEndpoint('ethereum', 'does-not-exist')).rejects.toThrow(
      /Record with: RECORD=1 pnpm test:fork/,
    );
  });
});
