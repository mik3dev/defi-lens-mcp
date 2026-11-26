import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { foundry } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasAnvil, startAnvil } from '../../helpers/anvil.js';
import {
  canonicalJson,
  type RecordedEntry,
  readRecording,
  requestKey,
  writeRecording,
} from '../../helpers/rpc-recording.js';
import { startProxyServer, startReplayServer } from '../../helpers/rpc-server.js';

const MISSING =
  'No recording for eth_getCode. Re-record with: RECORD=1 pnpm test:fork (runs test files serially to stay under provider rate limits)';

async function rpc(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

const entries: RecordedEntry[] = [
  { method: 'eth_blockNumber', params: [], result: '0x10' },
  { method: 'eth_call', params: [{ data: '0x01', to: '0xab' }, '0x10'], result: '0xbeef' },
  {
    method: 'eth_getBalance',
    params: ['0xab', '0x10'],
    error: { code: -32000, message: 'boom' },
  },
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rpc-harness-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('request keys', () => {
  it('canonicalises nested objects with sorted keys and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [{ y: 1, x: 2 }, 3] } })).toBe(
      '{"a":{"c":[{"x":2,"y":1},3],"d":1},"b":1}',
    );
  });

  it('ignores object key order in params and treats missing params as []', () => {
    expect(requestKey('eth_call', [{ to: '0x1', data: '0x2' }, 'latest'])).toBe(
      requestKey('eth_call', [{ data: '0x2', to: '0x1' }, 'latest']),
    );
    expect(requestKey('eth_blockNumber', undefined)).toBe(requestKey('eth_blockNumber', []));
    expect(requestKey('eth_call', ['0x1'])).not.toBe(requestKey('eth_getCode', ['0x1']));
  });
});

describe('recording files', () => {
  it('are written deterministically, sorted by request key, and read back', async () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    await writeRecording(a, entries);
    await writeRecording(b, [...entries].reverse());
    const text = await readFile(a, 'utf8');
    expect(text).toBe(await readFile(b, 'utf8'));
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  {\n');
    const read = await readRecording(a);
    expect(read.map((e) => e.method)).toEqual(['eth_blockNumber', 'eth_call', 'eth_getBalance']);
  });

  it('fails with a re-record hint when the file is missing', async () => {
    await expect(readRecording(join(dir, 'nope.json'))).rejects.toThrow(
      /Record with: RECORD=1 pnpm test:fork \(runs test files serially to stay under provider rate limits\)/,
    );
  });
});

describe('replay server', () => {
  it('answers by method and params, echoing the request id', async () => {
    const ep = await startReplayServer(entries);
    try {
      expect(await rpc(ep.rpcUrl, { jsonrpc: '2.0', id: 7, method: 'eth_blockNumber' })).toEqual({
        jsonrpc: '2.0',
        id: 7,
        result: '0x10',
      });
      const call = {
        jsonrpc: '2.0',
        id: 'abc',
        method: 'eth_call',
        params: [{ to: '0xab', data: '0x01' }, '0x10'],
      };
      expect(await rpc(ep.rpcUrl, call)).toEqual({ jsonrpc: '2.0', id: 'abc', result: '0xbeef' });
    } finally {
      await ep.stop();
    }
  });

  it('replays recorded JSON-RPC errors', async () => {
    const ep = await startReplayServer(entries);
    try {
      const body = { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0xab', '0x10'] };
      expect(await rpc(ep.rpcUrl, body)).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'boom' },
      });
    } finally {
      await ep.stop();
    }
  });

  it('fails unrecorded requests with a re-record instruction, also on stop', async () => {
    const ep = await startReplayServer(entries);
    const res = await rpc(ep.rpcUrl, { jsonrpc: '2.0', id: 3, method: 'eth_getCode', params: [] });
    expect(res).toMatchObject({ id: 3, error: { message: MISSING } });
    await expect(ep.stop()).rejects.toThrow(MISSING);
  });

  it('rejects batch requests', async () => {
    const ep = await startReplayServer(entries);
    try {
      const res = await rpc(ep.rpcUrl, [{ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }]);
      expect(res).toMatchObject({ error: { message: expect.stringMatching(/batch/i) } });
    } finally {
      await ep.stop();
    }
  });
});

describe('recording proxy', () => {
  it('records request/response pairs without URLs or headers', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const upstream = createServer((req, res) => {
      seen.push(req.headers);
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const { id } = JSON.parse(body) as { id: number };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x2a' }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as AddressInfo).port;
    const file = join(dir, 'rec.json');
    const proxy = await startProxyServer(`http://127.0.0.1:${port}/secret-key-path`, {
      recordTo: file,
    });
    try {
      const res = await rpc(
        proxy.rpcUrl,
        { jsonrpc: '2.0', id: 5, method: 'eth_chainId' },
        { authorization: 'Bearer client-secret' },
      );
      expect(res).toEqual({ jsonrpc: '2.0', id: 5, result: '0x2a' });
    } finally {
      await proxy.stop();
      await new Promise((r) => upstream.close(r));
    }
    expect(seen[0]?.authorization).toBeUndefined();
    const text = await readFile(file, 'utf8');
    for (const banned of ['http', '127.0.0.1', String(port), 'secret', 'authorization']) {
      expect(text).not.toContain(banned);
    }
    expect(await readRecording(file)).toEqual([
      { method: 'eth_chainId', params: [], result: '0x2a' },
    ]);
  });

  it('rejects cleanly, without an unhandled rejection, when anvil cannot start', async () => {
    await expect(startAnvil({ binary: 'anvil-binary-that-does-not-exist' })).rejects.toThrow(
      /anvil failed to start/,
    );
  });

  it.skipIf(!hasAnvil())(
    'round-trips a local anvil session through record and replay',
    async () => {
      const anvil = await startAnvil({});
      const file = join(dir, 'anvil.json');
      const proxy = await startProxyServer(anvil.rpcUrl, { recordTo: file });
      const read = async (url: string) => {
        const client = createPublicClient({
          chain: foundry,
          transport: http(url, { batch: false }),
        });
        const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
        const balance = await client.getBalance({
          address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          blockNumber,
        });
        return { blockNumber, balance, chainId: await client.getChainId() };
      };
      let live: Awaited<ReturnType<typeof read>>;
      try {
        live = await read(proxy.rpcUrl);
      } finally {
        await proxy.stop();
        await anvil.stop();
      }
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain('http');
      expect(text).not.toContain(new URL(anvil.rpcUrl).port);
      const replay = await startReplayServer(await readRecording(file));
      try {
        expect(await read(replay.rpcUrl)).toEqual(live);
      } finally {
        await replay.stop();
      }
    },
    30_000,
  );
});
