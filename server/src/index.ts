import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool, waitForDatabase } from './db/pool.js';
import { purgeExpiredSessions } from './auth/session.js';
import { startWorker } from './queue/worker.js';
import { startMonitorScheduler } from './monitoring/scheduler.js';
import { applyRetention } from './services/retention.js';

// A stray rejection from a third-party library must not take down the API or a running scan.
process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection:', e instanceof Error ? e.message : e));

await waitForDatabase();
await migrate();
const app = createApp();
const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`[api] WebAudit AI listening on http://${config.HOST}:${config.PORT}`);
  if (config.privateTargetAllowlist.size) console.warn(`[api] DEV ONLY: private scan targets allowed: ${[...config.privateTargetAllowlist].join(', ')}`);
  console.log(`[api] AI: ${config.aiConfigured ? config.AI_PROVIDER : 'not configured (deterministic checks only)'}`);
});

// Development convenience: run the scan worker inside the API process.
const worker = config.RUN_WORKER_IN_PROCESS ? startWorker() : null;
const monitors = config.RUN_WORKER_IN_PROCESS && config.MONITORING_ENABLED ? startMonitorScheduler() : null;

// Housekeeping every hour: expired sessions and data-retention deletion.
const housekeeping = setInterval(() => {
  purgeExpiredSessions().catch(() => {});
  applyRetention().catch((e) => console.error('[retention]', (e as Error).message));
}, 60 * 60 * 1000);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(housekeeping);
  server.close();
  await Promise.all([worker?.stop(), monitors?.stop()]);
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
