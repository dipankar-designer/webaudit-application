import { defineConfig } from 'vitest/config';

// Live checks against real public targets (internet required). No database or fixture needed.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 120_000,
    env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', AI_PROVIDER: 'none', APP_ORIGIN: 'http://localhost:5174' },
  },
});
