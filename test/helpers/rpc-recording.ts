import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** One recorded JSON-RPC exchange. Only method, params and the reply: never URLs or headers. */
export type RecordedEntry =
  | { method: string; params: unknown; result: unknown; error?: never }
  | { method: string; params: unknown; error: RpcErrorObject; result?: never };

export type RecordedReply = { result: unknown } | { error: RpcErrorObject };

export const RERECORD_HINT = 'RECORD=1 pnpm test:fork';

export function missingRecordingMessage(method: string): string {
  return `No recording for ${method}. Re-record with: ${RERECORD_HINT}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** JSON with object keys sorted recursively; array order is kept. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Replay key: method plus canonical params. The JSON-RPC id is deliberately not part of it. */
export function requestKey(method: string, params: unknown): string {
  return `${method} ${canonicalJson(params ?? [])}`;
}

export function replyOf(entry: RecordedEntry): RecordedReply {
  return entry.error === undefined ? { result: entry.result } : { error: entry.error };
}

export async function readRecording(path: string): Promise<RecordedEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`No recording file at ${path}. Record with: ${RERECORD_HINT}`);
  }
  return JSON.parse(text) as RecordedEntry[];
}

/** Writes entries sorted by request key, keys sorted, pretty-printed: stable and reviewable diffs. */
export async function writeRecording(path: string, entries: RecordedEntry[]): Promise<void> {
  const byKey = new Map(entries.map((e) => [requestKey(e.method, e.params), e]));
  const sorted = [...byKey.keys()].sort().map((k) => sortKeys(byKey.get(k)));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
}
