import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAINS } from '../../src/chains.js';
import { DISCOVERY_WALLET } from '../fixtures/wallets.js';
import { chainEndpoint } from '../helpers/chain-endpoint.js';
import { connectStdio, type StdioSession } from '../helpers/mcp-client.js';

const USDC_WETH_005: Address = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
// Never contacted: listing tools makes no RPC request.
const UNUSED_RPC_URL = 'http://127.0.0.1:9';
const SPAWN_TEST_TIMEOUT_MS = 20_000;

interface ToolCase {
  tool: string;
  validArgs: Record<string, unknown>;
  /** Recording under test/fixtures/rpc/ that answers the call (ethereum). */
  fixture: string;
}

/** One successful call per registered tool; extended whenever a tool is added. */
const CASES: ToolCase[] = [
  {
    tool: 'get_pool_state',
    validArgs: { chain: 'ethereum', pool: USDC_WETH_005 },
    fixture: 'e2e-pool-state',
  },
  {
    tool: 'get_token_balances',
    validArgs: {
      chain: 'ethereum',
      address: DISCOVERY_WALLET.owner,
      tokens: [CHAINS.ethereum.wrappedNative, DISCOVERY_WALLET.pricedTokens.USDC],
    },
    fixture: 'e2e-token-balances',
  },
];

describe('every registered tool', { timeout: SPAWN_TEST_TIMEOUT_MS }, () => {
  let session: StdioSession;

  beforeAll(async () => {
    session = await connectStdio({ RPC_URL_ETHEREUM: UNUSED_RPC_URL });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
  });

  it('has a call case for each listed tool', async () => {
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(CASES.map((c) => c.tool).sort());
  });

  it('advertises a description, object schemas and the read-only hint', async () => {
    const { tools } = await session.client.listTools();
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(0);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema?.type, tool.name).toBe('object');
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });
});

describe.each(CASES)(
  '$tool call',
  { timeout: SPAWN_TEST_TIMEOUT_MS },
  ({ tool, validArgs, fixture }) => {
    let endpoint: Awaited<ReturnType<typeof chainEndpoint>> | undefined;
    let session: StdioSession;

    beforeAll(async () => {
      endpoint = await chainEndpoint('ethereum', fixture);
      session = await connectStdio({ RPC_URL_ETHEREUM: endpoint.rpcUrl });
    }, 120_000);

    afterAll(async () => {
      await session?.close();
      await endpoint?.stop();
    });

    it('succeeds with structured content that satisfies its outputSchema', async () => {
      const { tools } = await session.client.listTools();
      const outputSchema = tools.find((t) => t.name === tool)?.outputSchema;
      expect(outputSchema).toBeDefined();
      const result = await session.client.callTool({ name: tool, arguments: validArgs });
      expect(result.isError).toBeFalsy();
      const validate = new AjvJsonSchemaValidator().getValidator(outputSchema as never);
      const verdict = validate(result.structuredContent);
      expect(verdict.errorMessage).toBeUndefined();
      expect(verdict.valid).toBe(true);
    });
  },
);
