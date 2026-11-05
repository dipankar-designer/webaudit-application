import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests run against the wpcg_test database (created by `npm run db:start`) and a local fixture
// website on port 4598, which is the only private target the scanner may reach in tests.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**', '**/node_modules/**'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://wpcg:wpcg_dev_password@127.0.0.1:5433/wpcg_test',
      SCAN_ALLOW_PRIVATE_TARGETS: '127.0.0.1:4598',
      STORAGE_DIR: path.join(os.tmpdir(), 'wpcg-test-storage'),
      RUN_WORKER_IN_PROCESS: 'false',
      LIGHTHOUSE_MAX_PAGES: '1',
      SCAN_PAGE_CONCURRENCY: '2',
      AI_PROVIDER: 'none',
      APP_ORIGIN: 'http://localhost:5174',
      MONITORING_ENABLED: 'false',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '2526',
      SMTP_SECURE: 'false',
      ALERT_FROM: 'WebAudit AI <alerts@example.com>',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
      STRIPE_PRICE_PRO: 'price_pro_test',
      STRIPE_PRICE_AGENCY: 'price_agency_test',
    },
  },
});
