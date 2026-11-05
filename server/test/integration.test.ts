// End-to-end: real HTTP API, real PostgreSQL, real headless Chrome, scanning the local fixture site.

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IssueDTO } from '@wpcg/shared';
import { createApp } from '../src/app.js';
import { reportHtml } from '../src/reports/exporters.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { pool, query } from '../src/db/pool.js';
import { claimNext, processScan } from '../src/queue/worker.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { absolute } from '../src/storage/files.js';
import { startFixtureSite, type FixtureSite } from './fixtureSite.js';

const app = createApp();
let site: FixtureSite;

interface Client {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  email: string;
}

async function signup(name: string): Promise<Client> {
  const agent = request.agent(app);
  const email = `${name.toLowerCase()}-${Date.now()}@example.com`;
  await agent.post('/api/auth/signup').send({ name, email, password: 'a-long-test-password', acceptTerms: true }).expect(201);
  const me = await agent.get('/api/auth/me').expect(200);
  return { agent, csrf: me.body.csrfToken, email };
}

const post = (c: Client, url: string, body: object) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);

/** Runs every queued scan to completion with the real worker code. */
async function drainQueue() {
  for (let job = await claimNext(); job; job = await claimNext()) await processScan(job);
}

async function issuesOf(c: Client, scanId: string): Promise<IssueDTO[]> {
  const res = await c.agent.get(`/api/issues?scanId=${scanId}&status=all&limit=500`).expect(200);
  return res.body.items;
}

const FULL_NO_PERF = ['availability', 'html', 'seo', 'accessibility', 'security', 'javascript', 'images', 'links', 'responsive'];

let a: Client;
let b: Client;
let scan1: string;
let website: string;

beforeAll(async () => {
  await migrate(() => {});
  site = await startFixtureSite(4598);
  a = await signup('Alice');
  b = await signup('Bob');
});

afterAll(async () => {
  await closeBrowser();
  await site.close();
  await pool.end();
});

describe('authentication and request protection', () => {
  it('rejects anonymous API access', async () => {
    await request(app).get('/api/overview').expect(401);
  });
  it('rejects state-changing requests without the CSRF token', async () => {
    await a.agent.post('/api/websites').send({ url: site.url }).expect(403);
  });
  it('rejects cross-site origins', async () => {
    await a.agent.post('/api/websites').set('x-csrf-token', a.csrf).set('origin', 'https://evil.example').send({ url: site.url }).expect(403);
  });
  it('does not reveal whether an e-mail exists on failed login', async () => {
    const r1 = await request(app).post('/api/auth/login').send({ email: a.email, password: 'wrong-password-123' }).expect(401);
    const r2 = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-123' }).expect(401);
    expect(r1.body.error.message).toBe(r2.body.error.message);
  });
  it('sets an HttpOnly, SameSite session cookie', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: a.email, password: 'a-long-test-password' }).expect(200);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(res.headers['set-cookie'])).toMatch(/SameSite=Lax/i);
  });
});

describe('scan submission safety', () => {
  it.each([
    ['http://127.0.0.1:4100/', /private/],
    ['http://169.254.169.254/latest/meta-data/', /private/],
    ['http://localhost:4598/', /internal or reserved/],
    ['file:///etc/passwd', /http/],
  ])('refuses %s', async (url, msg) => {
    const res = await post(a, '/api/scans', { url, kind: 'quick', viewports: ['desktop'], maxPages: 1, authorised: true }).expect(400);
    expect(res.body.error.message).toMatch(msg);
  });
  it('requires the authorisation confirmation', async () => {
    const res = await post(a, '/api/scans', { url: site.url, kind: 'quick', viewports: ['desktop'], maxPages: 1 }).expect(400);
    expect(res.body.error.message).toMatch(/authorised/);
  });
  it('enforces the plan page limit server-side', async () => {
    await post(a, '/api/scans', { url: site.url, kind: 'quick', viewports: ['desktop'], maxPages: 500, authorised: true }).expect(402);
  });
  it('preflight explains the target before scanning', async () => {
    const res = await post(a, '/api/scans/preflight', { url: site.url }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reachable).toBe(true);
  });
});

