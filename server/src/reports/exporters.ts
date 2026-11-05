// CSV and PDF exports of a report. The PDF is rendered from static, escaped HTML in a
// JavaScript-disabled browser context.

import { PNG } from 'pngjs';
import {
  CATEGORY_INFO,
  ISSUE_STATUS_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  VIEWPORTS,
  type ReportDTO,
  type ReportIssueDTO,
  type ScanSummary,
  type WordPressReportDTO,
} from '@wpcg/shared';
import { getBrowser } from '../scanner/browser.js';
import { readStored } from '../storage/files.js';
import { one } from '../db/pool.js';

// ---------------------------------------------------------------- CSV

/** Quote a CSV cell and neutralise spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function issuesCsv(report: ReportDTO): string {
  const header = [
    'Issue ID',
    'Title',
    'Severity',
    'Status',
    'Change in this scan',
    'Category',
    'Rule',
    'WCAG',
    'Affected pages',
    'Affected page URLs',
    'First detected',
    'Last detected',
    'Description',
    'Recommended fix',
    'How to verify',
    'Evidence (first page)',
  ];
  const rows = report.issues.map((i) =>
    [
      i.id,
      i.title,
      SEVERITY_LABELS[i.severity],
      ISSUE_STATUS_LABELS[i.status],
      i.changeInScan,
      CATEGORY_INFO[i.category].label,
      i.ruleId,
      i.wcag.join(' '),
      i.affectedCount,
      i.affectedUrls.join(' | '),
      i.firstDetectedAt,
      i.lastDetectedAt,
      i.description,
      i.remediation.steps.map((s, n) => `${n + 1}. ${s}`).join(' '),
      i.remediation.verify.join(' '),
      (i.evidence[0]?.evidence ?? []).map((e) => `${e.label}: ${e.value}`).join(' | ').slice(0, 2000),
    ]
      .map(csvCell)
      .join(','),
  );
  return '﻿' + [header.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- HTML for PDF

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : '—');
function verificationHtml(s: ScanSummary | null | undefined): string {
  const v = s?.verification;
  if (!v) return '';
  return `<h2>Verification</h2>
<p>Single-observation detections (images that did not render, links that failed) were re-requested before reporting: ${v.confirmed} confirmed, ${v.pending} pending verification, ${v.dismissed.length} dismissed as false positive(s). Colour-contrast and other checks that need human judgement are listed as “Needs Manual Review”, not as WCAG failures.</p>
${v.dismissed.length ? `<table><tr><th>Dismissed (not a defect)</th><th>Why</th></tr>${v.dismissed.slice(0, 40).map((d) => `<tr><td class="code">${esc(d.item)}</td><td class="muted">${esc(d.reason)}</td></tr>`).join('')}</table>` : ''}`;
}

const kib = (b: number | null) => (b === null ? '—' : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)} MiB` : `${Math.round(b / 1024)} KiB`);
const pct = (s: number | null | undefined) => (s === null || s === undefined ? '—' : String(Math.round(s * 100)));

/** Home-page Lighthouse summary per device: scores, lab metrics, top issues, weight, conditions, comparison. */
function performanceHtml(perf: ReportDTO['performance']): string {
  if (!perf?.length) return '';
  return `<h2>Performance (home page, Lighthouse)</h2>
<p class="muted">Lab measurements of ${esc(perf[0].pageUrl)}. Scores are Lighthouse’s own 0–100 scores, separate from the issue counts above. Lab results vary between runs and differ from real visitors’ experience.</p>
${perf
  .map((p) => {
    const c = p.comparison;
    return `<h3>${p.viewport === 'mobile' ? 'Mobile' : 'Desktop'}</h3>
<table class="meta">
  <tr><td>Scores</td><td>Performance ${pct(p.scores.performance)} · Accessibility ${pct(p.scores.accessibility)} · Best Practices ${pct(p.scores['best-practices'])} · SEO ${pct(p.scores.seo)}</td></tr>
  <tr><td>Lab metrics</td><td>${p.metrics.map((m) => `${esc(m.title)} ${esc(m.displayValue ?? '—')}`).join(' · ')}</td></tr>
  <tr><td>Page weight</td><td>${kib(p.totalTransferSize)}${p.totalRequests !== null ? ` in ${p.totalRequests} requests` : ''}</td></tr>
  <tr><td>Test conditions</td><td class="muted">${esc(p.conditions)}</td></tr>
</table>
${
  p.topIssues.length
    ? `<table><tr><th>Highest-impact Lighthouse findings</th><th>Result</th><th>Lighthouse’s estimated saving</th></tr>${p.topIssues
        .map((i) => `<tr><td>${esc(i.title)}</td><td>${esc(i.displayValue ?? '')}</td><td class="muted">${esc(i.lighthouseSavings ?? '—')}</td></tr>`)
        .join('')}</table>`
    : '<p>No failing performance audits.</p>'
}
${
  c
    ? `<p><strong>Compared with the previous scan</strong> (${esc(fmtDate(c.previousFinishedAt))}): performance ${pct(c.previousPerformance)} → ${pct(p.scores.performance)}; Largest Contentful Paint ${c.previousLcpMs !== null ? `${(c.previousLcpMs / 1000).toFixed(1)} s` : '—'} → ${c.currentLcpMs !== null ? `${(c.currentLcpMs / 1000).toFixed(1)} s` : '—'}; page weight ${kib(c.previousTransferSize)} → ${kib(p.totalTransferSize)}.${c.newlyFailing.length ? ` Newly failing: ${esc(c.newlyFailing.join(', '))}.` : ''}${c.nowPassing.length ? ` Now passing: ${esc(c.nowPassing.join(', '))}.` : ''}</p><p class="muted">${esc(c.notes.join(' '))}</p>`
    : '<p class="muted">No earlier scan of this page and device to compare with.</p>'
}`;
  })
  .join('')}`;
}

