// Monitoring engine end to end: real HTTP against the local fixture site, real PostgreSQL,
// real SMTP delivery (local smtp-server), real Stripe signature verification.

import Stripe from 'stripe';
import request from 'supertest';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MonitorDTO } from '@wpcg/shared';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool, query } from '../src/db/pool.js';
import { runDueOnce } from '../src/monitoring/scheduler.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { uptimeCheck } from '../src/monitoring/checks/uptime.js';
import { exposureCheck } from '../src/monitoring/checks/exposure.js';
import { defacementCheck, headersCheck, indexingCheck, scriptsCheck } from '../src/monitoring/checks/content.js';
import { detectChallenge, registrableDomain } from '../src/monitoring/probe.js';
import { parseWhoisExpiry } from '../src/monitoring/checks/domain.js';
import type { MonitorRow } from '../src/monitoring/types.js';
import { startFixtureSite, type FixtureSite } from './fixtureSite.js';

const app = createApp();
let site: FixtureSite;
const mail: { to: string; subject: string; raw: string }[] = [];
let smtp: SMTPServer;

const monitorRow = (over: Partial<MonitorRow> = {}): MonitorRow => ({
  id: '00000000-0000-0000-0000-000000000000',
  workspace_id: '00000000-0000-0000-0000-000000000000',
  website_id: null,
  kind: 'website',
  name: 'Fixture',
  url: site.url,
  enabled: true,
  interval_seconds: 300,
  keyword: null,
  keyword_mode: null,
  money_page: false,
  exposure_authorised_at: null,
  heartbeat_token: null,
  heartbeat_grace_seconds: 300,
  last_heartbeat_at: null,
  ...over,
});
const ctx = (over: Partial<MonitorRow> = {}, baseline: unknown = null) => ({ monitor: monitorRow(over), baseline, signal: new AbortController().signal });

async function signup(name: string) {
  const agent = request.agent(app);
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  await agent.post('/api/auth/signup').send({ name, email, password: 'a-long-test-password', acceptTerms: true }).expect(201);
  const me = await agent.get('/api/auth/me').expect(200);
  return { agent, csrf: me.body.csrfToken as string, email, workspaceId: me.body.workspace.id as string };
}

beforeAll(async () => {
  await migrate(() => {});
  site = await startFixtureSite(4598);
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        mail.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), subject: raw.match(/^Subject: (.*)$/m)?.[1] ?? '', raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(2526, '127.0.0.1', r));
});

afterAll(async () => {
  await closeBrowser();
  await site.close();
  await new Promise<void>((r) => smtp.close(() => r()));
  await pool.end();
});