describe('full scan of the fixture site', () => {
  it('runs a real scan and stores honest results', async () => {
    const res = await post(a, '/api/scans', {
      url: site.url,
      kind: 'full',
      viewports: ['desktop', 'mobile'],
      maxPages: 10,
      checks: [...FULL_NO_PERF, 'performance'],
      authorised: true,
    }).expect(201);
    scan1 = res.body.id;
    website = res.body.websiteId;
    expect(res.body.status).toBe('queued');
    await drainQueue();

    const detail = (await a.agent.get(`/api/scans/${scan1}`).expect(200)).body;
    expect(detail.scan.status).toBe('completed');
    const pages = detail.pages.map((p: { url: string }) => p.url);
    expect(pages).toEqual(expect.arrayContaining([site.url, `${site.url}about`, `${site.url}contact`, `${site.url}missing-page`, `${site.url}blog`]));
    expect(pages).not.toContain(`${site.url}old-about`); // redirect de-duplicated
    expect(pages).not.toContain(`${site.url}private/secret`); // robots.txt respected
    expect(detail.scan.summary.notes.join(' ')).toMatch(/robots\.txt/);

    const runs = Object.fromEntries(detail.checkRuns.map((r: { category: string; status: string }) => [r.category, r.status]));
    for (const c of FULL_NO_PERF) expect(runs[c]).toBe('completed');
    expect(['completed', 'partial', 'unavailable']).toContain(runs.performance);
    expect(runs.forms).toBe('skipped');
    expect(runs.visual).toBe('skipped');

    const home = detail.pages.find((p: { url: string }) => p.url === site.url);
    expect(home.screenshots).toHaveLength(2);
    const png = await a.agent.get(home.screenshots[0].url).expect(200);
    expect(png.headers['content-type']).toMatch(/png/);

    const ids = new Set((await issuesOf(a, scan1)).map((i) => i.ruleId));
    for (const expected of [
      'availability.not-found',
      'availability.server-error',
      'links.broken-internal',
      'links.internal-redirect',
      'javascript.uncaught-error',
      'javascript.console-error',
      'images.broken',
      'images.oversized',
      'html.missing-lang',
      'html.heading-level-skipped',
      'html.duplicate-ids',
      'axe.image-alt',
      'axe.label',
      'axe.color-contrast',
      'seo.structured-data-invalid',
      'seo.noindex-page',
      'seo.missing-meta-description',
      'responsive.horizontal-overflow',
      'security.no-https',
      'security.version-disclosure',
    ])
      expect(ids, expected).toContain(expected);
    // Things that are fine on the fixture must not be reported.
    for (const absent of ['seo.robots-blocks-site', 'seo.sitemap-missing', 'html.missing-viewport', 'seo.noindex-homepage', 'availability.site-unreachable'])
      expect(ids, absent).not.toContain(absent);
  });

  it('groups a broken link target across pages and records where it was found', async () => {
    const issues = await issuesOf(a, scan1);
    const broken = issues.find((i) => i.ruleId === 'links.broken-internal')!;
    const detail = (await a.agent.get(`/api/issues/${broken.id}`).expect(200)).body;
    expect(detail.findings[0].evidence.map((e: { value: string }) => e.value).join('\n')).toContain('/missing-page');
    expect(detail.remediation.steps.length).toBeGreaterThan(0);
    expect(detail.events[0].reason).toMatch(/First detected/);
    expect(detail.severityReason).toMatch(/High/);
  });

  it('reports overflow only for the mobile viewport', async () => {
    const issues = await issuesOf(a, scan1);
    const overflow = issues.filter((i) => i.ruleId === 'responsive.horizontal-overflow');
    expect(overflow).toHaveLength(1);
    const detail = (await a.agent.get(`/api/issues/${overflow[0].id}`).expect(200)).body;
    expect(detail.findings[0].viewport).toBe('mobile');
  });

  it('marks heuristic findings for review rather than as defects', async () => {
    const issues = await issuesOf(a, scan1);
    expect(issues.find((i) => i.ruleId === 'seo.noindex-page')!.status).toBe('needs_review');
  });
});

describe('pages tested, one page at a time', () => {
  it('pages through the scanned pages with a total, and matches the full list', async () => {
    const all = (await a.agent.get(`/api/scans/${scan1}`).expect(200)).body.pages as { url: string }[];
    const first = (await a.agent.get(`/api/scans/${scan1}/pages?limit=2&offset=0`).expect(200)).body;
    const second = (await a.agent.get(`/api/scans/${scan1}/pages?limit=2&offset=2`).expect(200)).body;
    expect(first.total).toBe(all.length);
    expect(first.items).toHaveLength(Math.min(2, all.length));
    expect([...first.items, ...second.items].map((p: { url: string }) => p.url)).toEqual(all.slice(0, 4).map((p) => p.url));
    await a.agent.get(`/api/scans/${scan1}/pages?limit=1000`).expect(400);
    await b.agent.get(`/api/scans/${scan1}/pages`).expect(404);
  });
});

