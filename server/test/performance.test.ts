// Advanced performance analysis: resource extraction, test conditions, scan comparison, WordPress asset
// attribution, delivery indicators and the AI prompt. The Lighthouse results below are small HAND-MADE
// TEST FRAGMENTS shaped like Lighthouse 13 output — not real scan results.

import { describe, expect, it } from 'vitest';
import { findDuplicateAssets, groupWordPressAssets, type LhResourceDTO, type LighthouseReportDTO } from '@wpcg/shared';
import { extractResources, extractTestConfig, MAX_RESOURCES } from '../src/scanner/lighthouseExtract.js';
import { compareReports } from '../src/reports/lighthouseCompare.js';
import { deliveryIndicators } from '../src/scanner/wordpress/delivery.js';
import { performancePrompt } from '../src/ai/performancePrompt.js';

const req = (url: string, over: Record<string, unknown> = {}) => ({
  url,
  resourceType: 'Script',
  mimeType: 'application/javascript',
  statusCode: 200,
  transferSize: 1000,
  resourceSize: 3000,
  networkRequestTime: 100,
  networkEndTime: 350,
  priority: 'Low',
  protocol: 'h2',
  cache: 'none',
  entity: 'example.ie',
  ...over,
});

const LHR_FRAGMENT = {
  entities: [{ name: 'example.ie', isFirstParty: true }, { name: 'Google Tag Manager', category: 'tag-manager' }],
  configSettings: { formFactor: 'mobile', throttlingMethod: 'simulate', throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 }, screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false } },
  environment: { benchmarkIndex: 2000, networkUserAgent: 'UA-net', hostUserAgent: 'UA-host' },
  audits: {
    'network-requests': {
      details: {
        items: [
          req('https://example.ie/'),
          req('https://www.googletagmanager.com/gtag/js', { entity: 'Google Tag Manager', transferSize: 90000 }),
          req('data:image/png;base64,AAA'),
          req('https://example.ie/wp-content/plugins/big-slider/slider.js', { networkEndTime: 50 }),
        ],
      },
    },
    'resource-summary': { details: { items: [{ resourceType: 'total', label: 'Total', requestCount: 3, transferSize: 92000 }, { resourceType: 'script', label: 'Script', requestCount: 3, transferSize: 92000 }] } },
    'third-parties-insight': { details: { items: [{ entity: 'Google Tag Manager', transferSize: 90000, mainThreadTime: 120 }] } },
    'unused-javascript': { details: { items: [{ url: 'https://www.googletagmanager.com/gtag/js', wastedBytes: 50000, totalBytes: 90000 }] } },
    'render-blocking-insight': { details: { items: [{ url: 'https://example.ie/wp-content/plugins/big-slider/slider.js', wastedMs: 300 }, { url: 'data:text/css,x' }] } },
  },
};

describe('resource extraction from a Lighthouse result', () => {
  it('copies measured request data, classifies third parties and skips data: URLs', () => {
    const r = extractResources(LHR_FRAGMENT);
    expect(r.resources.map((x) => x.url)).toEqual(['https://example.ie/', 'https://www.googletagmanager.com/gtag/js', 'https://example.ie/wp-content/plugins/big-slider/slider.js']);
    expect(r.resources[0]).toMatchObject({ transferSize: 1000, resourceSize: 3000, durationMs: 250, thirdParty: false, fromCache: false });
    expect(r.resources[1].thirdParty).toBe(true);
    // An end time before the start is not a duration: unknown, not a negative number.
    expect(r.resources[2].durationMs).toBeNull();
    expect(r.resourceSummary[0]).toEqual({ resourceType: 'total', label: 'Total', requestCount: 3, transferSize: 92000 });
    expect(r.thirdParties).toEqual([{ entity: 'Google Tag Manager', category: 'tag-manager', transferSize: 90000, mainThreadMs: 120 }]);
    expect(r.findingsByUrl['https://www.googletagmanager.com/gtag/js'][0]).toMatchObject({ label: 'Unused JavaScript', wastedBytes: 50000 });
    expect(Object.keys(r.findingsByUrl).some((u) => u.startsWith('data:'))).toBe(false);
  });

  it('keeps the heaviest requests when a page makes more than the cap', () => {
    const many = { audits: { 'network-requests': { details: { items: Array.from({ length: MAX_RESOURCES + 20 }, (_, i) => req(`https://example.ie/${i}.js`, { transferSize: i })) } } } };
    const r = extractResources(many);
    expect(r.resources).toHaveLength(MAX_RESOURCES);
    expect(r.resourcesTotal).toBe(MAX_RESOURCES + 20);
    expect(Math.min(...r.resources.map((x) => x.transferSize ?? 0))).toBe(20);
  });

  it('records the exact test settings, and missing values as null rather than guesses', () => {
    expect(extractTestConfig(LHR_FRAGMENT, 3)).toMatchObject({ formFactor: 'mobile', throttlingMethod: 'simulate', rttMs: 150, cpuSlowdownMultiplier: 4, screen: { width: 412, mobile: true }, benchmarkIndex: 2000, runs: 3 });
    expect(extractTestConfig({}, 1)).toMatchObject({ formFactor: 'desktop', screen: { width: null }, rttMs: null, benchmarkIndex: null });
  });
});

