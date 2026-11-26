import { defineConfig } from 'vitest/config';

// Fork mode forwards every read through anvil to the upstream RPC; replay keeps vitest's default.
const FORK_TEST_TIMEOUT_MS = 60_000;
const isFork = process.env.CHAIN_MODE === 'fork';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    ...(isFork ? { testTimeout: FORK_TEST_TIMEOUT_MS } : {}),
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 80, branches: 80 },
    },
  },
});
