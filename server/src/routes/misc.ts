import { Router } from 'express';
import { z } from 'zod';
import { PLANS, type BaselineDTO, type OverviewDTO } from '@wpcg/shared';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { conflict, forbidden, notFound, parse, quotaExceeded } from '../http/errors.js';
import { requireRole } from '../auth/session.js';
import { SCAN_SELECT, scanDTO, type ScanRow } from '../services/mappers.js';
import { usageFor } from '../services/quota.js';
import { absolute, deleteScanFiles } from '../storage/files.js';

// ---------------------------------------------------------------- overview

export const overviewRouter = Router();

overviewRouter.get('/', async (req, res) => {
  const ws = req.auth!.workspace;
  const c = await one<{ websites: number; scans: number; critical: number; high: number; review: number; resolved: number; active: number }>(
    `SELECT
       (SELECT count(*) FROM websites WHERE workspace_id = $1) AS websites,
       (SELECT count(*) FROM scans WHERE workspace_id = $1) AS scans,
       (SELECT count(*) FROM issues WHERE workspace_id = $1 AND severity = 'critical' AND status <> 'resolved') AS critical,
       (SELECT count(*) FROM issues WHERE workspace_id = $1 AND severity = 'high' AND status <> 'resolved') AS high,
       (SELECT count(*) FROM issues WHERE workspace_id = $1 AND status IN ('needs_review', 'inconclusive', 'not_tested')) AS review,
       (SELECT count(*) FROM issues WHERE workspace_id = $1 AND status = 'resolved') AS resolved,
       (SELECT count(*) FROM issues WHERE workspace_id = $1 AND status <> 'resolved') AS active`,
    [ws.id],
  );
  const recent = await query<ScanRow>(`${SCAN_SELECT} WHERE s.workspace_id = $1 ORDER BY s.created_at DESC LIMIT 8`, [ws.id]);
  const dto: OverviewDTO = {
    websites: Number(c?.websites ?? 0),
    scans: Number(c?.scans ?? 0),
    criticalIssues: Number(c?.critical ?? 0),
    highIssues: Number(c?.high ?? 0),
    awaitingReview: Number(c?.review ?? 0),
    resolvedIssues: Number(c?.resolved ?? 0),
    activeIssues: Number(c?.active ?? 0),
    recentScans: recent.map(scanDTO),
    usage: await usageFor(ws.id, ws.plan),
  };
  res.json(dto);
});

// ---------------------------------------------------------------- baselines

export const baselinesRouter = Router();

baselinesRouter.get('/', async (req, res) => {
  const q = parse(z.object({ websiteId: z.string().uuid().optional() }), req.query);
  const rows = await query<{
    id: string;
    name: string;
    website_id: string;
    website_name: string;
    scan_id: string;
    created_at: string;
    finished_at: string | null;
    config: { viewports: BaselineDTO['viewports'] };
    shots: number;
  }>(
    `SELECT b.id, b.name, b.website_id, w.name AS website_name, b.scan_id, b.created_at, s.finished_at, s.config,
            (SELECT count(*) FROM screenshots x WHERE x.scan_id = b.scan_id) AS shots
       FROM baselines b JOIN websites w ON w.id = b.website_id JOIN scans s ON s.id = b.scan_id
      WHERE b.workspace_id = $1 ${q.websiteId ? 'AND b.website_id = $2' : ''}
      ORDER BY b.created_at DESC`,
    q.websiteId ? [req.auth!.workspace.id, q.websiteId] : [req.auth!.workspace.id],
  );
  const out: BaselineDTO[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    websiteId: r.website_id,
    websiteName: r.website_name,
    scanId: r.scan_id,
    createdAt: r.created_at,
    scanFinishedAt: r.finished_at,
    viewports: r.config.viewports,
    screenshotCount: Number(r.shots),
  }));
  res.json(out);
});

baselinesRouter.post('/', async (req, res) => {
  const body = parse(z.object({ scanId: z.string().uuid(), name: z.string().trim().min(1).max(100) }), req.body);
  const ws = req.auth!.workspace;
  const scan = await one<{ id: string; website_id: string; status: string; shots: number }>(
    `SELECT s.id, s.website_id, s.status, (SELECT count(*) FROM screenshots x WHERE x.scan_id = s.id) AS shots
       FROM scans s WHERE s.id = $1 AND s.workspace_id = $2`,
    [body.scanId, ws.id],
  );
  if (!scan) throw notFound('Scan');
  if (scan.status !== 'completed') throw conflict('Only a completed scan can be saved as a baseline.');
  const exists = await one('SELECT 1 FROM baselines WHERE scan_id = $1', [scan.id]);
  if (exists) throw conflict('This scan is already a baseline.');
  const row = await one<{ id: string }>(
    'INSERT INTO baselines (workspace_id, website_id, scan_id, name, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [ws.id, scan.website_id, scan.id, body.name, req.auth!.user.id],
  );
  res.status(201).json({ id: row!.id, screenshotCount: Number(scan.shots) });
});

baselinesRouter.delete('/:id', async (req, res) => {
  const row = await one('DELETE FROM baselines WHERE id = $1 AND workspace_id = $2 RETURNING id', [req.params.id, req.auth!.workspace.id]);
  if (!row) throw notFound('Baseline');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- files (screenshots and diffs)

export const filesRouter = Router();

filesRouter.get('/screenshots/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Screenshot');
  const row = await one<{ path: string }>(
    'SELECT x.path FROM screenshots x JOIN scans s ON s.id = x.scan_id WHERE x.id = $1 AND s.workspace_id = $2',
    [req.params.id, req.auth!.workspace.id],
  );
  if (!row) throw notFound('Screenshot');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type('png').sendFile(absolute(row.path));
});

