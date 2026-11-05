import crypto from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import {
  PLANS,
  PRIORITIES,
  WATCHERS,
  WATCHER_KEYS,
  type AlertContactDTO,
  type AlertDeliveryDTO,
  type CheckKey,
  type CheckResultDTO,
  type IncidentDTO,
  type MonitorDTO,
  type MonitoringOverviewDTO,
  type PlanId,
  type WatcherKey,
  type WatcherStateDTO,
} from '@wpcg/shared';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { badRequest, conflict, notFound, parse, quotaExceeded } from '../http/errors.js';
import { requireRole } from '../auth/session.js';
import { sendTestAlert } from '../monitoring/alerts.js';
import { vetWebsiteUrl } from './websites.js';

export const monitorsRouter = Router();
export const incidentsRouter = Router();
export const alertsRouter = Router();
export const heartbeatRouter = Router();

const uuid = z.string().uuid();

interface MonitorRow {
  id: string;
  kind: 'website' | 'heartbeat';
  name: string;
  url: string | null;
  enabled: boolean;
  interval_seconds: number;
  keyword: string | null;
  keyword_mode: 'present' | 'absent' | null;
  money_page: boolean;
  exposure_authorised_at: string | null;
  heartbeat_token: string | null;
  heartbeat_grace_seconds: number;
  last_heartbeat_at: string | null;
  created_at: string;
}

interface CheckRow {
  monitor_id: string;
  check_key: CheckKey;
  enabled: boolean;
  interval_seconds: number;
  last_status: WatcherStateDTO['lastStatus'];
  last_severity: WatcherStateDTO['lastSeverity'];
  last_summary: string | null;
  last_run_at: string | null;
  next_run_at: string;
}

// Overall status = the worst assessed result. "Not assessed" (blocked, or not applicable such as TLS on an
// http:// target) never outranks a real verdict from another watcher; it shows only when nothing was assessed.
const STATUS_RANK: Record<string, number> = { down: 0, warning: 1, error: 2, up: 3, not_assessed: 4 };