// A stored report, as the scanner saves it (test fragment).
const stored = (o: { perf: number; lcp: number; bytes: number; failing: string[]; benchmark?: number; version?: string }) =>
  ({
    lighthouseVersion: o.version ?? '13.4.1',
    fetchTime: '2026-10-30T10:00:00.000Z',
    formFactor: 'mobile',
    environment: [],
    categories: [{ id: 'performance', title: 'Performance', score: o.perf, groups: [{ id: 'diagnostics', title: 'Diagnostics', auditIds: ['largest-contentful-paint', 'unused-javascript', 'render-blocking-insight'] }] }],
    audits: {
      'largest-contentful-paint': { id: 'largest-contentful-paint', title: 'Largest Contentful Paint', description: '', score: 0.5, scoreDisplayMode: 'numeric', numericValue: o.lcp },
      'unused-javascript': { id: 'unused-javascript', title: 'Reduce unused JavaScript', description: '', score: o.failing.includes('unused-javascript') ? 0 : 1, scoreDisplayMode: 'metricSavings' },
      'render-blocking-insight': { id: 'render-blocking-insight', title: 'Render-blocking requests', description: '', score: o.failing.includes('render-blocking-insight') ? 0 : 1, scoreDisplayMode: 'metricSavings' },
    },
    finalScreenshot: null,
    filmstrip: [],
    resourceSummary: [{ resourceType: 'total', label: 'Total', requestCount: 40, transferSize: o.bytes }],
    testConfig: { formFactor: 'mobile', screen: null, throttlingMethod: 'simulate', rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4, benchmarkIndex: o.benchmark ?? 2000, networkUserAgent: null, hostUserAgent: null, runs: 3 },
  }) as unknown as Omit<LighthouseReportDTO, 'pageUrl' | 'viewport'>;

describe('comparing two scans', () => {
  it('reports measured changes and which audits started or stopped failing', () => {
    const c = compareReports('mobile', 'https://example.ie/', { report: stored({ perf: 0.6, lcp: 4200, bytes: 2_000_000, failing: ['unused-javascript'] }), scanId: 'b', finishedAt: null }, { report: stored({ perf: 0.7, lcp: 3100, bytes: 1_500_000, failing: ['render-blocking-insight'] }), scanId: 'a', finishedAt: null });
    expect(c.previous!.scores.performance).toBe(0.7);
    expect(c.current.metrics['largest-contentful-paint']).toBe(4200);
    expect(c.current.totalTransferSize! - c.previous!.totalTransferSize!).toBe(500_000);
    expect(c.newlyFailing.map((a) => a.id)).toEqual(['unused-javascript']);
    expect(c.nowPassing.map((a) => a.id)).toEqual(['render-blocking-insight']);
    // Same conditions: only the general variability note.
    expect(c.conditionNotes).toHaveLength(1);
  });

  it('says when the two tests ran under different conditions', () => {
    const c = compareReports('mobile', 'https://example.ie/', { report: stored({ perf: 0.6, lcp: 1, bytes: 1, failing: [], benchmark: 1000, version: '13.5.0' }), scanId: 'b', finishedAt: null }, { report: stored({ perf: 0.6, lcp: 1, bytes: 1, failing: [], benchmark: 2000 }), scanId: 'a', finishedAt: null });
    expect(c.conditionNotes.join(' ')).toMatch(/Different Lighthouse versions/);
    expect(c.conditionNotes.join(' ')).toMatch(/CPU speed differed by more than 25%/);
  });

  it('has nothing to compare against for a first scan', () => {
    const c = compareReports('mobile', 'https://example.ie/', { report: stored({ perf: 0.6, lcp: 1, bytes: 1, failing: [] }), scanId: 'b', finishedAt: null }, null);
    expect(c.previous).toBeNull();
    expect(c.newlyFailing).toEqual([]);
  });
});

