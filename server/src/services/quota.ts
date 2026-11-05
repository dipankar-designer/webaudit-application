// Server-side plan limits. Usage is metered in usage_events per calendar month (UTC).

import { PLANS, type PlanId, type UsageDTO } from '@wpcg/shared';
import { one, query, type Queryable } from '../db/pool.js';
import { quotaExceeded } from '../http/errors.js';

export function periodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function usageFor(workspaceId: string, plan: PlanId, db?: Queryable): Promise<UsageDTO> {
  const start = periodStart();
  const row = await one<{ scans: number; ai: number; websites: number; monitors: number }>(
    `SELECT
       (SELECT count(*) FROM usage_events WHERE workspace_id = $1 AND kind = 'scan' AND created_at >= $2) AS scans,
       (SELECT count(*) FROM usage_events WHERE workspace_id = $1 AND kind = 'ai' AND created_at >= $2) AS ai,
       (SELECT count(*) FROM websites WHERE workspace_id = $1) AS websites,
       (SELECT count(*) FROM monitors WHERE workspace_id = $1) AS monitors`,
    [workspaceId, start.toISOString()],
    db,
  );
  return {
    plan: PLANS[plan],
    periodStart: start.toISOString(),
    scansUsed: Number(row?.scans ?? 0),
    aiRequestsUsed: Number(row?.ai ?? 0),
    websitesUsed: Number(row?.websites ?? 0),
    monitorsUsed: Number(row?.monitors ?? 0),
  };
}

/** Records one scan against the quota, failing if the monthly allowance is used up. Call inside the scan-creating transaction. */
export async function consumeScan(workspaceId: string, plan: PlanId, db: Queryable): Promise<void> {
  // Serialise concurrent scan creation per workspace so two requests cannot both take the last slot.
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`quota:${workspaceId}`], db);
  const u = await usageFor(workspaceId, plan, db);
  if (u.scansUsed >= u.plan.scansPerMonth)
    throw quotaExceeded(`Your ${u.plan.name} plan includes ${u.plan.scansPerMonth} scans per month and they have all been used. The allowance resets on the 1st.`);
  await query("INSERT INTO usage_events (workspace_id, kind) VALUES ($1, 'scan')", [workspaceId], db);
}

export async function consumeAi(workspaceId: string, plan: PlanId, db: Queryable): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ai:${workspaceId}`], db);
  const u = await usageFor(workspaceId, plan, db);
  if (u.aiRequestsUsed >= u.plan.aiRequestsPerMonth)
    throw quotaExceeded(`Your ${u.plan.name} plan includes ${u.plan.aiRequestsPerMonth} AI explanations per month and they have all been used.`);
  await query("INSERT INTO usage_events (workspace_id, kind) VALUES ($1, 'ai')", [workspaceId], db);
}
