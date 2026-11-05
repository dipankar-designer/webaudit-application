// Data retention: deletes scans (with pages, findings, screenshots) older than each workspace's
// retention period, and issues that have not been detected within that period.
// Baseline scans are kept until the baseline itself is deleted.

import { PLANS } from '@wpcg/shared';
import { query } from '../db/pool.js';
import { deleteScanFiles } from '../storage/files.js';

export async function applyRetention(): Promise<{ scans: number; issues: number }> {
  const expired = await query<{ id: string; workspace_id: string }>(
    `SELECT s.id, s.workspace_id FROM scans s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.status IN ('completed', 'failed', 'cancelled')
        AND s.created_at < now() - make_interval(days => w.retention_days)
        AND NOT EXISTS (SELECT 1 FROM baselines b WHERE b.scan_id = s.id)
      LIMIT 500`,
  );
  for (const s of expired) {
    await query('DELETE FROM scans WHERE id = $1', [s.id]);
    await deleteScanFiles(s.workspace_id, s.id);
  }
  const issues = await query(
    `DELETE FROM issues i USING workspaces w
      WHERE w.id = i.workspace_id AND i.last_detected_at < now() - make_interval(days => w.retention_days) RETURNING i.id`,
  );
  // Monitoring history: kept for the plan's history period (open incidents are always kept).
  const days = `CASE w.plan ${Object.values(PLANS).map((p) => `WHEN '${p.id}' THEN ${p.monitorHistoryDays}`).join(' ')} ELSE 7 END`;
  await query(
    `DELETE FROM incidents i USING workspaces w WHERE w.id = i.workspace_id AND i.status = 'resolved'
        AND i.resolved_at < now() - make_interval(days => ${days})`,
  );
  await query(
    `DELETE FROM check_results r USING monitors m, workspaces w
      WHERE m.id = r.monitor_id AND w.id = m.workspace_id AND r.started_at < now() - make_interval(days => ${days})
        AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.status = 'open' AND (i.first_result_id = r.id OR i.last_result_id = r.id))`,
  );
  await query("DELETE FROM alert_deliveries WHERE created_at < now() - interval '400 days'");
  await query("DELETE FROM stripe_events WHERE received_at < now() - interval '90 days'");
  return { scans: expired.length, issues: issues.length };
}