describe('WordPress front-end assets and delivery', () => {
  const res = (url: string, transferSize = 1000, resourceType = 'Script'): LhResourceDTO => ({ url, resourceType, mimeType: null, statusCode: 200, transferSize, resourceSize: transferSize * 3, durationMs: 10, startMs: 0, priority: null, protocol: null, fromCache: false, entity: null, thirdParty: false });

  it('groups files by the plugin/theme folder they were served from', () => {
    const g = groupWordPressAssets([
      res('https://example.ie/wp-content/plugins/elementor/assets/a.js', 5000),
      res('https://example.ie/wp-content/plugins/elementor/assets/b.css', 2000, 'Stylesheet'),
      res('https://example.ie/wp-content/themes/astra/style.css', 3000, 'Stylesheet'),
      res('https://example.ie/wp-includes/js/jquery/jquery.min.js', 30000),
      res('https://cdn.example.com/lib.js'),
    ]);
    expect(g.map((x) => `${x.kind}:${x.slug}:${x.requests}:${x.transferSize}`)).toEqual(['core:wp-includes:1:30000', 'plugin:elementor:2:7000', 'theme:astra:1:3000']);
  });

  it('flags the same library loaded from two places, but not generic file names', () => {
    const d = findDuplicateAssets([
      res('https://example.ie/wp-includes/js/jquery/jquery.min.js', 30000),
      res('https://code.jquery.com/jquery.js', 31000),
      res('https://example.ie/wp-content/themes/a/style.css', 100, 'Stylesheet'),
      res('https://example.ie/wp-content/plugins/b/style.css', 100, 'Stylesheet'),
    ]);
    expect(d).toEqual([{ name: 'jquery.js', urls: ['https://example.ie/wp-includes/js/jquery/jquery.min.js', 'https://code.jquery.com/jquery.js'], transferSize: 61000 }]);
  });

  it('reports cache/compression indicators with their evidence', () => {
    const d = deliveryIndicators('<!-- This website is like a Rocket, isn’t it? --><link href="/wp-content/cache/min/1/a.css">', { 'CF-Cache-Status': 'DYNAMIC', age: '120', 'content-encoding': 'br', 'cache-control': 'max-age=0' });
    expect(d.indicators.map((i) => `${i.label}:${i.state}`)).toEqual(['Cloudflare edge cache:miss', 'Served from a shared cache:hit', 'WP Rocket page cache:present', 'WP Rocket minified assets:present']);
    expect(d.indicators[0].evidence).toBe('Header cf-cache-status: DYNAMIC');
    expect(d.htmlCompression).toBe('br');
    expect(deliveryIndicators('<html></html>', {})).toMatchObject({ indicators: [], htmlCompression: null });
  });
});

describe('AI Performance Fix Assistant prompt', () => {
  it('contains only measured data and the rules against invented causes', () => {
    const report = { ...stored({ perf: 0.6, lcp: 4200, bytes: 2_000_000, failing: ['unused-javascript'] }), resources: [] };
    const p = performancePrompt({ website: 'https://example.ie/', pageUrl: 'https://example.ie/', viewport: 'mobile', report, wordpress: null });
    expect(p).toMatch(/Use ONLY the measured data/);
    expect(p).toMatch(/Loading files is not proof that a plugin slows the page/);
    expect(p).toMatch(/Exactly one fix for EACH item in "failingAudits"/);
    expect(p).toMatch(/Name a plugin only if it appears in detectedPlugins or deliveryIndicators/);
    expect(p).toMatch(/Reduce unused JavaScript/);
    expect(p).toMatch(/"Performance": 60/);
    expect(p).toMatch(/Not detected as WordPress/);
    expect(p).not.toMatch(/Render-blocking requests/); // passing audits are not presented as problems
  });
});

describe('local AI (Ollama) answers are read as a stream', () => {
  it('joins streamed pieces (split across chunks), and reports a model error', async () => {
    const http = await import('node:http');
    const { config } = await import('../src/config.js');
    const { generate } = await import('../src/ai/provider.js');
    let mode: 'ok' | 'error' = 'ok';
    let requestBody: { stream?: boolean; options?: { num_ctx?: number } } = {};
    // A stand-in for Ollama's /api/chat streaming format (newline-delimited JSON). Test only.
    const stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        requestBody = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (mode === 'error') return void res.end(`${JSON.stringify({ error: 'model ran out of memory' })}\n`);
        const lines = ['Fix 1: compress ', 'images.', '\nVerify: re-run the scan.'].map((t) => `${JSON.stringify({ message: { content: t }, done: false })}\n`).join('') + `${JSON.stringify({ done: true })}\n`;
        const cut = Math.floor(lines.length / 2); // split mid-line, as a real stream can
        res.write(lines.slice(0, cut));
        setTimeout(() => res.end(lines.slice(cut)), 20);
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const saved = { provider: config.AI_PROVIDER, url: config.OLLAMA_URL, configured: config.aiConfigured };
    Object.assign(config, { AI_PROVIDER: 'ollama', OLLAMA_URL: `http://127.0.0.1:${(stub.address() as { port: number }).port}`, aiConfigured: true });
    try {
      const out = await generate('Short prompt');
      expect(out.content).toBe('Fix 1: compress images.\nVerify: re-run the scan.');
      expect(requestBody.stream).toBe(true);
      expect(requestBody.options?.num_ctx).toBeGreaterThanOrEqual(4096);
      mode = 'error';
      await expect(generate('Short prompt')).rejects.toThrow(/model ran out of memory/);
    } finally {
      Object.assign(config, { AI_PROVIDER: saved.provider, OLLAMA_URL: saved.url, aiConfigured: saved.configured });
      await new Promise((r) => stub.close(r));
    }
  });
});