describe('checks against the fixture site', () => {
  it('uptime: up with timings; keyword present/absent', async () => {
    site.set({ mode: 'normal', delayMs: 0 });
    const up = await uptimeCheck(ctx());
    expect(up.status).toBe('up');
    expect(up.ttfbMs).toBeGreaterThanOrEqual(0);
    const missing = await uptimeCheck(ctx({ keyword: 'Checkout now', keyword_mode: 'present' }));
    expect(missing.status).toBe('down');
    expect(missing.summary).toMatch(/Checkout now/);
    const absent = await uptimeCheck(ctx({ keyword: 'Welcome to the fixture', keyword_mode: 'absent' }));
    expect(absent.status).toBe('down');
  });

  it('uptime: a 503 is retried three times before it counts as down (P1 for the homepage)', async () => {
    site.set({ mode: 'down' });
    const r = await uptimeCheck(ctx());
    expect(r.status).toBe('down');
    expect(r.severity).toBe('p1');
    expect(r.attempts).toBe(3);
    site.set({ mode: 'normal' });
  }, 30_000);

  it('uptime: a 200 page showing a database error is down', async () => {
    site.set({ mode: 'dberror' });
    const r = await uptimeCheck(ctx());
    expect(r.status).toBe('down');
    expect(r.summary).toMatch(/database/);
    site.set({ mode: 'normal' });
  });

  it('R0: a bot challenge is "not assessed", never down', async () => {
    site.set({ mode: 'challenge' });
    const r = await uptimeCheck(ctx());
    expect(r.status).toBe('not_assessed');
    expect(r.summary).toMatch(/challenge|refused/i);
    site.set({ mode: 'normal' });
  });

  it('uptime: slow first byte is re-sampled and reported as a P3 warning', async () => {
    site.set({ delayMs: 3300 });
    const r = await uptimeCheck(ctx());
    expect(r.status).toBe('warning');
    expect(r.severity).toBe('p3');
    expect(r.attempts).toBe(3);
    site.set({ delayMs: 0 });
  }, 40_000);

  it('headers: missing headers and PHP end-of-life from X-Powered-By', async () => {
    const r = await headersCheck(ctx());
    expect(r.status).toBe('warning');
    expect(r.severity).toBe('p2'); // PHP 7.4 is end-of-life
    expect(r.summary).toMatch(/PHP 7\.4 is end-of-life/);
    expect(r.summary).toMatch(/X-Content-Type-Options/);
  });

  it('indexing: sitemap found and robots.txt changes reported once', async () => {
    const first = await indexingCheck(ctx());
    expect(first.status).toBe('up');
    const changed = await indexingCheck(ctx({}, { robotsHash: 'different', robotsText: 'User-agent: *\nDisallow:' }));
    expect(changed.status).toBe('warning');
    expect(changed.summary).toMatch(/robots\.txt changed/);
    expect(changed.event).toBe(true);
  });

  it('defacement: records a baseline, then flags a changed title until accepted', async () => {
    const first = await defacementCheck(ctx());
    expect(first.status).toBe('up');
    site.set({ title: 'HACKED BY SOMEONE' });
    const second = await defacementCheck(ctx({}, first.baseline));
    expect(second.status).toBe('warning');
    expect(second.summary).toMatch(/HACKED BY SOMEONE/);
    site.set({ title: 'Fixture home page for scanning tests' });
  });

  it('defacement: never records a challenge page as the baseline', async () => {
    site.set({ mode: 'challenge' });
    const r = await defacementCheck(ctx());
    expect(r.status).toBe('not_assessed');
    expect(r.baseline).toBeUndefined();
    site.set({ mode: 'normal' });
  });

  it('scripts: alerts on a new third-party script domain', async () => {
    const first = await scriptsCheck(ctx());
    site.set({ extraScript: true });
    const second = await scriptsCheck(ctx({}, first.baseline));
    expect(second.status).toBe('warning');
    expect(second.summary).toMatch(/cdn\.skimmer-example\.net/);
    site.set({ extraScript: false });
  });

  it('exposure: refuses to run without authorisation', async () => {
    const r = await exposureCheck(ctx());
    expect(r.status).toBe('not_assessed');
    expect(r.summary).toMatch(/authorisation/);
  });

  it('exposure: content-confirmed hits only, also when the site answers 200 for everything', async () => {
    site.set({ exposed: true, soft404: true });
    const r = await exposureCheck(ctx({ exposure_authorised_at: new Date().toISOString() }));
    expect(r.status).toBe('warning');
    expect(r.severity).toBe('p1');
    const hits = (r.detail as { hits: { path: string }[]; soft404: boolean }).hits.map((h) => h.path).sort();
    expect(hits).toEqual(['/.env', '/.git/HEAD', '/backup.zip', '/uploads/']);
    expect((r.detail as { soft404: boolean }).soft404).toBe(true);
    site.set({ exposed: false });
    const clean = await exposureCheck(ctx({ exposure_authorised_at: new Date().toISOString() }));
    expect(clean.status).toBe('up'); // soft-404 pages are not mistaken for leaks
    site.set({ soft404: false });
  }, 60_000);
});