const RISK_LABEL: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', none: 'No known risk', unknown: 'Unknown' };

function wordpressHtml(wp: WordPressReportDTO | null | undefined): string {
  if (wp === undefined) return '';
  if (!wp || !wp.detected) return '<h2>WordPress and plugin information</h2><p class="muted">No WordPress markers were found on the scanned pages.</p>';
  const c = wp.core;
  const coreStatus = c?.status === 'latest' ? 'Latest release' : c?.status === 'outdated' ? 'Outdated' : c?.status === 'insecure' ? 'Insecure — update now' : 'Unable to verify';
  return `<h2>WordPress and plugin information</h2>
<table class="meta">
  <tr><td>WordPress version</td><td>${esc(c?.version ?? 'Unknown')}${c?.versionSource ? ` <span class="muted">(${esc(c.versionSource)}, ${esc(c.confidence)} confidence)</span>` : ''}</td></tr>
  <tr><td>Core status (WordPress.org)</td><td>${esc(coreStatus)}${c?.latestVersion ? ` · latest ${esc(c.latestVersion)}` : ''} · risk: ${esc(RISK_LABEL[c?.risk ?? 'unknown'])}${c?.vulnLookup === 'ok' ? ` · ${c.vulnerabilities.length} known vulnerabilit${c.vulnerabilities.length === 1 ? 'y' : 'ies'} for this version` : ''}</td></tr>
  <tr><td>Total installed plugins</td><td>Unable to verify from outside the site — ${wp.detectedPlugins} detected on the public pages</td></tr>
  <tr><td>Theme</td><td>${wp.themes.length ? wp.themes.map((t) => `${esc(t.name ?? t.slug)} ${t.version ? esc(t.version) : '(version unknown)'}`).join(', ') : 'Unknown'}</td></tr>
</table>
<table><tr><th>Plugin</th><th>Installed</th><th>Latest</th><th>Update status</th><th>Risk</th></tr>
${wp.plugins
  .map(
    (p) => `<tr><td><strong>${esc(p.name ?? p.slug)}</strong><div class="muted">${esc(p.slug)}</div></td>
<td>${esc(p.installedVersion ?? 'Unable to verify')}${p.versionSource ? `<div class="muted">${esc(p.versionSource)}</div>` : ''}</td>
<td>${esc(p.latestVersion ?? (p.wordpressOrg === false ? 'Not on WordPress.org' : p.wordpressOrg === 'closed' ? 'Closed on WordPress.org' : 'Unable to verify'))}</td>
<td>${p.updateStatus === 'up_to_date' ? 'Up to date' : p.updateStatus === 'update_available' ? 'Update available' : 'Unknown'}</td>
<td><strong>${esc(RISK_LABEL[p.risk])}</strong><div class="muted">${esc(p.riskReason)}</div>${p.vulnerabilities
      .slice(0, 5)
      .map((v) => `<div>• ${esc(v.title)} — ${esc(v.cve ?? 'no CVE')}, ${esc(v.severity ?? 'severity not published')}${v.fixedIn ? `, fixed in ${esc(v.fixedIn)}` : v.unfixed ? ', no fix yet' : ''}</div>`)
      .join('')}</td></tr>`,
  )
  .join('')}
</table>
<p class="muted">Sources: ${esc(wp.sources.join('; '))}.</p>
<ul class="lim">${wp.limitations.map((l) => `<li class="muted">${esc(l)}</li>`).join('')}</ul>`;
}

