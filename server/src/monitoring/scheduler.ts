// Monitoring scheduler: claims due watchers (FOR UPDATE SKIP LOCKED), runs them with a time
// limit, stores every result, keeps exactly one open incident per failing watcher, sends
// de-duplicated alerts, and watches itself (heartbeat + reclaiming runs that never finished).

import os from 'node:os';
import { PLANS, WATCHERS, type CheckKey, type PlanId, type Priority } from '@wpcg/shared';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { retryFailedDeliveries, sendIncidentAlerts, severityRank } from './alerts.js';
import { auditCheck } from './checks/audit.js';
import { browserCheck } from './checks/browser.js';
import { defacementCheck, headersCheck, indexingCheck, mixedContentCheck, scriptsCheck } from './checks/content.js';
import { dnsCheck } from './checks/dns.js';
import { domainCheck } from './checks/domain.js';
import { exposureCheck } from './checks/exposure.js';
import { heartbeatCheck } from './checks/heartbeat.js';
import { httpsCheck } from './checks/https.js';
import { tlsCheck } from './checks/tls.js';
import { uptimeCheck } from './checks/uptime.js';
import type { CheckOutcome, CheckRunner, MonitorRow } from './types.js';

export const RUNNERS: Record<CheckKey, CheckRunner> = {
  uptime: uptimeCheck,
  tls: tlsCheck,
  https: httpsCheck,
  headers: headersCheck,
  indexing: indexingCheck,
  mixed_content: mixedContentCheck,
  dns: dnsCheck,
  domain: domainCheck,
  defacement: defacementCheck,
  scripts: scriptsCheck,
  browser: browserCheck,
  exposure: exposureCheck,
  audit: auditCheck,
  heartbeat: heartbeatCheck,
};

const TIME_LIMIT_MS: Partial<Record<CheckKey, number>> = { browser: 120_000, exposure: 300_000, audit: 60_000 };
const DEFAULT_LIMIT_MS = 90_000;
/** A run still locked after this long did not complete: it is reclaimed and recorded as a monitoring error. */
const STALE_LOCK_MS = 10 * 60_000;
/** Consecutive monitoring errors before an incident is opened for the monitoring itself. */
const ERROR_INCIDENT_AFTER = 3;

const WORKER_ID = `${os.hostname()}:${process.pid}`;

interface ClaimedCheck {
  monitor_id: string;
  check_key: CheckKey;
  interval_seconds: number;
  baseline: unknown;
  last_status: string | null;
  consecutive_errors: number;
}

/** Whether the workspace's plan includes this watcher (heartbeat monitors are always allowed). */
export function entitled(plan: PlanId, key: CheckKey): boolean {
  return key === 'heartbeat' || PLANS[plan].watchers.includes(key);
}

async function claim(limit: number): Promise<ClaimedCheck[]> {
  return query<ClaimedCheck>(
    `WITH due AS (
       SELECT c.monitor_id, c.check_key FROM monitor_checks c JOIN monitors m ON m.id = c.monitor_id
        WHERE c.enabled AND m.enabled AND c.next_run_at <= now() AND c.locked_at IS NULL
        ORDER BY c.next_run_at LIMIT $2
        FOR UPDATE OF c SKIP LOCKED
     )
     UPDATE monitor_checks c SET locked_at = now(), locked_by = $1
       FROM due WHERE c.monitor_id = due.monitor_id AND c.check_key = due.check_key
     RETURNING c.monitor_id, c.check_key, c.interval_seconds, c.baseline, c.last_status, c.consecutive_errors`,
    [WORKER_ID, limit],
  );
}

