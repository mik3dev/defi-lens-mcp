import type { CallToolResult } from '@modelcontextprotocol/server';
import { type Address, getAddress, isAddress } from 'viem';
import { z } from 'zod/v4';
import { CHAIN_IDS, type ChainId } from '../chains.js';
import { type AppContext, requestScope } from '../context.js';
import type { PinnedBlock } from '../lib/blocks.js';
import { type AppError, redact, toAppError } from '../lib/errors.js';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export const chainSchema = z.enum(CHAIN_IDS);

/**
 * Input address: 0x + 40 hex digits; all-lowercase or a valid EIP-55 checksum. Outputs checksummed.
 * Has a transform, so it is for input schemas only; output schemas use checksumAddressSchema.
 */
export const addressSchema = z
  .string()
  .regex(ADDRESS_PATTERN, 'Expected a 0x-prefixed 20-byte hex address')
  .refine((s) => isAddress(s, { strict: true }), 'Invalid address checksum')
  .transform((s): Address => getAddress(s));

/** Output address: must already be EIP-55 checksummed. No transform, so it converts to JSON Schema. */
export const checksumAddressSchema = z
  .string()
  .regex(ADDRESS_PATTERN)
  .refine((s) => isAddress(s, { strict: true }) && s === getAddress(s), 'Not checksummed');

export const amountSchema = z.object({
  raw: z.string(),
  formatted: z.string(),
  decimals: z.number().int(),
});

export const tokenSchema = z.object({
  address: checksumAddressSchema,
  symbol: z.string(),
  decimals: z.number().int(),
});

export const usdSchema = z.object({
  usd: z.number().nullable(),
  priceSource: z.string().nullable(),
});

export function envelope<T extends z.ZodType>(data: T) {
  return z.object({
    chain: chainSchema,
    blockNumber: z.string(),
    blockTimestamp: z.string(),
    data,
    warnings: z.array(z.string()),
  });
}

export interface ToolOutput<T> {
  chain: ChainId;
  blockNumber: string;
  blockTimestamp: string;
  data: T;
  warnings: string[];
}

export function ok<T>(
  chain: ChainId,
  block: PinnedBlock,
  data: T,
  warnings: string[] = [],
): ToolOutput<T> {
  return {
    chain,
    blockNumber: block.number.toString(),
    blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
    data,
    warnings: [...warnings],
  };
}

function successResult<T>(output: ToolOutput<T>): CallToolResult {
  return {
    structuredContent: { ...output },
    content: [{ type: 'text', text: JSON.stringify(output) }],
  };
}

/** The message is redacted before anything else touches it; only the log line sees the raw error. */
function errorResult(error: AppError, secrets: string[]): CallToolResult {
  const message = redact(error.message, secrets);
  const payload = { code: error.code, message, retryable: error.retryable };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Runs one tool call: opens a requestScope that counts upstream requests, logs exactly one line
 * (tool, chain, durationMs, upstreamRequests, outcome) and maps any throw to an error result.
 */
export async function runTool<T>(
  ctx: AppContext,
  tool: string,
  chain: ChainId,
  fn: (signal: AbortSignal) => Promise<ToolOutput<T>>,
): Promise<CallToolResult> {
  const scope = { upstreamRequests: 0 };
  const started = performance.now();
  const controller = new AbortController(); // aborted on timeout from phase 7 on
  const fields = () => ({
    tool,
    chain,
    durationMs: Math.round(performance.now() - started),
    upstreamRequests: scope.upstreamRequests,
  });
  return requestScope.run(scope, async () => {
    try {
      const result = successResult(await fn(controller.signal));
      ctx.logger.info('tool call', { ...fields(), outcome: 'ok' });
      return result;
    } catch (e) {
      const error = toAppError(e);
      const log = error.code === 'INTERNAL' ? ctx.logger.error : ctx.logger.warn;
      log('tool call', { ...fields(), outcome: error.code, error: e }); // the logger redacts
      return errorResult(error, ctx.config.secrets);
    }
  });
}
