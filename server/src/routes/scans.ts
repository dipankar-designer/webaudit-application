import { Router } from 'express';
import { z } from 'zod';
import {
  CATEGORIES,
  FULL_SCAN_CHECKS,
  PLANS,
  QUICK_SCAN_CHECKS,
  type Category,
  type CheckRunDTO,
  type FieldDataDTO,
  type ScanConfig,
  type ScanPageDTO,
  type LighthouseIndexDTO,
  type LighthouseReportDTO,
  type ViewportName,
  type VisualComparisonDTO,
} from '@wpcg/shared';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { badRequest, conflict, notFound, parse, quotaExceeded } from '../http/errors.js';
import { safeFetch } from '../security/safeFetch.js';
import { BlockedTargetError, effectivePort, resolvePublic, validateScanUrl } from '../security/ssrf.js';
import { SCAN_SELECT, scanDTO, type ScanRow } from '../services/mappers.js';
import { consumeScan, usageFor } from '../services/quota.js';
import { fetchFieldData } from '../services/crux.js';
import { compareReports } from '../reports/lighthouseCompare.js';
import { deleteScanFiles } from '../storage/files.js';
import { ensureWebsite, vetWebsiteUrl } from './websites.js';

export const scansRouter = Router();

/** CSS-only selectors for regions hidden in screenshots. No Playwright engines, no script. */
const SAFE_SELECTOR = /^[A-Za-z0-9\s.#\-_[\]="':()>+~*,^$|]{1,200}$/;

const createSchema = z.object({
  websiteId: z.string().uuid().optional(),
  url: z.string().max(2048).optional(),
  name: z.string().trim().max(100).optional(),
  kind: z.enum(['quick', 'full']),
  viewports: z.array(z.enum(['desktop', 'mobile'])).min(1).max(2),
  maxPages: z.number().int().min(1).max(1000),
  pageMode: z.enum(['discover', 'selected']).default('discover'),
  selectedUrls: z.array(z.string().max(2048)).max(200).default([]),
  checks: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).optional(),
  baselineId: z.string().uuid().nullable().optional(),
  visualCompare: z.boolean().default(false),
  visualThresholdPct: z.number().min(0).max(100).default(1),
  pixelTolerance: z.number().min(0).max(1).default(0.1),
  ignoreSelectors: z.array(z.string().trim().regex(SAFE_SELECTOR, 'Only simple CSS selectors are allowed')).max(30).default([]),
  checkExternalLinks: z.boolean().default(false),
  authorised: z.literal(true, { errorMap: () => ({ message: 'Confirm that you are authorised to scan this website' }) }),
});

scansRouter.post('/preflight', async (req, res) => {
  const body = parse(z.object({ url: z.string().min(1).max(2048) }), req.body);
  let u: URL;
  try {
    u = validateScanUrl(body.url);
    await resolvePublic(u.hostname, effectivePort(u));
  } catch (e) {
    if (e instanceof BlockedTargetError) return void res.json({ ok: false, message: e.message });
    throw e;
  }
  // Status and headers are enough here: a server that answers but streams its page slowly is reachable.
  // Same limit the scan gives each page, so the check does not give up sooner than the scan would.
  const probe = await safeFetch(u, { timeoutMs: config.SCAN_PAGE_TIMEOUT_MS, readBody: () => false, headersOnly: true });
  const notes: string[] = [];
  if (probe.failure)
    notes.push(
      probe.failure.kind === 'timeout'
        ? `The start page did not start responding within ${Math.round(config.SCAN_PAGE_TIMEOUT_MS / 1000)} s (no HTTP response at all). The server may be down or overloaded right now; try again in a few minutes. You can still run the scan; pages that do not respond are reported as availability problems.`
        : `The start page could not be reached: ${probe.failure.message} You can still run the scan; it will report this as an availability problem.`,
    );
  else if (probe.status && probe.status >= 400) notes.push(`The start page returned HTTP ${probe.status}.`);
  // Time to the first response across all redirect hops.
  const waitedMs = probe.durationMs;
  if (!probe.failure && waitedMs >= 3000)
    notes.push(
      `The server is slow: it took ${(waitedMs / 1000).toFixed(1)} s to start responding (fast sites answer in well under 1 s). The scan will still run, but slow pages can time out after ${Math.round(config.SCAN_PAGE_TIMEOUT_MS / 1000)} s.`,
    );
  if (probe.finalUrl !== u.href && !probe.failure) notes.push(`The address redirects to ${probe.finalUrl}.`);
  if (u.protocol === 'http:') notes.push('This address uses http://. The scan will check whether HTTPS is available.');
  res.json({
    ok: true,
    normalizedUrl: u.href,
    host: u.hostname,
    reachable: !probe.failure,
    status: probe.status,
    responseMs: probe.failure ? null : waitedMs,
    finalUrl: probe.finalUrl,
    notes,
  });
});

