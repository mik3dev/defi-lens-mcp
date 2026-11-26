import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { connectStdio, runToExit, type StdioSession } from '../helpers/mcp-client.js';

const USDC_WETH_005: Address = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const POOL_FIXTURE = 'e2e-pool-state';
// Never contacted: the tests below fail before any RPC request is made.
const UNUSED_RPC_URL = 'http://127.0.0.1:9';

function parseToolError(result: { content: unknown }): { code: string; message: string } {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first?.text ?? '{}') as { code: string; message: string };
}

describe('stdio protocol (offline)', () => {
  let session: StdioSession;

  beforeAll(async () => {
    session = await connectStdio({ RPC_URL_ETHEREUM: UNUSED_RPC_URL });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
  });

  it('lists get_pool_state with schemas and read-only annotation', async () => {
    const { tools } = await session.client.listTools();
    const tool = tools.find((t) => t.name === 'get_pool_state');
    expect(tools.map((t) => t.name)).toEqual(['get_pool_state']);
    expect(tool?.description?.length).toBeGreaterThan(0);
    expect(tool?.inputSchema.type).toBe('object');
    expect(tool?.outputSchema).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('returns a tool error, not a protocol error, for invalid input', async () => {
    const result = await session.client.callTool({
      name: 'get_pool_state',
      arguments: { chain: 'ethereum', pool: '0x1234' },
    });
    expect(result.isError).toBe(true);
    // Rejected by the SDK's input validation before the handler (and any RPC) runs.
    const [first] = result.content as { type: string; text: string }[];
    expect(first?.text).toMatch(/invalid|validation/i);
  });

  it('reports CHAIN_NOT_CONFIGURED for a chain with no RPC', async () => {
    const result = await session.client.callTool({
      name: 'get_pool_state',
      arguments: { chain: 'base', pool: USDC_WETH_005 },
    });
    expect(result.isError).toBe(true);
    expect(parseToolError(result).code).toBe('CHAIN_NOT_CONFIGURED');
  });

  it('writes only JSON-RPC frames to stdout', () => {
    const lines = session.rawStdout();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0');
    }
  });
});

describe('stdio startup', () => {
  it('exits non-zero with a message naming the variable on bad config', async () => {
    const { code, stderr } = await runToExit({});
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/RPC_URL_/);
  });

  it('does not echo secret values when config is invalid', async () => {
    const { code, stderr } = await runToExit({
      RPC_URL_ETHEREUM: 'https://example.invalid/secret-key-123',
      LOG_LEVEL: 'loud',
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/LOG_LEVEL/);
    expect(stderr).not.toContain('secret-key-123');
  });
});

describe('stdio protocol (recorded chain)', () => {
  let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;
  let session: StdioSession;

  beforeAll(async () => {
    endpoint = await chainEndpoint('ethereum', POOL_FIXTURE);
    session = await connectStdio({ RPC_URL_ETHEREUM: endpoint.rpcUrl });
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    await endpoint?.stop();
  });

  it('returns structured content that satisfies the advertised outputSchema', async () => {
    const { tools } = await session.client.listTools();
    const outputSchema = tools.find((t) => t.name === 'get_pool_state')?.outputSchema;
    expect(outputSchema).toBeDefined();
    const result = await session.client.callTool({
      name: 'get_pool_state',
      arguments: { chain: 'ethereum', pool: USDC_WETH_005 },
    });
    expect(result.isError).toBeFalsy();
    const validate = new AjvJsonSchemaValidator().getValidator(outputSchema as never);
    const verdict = validate(result.structuredContent);
    expect(verdict.errorMessage).toBeUndefined();
    expect(verdict.valid).toBe(true);
  });
});
