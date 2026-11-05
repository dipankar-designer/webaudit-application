// Scheduled full audit: runs the existing audit engine (accessibility, SEO, links, images,
// JavaScript, responsive, Lighthouse, and visual comparison against the website's latest
// baseline) on a weekly cadence, and turns the finished scan into a watcher result.

import { FULL_SCAN_CHECKS, PLANS, type PlanId, type Priority, type ScanConfig, type ScanSummary } from '@wpcg/shared';
import { one } from '../../db/pool.js';
import { AppError } from '../../http/errors.js';
import { createScan } from '../../routes/scans.js';
import { ensureWebsite } from '../../routes/websites.js';
import type { CheckRunner } from '../types.js';

interface AuditBaseline {
  pendingScanId?: string;
}

export const auditCheck: CheckRunner = async ({ monitor, baseline }) => {
  const b = (baseline ?? {}) as AuditBaseline;

  if (b.pendingScanId) {
    const scan = await one<{ status: string; summary: ScanSummary | null; error: string | null }>('SELECT status, summary, error FROM scans WHERE id = $1', [b.pendingScanId]);
    if (scan && (scan.status === 'queued' || scan.status === 'running')) return { status: 'up', summary: 'Audit scan in progress', deferSeconds: 120, baseline: b };
    const scanId = b.pendingScanId;
    const detail = { scanId, scanStatus: scan?.status ?? 'deleted' };
    if (!scan || scan.status !== 'completed') return { status: 'error', summary: `Monitoring error: the scheduled audit scan did not complete (${scan?.error ?? scan?.status ?? 'scan deleted'})`, detail, baseline: {} };
    const s = scan.summary!;
    const serious = s.bySeverity.critical + s.bySeverity.high;
    const sev: Priority | null = s.bySeverity.critical ? 'p1' : s.bySeverity.high ? 'p2' : s.newIssues > 0 ? 'p3' : null;
    const summary = `${s.issuesDetected} issue(s) on ${s.pagesScanned} page(s): ${s.bySeverity.critical} critical, ${s.bySeverity.high} high; ${s.newIssues} new, ${s.resolvedIssues} resolved since the previous scan`;
    const full = { ...detail, summary: s };
    if (!sev) return { status: 'up', summary, detail: full, baseline: {} };
    return { status: 'warning', severity: sev, summary: serious ? summary : `${summary} (only lower-priority issues are new)`, detail: full, baseline: {} };
  }

  // Start a new audit scan.
  const ws = await one<{ plan: PlanId }>('SELECT plan FROM workspaces WHERE id = $1', [monitor.workspace_id]);
  const plan = PLANS[ws?.plan ?? 'free'];
  const url = new URL(monitor.url!);
  url.search = '';
  const owner = await one<{ created_by: string | null }>('SELECT created_by FROM monitors WHERE id = $1', [monitor.id]);
  const websiteId = monitor.website_id ?? (await ensureWebsite(monitor.workspace_id, ws?.plan ?? 'free', owner?.created_by ?? null, url).catch(() => null));
  if (!websiteId) return { status: 'not_assessed', summary: 'Not assessed: the website could not be added (website limit reached)' };
  const baselineRow = plan.visualComparison
    ? await one<{ id: string }>('SELECT id FROM baselines WHERE website_id = $1 ORDER BY created_at DESC LIMIT 1', [websiteId])
    : null;
  const cfg: ScanConfig = {
    kind: 'full',
    viewports: ['desktop', 'mobile'],
    maxPages: Math.min(plan.maxPagesPerScan, 10),
    pageMode: 'discover',
    selectedUrls: [],
    checks: FULL_SCAN_CHECKS.filter((c) => c !== 'visual' || !!baselineRow),
    baselineId: baselineRow?.id ?? null,
    visualCompare: !!baselineRow,
    visualThresholdPct: 1,
    pixelTolerance: 0.1,
    ignoreSelectors: [],
    checkExternalLinks: false,
    verifyIssueIds: [],
  };
  try {
    const scanId = await createScan(monitor.workspace_id, ws?.plan ?? 'free', websiteId, owner?.created_by ?? null, cfg);
    return { status: 'up', summary: 'Audit scan queued', deferSeconds: 120, baseline: { pendingScanId: scanId } };
  } catch (e) {
    if (e instanceof AppError) return { status: 'not_assessed', summary: `Not assessed: ${e.message}` };
    throw e;
  }
};
