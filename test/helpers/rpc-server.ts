import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  missingRecordingMessage,
  type RecordedEntry,
  type RecordedReply,
  replyOf,
  requestKey,
  writeRecording,
} from './rpc-recording.js';

export interface Endpoint {
  rpcUrl: string;
  stop(): Promise<void>;
}

interface JsonRpcRequest {
  id?: unknown;
  method: string;
  params?: unknown;
}

export type RpcHandler = (req: JsonRpcRequest) => RecordedReply | Promise<RecordedReply>;

const BATCH_UNSUPPORTED = 'Batch JSON-RPC requests are not supported by the replay server';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function rpcError(id: unknown, message: string, code = -32000) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function listen(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ rpcUrl: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => sendJson(res, 500, rpcError(null, 'Harness server error')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    rpcUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Local JSON-RPC server answering single (non-batch) requests with `handler`; replies echo the id. */
export async function startRpcServer(handler: RpcHandler): Promise<Endpoint> {
  const { rpcUrl, close } = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as JsonRpcRequest | JsonRpcRequest[];
    if (Array.isArray(body)) return sendJson(res, 200, rpcError(null, BATCH_UNSUPPORTED));
    const reply = await handler(body);
    sendJson(res, 200, { jsonrpc: '2.0', id: body.id ?? null, ...reply });
  });
  return { rpcUrl, stop: close };
}

/**
 * Answers from recorded entries keyed by method + canonical params. An unrecorded request gets a
 * JSON-RPC error and also makes `stop()` reject, so it fails the test even if the caller swallows it.
 */
export async function startReplayServer(entries: RecordedEntry[]): Promise<Endpoint> {
  const replies = new Map(entries.map((e) => [requestKey(e.method, e.params), replyOf(e)]));
  const misses: string[] = [];
  const server = await startRpcServer((req) => {
    const reply = replies.get(requestKey(req.method, req.params));
    if (reply) return reply;
    misses.push(req.method);
    return { error: { code: -32000, message: missingRecordingMessage(req.method) } };
  });
  return {
    rpcUrl: server.rpcUrl,
    stop: async () => {
      await server.stop();
      if (misses.length > 0) {
        throw new Error([...new Set(misses)].map(missingRecordingMessage).join('\n'));
      }
    },
  };
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: RecordedEntry['error'];
}

function pairExchanges(requestBody: string, responseBody: string): RecordedEntry[] {
  const requests = asArray(JSON.parse(requestBody) as JsonRpcRequest | JsonRpcRequest[]);
  const responses = asArray(JSON.parse(responseBody) as JsonRpcResponse | JsonRpcResponse[]);
  const byId = new Map(responses.map((r) => [JSON.stringify(r.id), r]));
  return requests.flatMap((req): RecordedEntry[] => {
    const res = byId.get(JSON.stringify(req.id));
    if (!res) return [];
    const params = req.params ?? [];
    return res.error === undefined
      ? [{ method: req.method, params, result: res.result }]
      : [{ method: req.method, params, error: res.error }];
  });
}

/**
 * Forwards request bodies verbatim to `upstreamUrl` (client headers are not forwarded). With
 * `recordTo`, every exchange is written to that file on `stop()`; only method, params and reply.
 */
export async function startProxyServer(
  upstreamUrl: string,
  opts: { recordTo?: string } = {},
): Promise<Endpoint> {
  const recorded: RecordedEntry[] = [];
  const { rpcUrl, close } = await listen(async (req, res) => {
    const body = await readBody(req);
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch {
      // The upstream URL can hold a key: never echo it or the fetch error.
      return sendJson(res, 502, rpcError(null, 'Upstream request failed'));
    }
    const text = await upstream.text();
    if (opts.recordTo && upstream.ok) recorded.push(...pairExchanges(body, text));
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(text);
  });
  return {
    rpcUrl,
    stop: async () => {
      await close();
      if (opts.recordTo) await writeRecording(opts.recordTo, recorded);
    },
  };
}
