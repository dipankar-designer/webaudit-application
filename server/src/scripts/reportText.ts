// Operator tool: prints a completed scan's client report as plain text (the PDF's content).
//   npx tsx src/scripts/reportText.ts <scanId>

import { one, pool } from '../db/pool.js';
import { buildReport } from '../reports/build.js';
import { reportHtml } from '../reports/exporters.js';

const id = process.argv[2];
const scan = await one<{ workspace_id: string }>('SELECT workspace_id FROM scans WHERE id = $1', [id]);
if (!scan) {
  console.error('Scan not found');
  process.exit(1);
}
const html = await reportHtml(await buildReport(id, scan.workspace_id), scan.workspace_id);
console.log(
  html
    .replace(/<style[\s\S]*?<\/style>/, '')
    .replace(/<(br|\/p|\/tr|\/h\d|\/li|\/div)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n'),
);
await pool.end();
