// Scan worker: claims queued scans from PostgreSQL (FOR UPDATE SKIP LOCKED), runs them with a
// heartbeat, honours cancellation and the global scan time limit, and recovers scans left
// "running" by a crashed worker.

import os from 'node:os';
import { PLANS, type PlanId, type ScanConfig } from '@wpcg/shared';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { closeBrowser } from '../scanner/browser.js';
import { runScan, ScanPolicyError } from '../scanner/engine.js';
import { deleteScanFiles } from '../storage/files.js';

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const HEARTBEAT_MS = 10_000;
const STALE_MS = 3 * 60_000;

interface ClaimedScan {
  id: string;
  workspace_id: string;
  website_id: string;
  base_url: string;
  config: ScanConfig;
  plan: PlanId;
}

export async function claimNext(): Promise<ClaimedScan | null> {
  return one<ClaimedScan>(
    `WITH next AS (
       SELECT id FROM scans WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE scans s SET status = 'running', started_at = now(), heartbeat_at = now(), worker_id = $1, attempts = attempts + 1,
                        progress = '{"phase":"starting","done":0,"total":0,"message":"Starting"}'
       FROM next, websites w, workspaces ws
      WHERE s.id = next.id AND w.id = s.website_id AND ws.id = s.workspace_id
      RETURNING s.id, s.workspace_id, s.website_id, w.base_url, s.config, ws.plan`,
    [WORKER_ID],
  );
}

/** For a worker on this machine, whether its process still exists (other hosts: unknown → false). */
function workerStillAlive(workerId: string | null): boolean {
  if (!workerId) return false;
  const [host, pidText] = workerId.split(':');
  const pid = Number(pidText);
  if (host !== os.hostname() || !Number.isInteger(pid) || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Requeue (once) or fail scans whose worker stopped sending heartbeats. */
export async function recoverStale(): Promise<number> {
  const stale = await query<{ id: string; workspace_id: string; attempts: number; worker_id: string | null; age_ms: number }>(
    `SELECT id, workspace_id, attempts, worker_id, extract(epoch FROM now() - heartbeat_at) * 1000 AS age_ms FROM scans WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' milliseconds')::interval`,
    [String(STALE_MS)],
  );
  for (const s of stale) {
    // A live worker is slow, not dead: leave its scan alone unless it is past the scan time limit.
    if (workerStillAlive(s.worker_id) && Number(s.age_ms) < config.SCAN_MAX_DURATION_MS) continue;

    // Clear everything the stopped run wrote, so a retry does not add a second set beside it.
    await query('DELETE FROM scan_pages WHERE scan_id = $1', [s.id]);
    for (const table of ['visual_comparisons', 'lighthouse_reports', 'check_runs', 'scan_coverage'])
      await query(`DELETE FROM ${table} WHERE scan_id = $1`, [s.id]);
    await deleteScanFiles(s.workspace_id, s.id);
    if (s.attempts < 2) await query("UPDATE scans SET status = 'queued', worker_id = NULL, progress = NULL WHERE id = $1 AND status = 'running'", [s.id]);
    else
      await query(
        "UPDATE scans SET status = 'failed', finished_at = now(), error = 'The scan worker stopped responding twice. Please start the scan again.' WHERE id = $1 AND status = 'running'",
        [s.id],
      );
  }
  return stale.length;
}

export async function processScan(job: ClaimedScan): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(Object.assign(new Error('time limit'), { name: 'TimeoutError' })), config.SCAN_MAX_DURATION_MS);
  let lastProgress = 0;
  let pending: { phase: string; done: number; total: number; message: string } | null = null;
  const flush = async () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    lastProgress = Date.now();
    await query('UPDATE scans SET progress = $2 WHERE id = $1', [job.id, JSON.stringify(p)]).catch(() => {});
  };
  const heartbeat = setInterval(async () => {
    try {
      const row = await one<{ cancel_requested: boolean }>('UPDATE scans SET heartbeat_at = now() WHERE id = $1 RETURNING cancel_requested', [job.id]);
      if (row?.cancel_requested && !controller.signal.aborted) controller.abort(new Error('cancelled'));
      await flush();
    } catch {
      /* transient DB error: next beat retries */
    }
  }, HEARTBEAT_MS);

  try {
    const summary = await runScan(
      {
        id: job.id,
        workspaceId: job.workspace_id,
        websiteId: job.website_id,
        baseUrl: job.base_url,
        config: job.config,
        plan: { visualComparison: PLANS[job.plan]?.visualComparison ?? false },
      },
      {
        signal: controller.signal,
        progress: (phase, done, total, message) => {
          pending = { phase, done, total, message };
          if (Date.now() - lastProgress > 1500) void flush();
        },
      },
    );
    await query("UPDATE scans SET status = 'completed', finished_at = now(), summary = $2, progress = NULL WHERE id = $1 AND status = 'running'", [job.id, JSON.stringify(summary)]);
  } catch (e) {
    const err = e as Error;
    const reason = controller.signal.reason as Error | undefined;
    if (controller.signal.aborted && reason?.message === 'cancelled') {
      await query("UPDATE scans SET status = 'cancelled', finished_at = now(), progress = NULL, error = 'Cancelled by a user before it finished. No issue statuses were changed.' WHERE id = $1 AND status = 'running'", [job.id]);
    } else if (err instanceof ScanPolicyError) {
      await query("UPDATE scans SET status = 'failed', finished_at = now(), progress = NULL, error = $2 WHERE id = $1 AND status = 'running'", [job.id, `Scanner limitation: ${err.message}`]);
    } else {
      console.error(`[worker] scan ${job.id} failed:`, err.stack?.split('\n').slice(0, 4).join(' | '));
      await query("UPDATE scans SET status = 'failed', finished_at = now(), progress = NULL, error = $2 WHERE id = $1 AND status = 'running'", [
        job.id,
        'The scan stopped because of an internal error in the scanner (not a problem with your website). Please try again.',
      ]);
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
  }
}

/** Runs the worker loop until `stop()` is called. */
export function startWorker(log = console.log): { stop: () => Promise<void> } {
  let running = true;
  const active = new Set<Promise<void>>();
  let lastRecovery = 0;

  const loop = async () => {
    while (running) {
      try {
        if (Date.now() - lastRecovery > 60_000) {
          lastRecovery = Date.now();
          const n = await recoverStale();
          if (n) log(`[worker] recovered ${n} stale scan(s)`);
        }
        if (active.size < config.WORKER_CONCURRENCY) {
          const job = await claimNext();
          if (job) {
            log(`[worker] scan ${job.id} started (${job.base_url})`);
            const p = processScan(job).finally(() => {
              active.delete(p);
              log(`[worker] scan ${job.id} finished`);
            });
            active.add(p);
            continue;
          }
        }
      } catch (e) {
        log(`[worker] loop error: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  void loop();
  log(`[worker] ${WORKER_ID} polling for scans (concurrency ${config.WORKER_CONCURRENCY})`);
  return {
    stop: async () => {
      running = false;
      await Promise.allSettled([...active]);
      await closeBrowser();
    },
  };
}
