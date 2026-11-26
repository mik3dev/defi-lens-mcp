import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
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

interface AnvilProcess {
  child: ChildProcess;
  output: () => string;
  spawnError: () => Error | undefined;
  exited: Promise<void>;
}

function spawnAnvil(binary: string, args: string[]): AnvilProcess {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let spawnError: Error | undefined;
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  // Settles on exit or on a spawn error (e.g. binary missing); never rejects, so nothing goes unhandled.
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', (e) => {
      spawnError = e;
      resolve();
    });
  });
  return { child, output: () => output, spawnError: () => spawnError, exited };
}

async function waitReady(proc: AnvilProcess, rpcUrl: string, fail: (why: string) => Error) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await isReady(rpcUrl))) {
    const spawnError = proc.spawnError();
    if (spawnError) throw fail(`failed to start (${spawnError.message})`);
    if (proc.child.exitCode !== null) throw fail(`exited with code ${proc.child.exitCode}`);
    if (Date.now() > deadline) {
      proc.child.kill('SIGKILL');
      throw fail('did not become ready');
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

/**
 * Starts anvil on a free local port; forks `forkUrl` at `forkBlockNumber` when given. Anvil output is
 * captured, never printed, and redacted of the fork URL before it appears in an error.
 */
export async function startAnvil(opts: {
  forkUrl?: string;
  forkBlockNumber?: bigint;
  binary?: string;
}): Promise<Endpoint> {
  const port = await freePort();
  const fork = opts.forkUrl
    ? ['--fork-url', opts.forkUrl, '--fork-block-number', String(opts.forkBlockNumber ?? 0n)]
    : [];
  const proc = spawnAnvil(opts.binary ?? 'anvil', [
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    ...fork,
  ]);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const fail = (why: string) =>
    new Error(`anvil ${why}: ${redact(proc.output(), opts.forkUrl ? [opts.forkUrl] : [])}`);
  await waitReady(proc, rpcUrl, fail);
  return {
    rpcUrl,
    stop: async () => {
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        proc.child.kill('SIGTERM');
        await proc.exited;
      }
    },
  };
}
