import type { Config } from '../config.js';
import { redact } from './errors.js';

export interface Logger {
  debug(msg: string, f?: object): void;
  info(msg: string, f?: object): void;
  warn(msg: string, f?: object): void;
  error(msg: string, f?: object): void;
}

type Level = Config['logLevel'];

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** JSON-lines logger; msg and all field values are stringified and redacted. Defaults to stderr. */
export function createLogger(
  level: Level,
  secrets: string[],
  out: NodeJS.WritableStream = process.stderr,
): Logger {
  const emit = (lvl: Level, msg: string, fields: object = {}): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const safeFields = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, redact(stringify(v), secrets)]),
    );
    const record = {
      ...safeFields,
      level: lvl,
      msg: redact(msg, secrets),
      time: new Date().toISOString(),
    };
    out.write(`${JSON.stringify(record)}\n`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