scansRouter.post('/', async (req, res) => {
  const body = parse(createSchema, req.body);
  const auth = req.auth!;
  const plan = PLANS[auth.workspace.plan];

  if (body.maxPages > Math.min(plan.maxPagesPerScan, config.SCAN_HARD_MAX_PAGES))
    throw quotaExceeded(`Your ${plan.name} plan scans up to ${Math.min(plan.maxPagesPerScan, config.SCAN_HARD_MAX_PAGES)} pages per scan.`);
  if (body.visualCompare && !plan.visualComparison) throw quotaExceeded(`Visual comparison is available on the Pro and Agency plans.`);

  let websiteId = body.websiteId;
  if (websiteId) {
    const w = await one('SELECT 1 FROM websites WHERE id = $1 AND workspace_id = $2', [websiteId, auth.workspace.id]);
    if (!w) throw notFound('Website');
  } else {
    if (!body.url) throw badRequest('Enter the website address to scan.');
    const url = await vetWebsiteUrl(body.url);
    websiteId = await ensureWebsite(auth.workspace.id, auth.workspace.plan, auth.user.id, url, body.name);
  }

  if (body.baselineId) {
    const b = await one('SELECT 1 FROM baselines WHERE id = $1 AND website_id = $2 AND workspace_id = $3', [body.baselineId, websiteId, auth.workspace.id]);
    if (!b) throw badRequest('The selected baseline does not belong to this website.');
  }
  if (body.visualCompare && !body.baselineId) throw badRequest('Choose a baseline to compare screenshots against.');
  if (body.pageMode === 'selected' && !body.selectedUrls.length) throw badRequest('Add at least one page URL, or choose "discover pages".');

  let checks: Category[] = body.checks ?? (body.kind === 'full' ? [...FULL_SCAN_CHECKS] : [...QUICK_SCAN_CHECKS]);
  if (!body.visualCompare) checks = checks.filter((c) => c !== 'visual');
  else if (!checks.includes('visual')) checks.push('visual');
  if (!checks.includes('availability')) checks.unshift('availability');

  const cfg: ScanConfig = {
    kind: body.kind,
    viewports: [...new Set(body.viewports)],
    maxPages: body.maxPages,
    pageMode: body.pageMode,
    selectedUrls: body.pageMode === 'selected' ? body.selectedUrls : [],
    checks,
    baselineId: body.baselineId ?? null,
    visualCompare: body.visualCompare,
    visualThresholdPct: body.visualThresholdPct,
    pixelTolerance: body.pixelTolerance,
    ignoreSelectors: body.ignoreSelectors,
    checkExternalLinks: body.checkExternalLinks,
    verifyIssueIds: [],
  };

  const scanId = await createScan(auth.workspace.id, auth.workspace.plan, websiteId, auth.user.id, cfg);
  const row = await one<ScanRow>(`${SCAN_SELECT} WHERE s.id = $1`, [scanId]);
  res.status(201).json(scanDTO(row!));
});

export async function createScan(workspaceId: string, plan: keyof typeof PLANS, websiteId: string, userId: string | null, cfg: ScanConfig): Promise<string> {
  return tx(async (c) => {
    // Per-website lock first (then consumeScan's workspace lock, always in this order), so parallel
    // requests cannot all pass the two-active-scans check.
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`scans:${websiteId}`], c);
    const active = await one<{ n: number }>("SELECT count(*) AS n FROM scans WHERE website_id = $1 AND status IN ('queued','running')", [websiteId], c);
    if (Number(active?.n ?? 0) >= 2) throw conflict('Two scans of this website are already queued or running. Wait for one to finish.');
    await consumeScan(workspaceId, plan, c);
    const row = await one<{ id: string }>(
      `INSERT INTO scans (workspace_id, website_id, created_by, kind, config, authorised_at, authorised_by) VALUES ($1,$2,$3,$4,$5, now(), $3) RETURNING id`,
      [workspaceId, websiteId, userId, cfg.kind, JSON.stringify(cfg)],
      c,
    );
    return row!.id;
  });
}