describe('real-user (field) data from the Chrome UX Report', () => {
  // A local stand-in for Google's API, answering in its documented format. Tests only.
  const calls: { key: string; body: { url?: string; origin?: string; formFactor: string } }[] = [];
  let stub: http.Server;
  let home: string;
  const saved = { key: config.CRUX_API_KEY, base: config.CRUX_API_BASE };
  const record = (lcpP75: number) => ({
    record: {
      metrics: {
        largest_contentful_paint: { histogram: [{ start: 0, end: 2500, density: 0.75 }, { start: 2500, end: 4000, density: 0.17 }, { start: 4000, density: 0.08 }], percentiles: { p75: lcpP75 } },
        cumulative_layout_shift: { histogram: [{ start: '0.00', end: '0.10', density: 0.9 }, { start: '0.10', end: '0.25', density: 0.06 }, { start: '0.25', density: 0.04 }], percentiles: { p75: '0.05' } },
        experimental_time_to_first_byte: { histogram: [{ start: 0, end: 800, density: 0.6 }, { start: 800, end: 1800, density: 0.1 }, { start: 1800, density: 0.3 }], percentiles: { p75: 1800 } },
      },
      collectionPeriod: { firstDate: { year: 2026, month: 9, day: 30 }, lastDate: { year: 2026, month: 10, day: 27 } },
    },
  });

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const key = new URL(req.url!, 'http://x').searchParams.get('key') ?? '';
        const body = JSON.parse(raw);
        calls.push({ key, body });
        res.setHeader('Content-Type', 'application/json');
        if (key !== 'test-key') return void res.writeHead(400).end(JSON.stringify({ error: { code: 400, message: 'API key not valid.' } }));
        // Phone: no data for the URL itself (Google's 404), data for the origin. Desktop: both.
        if (body.url && body.formFactor === 'PHONE') return void res.writeHead(404).end(JSON.stringify({ error: { code: 404, message: 'chrome ux report data not found' } }));
        res.end(JSON.stringify(record(body.formFactor === 'PHONE' ? 2500 : 1200)));
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    config.CRUX_API_BASE = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;
    home = `${site.url}/`;
    await query('INSERT INTO lighthouse_reports (scan_id, page_url, viewport, scores, report) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [scan1, home, 'mobile', '{}', '{}']);
  });
  afterAll(async () => {
    config.CRUX_API_KEY = saved.key;
    config.CRUX_API_BASE = saved.base;
    await new Promise((r) => stub.close(r));
  });
  const fetchField = (c: Client, page: string) => c.agent.get(`/api/scans/${scan1}/field-data?page=${encodeURIComponent(page)}`);

  it('says plainly that field data is not connected when there is no API key', async () => {
    config.CRUX_API_KEY = undefined;
    const body = (await fetchField(a, home).expect(200)).body;
    expect(body.status).toBe('not_configured');
    expect(body.phone).toEqual({ url: null, origin: null });
    expect(calls).toHaveLength(0);
  });

  it('reports a rejected key as unavailable and does not store it', async () => {
    config.CRUX_API_KEY = 'wrong-key';
    const body = (await fetchField(a, home).expect(200)).body;
    expect(body.status).toBe('unavailable');
    expect(body.message).toMatch(/rejected the Chrome UX Report API key/);
    expect(await query('SELECT 1 FROM crux_field_data WHERE scan_id = $1', [scan1])).toHaveLength(0);
  });

  it('returns URL and origin data per device, keeps Google’s “no data” as null, and stores it once', async () => {
    config.CRUX_API_KEY = 'test-key';
    calls.length = 0;
    const body = (await fetchField(a, home).expect(200)).body;
    expect(body.status).toBe('ok');
    expect(calls.map((c) => `${c.body.formFactor}:${c.body.url ? 'url' : 'origin'}`).sort()).toEqual(['DESKTOP:origin', 'DESKTOP:url', 'PHONE:origin', 'PHONE:url']);
    expect(calls.find((c) => c.body.url)!.body.url).toBe(home);
    expect(body.phone.url).toBeNull();
    expect(body.phone.origin.metrics.lcp).toEqual({ p75: 2500, distribution: [0.75, 0.17, 0.08] });
    expect(body.phone.origin.metrics.cls.p75).toBe(0.05);
    expect(body.phone.origin.metrics.inp).toBeUndefined();
    expect(body.phone.origin.firstDate).toBe('2026-09-30');
    expect(body.desktop.url.metrics.lcp.p75).toBe(1200);
    // Stored with the scan: a second view does not call Google again.
    const again = (await fetchField(a, home).expect(200)).body;
    expect(again).toEqual(body);
    expect(calls).toHaveLength(4);
  });

  it('only looks up pages the scan measured, and only for the owning workspace', async () => {
    await fetchField(a, 'https://example.com/').expect(404);
    await fetchField(b, home).expect(404);
  });
});

