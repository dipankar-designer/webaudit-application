// Assembles the full report for one scan from stored data only.

import {
  CATEGORIES,
  emptySeverityCounts,
  type Category,
  type FindingDTO,
  type ReportDTO,
  type ReportIssueDTO,
  type ReportPageDTO,
  type ScanSummary,
  type Severity,
  type ViewportName,
} from '@wpcg/shared';
import { one, query } from '../db/pool.js';
import { notFound } from '../http/errors.js';
import { ISSUE_SELECT, SEVERITY_ORDER_SQL, issueDTO, scanDTO, SCAN_SELECT, type IssueRow, type ScanRow } from '../services/mappers.js';
import { scanDetails } from '../routes/scans.js';
import { performanceSummaries } from './performanceSummary.js';

export const STANDARD_LIMITATIONS = [
  'Automated accessibility testing finds only part of the barriers people face. These results cannot establish WCAG conformance; manual testing with a keyboard and assistive technology is still required.',
  'Only publicly reachable pages were tested, without logging in. Forms were inspected but never submitted, and no purchases or messages were made.',
  'Results are a snapshot of the pages at scan time. Personalised, rotating or time-based content can differ between visits.',
  'Performance numbers are Lighthouse lab measurements from a single run. They are not real-user (field) Core Web Vitals and can vary between runs.',
  'SEO results are technical observations. They do not predict search rankings.',
  'Security results are passive observations of public responses (HTTPS, headers, mixed content). This is not a penetration test or a vulnerability scan.',
  'Screenshot comparisons can flag differences caused by adverts, animations, dates, cookie banners or font loading. Review each difference before acting.',
];