async function monitorDTOs(workspaceId: string, plan: PlanId, ids?: string[]): Promise<MonitorDTO[]> {
  const rows = await query<MonitorRow>(
    `SELECT * FROM monitors WHERE workspace_id = $1 ${ids ? 'AND id = ANY($2::uuid[])' : ''} ORDER BY created_at`,
    ids ? [workspaceId, ids] : [workspaceId],
  );
  if (!rows.length) return [];
  const monitorIds = rows.map((r) => r.id);
  const checks = await query<CheckRow>('SELECT * FROM monitor_checks WHERE monitor_id = ANY($1::uuid[])', [monitorIds]);
  const stats = await query<{ monitor_id: string; up24: number; total24: number; up7: number; total7: number; up30: number; total30: number; avg24: number | null }>(
    `SELECT monitor_id,
            count(*) FILTER (WHERE status IN ('up','warning') AND started_at > now() - interval '24 hours') AS up24,
            count(*) FILTER (WHERE status IN ('up','warning','down') AND started_at > now() - interval '24 hours') AS total24,
            count(*) FILTER (WHERE status IN ('up','warning') AND started_at > now() - interval '7 days') AS up7,
            count(*) FILTER (WHERE status IN ('up','warning','down') AND started_at > now() - interval '7 days') AS total7,
            count(*) FILTER (WHERE status IN ('up','warning')) AS up30,
            count(*) FILTER (WHERE status IN ('up','warning','down')) AS total30,
            round(avg(response_ms) FILTER (WHERE status IN ('up','warning') AND started_at > now() - interval '24 hours'))::int AS avg24
       FROM check_results WHERE monitor_id = ANY($1::uuid[]) AND check_key IN ('uptime','heartbeat') AND started_at > now() - interval '30 days'
      GROUP BY monitor_id`,
    [monitorIds],
  );
  const open = await query<{ monitor_id: string; n: number }>("SELECT monitor_id, count(*) AS n FROM incidents WHERE monitor_id = ANY($1::uuid[]) AND status = 'open' GROUP BY monitor_id", [monitorIds]);
  const pct = (up: number, total: number) => (Number(total) ? Math.round((Number(up) / Number(total)) * 10000) / 100 : null);

  return rows.map((m) => {
    const mine = checks.filter((c) => c.monitor_id === m.id);
    const st = stats.find((s) => s.monitor_id === m.id);
    const enabled = mine.filter((c) => c.enabled);
    const ran = enabled.filter((c) => c.last_status);
    let status: MonitorDTO['status'] = 'pending';
    if (!m.enabled) status = 'paused';
    else if (ran.length) status = ran.map((c) => c.last_status!).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])[0];
    const watchers: WatcherStateDTO[] = mine
      .sort((a, b) => [...WATCHER_KEYS, 'heartbeat'].indexOf(a.check_key) - [...WATCHER_KEYS, 'heartbeat'].indexOf(b.check_key))
      .map((c) => ({
        key: c.check_key,
        enabled: c.enabled,
        entitled: c.check_key === 'heartbeat' || PLANS[plan].watchers.includes(c.check_key as WatcherKey),
        intervalSeconds: c.interval_seconds,
        lastStatus: c.last_status,
        lastSeverity: c.last_severity,
        lastSummary: c.last_summary,
        lastRunAt: c.last_run_at,
        nextRunAt: c.enabled ? c.next_run_at : null,
      }));
    return {
      id: m.id,
      kind: m.kind,
      name: m.name,
      url: m.url,
      enabled: m.enabled,
      intervalSeconds: m.interval_seconds,
      keyword: m.keyword,
      keywordMode: m.keyword_mode,
      moneyPage: m.money_page,
      exposureAuthorised: !!m.exposure_authorised_at,
      heartbeatUrl: m.heartbeat_token ? `${config.publicUrl}/api/heartbeat/${m.heartbeat_token}` : null,
      heartbeatGraceSeconds: m.heartbeat_grace_seconds,
      lastHeartbeatAt: m.last_heartbeat_at,
      status,
      lastCheckedAt: ran.map((c) => c.last_run_at!).sort().pop() ?? null,
      uptime24h: st ? pct(st.up24, st.total24) : null,
      uptime7d: st ? pct(st.up7, st.total7) : null,
      uptime30d: st ? pct(st.up30, st.total30) : null,
      avgResponseMs24h: st?.avg24 ?? null,
      openIncidents: Number(open.find((o) => o.monitor_id === m.id)?.n ?? 0),
      watchers,
      createdAt: m.created_at,
    };
  });
}

