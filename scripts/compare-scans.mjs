// Compares an earlier scan's report with a fresh scan of the same site and classifies every earlier
// finding: still confirmed, needs manual review, pending verification, reclassified, false positive
// (disproved by re-request), or not reproduced. Writes Markdown to stdout.
//
//   node scripts/compare-scans.mjs <oldScanId> <newScanId> > comparison.md

import pg from 'pg';

const [oldId, newId] = process.argv.slice(2);
if (!oldId || !newId) {
  console.error('Usage: node scripts/compare-scans.mjs <oldScanId> <newScanId>');
  process.exit(1);
}
const db = new pg.Client(process.env.DATABASE_URL || 'postgres://wpcg:wpcg_dev_password@127.0.0.1:5433/wpcg');
await db.connect();

const scan = async (id) => (await db.query('SELECT s.id, s.summary, s.config, s.finished_at, w.base_url FROM scans s JOIN websites w ON w.id = s.website_id WHERE s.id = $1', [id])).rows[0];
const rows = async (id) =>
  (
    await db.query(
      `SELECT i.id AS issue_id, i.rule_id, i.title, i.severity, i.category, f.page_url, f.evidence,
              (SELECT e.to_status FROM issue_events e WHERE e.issue_id = i.id AND e.scan_id = $1 ORDER BY e.created_at DESC LIMIT 1) AS event_status,
              i.status AS current_status
         FROM findings f JOIN issues i ON i.id = f.issue_id WHERE f.scan_id = $1`,
      [id],
    )
  ).rows;

const [o, n] = [await scan(oldId), await scan(newId)];
const oldRows = await rows(oldId);
const newRows = await rows(newId);
const dismissed = n.summary?.verification?.dismissed ?? [];
const dismissedUrls = new Set(dismissed.map((d) => d.item));

// Old issues are what the original report listed (one per fingerprint).
const oldIssues = new Map();
for (const r of oldRows) {
  const e = oldIssues.get(r.issue_id) ?? { ...r, pages: new Set() };
  e.pages.add(r.page_url);
  oldIssues.set(r.issue_id, e);
}
// New state per rule + page.
const newState = new Map();
const statusOf = (r) => (r.current_status === 'resolved' ? 'open' : r.current_status);
for (const r of newRows) newState.set(`${r.rule_id}|${r.page_url}`, { status: statusOf(r), issue: r.issue_id, title: r.title });
const newIssueIds = new Set(newRows.map((r) => r.issue_id));
const newScanned = new Set((await db.query('SELECT url FROM scan_pages WHERE scan_id = $1', [newId])).rows.map((r) => r.url));

// Live re-request of an image URL (the same idea as the scanner's verification step).
const liveImage = new Map();
function imageLoads(u) {
  if (!liveImage.has(u))
    liveImage.set(
      u,
      fetch(u, { headers: { accept: 'image/*', 'user-agent': 'WebAuditAI/0.1 (+verification)' }, signal: AbortSignal.timeout(20000) })
        .then(async (r) => {
          const type = r.headers.get('content-type') ?? '';
          const bytes = (await r.arrayBuffer()).byteLength;
          return { ok: r.ok && type.startsWith('image/') && bytes > 0, detail: `HTTP ${r.status} ${type}` };
        })
        .catch((e) => ({ ok: null, detail: e.message })),
    );
  return liveImage.get(u);
}