scansRouter.get('/', async (req, res) => {
  const q = parse(
    z.object({
      websiteId: z.string().uuid().optional(),
      status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    req.query,
  );
  const params: unknown[] = [req.auth!.workspace.id];
  let where = 'WHERE s.workspace_id = $1';
  if (q.websiteId) {
    params.push(q.websiteId);
    where += ` AND s.website_id = $${params.length}`;
  }
  if (q.status) {
    params.push(q.status);
    where += ` AND s.status = $${params.length}`;
  }
  const total = await one<{ n: number }>(`SELECT count(*) AS n FROM scans s ${where}`, params);
  params.push(q.limit, q.offset);
  const rows = await query<ScanRow>(`${SCAN_SELECT} ${where} ORDER BY s.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ items: rows.map(scanDTO), total: Number(total?.n ?? 0) });
});

async function ownedScan(id: string, workspaceId: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('Scan');
  const row = await one<ScanRow & { workspace_id: string }>(`${SCAN_SELECT.replace('SELECT s.id,', 'SELECT s.workspace_id, s.id,')} WHERE s.id = $1 AND s.workspace_id = $2`, [id, workspaceId]);
  if (!row) throw notFound('Scan');
  return row;
}

/** Pages of a scan with their screenshots; limit/offset page through them (Pages tested section). */
export async function scanPages(scanId: string, limit: number | null = null, offset = 0) {
  const pageRows = await query<{
    id: string;
    url: string;
    final_url: string | null;
    status_code: number | null;
    load_ms: number | null;
    title: string | null;
    error: string | null;
    source: string;
    lab_metrics: Record<string, unknown>;
    findings: number;
  }>(
    `SELECT p.id, p.url, p.final_url, p.status_code, p.load_ms, p.title, p.error, p.source, p.lab_metrics,
            (SELECT count(*) FROM findings f WHERE f.scan_id = p.scan_id AND f.page_url = p.url) AS findings
       FROM scan_pages p WHERE p.scan_id = $1 ORDER BY p.depth, p.created_at, p.url${limit ? ` LIMIT ${limit} OFFSET ${offset}` : ''}`,
    [scanId],
  );
  const shots = await query<{ id: string; page_id: string; viewport: 'desktop' | 'mobile'; width: number; height: number }>(
    'SELECT id, page_id, viewport, width, height FROM screenshots WHERE scan_id = $1 AND page_id = ANY($2::uuid[])',
    [scanId, pageRows.map((p) => p.id)],
  );
  const pages: (ScanPageDTO & { labMetrics: Record<string, unknown> })[] = pageRows.map((p) => ({
    id: p.id,
    url: p.url,
    finalUrl: p.final_url,
    statusCode: p.status_code,
    loadMs: p.load_ms,
    title: p.title,
    error: p.error,
    source: p.source,
    findings: Number(p.findings),
    labMetrics: p.lab_metrics,
    screenshots: shots
      .filter((s) => s.page_id === p.id)
      .map((s) => ({ id: s.id, viewport: s.viewport, width: s.width, height: s.height, url: `/api/files/screenshots/${s.id}` })),
  }));
  return pages;
}

export async function scanDetails(scanId: string) {
  const runs = await query<{ category: Category; status: CheckRunDTO['status']; pages_tested: number; detail: string; started_at: string | null; finished_at: string | null }>(
    'SELECT category, status, pages_tested, detail, started_at, finished_at FROM check_runs WHERE scan_id = $1',
    [scanId],
  );
  const order = new Map(CATEGORIES.map((c, i) => [c, i]));
  const checkRuns: CheckRunDTO[] = runs
    .sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99))
    .map((r) => ({
      category: r.category,
      status: r.status,
      pagesTested: r.pages_tested,
      detail: r.detail,
      durationMs: r.started_at && r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null,
    }));
  const pages = await scanPages(scanId);
  const comps = await query<{
    id: string;
    page_url: string;
    viewport: 'desktop' | 'mobile';
    status: VisualComparisonDTO['status'];
    diff_ratio: number | null;
    threshold_pct: number;
    pixel_tolerance: number;
    baseline_screenshot_id: string | null;
    current_screenshot_id: string | null;
    diff_path: string | null;
    note: string | null;
  }>('SELECT * FROM visual_comparisons WHERE scan_id = $1 ORDER BY page_url, viewport', [scanId]);
  const visual: VisualComparisonDTO[] = comps.map((c) => ({
    id: c.id,
    pageUrl: c.page_url,
    viewport: c.viewport,
    status: c.status,
    diffRatio: c.diff_ratio,
    thresholdPct: c.threshold_pct,
    pixelTolerance: c.pixel_tolerance,
    baselineImage: c.baseline_screenshot_id ? `/api/files/screenshots/${c.baseline_screenshot_id}` : null,
    currentImage: c.current_screenshot_id ? `/api/files/screenshots/${c.current_screenshot_id}` : null,
    diffImage: c.diff_path ? `/api/files/diffs/${c.id}` : null,
    note: c.note,
  }));
  return { checkRuns, pages, visual };
}

/** "Pages tested", one page of results at a time (the section pages through them without reloading). */
scansRouter.get('/:id/pages', async (req, res) => {
  const row = await ownedScan(String(req.params.id), req.auth!.workspace.id);
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(10), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const total = await one<{ n: number }>('SELECT count(*)::int AS n FROM scan_pages WHERE scan_id = $1', [row.id]);
  res.json({ items: await scanPages(row.id, q.limit, q.offset), total: total?.n ?? 0, limit: q.limit, offset: q.offset });
});

/** Which pages and viewports have a full Lighthouse report, with category scores. */
scansRouter.get('/:id/lighthouse', async (req, res) => {
  const row = await ownedScan(String(req.params.id), req.auth!.workspace.id);
  const rows = await query<{ page_url: string; viewport: ViewportName; scores: Record<string, number | null> }>(
    'SELECT page_url, viewport, scores FROM lighthouse_reports WHERE scan_id = $1 ORDER BY created_at',
    [row.id],
  );
  res.json(rows.map((r): LighthouseIndexDTO => ({ pageUrl: r.page_url, viewport: r.viewport, scores: r.scores })));
});

/** One full Lighthouse report (categories, groups, audits, screenshots). */
scansRouter.get('/:id/lighthouse/report', async (req, res) => {
  const row = await ownedScan(String(req.params.id), req.auth!.workspace.id);
  const q = parse(z.object({ page: z.string().max(2048), viewport: z.enum(['desktop', 'mobile']) }), req.query);
  const r = await one<{ report: Omit<LighthouseReportDTO, 'pageUrl' | 'viewport'> }>('SELECT report FROM lighthouse_reports WHERE scan_id = $1 AND page_url = $2 AND viewport = $3', [row.id, q.page, q.viewport]);
  if (!r) throw notFound('Lighthouse report');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.json({ ...r.report, pageUrl: q.page, viewport: q.viewport } satisfies LighthouseReportDTO);
});

/** This scan's Lighthouse report against the latest earlier completed scan of the same website, page and device. */
scansRouter.get('/:id/lighthouse/compare', async (req, res) => {
  const row = await ownedScan(String(req.params.id), req.auth!.workspace.id);
  const q = parse(z.object({ page: z.string().max(2048), viewport: z.enum(['desktop', 'mobile']) }), req.query);
  type Stored = Omit<LighthouseReportDTO, 'pageUrl' | 'viewport'>;
  const cur = await one<{ report: Stored }>('SELECT report FROM lighthouse_reports WHERE scan_id = $1 AND page_url = $2 AND viewport = $3', [row.id, q.page, q.viewport]);
  if (!cur) throw notFound('Lighthouse report');
  const prev = await one<{ report: Stored; scan_id: string; finished_at: string | null }>(
    `SELECT l.report, s.id AS scan_id, s.finished_at FROM lighthouse_reports l JOIN scans s ON s.id = l.scan_id
      WHERE s.website_id = $1 AND s.workspace_id = $2 AND s.status = 'completed' AND s.created_at < $3
        AND l.page_url = $4 AND l.viewport = $5
      ORDER BY s.created_at DESC LIMIT 1`,
    [row.website_id, req.auth!.workspace.id, row.created_at, q.page, q.viewport],
  );
  res.json(
    compareReports(q.viewport, q.page, { report: cur.report, scanId: row.id, finishedAt: row.finished_at }, prev ? { report: prev.report, scanId: prev.scan_id, finishedAt: prev.finished_at } : null),
  );
});

/**
 * Real-user Core Web Vitals (Chrome UX Report) for the scan's Lighthouse page and its origin. Fetched
 * on first view and kept with the scan; only a real answer from Google is stored, so a missing key
 * or a failed lookup is retried next time.
 */
scansRouter.get('/:id/field-data', async (req, res) => {
  const row = await ownedScan(String(req.params.id), req.auth!.workspace.id);
  const q = parse(z.object({ page: z.string().max(2048) }), req.query);
  // Only a page this scan measured, so the endpoint cannot be used to look up arbitrary sites.
  const measured = await one('SELECT 1 FROM lighthouse_reports WHERE scan_id = $1 AND page_url = $2 LIMIT 1', [row.id, q.page]);
  if (!measured) throw notFound('Lighthouse report');
  const stored = await one<{ page_url: string; data: FieldDataDTO }>('SELECT page_url, data FROM crux_field_data WHERE scan_id = $1', [row.id]);
  if (stored && stored.page_url === q.page) return void res.json(stored.data);
  const data = await fetchFieldData(q.page);
  if (data.status === 'ok')
    await query('INSERT INTO crux_field_data (scan_id, page_url, data) VALUES ($1,$2,$3) ON CONFLICT (scan_id) DO UPDATE SET page_url = EXCLUDED.page_url, data = EXCLUDED.data, fetched_at = now()', [
      row.id,
      q.page,
      JSON.stringify(data),
    ]);
  res.json(data);
});

scansRouter.get('/:id', async (req, res) => {
  const row = await ownedScan(String(req.params.id), req.auth!.workspace.id);
  const details = row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled' || row.status === 'running' ? await scanDetails(row.id) : { checkRuns: [], pages: [], visual: [] };
  res.json({ scan: scanDTO(row), ...details });
});

scansRouter.post('/:id/cancel', async (req, res) => {
  const row = await ownedScan(String(req.params.id), req.auth!.workspace.id);
  if (row.status === 'queued') {
    const done = await query("UPDATE scans SET status = 'cancelled', finished_at = now(), error = 'Cancelled before it started.' WHERE id = $1 AND status = 'queued' RETURNING id", [row.id]);
    // A worker claimed it in the meantime: ask the running scan to stop instead.
    if (!done.length) await query("UPDATE scans SET cancel_requested = true WHERE id = $1 AND status = 'running'", [row.id]);
  } else if (row.status === 'running') {
    await query('UPDATE scans SET cancel_requested = true WHERE id = $1', [row.id]);
  } else throw conflict('Only queued or running scans can be cancelled.');
  res.json({ ok: true });
});

/**
 * Deletes several scans at once (Scan history "Delete selected"). Only this workspace's scans that are
 * not queued or running are deleted, in one statement; the rest are reported back as skipped.
 */
scansRouter.post('/delete', async (req, res) => {
  const body = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }), req.body);
  const ws = req.auth!.workspace.id;
  const ids = [...new Set(body.ids)];
  const deleted = await query<{ id: string }>(
    "DELETE FROM scans WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND status NOT IN ('queued','running') RETURNING id",
    [ids, ws],
  );
  for (const r of deleted) await deleteScanFiles(ws, r.id);
  const gone = new Set(deleted.map((r) => r.id));
  const active = await query<{ id: string }>("SELECT id FROM scans WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND status IN ('queued','running')", [ids.filter((i) => !gone.has(i)), ws]);
  res.json({
    deleted: deleted.length,
    skipped: [
      ...active.map((r) => ({ id: r.id, reason: 'Queued or running — cancel it first.' })),
      ...ids.filter((i) => !gone.has(i) && !active.some((a) => a.id === i)).map((id) => ({ id, reason: 'Not found.' })),
    ],
  });
});

scansRouter.delete('/:id', async (req, res) => {
  const row = await ownedScan(String(req.params.id), req.auth!.workspace.id);
  if (row.status === 'running' || row.status === 'queued') throw conflict('Cancel the scan before deleting it.');
  await query('DELETE FROM scans WHERE id = $1 AND workspace_id = $2', [row.id, req.auth!.workspace.id]);
  await deleteScanFiles(req.auth!.workspace.id, row.id);
  res.json({ ok: true });
});

scansRouter.get('/meta/limits', async (req, res) => {
  const ws = req.auth!.workspace;
  res.json({
    usage: await usageFor(ws.id, ws.plan),
    hardMaxPages: config.SCAN_HARD_MAX_PAGES,
    linkCheckMax: config.LINK_CHECK_MAX,
    lighthouseMaxPages: config.LIGHTHOUSE_MAX_PAGES,
    maxDurationMinutes: Math.round(config.SCAN_MAX_DURATION_MS / 60000),
  });
});

export { ownedScan };
