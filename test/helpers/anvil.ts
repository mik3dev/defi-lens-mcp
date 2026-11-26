import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { redact } from '../../src/lib/errors.js';
import type { Endpoint } from './rpc-server.js';

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 200;

export function hasAnvil(): boolean {
  return spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function isReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Starts anvil on a free local port; forks `forkUrl` at `forkBlockNumber` when given. Anvil output is
 * captured, never printed, and redacted of the fork URL before it appears in an error.
 */
export async function startAnvil(opts: {
  forkUrl?: string;
  forkBlockNumber?: bigint;
}): Promise<Endpoint> {
  const port = await freePort();
  const fork = opts.forkUrl
    ? ['--fork-url', opts.forkUrl, '--fork-block-number', String(opts.forkBlockNumber ?? 0n)]
    : [];
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), ...fork], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4_000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = once(child, 'exit');
  const rpcUrl = `http://127.0.0.1:${port}`;
  const fail = (why: string) =>
    new Error(`anvil ${why}: ${redact(output, opts.forkUrl ? [opts.forkUrl] : [])}`);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await isReady(rpcUrl))) {
    if (child.exitCode !== null) throw fail(`exited with code ${child.exitCode}`);
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw fail('did not become ready');
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return {
    rpcUrl,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
    },
  };
}