filesRouter.get('/diffs/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Diff image');
  const row = await one<{ diff_path: string | null }>(
    'SELECT v.diff_path FROM visual_comparisons v JOIN scans s ON s.id = v.scan_id WHERE v.id = $1 AND s.workspace_id = $2',
    [req.params.id, req.auth!.workspace.id],
  );
  if (!row?.diff_path) throw notFound('Diff image');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.type('png').sendFile(absolute(row.diff_path));
});

// ---------------------------------------------------------------- workspace settings, team, data deletion

export const workspaceRouter = Router();

workspaceRouter.patch('/', requireRole('owner', 'admin'), async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(100).optional(),
      retentionDays: z.number().int().min(1).max(3650).optional(),
      aiEnabled: z.boolean().optional(),
      reportBrandName: z.string().trim().max(100).nullable().optional(),
    }),
    req.body,
  );
  const ws = req.auth!.workspace;
  if (body.reportBrandName && !PLANS[ws.plan].brandedReports) throw quotaExceeded('Branded reports are available on the Agency plan.');
  await query(
    `UPDATE workspaces SET name = COALESCE($2, name), retention_days = COALESCE($3, retention_days), ai_enabled = COALESCE($4, ai_enabled),
            report_brand_name = CASE WHEN $5::boolean THEN $6 ELSE report_brand_name END
      WHERE id = $1`,
    [ws.id, body.name ?? null, body.retentionDays ?? null, body.aiEnabled ?? null, body.reportBrandName !== undefined, body.reportBrandName || null],
  );
  res.json({ ok: true });
});

workspaceRouter.get('/members', async (req, res) => {
  const rows = await query<{ user_id: string; name: string; email: string; role: string; created_at: string }>(
    'SELECT m.user_id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at',
    [req.auth!.workspace.id],
  );
  res.json(rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, role: r.role, joinedAt: r.created_at })));
});

/** Adds an existing account to the workspace (no invitation e-mails are sent by this version). */
workspaceRouter.post('/members', requireRole('owner', 'admin'), async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['admin', 'member']).default('member') }), req.body);
  const ws = req.auth!.workspace;
  await tx(async (c) => {
    // Serialise per workspace so two invitations at once cannot both pass the member limit.
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`members:${ws.id}`], c);
    const count = await one<{ n: number }>('SELECT count(*) AS n FROM memberships WHERE workspace_id = $1', [ws.id], c);
    if (Number(count?.n ?? 0) >= PLANS[ws.plan].maxMembers) throw quotaExceeded(`Your ${PLANS[ws.plan].name} plan allows ${PLANS[ws.plan].maxMembers} member(s).`);
    const user = await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [body.email], c);
    if (!user) throw notFound('An account with that e-mail');
    await query('INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ws.id, user.id, body.role], c);
  });
  res.status(201).json({ ok: true });
});

workspaceRouter.delete('/members/:userId', requireRole('owner', 'admin'), async (req, res) => {
  const ws = req.auth!.workspace;
  const target = await one<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', [ws.id, req.params.userId]);
  if (!target) throw notFound('Member');
  if (target.role === 'owner') throw forbidden('The workspace owner cannot be removed.');
  await query('DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2', [ws.id, req.params.userId]);
  await query('DELETE FROM sessions WHERE workspace_id = $1 AND user_id = $2', [ws.id, req.params.userId]);
  res.json({ ok: true });
});

/** Deletes every scan, issue, screenshot and baseline in the workspace (websites are kept unless asked). */
workspaceRouter.post('/purge', requireRole('owner'), async (req, res) => {
  const body = parse(z.object({ confirm: z.literal('DELETE'), includeWebsites: z.boolean().default(false) }), req.body);
  const ws = req.auth!.workspace;
  const scans = await query<{ id: string }>('SELECT id FROM scans WHERE workspace_id = $1', [ws.id]);
  const running = await one("SELECT 1 FROM scans WHERE workspace_id = $1 AND status IN ('queued','running')", [ws.id]);
  if (running) throw conflict('Cancel queued and running scans first.');
  await tx(async (c) => {
    await query('DELETE FROM issues WHERE workspace_id = $1', [ws.id], c);
    await query('DELETE FROM scans WHERE workspace_id = $1', [ws.id], c);
    await query('DELETE FROM ai_outputs WHERE workspace_id = $1', [ws.id], c);
    if (body.includeWebsites) await query('DELETE FROM websites WHERE workspace_id = $1', [ws.id], c);
  });
  for (const s of scans) await deleteScanFiles(ws.id, s.id);
  res.json({ ok: true, deletedScans: scans.length });
});

// ---------------------------------------------------------------- health

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  let db = false;
  try {
    await query('SELECT 1');
    db = true;
  } catch {
    db = false;
  }
  const worker = await one<{ n: number }>("SELECT count(*) AS n FROM scans WHERE status = 'running' AND heartbeat_at > now() - interval '1 minute'").catch(() => null);
  res.status(db ? 200 : 503).json({
    ok: db,
    database: db,
    activeScans: Number(worker?.n ?? 0),
    ai: config.aiConfigured ? config.AI_PROVIDER : 'not configured',
  });
});

