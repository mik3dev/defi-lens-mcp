#!/usr/bin/env node
import { createRequire } from 'node:module';
import { ConfigError, loadConfig } from './config.js';
import { createContext } from './context.js';
import { startStdio } from './transports/stdio.js';

function readVersion(): string {
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
  return pkg.version;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const ctx = createContext(config);
  if (config.transport === 'stdio') {
    await startStdio(ctx, readVersion());
    return;
  }
  throw new ConfigError('TRANSPORT=http is not available yet');
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) {
    process.stderr.write(`${e.message}\n`);
  } else {
    process.stderr.write(`Fatal: ${e instanceof Error ? e.message : 'unknown error'}\n`);
  }
  process.exit(1);
});