/** Runs one claimed watcher end to end. Exported for tests and "check now". */
export async function runClaimed(job: ClaimedCheck): Promise<void> {
  const monitor = await one<MonitorRow & { plan: PlanId }>(
    'SELECT m.*, w.plan FROM monitors m JOIN workspaces w ON w.id = m.workspace_id WHERE m.id = $1',
    [job.monitor_id],
  );
  if (!monitor) return;
  if (!entitled(monitor.plan, job.check_key)) {
    // Plan no longer includes this watcher: switch it off rather than run it.
    await query('UPDATE monitor_checks SET enabled = false, locked_at = NULL, locked_by = NULL WHERE monitor_id = $1 AND check_key = $2', [job.monitor_id, job.check_key]);
    return;
  }
  // After a downgrade, uptime checks slow to the current plan's minimum interval (the next run is
  // scheduled from job.interval_seconds; the stored setting is left for when the plan allows it again).
  if (job.check_key === 'uptime') job = { ...job, interval_seconds: Math.max(job.interval_seconds, PLANS[monitor.plan].minIntervalSeconds) };
  const started = new Date();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('time limit')), TIME_LIMIT_MS[job.check_key] ?? DEFAULT_LIMIT_MS);
  let outcome: CheckOutcome;
  try {
    outcome = await RUNNERS[job.check_key]({ monitor, baseline: job.baseline, signal: controller.signal });
  } catch (e) {
    const msg = controller.signal.aborted ? `the check exceeded its ${Math.round((TIME_LIMIT_MS[job.check_key] ?? DEFAULT_LIMIT_MS) / 1000)} s time limit` : (e as Error).message.split('\n')[0];
    outcome = { status: 'error', summary: `Monitoring error: ${msg.slice(0, 300)}` };
  } finally {
    clearTimeout(timer);
  }

  if (outcome.deferSeconds) {
    await query(
      `UPDATE monitor_checks SET locked_at = NULL, locked_by = NULL, next_run_at = now() + ($3 || ' seconds')::interval,
              baseline = COALESCE($4::jsonb, baseline) WHERE monitor_id = $1 AND check_key = $2`,
      [job.monitor_id, job.check_key, String(outcome.deferSeconds), outcome.baseline === undefined ? null : JSON.stringify(outcome.baseline)],
    );
    return;
  }
  const alerts = await persistOutcome(monitor, job, outcome, started);
  for (const a of alerts) await sendIncidentAlerts(a.incidentId, a.event).catch((e) => console.error('[monitor] alert failed:', (e as Error).message));
}