const fmtDuration = (ms: number | null) => (ms === null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

async function screenshotThumb(screenshotId: string, workspaceId: string): Promise<string | null> {
  const row = await one<{ path: string }>('SELECT x.path FROM screenshots x JOIN scans s ON s.id = x.scan_id WHERE x.id = $1 AND s.workspace_id = $2', [screenshotId, workspaceId]);
  if (!row) return null;
  try {
    const img = PNG.sync.read(await readStored(row.path));
    const h = Math.min(img.height, Math.round(img.width * 0.62));
    const out = new PNG({ width: img.width, height: h });
    PNG.bitblt(img, out, 0, 0, img.width, h, 0, 0);
    return `data:image/png;base64,${PNG.sync.write(out).toString('base64')}`;
  } catch {
    return null;
  }
}

function issueBlock(i: ReportIssueDTO): string {
  const ev = i.evidence[0];
  return `
  <section class="issue">
    <div class="issue-head">
      <span class="sev sev-${i.severity}">${esc(SEVERITY_LABELS[i.severity])}</span>
      <span class="status">${esc(ISSUE_STATUS_LABELS[i.status])}${i.changeInScan !== 'existing' ? ` · ${i.changeInScan === 'new' ? 'New' : 'Reopened'}` : ''}</span>
      <span class="cat">${esc(CATEGORY_INFO[i.category].label)}${i.wcag.length ? ` · WCAG ${esc(i.wcag.join(', '))}` : ''}</span>
    </div>
    <h3>${esc(i.title)}</h3>
    <p><strong>What was detected:</strong> ${esc(i.description)}</p>
    <p><strong>Where:</strong> ${i.affectedCount} page(s): ${i.affectedUrls.slice(0, 5).map(esc).join(', ')}${i.affectedCount > 5 ? ', …' : ''}</p>
    <p><strong>Why it matters:</strong> ${esc(i.remediation.whyItMatters)}</p>
    <p><strong>How serious:</strong> ${esc(i.severityReason)}</p>
    ${ev ? `<div class="evidence"><strong>Evidence</strong> (${esc(ev.pageUrl)}${ev.viewport ? `, ${esc(ev.viewport)}` : ''})<dl>${ev.evidence
      .slice(0, 6)
      .map((e) => `<dt>${esc(e.label)}</dt><dd${e.code ? ' class="code"' : ''}>${esc(e.value.slice(0, 900))}</dd>`)
      .join('')}</dl></div>` : ''}
    <p><strong>What to do:</strong></p>
    <ol>${i.remediation.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    ${i.remediation.codeExample ? `<pre>${i.remediation.codeExample.before ? `<span class="muted">Before:</span>\n${esc(i.remediation.codeExample.before)}\n\n<span class="muted">After:</span>\n` : ''}${esc(i.remediation.codeExample.after)}</pre>` : ''}
    <p><strong>How to verify:</strong> ${esc(i.remediation.verify.join(' '))}</p>
    ${i.limitations ? `<p class="muted"><strong>Limitations:</strong> ${esc(i.limitations)}</p>` : ''}
  </section>`;
}

export async function reportHtml(r: ReportDTO, workspaceId: string): Promise<string> {
  const s = r.scan;
  const brand = r.brandName || 'WebAudit AI';
  const thumbs: string[] = [];
  for (const p of r.pages.filter((p) => p.screenshots.length).slice(0, 4)) {
    const shot = p.screenshots.find((x) => x.viewport === 'desktop') ?? p.screenshots[0];
    const data = await screenshotThumb(shot.id, workspaceId);
    if (data) thumbs.push(`<figure><img src="${data}" alt=""><figcaption>${esc(p.url)} · ${esc(VIEWPORTS[shot.viewport].label)}</figcaption></figure>`);
  }
  const sevRow = SEVERITIES.map((k) => `<td><span class="sev sev-${k}">${SEVERITY_LABELS[k]}</span><div class="big">${r.severity[k]}</div></td>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(brand)} report — ${esc(s.websiteUrl)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body { font: 10pt/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 4px; } h2 { font-size: 13pt; margin: 22px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; break-after: avoid; }
  h3 { font-size: 11pt; margin: 6px 0; } p { margin: 4px 0; } .muted { color: #6b7280; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; font-size: 9pt; }
  th { color: #374151; font-weight: 600; background: #f9fafb; }
  .meta td:first-child { width: 28%; color: #6b7280; }
  .sev { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 8pt; font-weight: 600; border: 1px solid; }
  .sev-critical { color: #991b1b; background: #fef2f2; border-color: #fecaca; } .sev-high { color: #9a3412; background: #fff7ed; border-color: #fed7aa; }
  .sev-medium { color: #854d0e; background: #fefce8; border-color: #fde68a; } .sev-low { color: #1e40af; background: #eff6ff; border-color: #bfdbfe; }
  .sev-info { color: #374151; background: #f3f4f6; border-color: #d1d5db; }
  .big { font-size: 18pt; font-weight: 700; margin-top: 2px; }
  .issue { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; margin: 10px 0; break-inside: avoid-page; }
  .issue-head { display: flex; gap: 8px; align-items: center; font-size: 8.5pt; color: #4b5563; }
  .evidence { background: #f9fafb; border-radius: 4px; padding: 6px 8px; margin: 6px 0; font-size: 8.5pt; }
  dl { margin: 4px 0 0; } dt { font-weight: 600; color: #374151; } dd { margin: 0 0 4px; white-space: pre-wrap; word-break: break-word; } dd.code, pre { font-family: Consolas, Menlo, monospace; font-size: 8pt; }
  pre { background: #111827; color: #f9fafb; padding: 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  pre .muted { color: #9ca3af; }
  figure { margin: 8px 0; break-inside: avoid; } figure img { width: 100%; border: 1px solid #e5e7eb; } figcaption { font-size: 8pt; color: #6b7280; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  ul.lim li { margin-bottom: 3px; }
  .cover { border-bottom: 3px solid #4f46e5; padding-bottom: 10px; margin-bottom: 12px; }
</style></head><body>
<div class="cover">
  <div class="muted">${esc(brand)} · Website audit report</div>
  <h1>${esc(s.websiteName)}</h1>
  <div>${esc(s.websiteUrl)}</div>
</div>
<table class="meta">
  <tr><td>Scan date</td><td>${esc(fmtDate(s.startedAt ?? s.createdAt))}</td></tr>
  <tr><td>Duration</td><td>${esc(fmtDuration(s.durationMs))}</td></tr>
  <tr><td>Scan type</td><td>${esc(s.kind === 'full' ? 'Full scan' : s.kind === 'quick' ? 'Quick scan' : 'Verification scan')}</td></tr>
  <tr><td>Scope</td><td>${s.summary?.pagesScanned ?? 0} page(s) scanned of ${s.summary?.pagesDiscovered ?? 0} found${(s.summary?.pagesDiscovered ?? 0) > (s.summary?.pagesScanned ?? 0) ? ` (page limit ${s.config.maxPages})` : ' (all pages found)'}; viewports: ${esc(s.config.viewports.map((v) => VIEWPORTS[v].label).join(', '))}</td></tr>
  <tr><td>Checks</td><td>${esc(s.config.checks.map((c) => CATEGORY_INFO[c].label).join(', '))}</td></tr>
  <tr><td>Report generated</td><td>${esc(fmtDate(r.generatedAt))}</td></tr>
</table>

<h2>Summary</h2>
<p>This scan found <strong>${r.verification.confirmed}</strong> confirmed issue(s) on the pages tested${r.verification.needsManualReview ? `, plus ${r.verification.needsManualReview} item(s) that need manual review` : ''}${r.verification.pendingVerification ? ` and ${r.verification.pendingVerification} pending verification` : ''}${r.verification.needsManualReview || r.verification.pendingVerification ? ' (not counted as defects)' : ''}${s.summary ? `; ${s.summary.newIssues} new, ${s.summary.reopenedIssues} reopened, and ${s.summary.resolvedIssues} previously reported issue(s) resolved` : ''}.</p>
${r.aiSummary ? `<p><strong>AI summary</strong> <span class="muted">(${esc(r.aiSummary.provider)} ${esc(r.aiSummary.model)}, generated from the evidence below)</span></p><p>${esc(r.aiSummary.content).replace(/\n/g, '<br>')}</p>` : ''}
<p class="muted">Priority totals below count confirmed issues only.</p>
<table><tr>${sevRow}</tr></table>
${verificationHtml(s.summary)}
${wordpressHtml(s.summary?.wordpress)}
${performanceHtml(r.performance)}

<h2>Results by category</h2>
<table><tr><th>Category</th><th>Test status</th><th>Pages tested</th><th>Issues</th><th>Notes</th></tr>
${r.checkRuns
  .filter((c) => c.status !== 'skipped' || s.config.checks.includes(c.category))
  .map((c) => {
    const n = r.byCategory.find((b) => b.category === c.category)?.total ?? 0;
    return `<tr><td>${esc(CATEGORY_INFO[c.category].label)}</td><td>${esc(c.status)}</td><td>${c.pagesTested}</td><td>${n}</td><td class="muted">${esc(c.detail.slice(0, 300))}</td></tr>`;
  })
  .join('')}
</table>

${r.previous ? `<h2>Compared with the previous scan</h2><p>Previous full or quick scan: ${esc(fmtDate(r.previous.finishedAt))} with ${r.previous.summary?.issuesDetected ?? '—'} issue(s) detected.
Resolved in this scan: ${r.resolved.length}. Reopened: ${r.reopened.length}. New: ${r.issues.filter((i) => i.changeInScan === 'new').length}.</p>
${r.resolved.length ? `<table><tr><th>Resolved issue</th><th>Severity</th></tr>${r.resolved.map((i) => `<tr><td>${esc(i.title)}</td><td>${esc(SEVERITY_LABELS[i.severity])}</td></tr>`).join('')}</table>` : ''}` : ''}

<h2>Top priorities</h2>
${r.topPriorities.length ? `<table><tr><th>#</th><th>Issue</th><th>Severity</th><th>Pages</th></tr>${r.topPriorities.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.title)}</td><td><span class="sev sev-${i.severity}">${esc(SEVERITY_LABELS[i.severity])}</span></td><td>${i.affectedCount}</td></tr>`).join('')}</table>` : '<p>No actionable issues of low severity or above.</p>'}

<h2>Pages tested</h2>
<table><tr><th>URL</th><th>HTTP</th><th>Response</th><th>Findings</th></tr>
${r.pages.map((p) => `<tr><td>${esc(p.url)}${p.error ? `<div class="muted">${esc(p.error)}</div>` : ''}</td><td>${p.statusCode ?? '—'}</td><td>${p.loadMs ?? '—'} ms</td><td>${p.findings}</td></tr>`).join('')}
</table>

${thumbs.length ? `<h2>Screenshot evidence</h2><div class="grid">${thumbs.join('')}</div>` : ''}

<h2>Issue details</h2>
${r.issues.map(issueBlock).join('')}

${r.notCompleted.length ? `<h2>Tests not completed</h2><table><tr><th>Category</th><th>Status</th><th>Reason</th></tr>${r.notCompleted.map((c) => `<tr><td>${esc(CATEGORY_INFO[c.category].label)}</td><td>${esc(c.status)}</td><td>${esc(c.detail)}</td></tr>`).join('')}</table>` : ''}

<h2>Limitations</h2>
<ul class="lim">${r.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</body></html>`;
}

export async function renderPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ javaScriptEnabled: false, offline: true });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:7pt;color:#9ca3af;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await ctx.close();
  }
}