describe('deleting several scans at once', () => {
  // Extra scan rows copied from scan1 (same website), so the real scans used by later tests stay.
  const copy = async (status: string) =>
    (await query<{ id: string }>('INSERT INTO scans (workspace_id, website_id, kind, config, status, authorised_at) SELECT workspace_id, website_id, kind, config, $2, now() FROM scans WHERE id = $1 RETURNING id', [scan1, status]))[0].id;

  it('deletes finished scans, skips queued/running ones, and never touches another workspace', async () => {
    const done1 = await copy('completed');
    const done2 = await copy('failed');
    const running = await copy('running');
    // Bob cannot delete Alice's scans, even by id.
    const theirs = (await post(b, '/api/scans/delete', { ids: [done1] }).expect(200)).body;
    expect(theirs).toMatchObject({ deleted: 0, skipped: [{ id: done1, reason: 'Not found.' }] });
    const r = (await post(a, '/api/scans/delete', { ids: [done1, done2, running] }).expect(200)).body;
    expect(r.deleted).toBe(2);
    expect(r.skipped).toEqual([{ id: running, reason: 'Queued or running — cancel it first.' }]);
    const left = await query<{ id: string }>('SELECT id FROM scans WHERE id = ANY($1::uuid[])', [[done1, done2, running]]);
    expect(left.map((x) => x.id)).toEqual([running]);
    await query('DELETE FROM scans WHERE id = $1', [running]);
  });

  it('rejects bad input instead of failing', async () => {
    await post(a, '/api/scans/delete', { ids: [] }).expect(400);
    await post(a, '/api/scans/delete', { ids: ['not-a-uuid'] }).expect(400);
    await a.agent.post('/api/scans/delete').send({ ids: [scan1] }).expect(403); // no CSRF token
  });
});

