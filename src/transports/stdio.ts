import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { AppContext } from '../context.js';
import { buildServer } from '../server.js';

/** Serves MCP over stdin/stdout. Only protocol frames may be written to stdout; logs go to stderr. */
export async function startStdio(ctx: AppContext, version: string): Promise<void> {
  const server = buildServer(ctx, version);
  await server.connect(new StdioServerTransport());
}