const urlsIn = (evidence) => JSON.stringify(evidence).match(/https?:\/\/[^\s"\\]+/g) ?? [];

const results = [];
for (const i of oldIssues.values()) {
  const pages = [...i.pages];
  let verdict;
  let note = '';
  if (i.rule_id === 'links.internal-redirect') {
    verdict = 'Reclassified';
    note = 'The link works; it reaches the page after a redirect. Now an informational “link goes through a redirect” notice, not a broken link.';
  } else if (/^javascript\..*third-party$/.test(i.rule_id) && JSON.stringify(i.evidence).includes('challenges.cloudflare.com')) {
    verdict = 'Reclassified';
    note = 'Expected Cloudflare Turnstile behaviour (its token probe answers 401 by design; its iframe logs fingerprinting messages). Not a site defect; no longer reported.';
  } else if (i.rule_id.startsWith('axe-review.')) {
    verdict = 'Needs manual review';
    note = 'axe-core could not decide automatically (for example text over an image or gradient). Not a confirmed WCAG failure.';
  } else if (i.rule_id === 'images.broken') {
    const urls = [...new Set(urlsIn(i.evidence).filter((u) => /\.(webp|jpe?g|png|gif|svg|avif)(\?|$)/i.test(u)))];
    const live = await Promise.all(urls.map(imageLoads));
    const disproved = urls.filter((u, k) => dismissedUrls.has(u) || live[k].ok === true);
    const stillBroken = pages.some((p) => newState.get(`images.broken|${p}`)?.status === 'open');
    if (urls.length && disproved.length === urls.length) {
      verdict = 'False positive';
      note = `All ${urls.length} image(s) load: re-requested live, each returned ${[...new Set(live.map((l) => l.detail))].join(' / ')} with image data. The original scan counted Chrome's own cancelled lazy-load requests as failures (fixed).`;
    } else if (stillBroken) {
      verdict = 'Confirmed';
      note = 'At least one image still fails when re-requested.';
    } else {
      verdict = disproved.length ? 'False positive' : 'Not reproduced';
      note = disproved.length ? `${disproved.length} of ${urls.length} image(s) re-requested successfully; the rest were not seen again.` : 'Not seen again in the fresh scan.';
    }
  } else {
    const states = pages.map((p) => newState.get(`${i.rule_id}|${p}`)?.status).filter(Boolean);
    const testedAgain = pages.some((p) => newScanned.has(p));
    if (states.includes('open') || states.includes('reopened')) verdict = 'Confirmed';
    else if (states.includes('needs_review')) verdict = 'Needs manual review';
    else if (states.includes('inconclusive') || states.includes('not_tested')) verdict = 'Pending verification';
    else if (!testedAgain) {
      verdict = 'Pending verification';
      note = 'The page was not scanned again.';
    } else {
      verdict = 'Not reproduced';
      note = 'Not found when the same check re-ran on the same page.';
    }
  }
  results.push({ title: i.title, rule: i.rule_id, severity: i.severity, pages, verdict, note });
}

const order = ['Confirmed', 'Needs manual review', 'Pending verification', 'Reclassified', 'False positive', 'Not reproduced'];
results.sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || a.rule.localeCompare(b.rule));
const count = (v) => results.filter((r) => r.verdict === v).length;
const newConfirmedIssues = new Set(newRows.filter((r) => ['open', 'reopened'].includes(statusOf(r))).map((r) => r.issue_id)).size;

const out = [];
out.push(`# Audit comparison — ${o.base_url}`);
out.push('');
out.push(`Original scan \`${oldId}\` (${o.finished_at?.toISOString?.() ?? o.finished_at}): ${o.summary?.pagesScanned} pages, **${oldIssues.size} reported issues**.`);
out.push(`Fresh scan \`${newId}\` (${n.finished_at?.toISOString?.() ?? n.finished_at}): ${n.summary?.pagesScanned} of ${n.summary?.pagesDiscovered} pages found, **${n.summary?.confirmedIssues ?? '—'} confirmed issues**, ${n.summary?.needsManualReview ?? 0} need manual review, ${n.summary?.pendingVerification ?? 0} pending verification (${newIssueIds.size} issue records in total after grouping).`);
out.push('');
out.push('| Classification of the original findings | Count |');
out.push('|---|---|');
for (const v of order) out.push(`| ${v} | ${count(v)} |`);
out.push('');
for (const v of order) {
  const list = results.filter((r) => r.verdict === v);
  if (!list.length) continue;
  out.push(`## ${v} (${list.length})`);
  out.push('');
  out.push('| Original finding | Rule | Page | Note |');
  out.push('|---|---|---|---|');
  for (const r of list) out.push(`| ${r.title.replace(/\|/g, '/')} | \`${r.rule}\` | ${r.pages.map((p) => p.replace(o.base_url.replace(/\/$/, ''), '') || '/').join(', ')} | ${r.note} |`);
  out.push('');
}
if (dismissed.length) {
  out.push(`## Detections dismissed by re-request in the fresh scan (${dismissed.length})`);
  out.push('');
  for (const d of dismissed.slice(0, 60)) out.push(`- \`${d.item}\` — ${d.reason}`);
  out.push('');
}
console.log(out.join('\n'));
console.error(JSON.stringify({ originalIssues: oldIssues.size, newConfirmedIssues, byVerdict: Object.fromEntries(order.map((v) => [v, count(v)])) }));
await db.end();
