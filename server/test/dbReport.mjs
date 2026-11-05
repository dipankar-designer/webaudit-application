// Dev helper: wait for the latest scan to finish and print what was stored.
//   node test/dbReport.mjs [scanId]
import pg from 'pg';
const c = new pg.Client(process.env.DATABASE_URL || 'postgres://wpcg:wpcg_dev_password@127.0.0.1:5433/wpcg');
await c.connect();
const idArg = process.argv[2];
let scan;
for (;;) {
  scan = (await c.query(idArg ? 'SELECT * FROM scans WHERE id = $1' : 'SELECT * FROM scans ORDER BY created_at DESC LIMIT 1', idArg ? [idArg] : [])).rows[0];
  if (!['queued', 'running'].includes(scan.status)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(scan.id, scan.status, scan.error ?? '', `${Math.round((scan.finished_at - scan.started_at) / 1000)}s`);
console.log(JSON.stringify(scan.summary));
for (const r of (await c.query('SELECT category, status, pages_tested, detail FROM check_runs WHERE scan_id = $1 ORDER BY category', [scan.id])).rows)
  console.log(`  [${r.status}] ${r.category} pages=${r.pages_tested} ${r.detail.slice(0, 160)}`);
for (const p of (await c.query('SELECT url, status_code, title, error, lab_metrics, (SELECT count(*) FROM screenshots s WHERE s.page_id = p.id) AS shots FROM scan_pages p WHERE scan_id = $1', [scan.id])).rows)
  console.log(`  page ${p.status_code} ${p.url} shots=${p.shots} title=${p.title} ${p.error ?? ''} ${Object.keys(p.lab_metrics).length ? JSON.stringify(Object.fromEntries(Object.entries(p.lab_metrics).map(([k, v]) => [k, { score: v.performanceScore, lcp: Math.round(v.lcpMs) }]))) : ''}`);
const issues = await c.query(
  `SELECT i.severity, i.status, i.rule_id, i.title, count(DISTINCT f.page_url) AS pages FROM issues i JOIN findings f ON f.issue_id = i.id AND f.scan_id = $1
    GROUP BY i.id ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, i.rule_id`,
  [scan.id],
);
for (const i of issues.rows) console.log(`  ${i.severity.padEnd(8)} ${i.status.padEnd(12)} ${i.rule_id.padEnd(42)} ${i.pages}p ${i.title}`);
const ev = await c.query('SELECT e.to_status, count(*) n FROM issue_events e WHERE e.scan_id = $1 GROUP BY 1', [scan.id]);
console.log('events', JSON.stringify(ev.rows));
await c.end();