async function ownedMonitor(id: string, workspaceId: string): Promise<MonitorRow> {
  if (!uuid.safeParse(id).success) throw notFound('Monitor');
  const m = await one<MonitorRow>('SELECT * FROM monitors WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!m) throw notFound('Monitor');
  return m;
}

/** Interval for a watcher: the monitor's own for uptime/heartbeat, the catalogue cadence otherwise. */
const watcherInterval = (key: CheckKey, monitorInterval: number) => WATCHERS[key].defaultInterval === null || key === 'heartbeat' ? monitorInterval : WATCHERS[key].defaultInterval!;

// ---------------------------------------------------------------- monitors

monitorsRouter.get('/', async (req, res) => {
  res.json(await monitorDTOs(req.auth!.workspace.id, req.auth!.workspace.plan));
});

const createSchema = z.object({
  kind: z.enum(['website', 'heartbeat']).default('website'),
  name: z.string().trim().min(1).max(100),
  url: z.string().max(2048).optional(),
  intervalSeconds: z.number().int().min(30).max(86400).default(300),
  keyword: z.string().trim().max(200).optional().nullable(),
  keywordMode: z.enum(['present', 'absent']).optional().nullable(),
  moneyPage: z.boolean().default(false),
  watchers: z.array(z.enum(WATCHER_KEYS)).max(WATCHER_KEYS.length).default(['uptime', 'tls', 'https']),
  exposureAuthorised: z.boolean().default(false),
  heartbeatGraceSeconds: z.number().int().min(0).max(86400).default(300),
  authorised: z.literal(true, { errorMap: () => ({ message: 'Confirm that you own the website or have permission to monitor it' }) }),
});

monitorsRouter.post('/', async (req, res) => {
  const body = parse(createSchema, req.body);
  const ws = req.auth!.workspace;
  const plan = PLANS[ws.plan];
  if (body.intervalSeconds < plan.minIntervalSeconds) throw quotaExceeded(`Your ${plan.name} plan checks at most every ${plan.minIntervalSeconds / 60} minute(s).`);
  const notAllowed = body.watchers.filter((w) => !plan.watchers.includes(w));
  if (notAllowed.length) throw quotaExceeded(`These watchers are not included in your ${plan.name} plan: ${notAllowed.map((w) => WATCHERS[w].label).join(', ')}.`);
  if (body.watchers.includes('exposure') && !body.exposureAuthorised) throw badRequest('The exposed-files watcher needs your explicit authorisation, because its requests look like an attack to a firewall.');

  let url: string | null = null;
  if (body.kind === 'website') {
    if (!body.url) throw badRequest('Enter the address to monitor.');
    const u = await vetWebsiteUrl(body.url);
    url = u.href;
    if (!body.watchers.includes('uptime')) body.watchers.unshift('uptime');
  }
  const keys: CheckKey[] = body.kind === 'heartbeat' ? ['heartbeat'] : [...new Set(body.watchers)];

  const id = await tx(async (c) => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`monitors:${ws.id}`], c);
    const n = await one<{ n: number }>('SELECT count(*) AS n FROM monitors WHERE workspace_id = $1', [ws.id], c);
    if (Number(n?.n ?? 0) >= plan.maxMonitors) throw quotaExceeded(`Your ${plan.name} plan includes ${plan.maxMonitors} monitors.`);
    const website = url ? await one<{ id: string }>('SELECT id FROM websites WHERE workspace_id = $1 AND base_url = $2', [ws.id, url], c) : null;
    const row = await one<{ id: string }>(
      `INSERT INTO monitors (workspace_id, website_id, kind, name, url, interval_seconds, keyword, keyword_mode, money_page, exposure_authorised_at, heartbeat_token, heartbeat_grace_seconds, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        ws.id,
        website?.id ?? null,
        body.kind,
        body.name,
        url,
        body.intervalSeconds,
        body.keyword || null,
        body.keyword ? (body.keywordMode ?? 'present') : null,
        body.moneyPage,
        body.exposureAuthorised ? new Date().toISOString() : null,
        body.kind === 'heartbeat' ? crypto.randomBytes(18).toString('base64url') : null,
        body.heartbeatGraceSeconds,
        req.auth!.user.id,
      ],
      c,
    );
    // Stagger the first runs a little so one monitor's watchers do not all start in the same second.
    for (const [i, key] of keys.entries())
      await query(
        "INSERT INTO monitor_checks (monitor_id, check_key, interval_seconds, next_run_at) VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)",
        [row!.id, key, watcherInterval(key, body.intervalSeconds), String(key === 'heartbeat' ? body.intervalSeconds : i * 3)],
        c,
      );
    return row!.id;
  });
  res.status(201).json((await monitorDTOs(ws.id, ws.plan, [id]))[0]);
});

monitorsRouter.get('/overview', async (req, res) => {
  const ws = req.auth!.workspace;
  const list = await monitorDTOs(ws.id, ws.plan);
  const beat = await one<{ beat_at: string }>("SELECT beat_at FROM system_heartbeats WHERE component = 'monitor-scheduler'");
  const u30 = await one<{ up: number; total: number }>(
    `SELECT count(*) FILTER (WHERE r.status IN ('up','warning')) AS up, count(*) FILTER (WHERE r.status IN ('up','warning','down')) AS total
       FROM check_results r JOIN monitors m ON m.id = r.monitor_id
      WHERE m.workspace_id = $1 AND r.check_key IN ('uptime','heartbeat') AND r.started_at > now() - interval '30 days'`,
    [ws.id],
  );
  const dto: MonitoringOverviewDTO = {
    monitors: list.length,
    up: list.filter((m) => m.status === 'up').length,
    down: list.filter((m) => m.status === 'down' || m.status === 'error').length,
    warning: list.filter((m) => m.status === 'warning').length,
    notAssessed: list.filter((m) => m.status === 'not_assessed' || m.status === 'pending').length,
    paused: list.filter((m) => m.status === 'paused').length,
    openIncidents: list.reduce((s, m) => s + m.openIncidents, 0),
    uptime30d: Number(u30?.total) ? Math.round((Number(u30!.up) / Number(u30!.total)) * 10000) / 100 : null,
    scheduler: { lastBeatAt: beat?.beat_at ?? null, healthy: !!beat && Date.now() - Date.parse(beat.beat_at) < 120_000 },
    emailConfigured: config.emailConfigured,
  };
  res.json(dto);
});

monitorsRouter.get('/:id', async (req, res) => {
  const m = await ownedMonitor(String(req.params.id), req.auth!.workspace.id);
  res.json((await monitorDTOs(req.auth!.workspace.id, req.auth!.workspace.plan, [m.id]))[0]);
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(30).max(86400).optional(),
  keyword: z.string().trim().max(200).nullable().optional(),
  keywordMode: z.enum(['present', 'absent']).nullable().optional(),
  moneyPage: z.boolean().optional(),
  watchers: z.array(z.enum(WATCHER_KEYS)).max(WATCHER_KEYS.length).optional(),
  exposureAuthorised: z.boolean().optional(),
  heartbeatGraceSeconds: z.number().int().min(0).max(86400).optional(),
});

monitorsRouter.patch('/:id', async (req, res) => {
  const body = parse(updateSchema, req.body);
  const ws = req.auth!.workspace;
  const plan = PLANS[ws.plan];
  const m = await ownedMonitor(String(req.params.id), ws.id);
  if (body.intervalSeconds !== undefined && body.intervalSeconds < plan.minIntervalSeconds) throw quotaExceeded(`Your ${plan.name} plan checks at most every ${plan.minIntervalSeconds / 60} minute(s).`);
  if (body.watchers) {
    const notAllowed = body.watchers.filter((w) => !plan.watchers.includes(w));
    if (notAllowed.length) throw quotaExceeded(`Not included in your ${plan.name} plan: ${notAllowed.map((w) => WATCHERS[w].label).join(', ')}.`);
    if (m.kind === 'website' && !body.watchers.includes('uptime')) body.watchers.unshift('uptime');
  }
  const exposureOn = body.exposureAuthorised ?? !!m.exposure_authorised_at;
  if (body.watchers?.includes('exposure') && !exposureOn) throw badRequest('The exposed-files watcher needs your explicit authorisation.');
  const interval = body.intervalSeconds ?? m.interval_seconds;
  await tx(async (c) => {
    await query(
      `UPDATE monitors SET name = COALESCE($2, name), enabled = COALESCE($3, enabled), interval_seconds = $4,
              keyword = CASE WHEN $5::boolean THEN $6 ELSE keyword END,
              keyword_mode = CASE WHEN $5::boolean THEN $7 ELSE keyword_mode END,
              money_page = COALESCE($8, money_page),
              exposure_authorised_at = CASE WHEN $9::boolean IS NULL THEN exposure_authorised_at WHEN $9 THEN COALESCE(exposure_authorised_at, now()) ELSE NULL END,
              heartbeat_grace_seconds = COALESCE($10, heartbeat_grace_seconds)
        WHERE id = $1`,
      [
        m.id,
        body.name ?? null,
        body.enabled ?? null,
        interval,
        body.keyword !== undefined,
        body.keyword || null,
        body.keyword ? (body.keywordMode ?? 'present') : null,
        body.moneyPage ?? null,
        body.exposureAuthorised ?? null,
        body.heartbeatGraceSeconds ?? null,
      ],
      c,
    );
    // A shorter interval takes effect now, not after the old (possibly day-long) wait.
    await query(
      "UPDATE monitor_checks SET interval_seconds = $2::int, next_run_at = LEAST(next_run_at, now() + make_interval(secs => $2::int)) WHERE monitor_id = $1 AND check_key IN ('uptime','heartbeat')",
      [m.id, interval],
      c,
    );
    if (body.watchers && m.kind === 'website') {
      for (const key of WATCHER_KEYS) {
        const want = body.watchers.includes(key);
        if (want)
          await query(
            `INSERT INTO monitor_checks (monitor_id, check_key, interval_seconds) VALUES ($1,$2,$3)
             ON CONFLICT (monitor_id, check_key) DO UPDATE SET enabled = true, next_run_at = CASE WHEN monitor_checks.enabled THEN monitor_checks.next_run_at ELSE now() END`,
            [m.id, key, watcherInterval(key, interval)],
            c,
          );
        else await query('UPDATE monitor_checks SET enabled = false WHERE monitor_id = $1 AND check_key = $2', [m.id, key], c);
      }
    }
    if (body.enabled === false) await query("UPDATE incidents SET status = 'resolved', resolved_at = now(), detail = detail || '{\"paused\":true}' WHERE monitor_id = $1 AND status = 'open'", [m.id], c);
  });
  res.json((await monitorDTOs(ws.id, ws.plan, [m.id]))[0]);
});

monitorsRouter.delete('/:id', async (req, res) => {
  const m = await ownedMonitor(String(req.params.id), req.auth!.workspace.id);
  await query('DELETE FROM monitors WHERE id = $1', [m.id]);
  res.json({ ok: true });
});

/** "Check now": schedules the watcher(s) immediately; limited to once a minute per monitor. */
monitorsRouter.post('/:id/run', async (req, res) => {
  const body = parse(z.object({ checkKey: z.string().max(40).optional() }), req.body ?? {});
  const m = await ownedMonitor(String(req.params.id), req.auth!.workspace.id);
  // Once a minute per monitor, or per check when one is named (so a single watcher cannot be re-run in a loop).
  const recent = body.checkKey
    ? await one<{ n: number }>("SELECT count(*) AS n FROM check_results WHERE monitor_id = $1 AND check_key = $2 AND started_at > now() - interval '60 seconds'", [m.id, body.checkKey])
    : await one<{ n: number }>("SELECT count(*) AS n FROM check_results WHERE monitor_id = $1 AND started_at > now() - interval '60 seconds'", [m.id]);
  if (Number(recent?.n ?? 0) > 0)
    throw conflict(body.checkKey ? 'This check ran in the last minute. Please wait a moment.' : 'This monitor was checked in the last minute. Please wait a moment.');
  const r = await query(
    `UPDATE monitor_checks SET next_run_at = now() WHERE monitor_id = $1 AND enabled AND locked_at IS NULL ${body.checkKey ? 'AND check_key = $2' : ''} RETURNING check_key`,
    body.checkKey ? [m.id, body.checkKey] : [m.id],
  );
  res.json({ scheduled: r.length });
});

/** Accepts the current page as the new baseline for change-detection watchers (defacement, scripts). */
monitorsRouter.post('/:id/checks/:key/accept', async (req, res) => {
  const m = await ownedMonitor(String(req.params.id), req.auth!.workspace.id);
  const key = String(req.params.key);
  if (key !== 'defacement' && key !== 'scripts') throw badRequest('Only the defacement and third-party script watchers have a baseline to accept.');
  await query('UPDATE monitor_checks SET baseline = NULL, next_run_at = now() WHERE monitor_id = $1 AND check_key = $2', [m.id, key]);
  res.json({ ok: true, message: 'The next run records the current page as the accepted baseline.' });
});

monitorsRouter.get('/:id/results', async (req, res) => {
  const m = await ownedMonitor(String(req.params.id), req.auth!.workspace.id);
  const q = parse(z.object({ checkKey: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(500).default(50), before: z.coerce.number().int().optional() }), req.query);
  const days = PLANS[req.auth!.workspace.plan].monitorHistoryDays;
  const params: unknown[] = [m.id, String(days)];
  let where = "monitor_id = $1 AND started_at > now() - ($2 || ' days')::interval";
  if (q.checkKey) {
    params.push(q.checkKey);
    where += ` AND check_key = $${params.length}`;
  }
  if (q.before) {
    params.push(q.before);
    where += ` AND id < $${params.length}`;
  }
  params.push(q.limit);
  const rows = await query<{ id: number; check_key: CheckKey; status: CheckResultDTO['status']; severity: CheckResultDTO['severity']; summary: string; detail: Record<string, unknown>; response_ms: number | null; ttfb_ms: number | null; http_status: number | null; attempts: number; started_at: string }>(
    `SELECT * FROM check_results WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  const out: CheckResultDTO[] = rows.map((r) => ({
    id: Number(r.id),
    checkKey: r.check_key,
    status: r.status,
    severity: r.severity,
    summary: r.summary,
    detail: r.detail,
    responseMs: r.response_ms,
    ttfbMs: r.ttfb_ms,
    httpStatus: r.http_status,
    attempts: r.attempts,
    startedAt: r.started_at,
  }));
  res.json(out);
});

/** Chart data: response times (last 24 h or 7 d) and per-day uptime bars (up to the plan's history). */
monitorsRouter.get('/:id/series', async (req, res) => {
  const m = await ownedMonitor(String(req.params.id), req.auth!.workspace.id);
  const q = parse(z.object({ range: z.enum(['24h', '7d', '30d']).default('24h') }), req.query);
  const interval = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' }[q.range];
  const key = m.kind === 'heartbeat' ? 'heartbeat' : 'uptime';
  // At most ~3000 points spread evenly over the whole range (keeping the newest and every "down"
  // result), so a busy monitor's 7- or 30-day chart is not cut off days before now.
  const points = await query<{ t: string; ms: number | null; ttfb: number | null; status: string }>(
    `WITH s AS (
       SELECT started_at, response_ms, ttfb_ms, status, row_number() OVER (ORDER BY started_at) AS rn, count(*) OVER () AS n
         FROM check_results WHERE monitor_id = $1 AND check_key = $2 AND started_at > now() - $3::interval)
     SELECT started_at AS t, response_ms AS ms, ttfb_ms AS ttfb, status FROM s
      WHERE n <= 3000 OR rn % ceil(n / 3000.0)::int = 0 OR rn = n OR status = 'down'
      ORDER BY started_at`,
    [m.id, key, interval],
  );
  const days = Math.min(90, PLANS[req.auth!.workspace.plan].monitorHistoryDays);
  const bars = await query<{ day: string; up: number; down: number; other: number }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            count(r.*) FILTER (WHERE r.status IN ('up','warning')) AS up,
            count(r.*) FILTER (WHERE r.status = 'down') AS down,
            count(r.*) FILTER (WHERE r.status IN ('not_assessed','error')) AS other
       FROM generate_series(date_trunc('day', now()) - ($3 || ' days')::interval, date_trunc('day', now()), interval '1 day') d
       LEFT JOIN check_results r ON r.monitor_id = $1 AND r.check_key = $2 AND r.started_at >= d AND r.started_at < d + interval '1 day'
      GROUP BY d ORDER BY d`,
    [m.id, key, String(days - 1)],
  );
  res.json({
    range: q.range,
    points: points.map((p) => ({ t: p.t, ms: p.ms, ttfb: p.ttfb, status: p.status })),
    days: bars.map((b) => ({ day: b.day, up: Number(b.up), down: Number(b.down), other: Number(b.other) })),
  });
});

// ---------------------------------------------------------------- incidents

function incidentDTO(r: { id: string; monitor_id: string; monitor_name: string; monitor_url: string | null; check_key: CheckKey; severity: IncidentDTO['severity']; title: string; status: IncidentDTO['status']; opened_at: string; resolved_at: string | null; last_seen_at: string; occurrences: number; acknowledged_at: string | null; detail: Record<string, unknown> }): IncidentDTO {
  return {
    id: r.id,
    monitorId: r.monitor_id,
    monitorName: r.monitor_name,
    monitorUrl: r.monitor_url,
    checkKey: r.check_key,
    severity: r.severity,
    title: r.title,
    status: r.status,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    lastSeenAt: r.last_seen_at,
    occurrences: r.occurrences,
    acknowledgedAt: r.acknowledged_at,
    detail: r.detail,
  };
}

incidentsRouter.get('/', async (req, res) => {
  const q = parse(z.object({ status: z.enum(['open', 'resolved', 'all']).default('all'), monitorId: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
  const params: unknown[] = [req.auth!.workspace.id, String(PLANS[req.auth!.workspace.plan].monitorHistoryDays)];
  let where = "i.workspace_id = $1 AND (i.status = 'open' OR i.opened_at > now() - ($2 || ' days')::interval)";
  if (q.status !== 'all') {
    params.push(q.status);
    where += ` AND i.status = $${params.length}`;
  }
  if (q.monitorId) {
    params.push(q.monitorId);
    where += ` AND i.monitor_id = $${params.length}`;
  }
  params.push(q.limit);
  const rows = await query<Parameters<typeof incidentDTO>[0]>(
    `SELECT i.*, m.name AS monitor_name, m.url AS monitor_url FROM incidents i JOIN monitors m ON m.id = i.monitor_id
      WHERE ${where} ORDER BY (i.status = 'open') DESC, CASE i.severity WHEN 'p1' THEN 0 WHEN 'p2' THEN 1 WHEN 'p3' THEN 2 ELSE 3 END, i.opened_at DESC LIMIT $${params.length}`,
    params,
  );
  res.json(rows.map(incidentDTO));
});

incidentsRouter.post('/:id/ack', async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw notFound('Incident');
  const r = await one('UPDATE incidents SET acknowledged_at = now(), acknowledged_by = $3 WHERE id = $1 AND workspace_id = $2 RETURNING id', [req.params.id, req.auth!.workspace.id, req.auth!.user.id]);
  if (!r) throw notFound('Incident');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- alert contacts and settings

alertsRouter.get('/', async (req, res) => {
  const ws = req.auth!.workspace;
  const contacts = await query<{ id: string; channel: 'email'; target: string; enabled: boolean }>('SELECT id, channel, target, enabled FROM alert_contacts WHERE workspace_id = $1 ORDER BY created_at', [ws.id]);
  const deliveries = await query<{ id: string; incident_id: string | null; title: string | null; target: string; event: AlertDeliveryDTO['event']; status: AlertDeliveryDTO['status']; error: string | null; created_at: string }>(
    `SELECT d.id, d.incident_id, i.title, d.target, d.event, d.status, d.error, d.created_at
       FROM alert_deliveries d LEFT JOIN incidents i ON i.id = d.incident_id WHERE d.workspace_id = $1 ORDER BY d.created_at DESC LIMIT 50`,
    [ws.id],
  );
  const settings = await one<{ alert_min_severity: string }>('SELECT alert_min_severity FROM workspaces WHERE id = $1', [ws.id]);
  res.json({
    emailConfigured: config.emailConfigured,
    devInboxUrl: config.SMTP_DEV_INBOX_URL ?? null,
    minSeverity: settings?.alert_min_severity ?? 'p2',
    maxContacts: PLANS[ws.plan].maxAlertContacts,
    contacts: contacts.map((c): AlertContactDTO => ({ id: c.id, channel: c.channel, target: c.target, enabled: c.enabled })),
    deliveries: deliveries.map(
      (d): AlertDeliveryDTO => ({ id: d.id, incidentId: d.incident_id, incidentTitle: d.title, target: d.target, event: d.event, status: d.status, error: d.error, createdAt: d.created_at }),
    ),
  });
});

alertsRouter.post('/contacts', requireRole('owner', 'admin'), async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email().max(254) }), req.body);
  const ws = req.auth!.workspace;
  await tx(async (c) => {
    // Serialise per workspace so two requests at once cannot both pass the contact limit.
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`alert-contacts:${ws.id}`], c);
    const n = await one<{ n: number }>('SELECT count(*) AS n FROM alert_contacts WHERE workspace_id = $1', [ws.id], c);
    if (Number(n?.n ?? 0) >= PLANS[ws.plan].maxAlertContacts) throw quotaExceeded(`Your ${PLANS[ws.plan].name} plan includes ${PLANS[ws.plan].maxAlertContacts} alert contact(s).`);
    const ins = await one("INSERT INTO alert_contacts (workspace_id, channel, target) VALUES ($1, 'email', $2) ON CONFLICT DO NOTHING RETURNING id", [ws.id, body.email], c);
    if (!ins) throw conflict('That address is already an alert contact.');
  });
  res.status(201).json({ ok: true });
});

alertsRouter.patch('/contacts/:id', requireRole('owner', 'admin'), async (req, res) => {
  const body = parse(z.object({ enabled: z.boolean() }), req.body);
  if (!uuid.safeParse(req.params.id).success) throw notFound('Contact');
  const r = await one('UPDATE alert_contacts SET enabled = $3 WHERE id = $1 AND workspace_id = $2 RETURNING id', [req.params.id, req.auth!.workspace.id, body.enabled]);
  if (!r) throw notFound('Contact');
  res.json({ ok: true });
});

alertsRouter.delete('/contacts/:id', requireRole('owner', 'admin'), async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw notFound('Contact');
  const r = await one('DELETE FROM alert_contacts WHERE id = $1 AND workspace_id = $2 RETURNING id', [req.params.id, req.auth!.workspace.id]);
  if (!r) throw notFound('Contact');
  res.json({ ok: true });
});

const testLimiter = rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'test' ? 1000 : 5, standardHeaders: 'draft-8', legacyHeaders: false });
alertsRouter.post('/contacts/:id/test', testLimiter, async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) throw notFound('Contact');
  try {
    res.json(await sendTestAlert(req.auth!.workspace.id, String(req.params.id)));
  } catch {
    throw notFound('Contact');
  }
});

alertsRouter.patch('/settings', requireRole('owner', 'admin'), async (req, res) => {
  const body = parse(z.object({ minSeverity: z.enum(PRIORITIES) }), req.body);
  await query('UPDATE workspaces SET alert_min_severity = $2 WHERE id = $1', [req.auth!.workspace.id, body.minSeverity]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- public heartbeat endpoint

// Per heartbeat (token), so one server pinging many monitors is not throttled into false "down"
// incidents; plus a generous per-IP ceiling against floods.
const heartbeatLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.NODE_ENV === 'test' ? 1000 : 10,
  keyGenerator: (req) => `hb:${String(req.params.token ?? '')}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const heartbeatIpLimiter = rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'test' ? 10_000 : 600, standardHeaders: 'draft-8', legacyHeaders: false });
heartbeatRouter.all('/:token', heartbeatIpLimiter, heartbeatLimiter, async (req, res) => {
  const token = String(req.params.token);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound('Heartbeat');
  const m = await one<{ id: string; enabled: boolean }>(
    "UPDATE monitors SET last_heartbeat_at = now() WHERE heartbeat_token = $1 AND kind = 'heartbeat' RETURNING id, enabled",
    [token],
  );
  if (!m) throw notFound('Heartbeat');
  // Re-evaluate straight away so a recovered job resolves its incident without waiting.
  await query("UPDATE monitor_checks SET next_run_at = now() WHERE monitor_id = $1 AND check_key = 'heartbeat' AND locked_at IS NULL", [m.id]);
  res.type('text/plain').send(m.enabled ? 'OK' : 'OK (monitor paused)');
});

