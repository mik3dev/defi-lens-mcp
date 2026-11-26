#!/usr/bin/env node
import { createRequire } from 'node:module';
import { type Config, ConfigError, loadConfig } from './config.js';
import { createContext } from './context.js';
import { redact } from './lib/errors.js';
import { startHttp } from './transports/http.js';
import { startStdio } from './transports/stdio.js';

function readVersion(): string {
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
  return pkg.version;
}

let config: Config | undefined;

async function main(): Promise<void> {
  config = loadConfig(process.env);
  const ctx = createContext(config);
  if (config.transport === 'stdio') {
    await startStdio(ctx, readVersion());
    return;
  }
  await startHttp(ctx);
}

/** Never echoes an unredacted message: a startup error can embed an RPC URL or API key. */
function fatalMessage(e: unknown): string {
  if (e instanceof ConfigError) return e.message;
  if (config && e instanceof Error) return `Fatal: ${redact(e.message, config.secrets)}`;
  return `Fatal: startup failed (${e instanceof Error ? e.name : 'unknown error'})`;
}

main().catch((e: unknown) => {
  process.stderr.write(`${fatalMessage(e)}\n`);
  process.exit(1);
});
