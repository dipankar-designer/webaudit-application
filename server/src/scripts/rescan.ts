// Operator tool: queues a new scan with the same settings as an earlier one, covering all pages
// (up to the workspace plan's page limit). The running worker picks it up.
//   npx tsx src/scripts/rescan.ts <scanId>
// Counts against the workspace's monthly scan quota like any other scan.

import { PLANS, type ScanConfig } from '@wpcg/shared';
import { config } from '../config.js';
import { one, pool } from '../db/pool.js';
import { createScan } from '../routes/scans.js';

const id = process.argv[2];
if (!id) {
  console.error('Usage: tsx src/scripts/rescan.ts <scanId>');
  process.exit(1);
}
const prev = await one<{ workspace_id: string; website_id: string; created_by: string | null; config: ScanConfig; plan: keyof typeof PLANS }>(
  'SELECT s.workspace_id, s.website_id, s.created_by, s.config, w.plan FROM scans s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = $1',
  [id],
);
if (!prev) {
  console.error('Scan not found');
  process.exit(1);
}
const maxPages = Math.min(PLANS[prev.plan].maxPagesPerScan, config.SCAN_HARD_MAX_PAGES);
const cfg: ScanConfig = { ...prev.config, pageMode: 'discover', selectedUrls: [], maxPages, verifyIssueIds: [] };
const newId = await createScan(prev.workspace_id, prev.plan, prev.website_id, prev.created_by, cfg);
console.log(`Queued scan ${newId} (all pages, up to ${maxPages}).`);
await pool.end();
