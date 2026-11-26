import { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from './context.js';
import { register as registerGetPoolState } from './tools/get-pool-state.js';
import { register as registerGetTokenBalances } from './tools/get-token-balances.js';

export const SERVER_NAME = 'defi-lens-mcp';

/** Builds the MCP server and registers every tool; nothing else happens here. */
export function buildServer(ctx: AppContext, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version });
  registerGetPoolState(server, ctx);
  registerGetTokenBalances(server, ctx);
  return server;
}