describe('helpers', () => {
  it('registrable domains', () => {
    expect(registrableDomain('www.irishmediaagency.ie')).toBe('irishmediaagency.ie');
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
  });
  it('WHOIS expiry formats', () => {
    expect(parseWhoisExpiry('Registry Expiry Date: 2027-03-15T00:00:00Z')?.toISOString().slice(0, 10)).toBe('2027-03-15');
    expect(parseWhoisExpiry('renewal date: 14-May-2027')?.getUTCFullYear()).toBe(2027);
  });
  it('challenge detection', () => {
    const base = { ok: false, requestedUrl: '', finalUrl: '', truncated: false, redirects: [], durationMs: 0, ttfbMs: 0, failure: null };
    expect(detectChallenge({ ...base, status: 200, headers: {}, body: Buffer.from('<title>Hello</title>') }).blocked).toBe(false);
    expect(detectChallenge({ ...base, status: 503, headers: { server: 'cloudflare' }, body: Buffer.from('<title>Just a moment...</title>') }).blocked).toBe(true);
    expect(detectChallenge({ ...base, status: 403, headers: {}, body: Buffer.from('Forbidden') }).blocked).toBe(true);
  });
});

describe('monitors API, scheduler, incidents and alerts', () => {
  let a: Awaited<ReturnType<typeof signup>>;
  let monitorId: string;

  it('enforces plan limits on the server', async () => {
    a = await signup('Mona');
    const tooFast = await a.agent.post('/api/monitors').set('x-csrf-token', a.csrf).send({ name: 'x', url: site.url, intervalSeconds: 60, authorised: true });
    expect(tooFast.status).toBe(402);
    const paid = await a.agent.post('/api/monitors').set('x-csrf-token', a.csrf).send({ name: 'x', url: site.url, watchers: ['uptime', 'headers'], authorised: true });
    expect(paid.status).toBe(402);
    expect(paid.body.error.message).toMatch(/Security headers/);
    await a.agent.post('/api/monitors').set('x-csrf-token', a.csrf).send({ name: 'x', url: site.url }).expect(400); // authorisation required
  });

  it('creates a monitor, runs it, stores results and computes uptime', async () => {
    const r = await a.agent.post('/api/monitors').set('x-csrf-token', a.csrf).send({ name: 'Fixture', url: site.url, intervalSeconds: 300, watchers: ['uptime', 'https'], authorised: true }).expect(201);
    monitorId = r.body.id;
    expect(r.body.watchers.map((w: { key: string }) => w.key)).toEqual(['uptime', 'https']);
    // New watchers are staggered so they do not all hit the site at once; make both due now.
    await query("UPDATE monitor_checks SET next_run_at = now() WHERE monitor_id = $1", [monitorId]);
    expect(await runDueOnce()).toBe(2);
    const m: MonitorDTO = (await a.agent.get(`/api/monitors/${monitorId}`).expect(200)).body;
    expect(m.watchers.find((w) => w.key === 'uptime')!.lastStatus).toBe('up');
    expect(m.uptime24h).toBe(100);
    const results = (await a.agent.get(`/api/monitors/${monitorId}/results?checkKey=uptime`).expect(200)).body;
    expect(results[0].ttfbMs).toBeGreaterThanOrEqual(0);
  });

  it('opens one incident when the site goes down, alerts once by e-mail, and resolves with a recovery e-mail', async () => {
    // Configure an alert contact (SMTP points at the local test server via env in vitest config).
    await a.agent.post('/api/alerts/contacts').set('x-csrf-token', a.csrf).send({ email: 'ops@example.com' }).expect(201);
    site.set({ mode: 'down' });
    await query("UPDATE monitor_checks SET next_run_at = now() WHERE monitor_id = $1 AND check_key = 'uptime'", [monitorId]);
    await runDueOnce();
    await query("UPDATE monitor_checks SET next_run_at = now() WHERE monitor_id = $1 AND check_key = 'uptime'", [monitorId]);
    await runDueOnce(); // still down: same incident, no second alert
    const incidents = (await a.agent.get('/api/incidents?status=open').expect(200)).body;
    expect(incidents).toHaveLength(1);
    expect(incidents[0].severity).toBe('p1');
    expect(incidents[0].occurrences).toBe(2);
    expect(mail.filter((m) => m.subject.includes('[P1]'))).toHaveLength(1);

    site.set({ mode: 'normal' });
    await query("UPDATE monitor_checks SET next_run_at = now() WHERE monitor_id = $1 AND check_key = 'uptime'", [monitorId]);
    await runDueOnce();
    expect((await a.agent.get('/api/incidents?status=open').expect(200)).body).toHaveLength(0);
    expect(mail.filter((m) => m.subject.includes('[Resolved]'))).toHaveLength(1);
    const alerts = (await a.agent.get('/api/alerts').expect(200)).body;
    expect(alerts.deliveries.map((d: { event: string; status: string }) => `${d.event}:${d.status}`).sort()).toEqual(['opened:sent', 'resolved:sent']);
  }, 60_000);

  it('a bot challenge neither opens nor resolves incidents', async () => {
    site.set({ mode: 'challenge' });
    await query("UPDATE monitor_checks SET next_run_at = now() WHERE monitor_id = $1 AND check_key = 'uptime'", [monitorId]);
    await runDueOnce();
    const m: MonitorDTO = (await a.agent.get(`/api/monitors/${monitorId}`).expect(200)).body;
    expect(m.watchers.find((w) => w.key === 'uptime')!.lastStatus).toBe('not_assessed');
    expect((await a.agent.get('/api/incidents?status=open').expect(200)).body).toHaveLength(0);
    site.set({ mode: 'normal' });
  });

  it('records crashed runs as monitoring errors and reclaims stale locks', async () => {
    const { reclaimStale } = await import('../src/monitoring/scheduler.js');
    await query("UPDATE monitor_checks SET locked_at = now() - interval '11 minutes', locked_by = 'dead-worker:1' WHERE monitor_id = $1 AND check_key = 'https'", [monitorId]);
    expect(await reclaimStale()).toBe(1);
    const results = (await a.agent.get(`/api/monitors/${monitorId}/results?checkKey=https&limit=1`).expect(200)).body;
    expect(results[0].status).toBe('error');
    expect(results[0].summary).toMatch(/did not complete/);
  });

  it('heartbeat monitors: ping URL, up while pinging, down when silent', async () => {
    const r = await a.agent.post('/api/monitors').set('x-csrf-token', a.csrf).send({ kind: 'heartbeat', name: 'Nightly backup', intervalSeconds: 300, heartbeatGraceSeconds: 60, authorised: true }).expect(201);
    const token = new URL(r.body.heartbeatUrl).pathname.split('/').pop();
    await request(app).get(`/api/heartbeat/${token}`).expect(200);
    await runDueOnce();
    let m: MonitorDTO = (await a.agent.get(`/api/monitors/${r.body.id}`).expect(200)).body;
    expect(m.status).toBe('up');
    await query("UPDATE monitors SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [r.body.id]);
    await query("UPDATE monitor_checks SET next_run_at = now() WHERE monitor_id = $1", [r.body.id]);
    await runDueOnce();
    m = (await a.agent.get(`/api/monitors/${r.body.id}`).expect(200)).body;
    expect(m.status).toBe('down');
    await request(app).post(`/api/heartbeat/not-a-real-token-123456`).expect(404);
  });

  it('isolates monitors between workspaces', async () => {
    const b = await signup('Bob');
    await b.agent.get(`/api/monitors/${monitorId}`).expect(404);
    expect((await b.agent.get('/api/monitors').expect(200)).body).toHaveLength(0);
    expect((await b.agent.get('/api/incidents').expect(200)).body).toHaveLength(0);
  });

  it('overview reports the scheduler heartbeat honestly (none in tests)', async () => {
    const o = (await a.agent.get('/api/monitors/overview').expect(200)).body;
    expect(o.monitors).toBe(2);
    expect(o.scheduler.healthy).toBe(false);
  });
});

describe('Stripe webhooks', () => {
  const stripe = new Stripe('sk_test_dummy');
  const send = (event: object, secret = 'whsec_test_secret') => {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return request(app).post('/api/billing/webhook').set('content-type', 'application/json').set('stripe-signature', header).send(payload);
  };
  const subEvent = (id: string, workspaceId: string, status: string, price: string) => ({
    id,
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_test_1',
        object: 'subscription',
        customer: 'cus_test_1',
        status,
        metadata: { workspace_id: workspaceId },
        items: { data: [{ price: { id: price }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
      },
    },
  });

  it('rejects unsigned or wrongly signed webhooks', async () => {
    await request(app).post('/api/billing/webhook').set('content-type', 'application/json').send('{}').expect(400);
    const bad = await send(subEvent('evt_bad', '00000000-0000-0000-0000-000000000000', 'active', 'price_pro_test'), 'whsec_wrong');
    expect(bad.status).toBe(400);
  });

  it('grants the plan only from a verified subscription event, idempotently, and downgrades on cancellation', async () => {
    const w = await signup('Paula');
    expect((await send(subEvent('evt_1', w.workspaceId, 'active', 'price_pro_test'))).status).toBe(200);
    let ws = (await w.agent.get('/api/auth/me').expect(200)).body.workspace;
    expect(ws.plan).toBe('pro');
    const dup = await send(subEvent('evt_1', w.workspaceId, 'canceled', 'price_pro_test'));
    expect(dup.body.duplicate).toBe(true); // replayed event id is ignored
    ws = (await w.agent.get('/api/auth/me').expect(200)).body.workspace;
    expect(ws.plan).toBe('pro');
    await send(subEvent('evt_2', w.workspaceId, 'past_due', 'price_pro_test')).expect(200);
    expect((await w.agent.get('/api/auth/me')).body.workspace.plan).toBe('pro'); // grace period keeps access
    await send(subEvent('evt_3', w.workspaceId, 'canceled', 'price_pro_test')).expect(200);
    expect((await w.agent.get('/api/auth/me')).body.workspace.plan).toBe('free');
    const billing = (await w.agent.get('/api/billing').expect(200)).body;
    expect(billing.subscription.status).toBe('canceled');
  });

  it('the browser cannot grant itself a plan', async () => {
    const w = await signup('Carl');
    await w.agent.post('/api/workspace').set('x-csrf-token', w.csrf).send({ plan: 'agency' });
    expect((await w.agent.get('/api/auth/me')).body.workspace.plan).toBe('free');
  });
});

describe('review fixes: API behaviour', () => {
  const post = (c: Awaited<ReturnType<typeof signup>>, url: string, body: object) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  let r: Awaited<ReturnType<typeof signup>>;
  let mon: string;

  it('a malformed id is "not found", not a server error', async () => {
    r = await signup('Rex');
    for (const path of ['/api/websites/abc', '/api/monitors/abc', '/api/scans/abc', '/api/issues/abc']) {
      const res = await r.agent.get(path);
      expect([400, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toMatch(/22P02|invalid input syntax/);
    }
  });

  it('two sign-ups with the same email at once: one account, one clear conflict', async () => {
    const email = `twin-${Date.now()}@example.com`;
    const body = { name: 'Twin', email, password: 'a-long-test-password', acceptTerms: true };
    const res = await Promise.all([request(app).post('/api/auth/signup').send(body), request(app).post('/api/auth/signup').send(body)]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
  });

  it('"Check now" for one watcher is also limited to once a minute', async () => {
    const m = await post(r, '/api/monitors', { name: 'Throttle', url: site.url, intervalSeconds: 300, watchers: ['uptime', 'https'], authorised: true }).expect(201);
    mon = m.body.id;
    await query("INSERT INTO check_results (monitor_id, check_key, status, summary, started_at) VALUES ($1, 'https', 'up', 'ok', now())", [mon]);
    expect((await post(r, `/api/monitors/${mon}/run`, { checkKey: 'https' })).status).toBe(409);
    expect((await post(r, `/api/monitors/${mon}/run`, { checkKey: 'uptime' })).status).toBe(200);
  });

  it('a shorter interval takes effect now, not after the old wait', async () => {
    await query("UPDATE monitor_checks SET next_run_at = now() + interval '1 day' WHERE monitor_id = $1 AND check_key = 'uptime'", [mon]);
    await r.agent.patch(`/api/monitors/${mon}`).set('x-csrf-token', r.csrf).send({ intervalSeconds: 600 }).expect(200);
    const row = await query<{ due_in: number }>("SELECT extract(epoch FROM next_run_at - now()) AS due_in FROM monitor_checks WHERE monitor_id = $1 AND check_key = 'uptime'", [mon]);
    expect(Number(row[0].due_in)).toBeLessThanOrEqual(601);
  });

  it('the response-time chart covers the whole range up to now, keeping outages', async () => {
    await query('DELETE FROM check_results WHERE monitor_id = $1', [mon]);
    // 5,000 results over the last 7 days (newest ~1 minute ago), one "down" in the middle.
    await query(
      `INSERT INTO check_results (monitor_id, check_key, status, summary, response_ms, started_at)
       SELECT $1, 'uptime', CASE WHEN g = 2500 THEN 'down' ELSE 'up' END, 'x', 100, now() - (g * interval '2 minutes') + interval '1 minute'
         FROM generate_series(1, 5000) g`,
      [mon],
    );
    const s = (await r.agent.get(`/api/monitors/${mon}/series?range=7d`).expect(200)).body;
    expect(s.points.length).toBeLessThanOrEqual(3100);
    expect(Date.now() - new Date(s.points.at(-1).t).getTime()).toBeLessThan(5 * 60_000);
    expect(s.points.some((p: { status: string }) => p.status === 'down')).toBe(true);
  });
});

describe('review fixes: Stripe events', () => {
  const stripe = new Stripe('sk_test_dummy');
  const send = (event: object) => {
    const payload = JSON.stringify(event);
    return request(app).post('/api/billing/webhook').set('content-type', 'application/json').set('stripe-signature', stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' })).send(payload);
  };
  const ev = (id: string, subId: string, workspaceId: string, status: string, customer = `cus_${workspaceId.slice(0, 8)}`) => ({
    id,
    object: 'event',
    type: status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated',
    data: { object: { id: subId, object: 'subscription', customer, status, metadata: { workspace_id: workspaceId }, items: { data: [{ price: { id: 'price_pro_test' }, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] } } },
  });

  it('an old subscription’s late cancellation does not downgrade a workspace paying for a newer one', async () => {
    const w = await signup('Olga');
    await send(ev(`evt_a_${Date.now()}`, 'sub_old', w.workspaceId, 'active')).expect(200);
    await send(ev(`evt_b_${Date.now()}`, 'sub_new', w.workspaceId, 'active')).expect(200);
    await send(ev(`evt_c_${Date.now()}`, 'sub_old', w.workspaceId, 'canceled')).expect(200);
    const me = (await w.agent.get('/api/auth/me').expect(200)).body.workspace;
    expect(me.plan).toBe('pro');
    // The current subscription's own cancellation still downgrades.
    await send(ev(`evt_d_${Date.now()}`, 'sub_new', w.workspaceId, 'canceled')).expect(200);
    expect((await w.agent.get('/api/auth/me')).body.workspace.plan).toBe('free');
  });

  it('an event left unprocessed by a crash is processed on Stripe’s retry, not dropped as a duplicate', async () => {
    const w = await signup('Rita');
    const id = `evt_crash_${Date.now()}`;
    await query("INSERT INTO stripe_events (id, type, received_at) VALUES ($1, 'customer.subscription.updated', now() - interval '10 minutes')", [id]);
    const res = await send(ev(id, 'sub_rita', w.workspaceId, 'active')).expect(200);
    expect(res.body.duplicate).toBeUndefined();
    expect((await w.agent.get('/api/auth/me')).body.workspace.plan).toBe('pro');
  });
});
