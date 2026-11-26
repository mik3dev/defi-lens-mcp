import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Client,
  deserializeMessage,
  type JSONRPCMessage,
  StreamableHTTPClientTransport,
  serializeMessage,
  type Transport,
} from '@modelcontextprotocol/client';

const ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

export interface StdioSession {
  client: Client;
  stderr(): string;
  rawStdout(): string[];
  close(): Promise<void>;
}

/** Stdio client transport that keeps every raw stdout line, so tests can assert on the wire format. */
class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly lines: string[] = [];
  private pending = '';

  constructor(private readonly child: ChildProcess) {}

  async start(): Promise<void> {
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.read(chunk));
    this.child.on('close', () => this.onclose?.());
    this.child.on('error', (e) => this.onerror?.(e));
  }

  private read(chunk: string): void {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    for (const line of parts) {
      this.lines.push(line);
      try {
        this.onmessage?.(deserializeMessage(line));
      } catch (e) {
        this.onerror?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.child.stdin?.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once('close', () => resolve()));
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
}

/**
 * Spawns `node dist/index.js` with ONLY `env` (plus PATH), never the parent environment, so a
 * developer .env or shell variables cannot leak into the server under test.
 */
export async function connectStdio(env: Record<string, string>): Promise<StdioSession> {
  if (!existsSync(ENTRY)) {
    throw new Error('dist/index.js is missing: run `pnpm build` before the e2e tests');
  }
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const transport = new RecordingTransport(child);
  const client = new Client({ name: 'e2e-test-client', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (e) {
    await transport.close();
    throw e;
  }
  return {
    client,
    stderr: () => stderr,
    rawStdout: () => [...transport.lines],
    close: () => client.close(),
  };
}

/** Spawns the server and resolves with its exit code and stderr once it exits on its own. */
export function runToExit(
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  if (!existsSync(ENTRY)) {
    return Promise.reject(
      new Error('dist/index.js is missing: run `pnpm build` before the e2e tests'),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

/** Connects a Streamable HTTP client; the token, when given, is sent as `Authorization: Bearer`. */
export async function connectHttp(url: string, token?: string): Promise<Client> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client({ name: 'e2e-test-client', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (e) {
    await transport.close().catch(() => undefined);
    throw e;
  }
  return client;
}
