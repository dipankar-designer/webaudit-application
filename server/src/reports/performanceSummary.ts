// Performance section of the report (web view, PDF): the home page's Lighthouse results per device, the
// highest-impact failing audits, page weight, test conditions and the comparison with the previous scan.
// Built from stored reports only.

import type { LighthouseReportDTO, PerformanceSummaryDTO, ViewportName } from '@wpcg/shared';
import { one, query } from '../db/pool.js';
import { COMPARED_METRICS, compareReports } from './lighthouseCompare.js';

type Stored = Omit<LighthouseReportDTO, 'pageUrl' | 'viewport'>;

function conditions(r: Stored): string {
  const t = r.testConfig;
  if (!t) return r.environment.join(' · ');
  const device = t.formFactor === 'mobile' ? 'Emulated mobile' : 'Emulated desktop';
  const net = t.rttMs !== null && t.throughputKbps !== null ? `${t.rttMs} ms RTT, ${(t.throughputKbps / 1024).toFixed(1)} Mbps` : 'no network throttling';
  return `${device}${t.screen ? ` ${t.screen.width}×${t.screen.height}` : ''}; ${t.throttlingMethod === 'simulate' ? 'simulated' : (t.throttlingMethod ?? '')} ${net}, ${t.cpuSlowdownMultiplier ?? 1}× CPU slowdown; ${t.runs > 1 ? `median of ${t.runs} runs` : 'single run'}; Lighthouse ${r.lighthouseVersion}. Lab test, not a real device.`;
}

export async function performanceSummaries(scanId: string, websiteId: string, workspaceId: string, createdAt: string): Promise<PerformanceSummaryDTO[]> {
  const rows = await query<{ page_url: string; viewport: ViewportName; report: Stored }>(
    'SELECT page_url, viewport, report FROM lighthouse_reports WHERE scan_id = $1 ORDER BY length(page_url), page_url, viewport',
    [scanId],
  );
  const home = rows[0]?.page_url;
  const out: PerformanceSummaryDTO[] = [];
  for (const row of rows.filter((x) => x.page_url === home)) {
    const r = row.report;
    if (!Array.isArray(r?.categories)) continue;
    const prev = await one<{ report: Stored; scan_id: string; finished_at: string | null }>(
      `SELECT l.report, s.id AS scan_id, s.finished_at FROM lighthouse_reports l JOIN scans s ON s.id = l.scan_id
        WHERE s.website_id = $1 AND s.workspace_id = $2 AND s.status = 'completed' AND s.created_at < $3 AND l.page_url = $4 AND l.viewport = $5
        ORDER BY s.created_at DESC LIMIT 1`,
      [websiteId, workspaceId, createdAt, row.page_url, row.viewport],
    );
    const cmp = compareReports(row.viewport, row.page_url, { report: r, scanId, finishedAt: null }, prev ? { report: prev.report, scanId: prev.scan_id, finishedAt: prev.finished_at } : null);
    const perfIds = r.categories.find((c) => c.id === 'performance')?.groups.flatMap((g) => g.auditIds) ?? [];
    const impact = (id: string) => {
      const s = r.audits[id]?.metricSavings ?? {};
      return Math.max(s.LCP ?? 0, s.FCP ?? 0, (s.TBT ?? 0) * 0.5, (s.CLS ?? 0) * 10_000);
    };
    const failing = perfIds
      .filter((id) => !(COMPARED_METRICS as readonly string[]).includes(id))
      .map((id) => r.audits[id])
      .filter((a) => a && a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative')
      .sort((a, b) => impact(b.id) - impact(a.id))
      .slice(0, 5);
    out.push({
      viewport: row.viewport,
      pageUrl: row.page_url,
      scores: cmp.current.scores,
      metrics: COMPARED_METRICS.map((id) => ({ id, title: r.audits[id]?.title ?? id, displayValue: r.audits[id]?.displayValue ?? null, score: r.audits[id]?.score ?? null })),
      topIssues: failing.map((a) => ({
        title: a.title,
        displayValue: a.displayValue ?? null,
        lighthouseSavings: Object.entries(a.metricSavings ?? {})
          .filter(([, v]) => v > 0)
          .map(([k, v]) => (k === 'CLS' ? `CLS ${v.toFixed(3)}` : `${k} ${Math.round(v)} ms`))
          .join(', ') || null,
      })),
      totalTransferSize: cmp.current.totalTransferSize,
      totalRequests: cmp.current.totalRequests,
      conditions: conditions(r),
      comparison: cmp.previous
        ? {
            previousScanId: cmp.previous.scanId,
            previousFinishedAt: cmp.previous.scanFinishedAt,
            previousPerformance: cmp.previous.scores.performance ?? null,
            previousLcpMs: cmp.previous.metrics['largest-contentful-paint'] ?? null,
            currentLcpMs: cmp.current.metrics['largest-contentful-paint'] ?? null,
            previousTransferSize: cmp.previous.totalTransferSize,
            newlyFailing: cmp.newlyFailing.map((a) => a.title),
            nowPassing: cmp.nowPassing.map((a) => a.title),
            notes: cmp.conditionNotes,
          }
        : null,
    });
  }
  return out;
}
