import { Router } from 'express';
import { z } from 'zod';
import { CATEGORIES, ISSUE_STATUSES, SEVERITIES, type FindingDTO, type IssueDetailDTO, type IssueEventDTO, type ScanConfig, type ViewportName } from '@wpcg/shared';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { badRequest, conflict, notFound, parse } from '../http/errors.js';
import { ISSUE_SELECT, SEVERITY_ORDER_SQL, issueDTO, type IssueRow } from '../services/mappers.js';
import { createScan } from './scans.js';

export const issuesRouter = Router();

issuesRouter.get('/', async (req, res) => {
  const q = parse(
    z.object({
      status: z.union([z.enum(ISSUE_STATUSES), z.literal('active'), z.literal('review'), z.literal('all')]).default('active'),
      severity: z.enum(SEVERITIES).optional(),
      category: z.enum(CATEGORIES).optional(),
      websiteId: z.string().uuid().optional(),
      scanId: z.string().uuid().optional(),
      q: z.string().trim().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    req.query,
  );
  const params: unknown[] = [req.auth!.workspace.id];
  const where = ['i.workspace_id = $1'];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (q.status === 'active') where.push("i.status <> 'resolved'");
  // "Awaiting review" on the overview: the same three statuses its count includes.
  else if (q.status === 'review') where.push("i.status IN ('needs_review','inconclusive','not_tested')");
  else if (q.status !== 'all') where.push(`i.status = ${p(q.status)}`);
  if (q.severity) where.push(`i.severity = ${p(q.severity)}`);
  if (q.category) where.push(`i.category = ${p(q.category)}`);
  if (q.websiteId) where.push(`i.website_id = ${p(q.websiteId)}`);
  if (q.scanId) where.push(`EXISTS (SELECT 1 FROM findings f2 WHERE f2.issue_id = i.id AND f2.scan_id = ${p(q.scanId)})`);
  if (q.q) where.push(`(i.title ILIKE ${p(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`)} OR i.rule_id ILIKE $${params.length})`);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = await one<{ n: number }>(`SELECT count(*) AS n FROM issues i ${whereSql}`, params);
  const rows = await query<IssueRow>(
    `${ISSUE_SELECT} ${whereSql} ORDER BY ${SEVERITY_ORDER_SQL}, i.last_detected_at DESC LIMIT ${p(q.limit)} OFFSET ${p(q.offset)}`,
    params,
  );
  res.json({ items: rows.map(issueDTO), total: Number(total?.n ?? 0) });
});

async function ownedIssue(id: string, workspaceId: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Issue');
  const row = await one<IssueRow & { details: Record<string, unknown>; coverage_keys: string[] }>(
    `${ISSUE_SELECT.replace('SELECT i.id,', 'SELECT i.details, i.coverage_keys, i.id,')} WHERE i.id = $1 AND i.workspace_id = $2`,
    [id, workspaceId],
  );
  if (!row) throw notFound('Issue');
  return row;
}

issuesRouter.get('/:id', async (req, res) => {
  const row = await ownedIssue(String(req.params.id), req.auth!.workspace.id);
  const findings = await query<{ id: string; scan_id: string; page_url: string; viewport: ViewportName | null; evidence: FindingDTO['evidence']; created_at: string }>(
    `SELECT id, scan_id, page_url, viewport, evidence, created_at FROM findings
      WHERE issue_id = $1 AND scan_id = $2 ORDER BY page_url LIMIT 50`,
    [row.id, row.last_scan_id],
  );
  const events = await query<{ id: string; scan_id: string | null; from_status: IssueEventDTO['fromStatus']; to_status: IssueEventDTO['toStatus']; reason: string; created_at: string }>(
    'SELECT id, scan_id, from_status, to_status, reason, created_at FROM issue_events WHERE issue_id = $1 ORDER BY created_at DESC LIMIT 100',
    [row.id],
  );
  const d = row.details as {
    description: string;
    detectionMethod: string;
    confidence: IssueDetailDTO['confidence'];
    limitations: string | null;
    severityReason: string;
    remediation: IssueDetailDTO['remediation'];
    technical: { label: string; value: string }[];
    target?: string;
    scope?: string;
  };
  const dto: IssueDetailDTO = {
    ...issueDTO(row),
    description: d.description,
    detectionMethod: d.detectionMethod,
    confidence: d.confidence,
    limitations: d.limitations,
    severityReason: d.severityReason,
    remediation: d.remediation,
    technical: [
      { label: 'Rule ID', value: row.rule_id },
      ...(d.scope ? [{ label: 'Grouping', value: d.scope === 'page' ? 'One issue per page' : d.scope === 'site' ? 'One issue per site' : `One issue per target: ${d.target}` }] : []),
      ...(d.technical ?? []),
      { label: 'Re-test conditions', value: row.coverage_keys.map((k) => k.split('|').map((p, i) => (i === 1 && p === '-' ? 'any viewport' : p)).join(' · ')).join('\n') || '—' },
    ],
    findings: findings.map((f) => ({ id: f.id, scanId: f.scan_id, pageUrl: f.page_url, viewport: f.viewport, evidence: f.evidence, detectedAt: f.created_at })),
    events: events.map((e) => ({ id: e.id, scanId: e.scan_id, fromStatus: e.from_status, toStatus: e.to_status, reason: e.reason, createdAt: e.created_at })),
    aiAvailable: config.aiConfigured && req.auth!.workspace.aiEnabled,
  };
  res.json(dto);
});

/** Users may flag an issue for review or return it to open; "resolved" only comes from a verification scan. */
issuesRouter.patch('/:id', async (req, res) => {
  const body = parse(z.object({ status: z.enum(['open', 'needs_review']), note: z.string().trim().max(500).optional() }), req.body);
  const row = await ownedIssue(String(req.params.id), req.auth!.workspace.id);
  if (row.status === 'resolved') throw conflict('Resolved issues reopen automatically if a later scan detects them again.');
  if (row.status === body.status) return void res.json({ ok: true });
  await query('UPDATE issues SET status = $2, updated_at = now() WHERE id = $1', [row.id, body.status]);
  await query('INSERT INTO issue_events (issue_id, actor_user_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5)', [
    row.id,
    req.auth!.user.id,
    row.status,
    body.status,
    `Changed by ${req.auth!.user.name}${body.note ? `: ${body.note}` : '.'}`,
  ]);
  res.json({ ok: true });
});

/** Starts a verification scan that re-runs this issue's check on the same pages and viewports. */
issuesRouter.post('/:id/verify', async (req, res) => {
  parse(z.object({ authorised: z.literal(true, { errorMap: () => ({ message: 'Confirm that you are authorised to scan this website' }) }) }), req.body);
  const auth = req.auth!;
  const row = await ownedIssue(String(req.params.id), auth.workspace.id);
  if (row.status === 'resolved') throw badRequest('This issue is already resolved.');
  const pages = [...new Set(row.coverage_keys.map((k) => k.split('|').slice(2).join('|')).filter(Boolean))];
  const viewports = [...new Set(row.coverage_keys.map((k) => k.split('|')[1]).filter((v): v is ViewportName => v === 'desktop' || v === 'mobile'))];
  const last = await one<{ config: ScanConfig }>('SELECT config FROM scans WHERE id = $1', [row.last_scan_id]);
  if (!pages.length || !last) throw badRequest('This issue has no recorded test conditions to repeat. Run a new full scan instead.');
  const checks = [...new Set(['availability', row.category])] as ScanConfig['checks'];
  const cfg: ScanConfig = {
    kind: 'verification',
    viewports: viewports.length ? viewports : last.config.viewports,
    maxPages: Math.min(pages.length, 200),
    pageMode: 'selected',
    selectedUrls: pages.slice(0, 200),
    checks,
    baselineId: row.category === 'visual' ? last.config.baselineId : null,
    visualCompare: row.category === 'visual' && !!last.config.baselineId,
    visualThresholdPct: last.config.visualThresholdPct,
    pixelTolerance: last.config.pixelTolerance,
    ignoreSelectors: last.config.ignoreSelectors,
    checkExternalLinks: row.category === 'links' ? true : last.config.checkExternalLinks,
    verifyIssueIds: [row.id],
  };
  const scanId = await createScan(auth.workspace.id, auth.workspace.plan, row.website_id, auth.user.id, cfg);
  res.status(201).json({ scanId });
});
