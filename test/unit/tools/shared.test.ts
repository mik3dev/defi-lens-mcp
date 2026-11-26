import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import type { AppContext } from '../../../src/context.js';
import { AppError } from '../../../src/lib/errors.js';
import { createLogger } from '../../../src/lib/logger.js';
import {
  addressSchema,
  amountSchema,
  chainSchema,
  checksumAddressSchema,
  envelope,
  ok,
  runTool,
  tokenSchema,
  usdSchema,
} from '../../../src/tools/shared.js';
import { testContext } from '../../helpers/context.js';
import type { Endpoint } from '../../helpers/rpc-server.js';
import { startRpcServer } from '../../helpers/rpc-server.js';

const A = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const A_CHECKSUM = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const SECRET = 'super-secret-api-key-0123456789';
const BLOCK = { number: 5n, timestamp: 1700000000n };

interface LogRecord {
  [field: string]: string;
}

function capturingContext(rpcUrls: Record<string, string> = {}): {
  ctx: AppContext;
  lines: LogRecord[];
} {
  const lines: LogRecord[] = [];
  const out = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(JSON.parse(chunk.toString()) as LogRecord);
      done();
    },
  });
  const base = testContext(rpcUrls, { secrets: [SECRET] });
  return { ctx: { ...base, logger: createLogger('debug', [SECRET], out) }, lines };
}

function errorPayload(result: { content?: unknown[] }): unknown {
  const first = result.content?.[0] as { type: string; text: string };
  expect(first.type).toBe('text');
  return JSON.parse(first.text);
}