describe('performance comparison with the previous scan', () => {
  // Two scans of the same website with stored Lighthouse reports (TEST FRAGMENTS, not real results).
  const report = (perf: number, lcp: number, bytes: number) => ({
    lighthouseVersion: '13.4.1',
    fetchTime: new Date().toISOString(),
    formFactor: 'mobile',
    environment: [],
    categories: [{ id: 'performance', title: 'Performance', score: perf, groups: [{ id: 'metrics', title: 'Metrics', auditIds: ['largest-contentful-paint'] }] }],
    audits: { 'largest-contentful-paint': { id: 'largest-contentful-paint', title: 'Largest Contentful Paint', description: '', score: 0.5, scoreDisplayMode: 'numeric', numericValue: lcp } },
    finalScreenshot: null,
    filmstrip: [],
    resourceSummary: [{ resourceType: 'total', label: 'Total', requestCount: 30, transferSize: bytes }],
  });
  const page = 'https://example.ie/perf-compare';
  const scanAt = async (minutesAgo: number) =>
    (
      await query<{ id: string }>(
        `INSERT INTO scans (workspace_id, website_id, kind, config, status, authorised_at, created_at, finished_at)
         SELECT workspace_id, website_id, kind, config, 'completed', now(), now() - make_interval(mins => $2::int), now() - make_interval(mins => $2::int) FROM scans WHERE id = $1 RETURNING id`,
        [scan1, minutesAgo],
      )
    )[0].id;

  it('compares scores, metrics and page weight with the latest earlier scan, and only within the workspace', async () => {
    const older = await scanAt(120);
    const newer = await scanAt(60);
    await query('INSERT INTO lighthouse_reports (scan_id, page_url, viewport, scores, report) VALUES ($1,$2,$3,$4,$5)', [older, page, 'mobile', '{}', JSON.stringify(report(0.8, 2500, 1_000_000))]);
    await query('INSERT INTO lighthouse_reports (scan_id, page_url, viewport, scores, report) VALUES ($1,$2,$3,$4,$5)', [newer, page, 'mobile', '{}', JSON.stringify(report(0.6, 4000, 1_400_000))]);
    const q = `page=${encodeURIComponent(page)}&viewport=mobile`;
    const c = (await a.agent.get(`/api/scans/${newer}/lighthouse/compare?${q}`).expect(200)).body;
    expect(c.previous.scanId).toBe(older);
    expect(c.previous.scores.performance).toBe(0.8);
    expect(c.current.metrics['largest-contentful-paint']).toBe(4000);
    expect(c.current.totalTransferSize - c.previous.totalTransferSize).toBe(400_000);
    // The oldest scan has nothing before it.
    expect((await a.agent.get(`/api/scans/${older}/lighthouse/compare?${q}`).expect(200)).body.previous).toBeNull();
    await b.agent.get(`/api/scans/${newer}/lighthouse/compare?${q}`).expect(404);
    await a.agent.get(`/api/scans/${newer}/lighthouse/compare?page=${encodeURIComponent(page)}&viewport=tablet`).expect(400);
    // The report carries the same comparison in its performance section, and the export shows it.
    const rep = (await a.agent.get('/api/reports/' + newer).expect(200)).body;
    expect(rep.performance[0]).toMatchObject({ viewport: 'mobile', totalTransferSize: 1_400_000, comparison: { previousPerformance: 0.8, previousLcpMs: 2500, currentLcpMs: 4000 } });
    const me = (await a.agent.get('/api/auth/me').expect(200)).body;
    const html = await reportHtml(rep, me.workspace.id);
    expect(html).toContain('Performance (home page, Lighthouse)');
    expect(html).toMatch(/performance 80 → 60/);
    // Remove the test scans so later tests that count scans are unaffected.
    await query('DELETE FROM scans WHERE id = ANY($1::uuid[])', [[older, newer]]);
  });

  it('the AI fix plan has no saved plan yet and refuses cleanly when AI is not configured', async () => {
    expect((await a.agent.get(`/api/ai/scans/${scan1}/performance?viewport=mobile`).expect(200)).body).toEqual({ plan: null, pending: false, startedAt: null, error: null });
    const r = await post(a, `/api/ai/scans/${scan1}/performance`, { viewport: 'mobile' });
    expect([403, 404, 503]).toContain(r.status);
    expect(r.body.error.code).toMatch(/ai_|not_found/);
  });
});

describe('workspace isolation', () => {
  it('hides one workspace’s scans, issues, reports and screenshots from another', async () => {
    await b.agent.get(`/api/scans/${scan1}`).expect(404);
    await b.agent.get(`/api/reports/${scan1}`).expect(404);
    const issue = (await issuesOf(a, scan1))[0];
    await b.agent.get(`/api/issues/${issue.id}`).expect(404);
    const shot = (await a.agent.get(`/api/scans/${scan1}`)).body.pages[0].screenshots[0];
    await b.agent.get(shot.url).expect(404);
    expect((await b.agent.get('/api/issues?status=all').expect(200)).body.total).toBe(0);
    expect((await b.agent.get('/api/overview').expect(200)).body.scans).toBe(0);
  });
});

