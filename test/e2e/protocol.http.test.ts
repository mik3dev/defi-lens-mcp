import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { startHttp } from '../../src/transports/http.js';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { testContext } from '../helpers/context.js';
import { connectHttp } from '../helpers/mcp-client.js';

const USDC_WETH_005: Address = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const POOL_FIXTURE = 'e2e-pool-state';
const TOKEN = 'e2e-token-0123456789';
const HTTP_OVERRIDES: Partial<Config> = {
  transport: 'http',
  host: '127.0.0.1',
  port: 0,
  authTokens: [TOKEN],
  secrets: [TOKEN],
};

describe('http protocol', () => {
  let http: Awaited<ReturnType<typeof startHttp>>;
  let endpoint: Awaited<ReturnType<typeof chainEndpoint>>;
  let base: string;

  beforeAll(async () => {
    endpoint = await chainEndpoint('ethereum', POOL_FIXTURE);
    const ctx = testContext({ ethereum: endpoint.rpcUrl }, HTTP_OVERRIDES);
    http = await startHttp(ctx);
    base = `http://127.0.0.1:${http.port}`;
  }, 120_000);

  afterAll(async () => {
    await http?.close();
    await endpoint?.stop();
  });

  it('serves /healthz without auth', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects /mcp without a token', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects /mcp with a wrong token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a client connecting without a token', async () => {
    await expect(connectHttp(`${base}/mcp`)).rejects.toThrow();
  });

  it('lists tools with a valid token', async () => {
    const client = await connectHttp(`${base}/mcp`, TOKEN);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'get_pool_state');
      expect(tools.map((t) => t.name)).toEqual(['get_pool_state', 'get_token_balances']);
      expect(tool?.outputSchema).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('calls a tool with a valid token', async () => {
    const client = await connectHttp(`${base}/mcp`, TOKEN);
    try {
      const result = await client.callTool({
        name: 'get_pool_state',
        arguments: { chain: 'ethereum', pool: USDC_WETH_005 },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('answers GET and DELETE /mcp with 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(405);
    }
  });

  it('rejects a body over 1 MB', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }),
    });
    expect(res.status).toBe(413);
  });
});
