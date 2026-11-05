import { migrate } from './db/migrate.js';
import { pool, waitForDatabase } from './db/pool.js';
import { startWorker } from './queue/worker.js';
import { config } from './config.js';
import { startMonitorScheduler } from './monitoring/scheduler.js';

// A stray rejection from a third-party library must not take down the API or a running scan.
process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection:', e instanceof Error ? e.message : e));

await waitForDatabase();
await migrate();
const worker = startWorker();
const monitors = config.MONITORING_ENABLED ? startMonitorScheduler() : null;

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received, finishing active scans…`);
  await Promise.all([worker.stop(), monitors?.stop()]);
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