describe('overview metrics come from stored data', () => {
  it('matches the database', async () => {
    const o = (await a.agent.get('/api/overview').expect(200)).body;
    const [row] = await query<{ high: number; total: number }>(
      `SELECT count(*) FILTER (WHERE severity = 'high' AND status <> 'resolved') AS high, count(*) AS total FROM issues i JOIN memberships m ON m.workspace_id = i.workspace_id JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [a.email],
    );
    expect(o.highIssues).toBe(Number(row.high));
    expect(o.scans).toBe(1);
    expect(o.websites).toBe(1);
    expect(o.usage.scansUsed).toBe(1);
  });
});

describe('baselines, visual comparison and resolution', () => {
  let scan2: string;
  it('needs an entitled plan for visual comparison', async () => {
    const baseline = await post(a, '/api/baselines', { scanId: scan1, name: 'Before fixes' }).expect(201);
    const res = await post(a, '/api/scans', { websiteId: website, kind: 'full', viewports: ['desktop', 'mobile'], maxPages: 10, visualCompare: true, baselineId: baseline.body.id, authorised: true });
    expect(res.status).toBe(402);
  });

  it('resolves fixed issues, keeps untested ones open, and flags visual changes', async () => {
    await query("UPDATE workspaces SET plan = 'pro' WHERE id = (SELECT workspace_id FROM websites WHERE id = $1)", [website]);
    const baselines = (await a.agent.get('/api/baselines').expect(200)).body;
    site.setFixed(true);
    site.setBanner(true);
    const res = await post(a, '/api/scans', {
      websiteId: website,
      kind: 'full',
      viewports: ['desktop', 'mobile'],
      maxPages: 10,
      checks: FULL_NO_PERF,
      visualCompare: true,
      baselineId: baselines[0].id,
      visualThresholdPct: 1,
      authorised: true,
    }).expect(201);
    scan2 = res.body.id;
    await drainQueue();
    const detail = (await a.agent.get(`/api/scans/${scan2}`).expect(200)).body;
    expect(detail.scan.status).toBe('completed');
    expect(detail.scan.summary.resolvedIssues).toBeGreaterThan(5);

    const all: IssueDTO[] = (await a.agent.get(`/api/issues?websiteId=${website}&status=all&limit=500`).expect(200)).body.items;
    const status = (rule: string) => all.find((i) => i.ruleId === rule)?.status;
    for (const fixed of ['html.missing-lang', 'links.broken-internal', 'javascript.uncaught-error', 'images.broken', 'axe.label', 'seo.structured-data-invalid', 'responsive.horizontal-overflow'])
      expect(status(fixed), fixed).toBe('resolved');
    // /blog was removed from the sitemap, so it was not re-tested: its server error must stay open.
    expect(status('availability.server-error')).toBe('open');
    // Lighthouse did not run in this scan, so performance issues cannot be resolved by it.
    const perf = all.filter((i) => i.category === 'performance');
    for (const p of perf) expect(p.status).not.toBe('resolved');

    expect(detail.visual.length).toBeGreaterThan(0);
    const changed = detail.visual.filter((v: { status: string }) => v.status === 'changed');
    expect(changed.length).toBeGreaterThan(0);
    await a.agent.get(changed[0].diffImage).expect(200);
    expect(status('visual.changed')).toBe('needs_review');
  });

  it('builds a report with comparison, limitations and exports', async () => {
    const r = (await a.agent.get(`/api/reports/${scan2}`).expect(200)).body;
    expect(r.previous?.scanId).toBe(scan1);
    expect(r.resolved.length).toBeGreaterThan(5);
    expect(r.limitations.join(' ')).toMatch(/cannot establish WCAG conformance/);
    expect(r.checkRuns.find((c: { category: string }) => c.category === 'visual').status).toBe('completed');

    const csv = await a.agent.get(`/api/reports/${scan1}/issues.csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toContain('Issue ID');
    expect(csv.text.split('\r\n').length).toBeGreaterThan(10);

    const pdf = await a.agent.get(`/api/reports/${scan1}/report.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('reopens issues that come back', async () => {
    site.setFixed(false);
    site.setBanner(false);
    const res = await post(a, '/api/scans', { websiteId: website, kind: 'quick', viewports: ['desktop'], maxPages: 3, authorised: true }).expect(201);
    await drainQueue();
    const detail = (await a.agent.get(`/api/scans/${res.body.id}`).expect(200)).body;
    expect(detail.scan.summary.reopenedIssues).toBeGreaterThan(0);
    const all: IssueDTO[] = (await a.agent.get(`/api/issues?websiteId=${website}&status=all&limit=500`).expect(200)).body.items;
    expect(all.find((i) => i.ruleId === 'html.missing-lang')!.status).toBe('reopened');
    // Mobile overflow was not re-tested by a desktop-only quick scan: it stays resolved, not reopened.
    expect(all.find((i) => i.ruleId === 'responsive.horizontal-overflow')!.status).toBe('resolved');
  });
});

describe('verification scans', () => {
  it('re-runs one issue’s check on its pages and resolves it when fixed', async () => {
    const all: IssueDTO[] = (await a.agent.get(`/api/issues?websiteId=${website}&status=active&limit=500`).expect(200)).body.items;
    const lang = all.find((i) => i.ruleId === 'html.missing-lang')!;
    site.setFixed(true);
    const res = await post(a, `/api/issues/${lang.id}/verify`, { authorised: true }).expect(201);
    await drainQueue();
    const scan = (await a.agent.get(`/api/scans/${res.body.scanId}`).expect(200)).body;
    expect(scan.scan.kind).toBe('verification');
    expect(scan.scan.config.selectedUrls).toEqual([site.url]);
    expect(scan.pages).toHaveLength(1);
    const after = (await a.agent.get(`/api/issues/${lang.id}`).expect(200)).body;
    expect(after.status).toBe('resolved');
    site.setFixed(false);
  });

  it('marks the issue Not Tested when the page cannot be loaded, instead of resolving it', async () => {
    // Re-open the language issue, then verify while the site is down.
    const r = await post(a, '/api/scans', { websiteId: website, kind: 'quick', viewports: ['desktop'], maxPages: 1, pageMode: 'selected', selectedUrls: [site.url], authorised: true }).expect(201);
    await drainQueue();
    expect((await a.agent.get(`/api/scans/${r.body.id}`)).body.scan.status).toBe('completed');
    const lang = ((await a.agent.get(`/api/issues?websiteId=${website}&status=active&limit=500`)).body.items as IssueDTO[]).find((i) => i.ruleId === 'html.missing-lang')!;
    expect(lang.status).toBe('reopened');
    await site.close();
    const v = await post(a, `/api/issues/${lang.id}/verify`, { authorised: true }).expect(201);
    await drainQueue();
    const after = (await a.agent.get(`/api/issues/${lang.id}`).expect(200)).body;
    expect(after.status).toBe('not_tested');
    expect(after.events[0].reason).toMatch(/could not re-run/);
    const vs = (await a.agent.get(`/api/scans/${v.body.scanId}`)).body;
    expect(vs.scan.status).toBe('completed');
    site = await startFixtureSite(4598);
  });
});

describe('scan lifecycle and quotas', () => {
  it('cancels a queued scan without touching issue statuses', async () => {
    const res = await post(a, '/api/scans', { websiteId: website, kind: 'quick', viewports: ['desktop'], maxPages: 1, authorised: true }).expect(201);
    await post(a, `/api/scans/${res.body.id}/cancel`, {}).expect(200);
    const s = (await a.agent.get(`/api/scans/${res.body.id}`)).body.scan;
    expect(s.status).toBe('cancelled');
    expect(await claimNext()).toBeNull();
  });

  it('enforces the monthly scan quota on the server', async () => {
    const ws = await query<{ workspace_id: string }>('SELECT workspace_id FROM websites WHERE id = $1', [website]);
    await query("UPDATE workspaces SET plan = 'free' WHERE id = $1", [ws[0].workspace_id]);
    await query("INSERT INTO usage_events (workspace_id, kind) SELECT $1, 'scan' FROM generate_series(1, 25)", [ws[0].workspace_id]);
    const res = await post(a, '/api/scans', { websiteId: website, kind: 'quick', viewports: ['desktop'], maxPages: 1, authorised: true }).expect(402);
    expect(res.body.error.message).toMatch(/scans per month/);
  });

  it('deletes a scan with its screenshots', async () => {
    const shots = await query<{ path: string }>('SELECT path FROM screenshots WHERE scan_id = $1', [scan1]);
    expect(shots.length).toBeGreaterThan(0);
    // scan1 is a baseline; remove the baseline first, then the scan.
    const baselines = (await a.agent.get('/api/baselines')).body;
    for (const bl of baselines) await a.agent.delete(`/api/baselines/${bl.id}`).set('x-csrf-token', a.csrf).expect(200);
    await a.agent.delete(`/api/scans/${scan1}`).set('x-csrf-token', a.csrf).expect(200);
    for (const s of shots) expect(fs.existsSync(absolute(s.path))).toBe(false);
    await a.agent.get(`/api/scans/${scan1}`).expect(404);
  });

  it('AI endpoints degrade honestly when no provider is configured', async () => {
    const issue = ((await a.agent.get(`/api/issues?websiteId=${website}&status=all`)).body.items as IssueDTO[])[0];
    const res = await post(a, `/api/ai/issues/${issue.id}`, {});
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/not configured/);
  });
});
