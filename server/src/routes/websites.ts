import { Router } from 'express';
import { z } from 'zod';
import { PLANS, type WebsiteDTO } from '@wpcg/shared';
import { one, query, tx } from '../db/pool.js';
import { badRequest, conflict, notFound, parse, quotaExceeded } from '../http/errors.js';
import { BlockedTargetError, effectivePort, resolvePublic, validateScanUrl } from '../security/ssrf.js';
import { deleteScanFiles } from '../storage/files.js';

export const websitesRouter = Router();

const WEBSITE_SELECT = `
  SELECT w.id, w.name, w.base_url, w.created_at,
         ls.created_at AS last_scan_at, ls.status AS last_scan_status,
         (SELECT count(*) FROM scans s WHERE s.website_id = w.id) AS scan_count,
         (SELECT count(*) FROM issues i WHERE i.website_id = w.id AND i.status <> 'resolved') AS active_issues
    FROM websites w
    LEFT JOIN LATERAL (SELECT created_at, status FROM scans s WHERE s.website_id = w.id ORDER BY created_at DESC LIMIT 1) ls ON true`;

interface WebsiteRow {
  id: string;
  name: string;
  base_url: string;
  created_at: string;
  last_scan_at: string | null;
  last_scan_status: WebsiteDTO['lastScanStatus'];
  scan_count: number;
  active_issues: number;
}

const toDTO = (r: WebsiteRow): WebsiteDTO => ({
  id: r.id,
  name: r.name,
  baseUrl: r.base_url,
  createdAt: r.created_at,
  lastScanAt: r.last_scan_at,
  lastScanStatus: r.last_scan_status,
  scanCount: Number(r.scan_count),
  activeIssues: Number(r.active_issues),
});

/** Validates a URL (syntax, policy and DNS) and returns the normalised base URL. */
export async function vetWebsiteUrl(input: string): Promise<URL> {
  let u: URL;
  try {
    u = validateScanUrl(input);
    await resolvePublic(u.hostname, effectivePort(u));
  } catch (e) {
    if (e instanceof BlockedTargetError) throw badRequest(e.message);
    throw e;
  }
  u.search = '';
  return u;
}

/** Finds or creates a website for a URL inside the workspace, enforcing the plan's website limit. */
export async function ensureWebsite(workspaceId: string, plan: keyof typeof PLANS, userId: string | null, url: URL, name?: string): Promise<string> {
  const base = url.href;
  const existing = await one<{ id: string }>('SELECT id FROM websites WHERE workspace_id = $1 AND base_url = $2', [workspaceId, base]);
  if (existing) return existing.id;
  return tx(async (c) => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`websites:${workspaceId}`], c);
    const count = await one<{ n: number }>('SELECT count(*) AS n FROM websites WHERE workspace_id = $1', [workspaceId], c);
    if (Number(count?.n ?? 0) >= PLANS[plan].maxWebsites)
      throw quotaExceeded(`Your ${PLANS[plan].name} plan allows ${PLANS[plan].maxWebsites} websites. Remove one or change plan to add another.`);
    const row = await one<{ id: string }>(
      'INSERT INTO websites (workspace_id, name, base_url, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, base_url) DO UPDATE SET name = websites.name RETURNING id',
      [workspaceId, (name || url.hostname).slice(0, 100), base, userId],
      c,
    );
    return row!.id;
  });
}

websitesRouter.get('/', async (req, res) => {
  const rows = await query<WebsiteRow>(`${WEBSITE_SELECT} WHERE w.workspace_id = $1 ORDER BY w.created_at DESC`, [req.auth!.workspace.id]);
  res.json(rows.map(toDTO));
});

websitesRouter.post('/', async (req, res) => {
  const body = parse(z.object({ url: z.string().min(1).max(2048), name: z.string().trim().max(100).optional() }), req.body);
  const url = await vetWebsiteUrl(body.url);
  const ws = req.auth!.workspace;
  const dupe = await one('SELECT 1 FROM websites WHERE workspace_id = $1 AND base_url = $2', [ws.id, url.href]);
  if (dupe) throw conflict('That website is already in your workspace.');
  const id = await ensureWebsite(ws.id, ws.plan, req.auth!.user.id, url, body.name);
  const row = await one<WebsiteRow>(`${WEBSITE_SELECT} WHERE w.id = $1`, [id]);
  res.status(201).json(toDTO(row!));
});

websitesRouter.get('/:id', async (req, res) => {
  const row = await one<WebsiteRow>(`${WEBSITE_SELECT} WHERE w.id = $1 AND w.workspace_id = $2`, [req.params.id, req.auth!.workspace.id]);
  if (!row) throw notFound('Website');
  res.json(toDTO(row));
});

websitesRouter.patch('/:id', async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
  const row = await one<{ id: string }>('UPDATE websites SET name = $3 WHERE id = $1 AND workspace_id = $2 RETURNING id', [req.params.id, req.auth!.workspace.id, body.name]);
  if (!row) throw notFound('Website');
  res.json({ ok: true });
});

/** Deletes the website with all of its scans, issues, screenshots and baselines. */
websitesRouter.delete('/:id', async (req, res) => {
  const ws = req.auth!.workspace.id;
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw notFound('Website');
  const active = await one<{ n: number }>("SELECT count(*)::int AS n FROM scans WHERE website_id = $1 AND workspace_id = $2 AND status IN ('queued','running')", [req.params.id, ws]);
  if (active && active.n > 0) throw conflict('A scan of this website is queued or running. Cancel it or wait for it to finish, then remove the website.');
  const scans = await query<{ id: string }>('SELECT id FROM scans WHERE website_id = $1 AND workspace_id = $2', [req.params.id, ws]);
  const row = await one<{ id: string }>('DELETE FROM websites WHERE id = $1 AND workspace_id = $2 RETURNING id', [req.params.id, ws]);
  if (!row) throw notFound('Website');
  for (const s of scans) await deleteScanFiles(ws, s.id);
  res.json({ ok: true, deletedScans: scans.length });
});