describe('addressSchema', () => {
  it('accepts lowercase and returns the checksummed address', () => {
    expect(addressSchema.parse(A)).toBe(A_CHECKSUM);
  });

  it('accepts a correctly checksummed address', () => {
    expect(addressSchema.parse(A_CHECKSUM)).toBe(A_CHECKSUM);
  });

  it('rejects a bad checksum, a short value and a missing 0x prefix', () => {
    expect(addressSchema.safeParse('0x88E6A0c2dDD26FEEb64F039a2c41296FcB3f5640').success).toBe(
      false,
    );
    expect(addressSchema.safeParse('0x1234').success).toBe(false);
    expect(addressSchema.safeParse('88e6a0c2ddd26feeb64f039a2c41296fcb3f5640').success).toBe(false);
    expect(addressSchema.safeParse(42).success).toBe(false);
  });

  it('is representable as an input JSON Schema with the address pattern', () => {
    const json = z.toJSONSchema(addressSchema, { io: 'input' });
    expect(json).toMatchObject({ type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' });
  });
});

describe('output schemas', () => {
  it('checksumAddressSchema accepts only checksummed addresses', () => {
    expect(checksumAddressSchema.safeParse(A_CHECKSUM).success).toBe(true);
    expect(checksumAddressSchema.safeParse(A).success).toBe(false);
  });

  it('chainSchema accepts supported chains only', () => {
    expect(chainSchema.parse('base')).toBe('base');
    expect(chainSchema.safeParse('solana').success).toBe(false);
  });

  it('amount, token and usd schemas match their shapes', () => {
    expect(amountSchema.parse({ raw: '1', formatted: '0.000001', decimals: 6 })).toBeDefined();
    expect(tokenSchema.parse({ address: A_CHECKSUM, symbol: 'X', decimals: 18 })).toBeDefined();
    expect(usdSchema.parse({ usd: null, priceSource: null })).toBeDefined();
    expect(amountSchema.safeParse({ raw: 1, formatted: '1', decimals: 0 }).success).toBe(false);
  });

  it('envelope wraps data and converts to an output JSON Schema without throwing', () => {
    const schema = envelope(z.object({ a: z.number(), token: tokenSchema }));
    const value = ok('ethereum', BLOCK, {
      a: 1,
      token: { address: A_CHECKSUM, symbol: 'X', decimals: 1 },
    });
    expect(schema.parse(value)).toEqual(value);
    expect(() => z.toJSONSchema(schema, { io: 'output' })).not.toThrow();
  });
});

describe('ok', () => {
  it('builds the response envelope', () => {
    expect(ok('ethereum', BLOCK, { a: 1 })).toEqual({
      chain: 'ethereum',
      blockNumber: '5',
      blockTimestamp: '2023-11-14T22:13:20.000Z',
      data: { a: 1 },
      warnings: [],
    });
  });

  it('carries warnings', () => {
    expect(ok('base', BLOCK, null, ['partial']).warnings).toEqual(['partial']);
  });
});

describe('runTool', () => {
  let server: Endpoint | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('returns structuredContent and the same JSON as text', async () => {
    const { ctx } = capturingContext();
    const output = ok('ethereum', BLOCK, { a: 1 });
    const result = await runTool(ctx, 'test_tool', 'ethereum', async () => output);
    expect(result).toEqual({
      structuredContent: output,
      content: [{ type: 'text', text: JSON.stringify(output) }],
    });
    expect(result.isError).toBeUndefined();
  });

  it('converts a thrown AppError into an error result', async () => {
    const { ctx } = capturingContext();
    const result = await runTool(ctx, 'test_tool', 'ethereum', async () => {
      throw new AppError('NOT_FOUND', 'no pool');
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: 'text',
      text: '{"code":"NOT_FOUND","message":"no pool","retryable":false}',
    });
  });

  it('turns an unknown error containing a secret into INTERNAL / Internal error', async () => {
    const { ctx, lines } = capturingContext();
    const result = await runTool(ctx, 'test_tool', 'ethereum', async () => {
      throw new Error(`request to https://rpc.example/${SECRET} failed`);
    });
    expect(result.isError).toBe(true);
    expect(errorPayload(result)).toEqual({
      code: 'INTERNAL',
      message: 'Internal error',
      retryable: false,
    });
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('redacts configured secrets from AppError messages in the output', async () => {
    const { ctx, lines } = capturingContext();
    const result = await runTool(ctx, 'test_tool', 'ethereum', async () => {
      throw new AppError('UPSTREAM_ERROR', `HTTP 500 from https://rpc.example/${SECRET}`, {
        retryable: true,
      });
    });
    const text = JSON.stringify(result);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(SECRET);
    expect(errorPayload(result)).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('writes exactly one log line per call with tool, chain, duration, requests and outcome', async () => {
    const { ctx, lines } = capturingContext();
    await runTool(ctx, 'tool_a', 'base', async () => ok('base', BLOCK, {}));
    await runTool(ctx, 'tool_b', 'polygon', async () => {
      throw new AppError('INVALID_INPUT', 'bad');
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      tool: 'tool_a',
      chain: 'base',
      upstreamRequests: '0',
      outcome: 'ok',
    });
    expect(lines[1]).toMatchObject({ tool: 'tool_b', chain: 'polygon', outcome: 'INVALID_INPUT' });
    expect(Number(lines[0]?.durationMs)).toBeGreaterThanOrEqual(0);
  });

  it('logs only the failure when the success result cannot be built', async () => {
    const { ctx, lines } = capturingContext();
    const result = await runTool(ctx, 'test_tool', 'ethereum', async () =>
      ok('ethereum', BLOCK, { n: 1n }),
    ); // a bigint cannot be serialized to JSON
    expect(errorPayload(result)).toMatchObject({ code: 'INTERNAL' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: 'INTERNAL' });
  });

  it('counts upstream requests per call even when calls overlap', async () => {
    server = await startRpcServer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { result: '0x1' };
    });
    const { ctx, lines } = capturingContext({ ethereum: server.rpcUrl });
    const client = ctx.clients.ethereum;
    if (!client) throw new Error('client missing');
    const request = () => client.request({ method: 'eth_blockNumber' });
    await Promise.all([
      runTool(ctx, 'three', 'ethereum', async () => {
        await Promise.all([request(), request(), request()]);
        return ok('ethereum', BLOCK, {});
      }),
      runTool(ctx, 'one', 'ethereum', async () => {
        await request();
        return ok('ethereum', BLOCK, {});
      }),
    ]);
    const byTool = Object.fromEntries(lines.map((l) => [l.tool, l.upstreamRequests]));
    expect(byTool).toEqual({ three: '3', one: '1' });
  });

  it('passes fn an AbortSignal that is not aborted', async () => {
    const { ctx } = capturingContext();
    let seen: AbortSignal | undefined;
    await runTool(ctx, 'test_tool', 'ethereum', async (signal) => {
      seen = signal;
      return ok('ethereum', BLOCK, {});
    });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });
});