export async function buildReport(scanId: string, workspaceId: string): Promise<ReportDTO> {
  const scanRow = await one<ScanRow>(`${SCAN_SELECT} WHERE s.id = $1 AND s.workspace_id = $2`, [scanId, workspaceId]);
  if (!scanRow) throw notFound('Scan');
  const ws = await one<{ name: string; report_brand_name: string | null }>('SELECT name, report_brand_name FROM workspaces WHERE id = $1', [workspaceId]);
  const details = await scanDetails(scanId);

  // Issues detected in this scan, with their state as of now, most severe first.
  const issueRows = await query<IssueRow & { details: Record<string, unknown> }>(
    `${ISSUE_SELECT.replace('SELECT i.id,', 'SELECT i.details, i.id,')}
      WHERE i.workspace_id = $1 AND EXISTS (SELECT 1 FROM findings f WHERE f.issue_id = i.id AND f.scan_id = $2)
      ORDER BY ${SEVERITY_ORDER_SQL}, i.category, i.title`,
    [workspaceId, scanId],
  );
  // Affected URLs for the report must come from this scan, not from the issue's latest scan.
  const findingRows = await query<{ id: string; issue_id: string; page_url: string; viewport: ViewportName | null; evidence: FindingDTO['evidence']; created_at: string }>(
    'SELECT id, issue_id, page_url, viewport, evidence, created_at FROM findings WHERE scan_id = $1 ORDER BY page_url',
    [scanId],
  );
  const byIssue = new Map<string, typeof findingRows>();
  for (const f of findingRows) byIssue.set(f.issue_id, [...(byIssue.get(f.issue_id) ?? []), f]);

  const events = await query<{ issue_id: string; to_status: string; reason: string }>(
    'SELECT issue_id, to_status, reason FROM issue_events WHERE scan_id = $1',
    [scanId],
  );
  const newIds = new Set(events.filter((e) => e.reason.startsWith('First detected')).map((e) => e.issue_id));
  const reopenedIds = new Set(events.filter((e) => e.to_status === 'reopened').map((e) => e.issue_id));
  // Regrouped ("Merged:") or reclassified ("Reclassified:") records were never fixed, so they are not listed as resolved.
  const resolvedIds = events.filter((e) => e.to_status === 'resolved' && !/^(Merged|Reclassified):/.test(e.reason)).map((e) => e.issue_id);

  const issues: ReportIssueDTO[] = issueRows.map((r) => {
    const fs = byIssue.get(r.id) ?? [];
    const d = r.details as unknown as Pick<ReportIssueDTO, 'description' | 'detectionMethod' | 'confidence' | 'limitations' | 'severityReason' | 'remediation'>;
    const urls = [...new Set(fs.map((f) => f.page_url))];
    return {
      ...issueDTO(r),
      affectedUrls: urls.slice(0, 20),
      affectedCount: urls.length,
      description: d.description,
      detectionMethod: d.detectionMethod,
      confidence: d.confidence,
      limitations: d.limitations,
      severityReason: d.severityReason,
      remediation: d.remediation,
      evidence: fs.slice(0, 5).map((f) => ({ id: f.id, scanId, pageUrl: f.page_url, viewport: f.viewport, evidence: f.evidence, detectedAt: f.created_at })),
      changeInScan: newIds.has(r.id) ? 'new' : reopenedIds.has(r.id) ? 'reopened' : 'existing',
    };
  });

  const severity = emptySeverityCounts();
  const cat = new Map<Category, { total: number; bySeverity: ReturnType<typeof emptySeverityCounts> }>();
  // Severity totals count confirmed defects only; manual-review and pending items are counted apart.
  const verification = { confirmed: 0, needsManualReview: 0, pendingVerification: 0 };
  for (const i of issues) {
    if (i.status === 'needs_review') verification.needsManualReview++;
    else if (i.status === 'inconclusive' || i.status === 'not_tested') verification.pendingVerification++;
    else {
      verification.confirmed++;
      severity[i.severity as Severity]++;
    }
    const c = cat.get(i.category) ?? { total: 0, bySeverity: emptySeverityCounts() };
    c.total++;
    c.bySeverity[i.severity as Severity]++;
    cat.set(i.category, c);
  }
  const byCategory = CATEGORIES.filter((c) => cat.has(c)).map((c) => ({ category: c, ...cat.get(c)! }));

  const topPriorities = issues
    .filter((i) => (i.status === 'open' || i.status === 'reopened') && i.severity !== 'info')
    .slice(0, 10);

  const resolved = resolvedIds.length
    ? (await query<IssueRow>(`${ISSUE_SELECT} WHERE i.workspace_id = $1 AND i.id = ANY($2::uuid[]) ORDER BY ${SEVERITY_ORDER_SQL}`, [workspaceId, resolvedIds])).map(issueDTO)
    : [];

  const prev = await one<{ id: string; finished_at: string | null; summary: ScanSummary | null }>(
    `SELECT id, finished_at, summary FROM scans
      WHERE website_id = $1 AND status = 'completed' AND created_at < $2 AND id <> $3 AND kind <> 'verification'
      ORDER BY created_at DESC LIMIT 1`,
    [scanRow.website_id, scanRow.created_at, scanId],
  );

  const ai = await one<{ content: string; provider: string; model: string; created_at: string }>(
    "SELECT content, provider, model, created_at FROM ai_outputs WHERE scan_id = $1 AND kind = 'report_summary' ORDER BY created_at DESC LIMIT 1",
    [scanId],
  );

  const notCompleted = details.checkRuns.filter((r) => r.status !== 'completed' && r.status !== 'skipped');
  const limitations = [...STANDARD_LIMITATIONS, ...(scanRow.summary?.notes ?? [])];

  return {
    generatedAt: new Date().toISOString(),
    brandName: ws?.report_brand_name ?? null,
    workspaceName: ws?.name ?? '',
    scan: scanDTO(scanRow),
    checkRuns: details.checkRuns,
    pages: details.pages as ReportPageDTO[],
    severity,
    verification,
    byCategory,
    topPriorities,
    issues,
    resolved,
    reopened: issues.filter((i) => i.changeInScan === 'reopened'),
    previous: prev ? { scanId: prev.id, finishedAt: prev.finished_at, summary: prev.summary } : null,
    visual: details.visual,
    limitations,
    notCompleted,
    aiSummary: ai ? { content: ai.content, provider: ai.provider, model: ai.model, createdAt: ai.created_at } : null,
    performance: await performanceSummaries(scanId, scanRow.website_id, workspaceId, scanRow.created_at),
  };
}