/** Stores the result and applies incident rules. Returns alerts to send after commit. */
export async function persistOutcome(monitor: MonitorRow, job: ClaimedCheck, outcome: CheckOutcome, started: Date): Promise<{ incidentId: string; event: 'opened' | 'resolved' }[]> {
  const alerts: { incidentId: string; event: 'opened' | 'resolved' }[] = [];
  const isError = outcome.status === 'error';
  const consecutiveErrors = isError ? job.consecutive_errors + 1 : 0;
  // Long cadences get up to 10 % jitter so many monitors do not fire in the same second.
  const jitter = job.interval_seconds >= 3600 ? Math.floor(Math.random() * job.interval_seconds * 0.1) : 0;

  await tx(async (c) => {
    const res = await one<{ id: number }>(
      `INSERT INTO check_results (monitor_id, check_key, status, severity, summary, detail, response_ms, ttfb_ms, http_status, attempts, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        monitor.id,
        job.check_key,
        outcome.status,
        outcome.status === 'warning' || outcome.status === 'down' ? (outcome.severity ?? 'p3') : null,
        outcome.summary.slice(0, 1000),
        JSON.stringify({ ...(outcome.detail ?? {}), ...(outcome.event ? { event: true } : {}) }),
        outcome.responseMs ?? null,
        outcome.ttfbMs ?? null,
        outcome.httpStatus ?? null,
        outcome.attempts ?? 1,
        started.toISOString(),
      ],
      c,
    );
    const resultId = res!.id;
    await query(
      `UPDATE monitor_checks SET locked_at = NULL, locked_by = NULL, last_run_at = now(),
              last_change_at = CASE WHEN last_status IS DISTINCT FROM $3 THEN now() ELSE last_change_at END,
              last_status = $3, last_severity = $4, last_summary = $5, consecutive_errors = $6,
              baseline = COALESCE($7::jsonb, baseline),
              next_run_at = now() + ((interval_seconds + $8) || ' seconds')::interval
        WHERE monitor_id = $1 AND check_key = $2`,
      [
        monitor.id,
        job.check_key,
        outcome.status,
        outcome.status === 'warning' || outcome.status === 'down' ? (outcome.severity ?? 'p3') : null,
        outcome.summary.slice(0, 500),
        consecutiveErrors,
        outcome.baseline === undefined ? null : JSON.stringify(outcome.baseline),
        String(jitter),
      ],
      c,
    );

    // ----- incidents
    // "Not assessed" neither opens nor resolves anything (R0). A single monitoring error is
    // ignored; repeated errors become an incident about the monitoring itself (build note 14).
    let failing: { severity: Priority; title: string } | null = null;
    if (outcome.status === 'down' || outcome.status === 'warning') failing = { severity: outcome.severity ?? 'p3', title: outcome.summary };
    else if (isError && consecutiveErrors >= ERROR_INCIDENT_AFTER) failing = { severity: 'p3', title: `Monitoring is failing for ${WATCHERS[job.check_key].label}: ${outcome.summary}` };
    const passing = outcome.status === 'up';

    const open = await one<{ id: string; severity: Priority; detail: { event?: boolean } }>(
      "SELECT id, severity, detail FROM incidents WHERE monitor_id = $1 AND check_key = $2 AND status = 'open' FOR UPDATE",
      [monitor.id, job.check_key],
      c,
    );
    if (failing) {
      if (open && severityRank(failing.severity) < severityRank(open.severity)) {
        // Escalation (e.g. P3 → P1): close the old incident quietly and open a new one, so the escalation alerts.
        await query("UPDATE incidents SET status = 'resolved', resolved_at = now(), detail = detail || '{\"superseded\":true}' WHERE id = $1", [open.id], c);
      }
      if (open && severityRank(failing.severity) >= severityRank(open.severity)) {
        await query(
          'UPDATE incidents SET last_seen_at = now(), occurrences = occurrences + 1, last_result_id = $2, title = $3, detail = $4 WHERE id = $1',
          [open.id, resultId, failing.title.slice(0, 500), JSON.stringify({ event: !!outcome.event, summary: outcome.summary.slice(0, 1000) })],
          c,
        );
      } else {
        const inc = await one<{ id: string }>(
          `INSERT INTO incidents (workspace_id, monitor_id, check_key, severity, title, first_result_id, last_result_id, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7) RETURNING id`,
          [monitor.workspace_id, monitor.id, job.check_key, failing.severity, failing.title.slice(0, 500), resultId, JSON.stringify({ event: !!outcome.event, summary: outcome.summary.slice(0, 1000) })],
          c,
        );
        alerts.push({ incidentId: inc!.id, event: 'opened' });
      }
    } else if (passing && open) {
      await query("UPDATE incidents SET status = 'resolved', resolved_at = now(), last_result_id = $2 WHERE id = $1", [open.id, resultId], c);
      // Change events (DNS change, robots.txt change) do not get a separate recovery alert.
      if (!open.detail?.event) alerts.push({ incidentId: open.id, event: 'resolved' });
    }
  });
  return alerts;
}

/** Reclaims runs whose worker died mid-check and records them as monitoring errors. */
export async function reclaimStale(): Promise<number> {
  const stale = await query<ClaimedCheck & { locked_by: string }>(
    `SELECT monitor_id, check_key, interval_seconds, baseline, last_status, consecutive_errors, locked_by FROM monitor_checks
      WHERE locked_at < now() - ($1 || ' milliseconds')::interval`,
    [String(STALE_LOCK_MS)],
  );
  for (const s of stale) {
    const monitor = await one<MonitorRow>('SELECT * FROM monitors WHERE id = $1', [s.monitor_id]);
    if (!monitor) continue;
    const alerts = await persistOutcome(monitor, s, { status: 'error', summary: `Monitoring error: the run started by ${s.locked_by} did not complete` }, new Date());
    for (const a of alerts) await sendIncidentAlerts(a.incidentId, a.event).catch(() => {});
  }
  return stale.length;
}

/** Claims and runs every due watcher once, in the foreground (tests and operator scripts). */
export async function runDueOnce(limit = 100): Promise<number> {
  const jobs = await claim(limit);
  for (const j of jobs) await runClaimed(j);
  return jobs.length;
}

/** Starts the scheduling loop in this process. */
export function startMonitorScheduler(log = console.log): { stop: () => Promise<void> } {
  let running = true;
  const active = new Set<Promise<void>>();
  let lastHousekeeping = 0;

  const loop = async () => {
    while (running) {
      try {
        await query(
          `INSERT INTO system_heartbeats (component, worker_id, beat_at, detail) VALUES ('monitor-scheduler', $1, now(), $2)
           ON CONFLICT (component) DO UPDATE SET worker_id = EXCLUDED.worker_id, beat_at = now(), detail = EXCLUDED.detail`,
          [WORKER_ID, JSON.stringify({ active: active.size })],
        );
        if (Date.now() - lastHousekeeping > 60_000) {
          lastHousekeeping = Date.now();
          const n = await reclaimStale();
          if (n) log(`[monitor] reclaimed ${n} run(s) that did not complete`);
          await retryFailedDeliveries().catch(() => 0);
        }
        const free = config.MONITOR_CONCURRENCY - active.size;
        if (free > 0) {
          for (const job of await claim(free)) {
            const p = runClaimed(job)
              .catch(async (e) => {
                console.error(`[monitor] ${job.check_key} on ${job.monitor_id} crashed:`, (e as Error).message);
                await query('UPDATE monitor_checks SET locked_at = NULL, locked_by = NULL WHERE monitor_id = $1 AND check_key = $2', [job.monitor_id, job.check_key]).catch(() => {});
              })
              .finally(() => active.delete(p));
            active.add(p);
          }
        }
      } catch (e) {
        log(`[monitor] scheduler error: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  void loop();
  log(`[monitor] scheduler ${WORKER_ID} running (concurrency ${config.MONITOR_CONCURRENCY})`);
  return {
    stop: async () => {
      running = false;
      await Promise.allSettled([...active]);
    },
  };
}
