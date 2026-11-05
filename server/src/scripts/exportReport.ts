// Operator tool: renders a completed scan's client report to PDF (the same output as the PDF
// button in the app).
//   npx tsx src/scripts/exportReport.ts <scanId> <out.pdf>

import fs from 'node:fs';
import { one, pool } from '../db/pool.js';
import { buildReport } from '../reports/build.js';
import { renderPdf, reportHtml } from '../reports/exporters.js';
import { closeBrowser } from '../scanner/browser.js';

const [scanId, out] = process.argv.slice(2);
if (!scanId || !out) {
  console.error('Usage: tsx src/scripts/exportReport.ts <scanId> <out.pdf>');
  process.exit(1);
}
const scan = await one<{ workspace_id: string }>('SELECT workspace_id FROM scans WHERE id = $1', [scanId]);
if (!scan) {
  console.error('Scan not found');
  process.exit(1);
}
const report = await buildReport(scanId, scan.workspace_id);
fs.writeFileSync(out, await renderPdf(await reportHtml(report, scan.workspace_id)));
console.log(`Wrote ${out}`);
await closeBrowser();
await pool.end();
