// Watchers that read the page's headers and HTML: security headers (R4, R4b, R14),
// search indexing (R13 + robots.txt diff), mixed content (R17), defacement canary (R16)
// and the third-party script inventory.

import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import type { Priority } from '@wpcg/shared';
import type { SafeResponse } from '../../security/safeFetch.js';
import { isAllowed, parseRobots } from '../../scanner/robots.js';
import { detectChallenge, monitorFetch, registrableDomain } from '../probe.js';
import type { CheckOutcome, CheckRunner } from '../types.js';

const ORDER: Priority[] = ['p1', 'p2', 'p3', 'p4'];
const worst = (list: Priority[]): Priority => ORDER.find((p) => list.includes(p)) ?? 'p4';

/** Fetch the monitored page; returns an outcome instead when it cannot be assessed. */
async function getPage(url: string, signal: AbortSignal): Promise<{ res: SafeResponse } | { outcome: CheckOutcome }> {
  const res = await monitorFetch(url, { signal, maxBytes: 3 * 1024 * 1024 });
  if (res.failure) return { outcome: { status: 'not_assessed', summary: `Not assessed: the page could not be fetched (${res.failure.message})` } };
  const ch = detectChallenge(res);
  if (ch.blocked) return { outcome: { status: 'not_assessed', summary: `Not assessed: ${ch.reason}`, httpStatus: res.status } };
  if ((res.status ?? 0) >= 400) return { outcome: { status: 'not_assessed', summary: `Not assessed: the page returned HTTP ${res.status} (see the uptime watcher)`, httpStatus: res.status } };
  return { res };
}

// ---------------------------------------------------------------- R4, R4b, R14

export const headersCheck: CheckRunner = async ({ monitor, signal }) => {
  const page = await getPage(monitor.url!, signal);
  if ('outcome' in page) return page.outcome;
  const h = page.res.headers;
  const https = new URL(page.res.finalUrl).protocol === 'https:';
  const findings: { severity: Priority; text: string }[] = [];
  const missing: string[] = [];
  if (https && !h['strict-transport-security']) missing.push('Strict-Transport-Security');
  if ((h['x-content-type-options'] ?? '').toLowerCase().trim() !== 'nosniff') missing.push('X-Content-Type-Options: nosniff');
  if (!h['x-frame-options'] && !/frame-ancestors/i.test(h['content-security-policy'] ?? '')) missing.push('X-Frame-Options (or CSP frame-ancestors)');
  if (!h['referrer-policy']) missing.push('Referrer-Policy');
  if (missing.length) findings.push({ severity: 'p3', text: `Missing: ${missing.join(', ')}` });

  const powered = h['x-powered-by'] ?? '';
  const php = powered.match(/PHP\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (php) {
    findings.push({ severity: 'p4', text: `X-Powered-By advertises the exact PHP version (${php[0]})` });
    const major = Number(php[1]);
    const minor = Number(php[2]);
    if (major < 8 || (major === 8 && minor < 1)) findings.push({ severity: 'p2', text: `PHP ${major}.${minor} is end-of-life (below 8.1) and no longer receives security fixes` });
  } else if (/\d+\.\d+/.test(h.server ?? '')) findings.push({ severity: 'p4', text: `Server header discloses a version (${h.server})` });

  // A simple grade over the six headers that matter most (Header quality grading).
  const graded = {
    hsts: https && /max-age=(\d+)/i.test(h['strict-transport-security'] ?? '') && Number((h['strict-transport-security'] ?? '').match(/max-age=(\d+)/i)?.[1]) >= 15552000,
    csp: !!h['content-security-policy'],
    xcto: (h['x-content-type-options'] ?? '').toLowerCase().includes('nosniff'),
    framing: !!h['x-frame-options'] || /frame-ancestors/i.test(h['content-security-policy'] ?? ''),
    referrer: !!h['referrer-policy'],
    permissions: !!h['permissions-policy'],
  };
  const score = Object.values(graded).filter(Boolean).length;
  const grade = ['F', 'F', 'E', 'D', 'C', 'B', 'A'][score];
  const detail = {
    grade,
    graded,
    headers: Object.fromEntries(
      ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'x-powered-by', 'server'].map((k) => [k, h[k] ?? null]),
    ),
  };
  if (!findings.length) return { status: 'up', summary: `Security headers grade ${grade}; required headers present`, detail, httpStatus: page.res.status };
  return { status: 'warning', severity: worst(findings.map((f) => f.severity)), summary: `Grade ${grade}. ${findings.map((f) => f.text).join('. ')}`, detail: { ...detail, findings }, httpStatus: page.res.status };
};

// ---------------------------------------------------------------- R13 + robots.txt diff

export const indexingCheck: CheckRunner = async ({ monitor, signal, baseline }) => {
  const page = await getPage(monitor.url!, signal);
  if ('outcome' in page) return page.outcome;
  const origin = new URL(page.res.finalUrl).origin;
  const findings: { severity: Priority; text: string }[] = [];

  // Robots: read from the host root only, by user-agent group (build note 9).
  const robotsRes = await monitorFetch(`${origin}/robots.txt`, { signal, maxBytes: 512 * 1024, readBody: () => true });
  if (detectChallenge(robotsRes).blocked) return { status: 'not_assessed', summary: `Not assessed: robots.txt was blocked (${detectChallenge(robotsRes).reason})` };
  const robotsText = robotsRes.status === 200 && robotsRes.body ? robotsRes.body.toString('utf8') : '';
  const robots = robotsText ? parseRobots(robotsText) : null;
  if (robots && (!isAllowed(robots, '/', 'googlebot') || !isAllowed(robots, '/', 'bingbot')))
    findings.push({ severity: 'p2', text: 'robots.txt blocks search engines from the whole site (Disallow: / for Googlebot or Bingbot)' });

  const $ = cheerio.load(page.res.body?.toString('utf8') ?? '');
  const metaRobots = $('meta[name="robots" i], meta[name="googlebot" i]').map((_, el) => $(el).attr('content') ?? '').get().join(', ');
  const headerRobots = page.res.headers['x-robots-tag'] ?? '';
  if (/noindex|none/i.test(metaRobots) || /noindex|none/i.test(headerRobots))
    findings.push({ severity: 'p2', text: `The page tells search engines not to index it (${[metaRobots && `meta robots: ${metaRobots}`, headerRobots && `X-Robots-Tag: ${headerRobots}`].filter(Boolean).join('; ')})` });

  let sitemapFound = (robots?.sitemaps.length ?? 0) > 0;
  if (!sitemapFound) {
    for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml']) {
      const s = await monitorFetch(`${origin}${p}`, { signal, maxBytes: 64 * 1024, readBody: () => true });
      if (s.status === 200 && /<(urlset|sitemapindex)[\s>]/i.test(s.body?.toString('utf8') ?? '')) {
        sitemapFound = true;
        break;
      }
    }
  }
  if (!sitemapFound) findings.push({ severity: 'p3', text: 'No XML sitemap found (robots.txt Sitemap line, /sitemap.xml, /sitemap_index.xml, /wp-sitemap.xml)' });

  // robots.txt diff: an event, reported once per change. Only a definite answer counts (200, or 404/410 =
  // no file): a failed or 5xx fetch is not an empty robots.txt, and must not alert or replace the baseline.
  const robotsKnown = !robotsRes.failure && [200, 404, 410].includes(robotsRes.status ?? 0);
  const hash = crypto.createHash('sha256').update(robotsText).digest('hex').slice(0, 16);
  const prev = baseline as { robotsHash?: string; robotsText?: string } | null;
  const newBaseline = { robotsHash: hash, robotsText: robotsText.slice(0, 5000) };
  let changed: string | null = null;
  if (robotsKnown && prev?.robotsHash && prev.robotsHash !== hash) {
    const before = new Set((prev.robotsText ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const after = new Set(robotsText.slice(0, 5000).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const added = [...after].filter((l) => !before.has(l));
    const removed = [...before].filter((l) => !after.has(l));
    changed = `robots.txt changed (${added.length} line(s) added, ${removed.length} removed)`;
    findings.push({ severity: 'p3', text: changed });
    Object.assign(newBaseline, { lastDiff: { added: added.slice(0, 30), removed: removed.slice(0, 30) } });
  }
  const detail = { robotsStatus: robotsRes.status, sitemapFound, metaRobots: metaRobots || null, xRobotsTag: headerRobots || null, robotsDiff: changed ? (newBaseline as { lastDiff?: unknown }).lastDiff : undefined };
  const keepBaseline = robotsKnown ? newBaseline : undefined;
  if (!findings.length) return { status: 'up', summary: 'Indexable: no site-wide block, no noindex, sitemap present', detail, baseline: keepBaseline };
  return { status: 'warning', severity: worst(findings.map((f) => f.severity)), summary: findings.map((f) => f.text).join('. '), detail, baseline: keepBaseline, event: !!changed && findings.length === 1 };
};

// ---------------------------------------------------------------- R17 (subresources only, build note 10)

export const mixedContentCheck: CheckRunner = async ({ monitor, signal }) => {
  const page = await getPage(monitor.url!, signal);
  if ('outcome' in page) return page.outcome;
  if (new URL(page.res.finalUrl).protocol !== 'https:') return { status: 'not_assessed', summary: 'Not assessed: the page is not served over HTTPS (see the HTTPS watcher)' };
  const html = page.res.body?.toString('utf8') ?? '';
  const $ = cheerio.load(html);
  const insecure = new Set<string>();
  $('[src]').each((_, el) => {
    const v = $(el).attr('src') ?? '';
    if (/^http:\/\//i.test(v)) insecure.add(`<${el.tagName}> ${v}`);
  });
  $('[srcset]').each((_, el) => {
    for (const part of ($(el).attr('srcset') ?? '').split(',')) {
      const v = part.trim().split(/\s+/)[0];
      if (/^http:\/\//i.test(v)) insecure.add(`<${el.tagName} srcset> ${v}`);
    }
  });
  $('link[rel~="stylesheet"][href], link[rel~="preload"][href]').each((_, el) => {
    const v = $(el).attr('href') ?? '';
    if (/^http:\/\//i.test(v)) insecure.add(`<link> ${v}`);
  });
  const cssUrls = [...html.matchAll(/url\(\s*['"]?(http:\/\/[^'")\s]+)/gi)].map((m) => m[1]);
  for (const v of cssUrls) insecure.add(`CSS url() ${v}`);
  const list = [...insecure].slice(0, 50);
  if (!list.length) return { status: 'up', summary: 'No insecure http:// subresources on the page' };
  return { status: 'warning', severity: 'p3', summary: `${insecure.size} insecure http:// subresource(s) on an HTTPS page`, detail: { insecure: list } };
};

// ---------------------------------------------------------------- R16 defacement canary

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);

export const defacementCheck: CheckRunner = async ({ monitor, signal, baseline }) => {
  const page = await getPage(monitor.url!, signal);
  if ('outcome' in page) return page.outcome; // never baseline a challenge page (build note 1)
  const $ = cheerio.load(page.res.body?.toString('utf8') ?? '');
  const current = { title: norm($('title').first().text()), h1: norm($('h1').first().text()) };
  const hash = crypto.createHash('sha256').update(`${current.title}\n${current.h1}`).digest('hex').slice(0, 16);
  const prev = baseline as { hash?: string; title?: string; h1?: string } | null;
  if (!prev?.hash) return { status: 'up', summary: `Baseline recorded: "${current.title}"${current.h1 ? ` / "${current.h1}"` : ''}`, baseline: { hash, ...current } };
  if (prev.hash === hash) return { status: 'up', summary: 'Homepage title and main heading match the accepted baseline' };
  // Kept open until the change is accepted (or reverted); the baseline is not moved automatically.
  return {
    status: 'warning',
    severity: 'p2',
    summary: `Homepage changed: title "${prev.title}" → "${current.title}"${prev.h1 !== current.h1 ? `, heading "${prev.h1}" → "${current.h1}"` : ''}. Accept it if this was a deliberate update.`,
    detail: { before: { title: prev.title, h1: prev.h1 }, after: current, acceptable: true },
  };
};

// ---------------------------------------------------------------- third-party script inventory

export const scriptsCheck: CheckRunner = async ({ monitor, signal, baseline }) => {
  const page = await getPage(monitor.url!, signal);
  if ('outcome' in page) return page.outcome;
  const siteDomain = registrableDomain(new URL(page.res.finalUrl).hostname);
  const $ = cheerio.load(page.res.body?.toString('utf8') ?? '');
  const domains = new Set<string>();
  $('script[src]').each((_, el) => {
    try {
      const host = new URL($(el).attr('src') ?? '', page.res.finalUrl).hostname.toLowerCase();
      if (host && registrableDomain(host) !== siteDomain) domains.add(host);
    } catch {
      /* ignore malformed src */
    }
  });
  const current = [...domains].sort();
  const prev = baseline as { domains?: string[] } | null;
  if (!prev?.domains) return { status: 'up', summary: `Baseline recorded: ${current.length} third-party script domain(s)`, detail: { domains: current }, baseline: { domains: current } };
  const added = current.filter((d) => !prev.domains!.includes(d));
  const removed = prev.domains.filter((d) => !current.includes(d));
  const detail = { domains: current, added, removed, acceptable: added.length > 0 };
  if (added.length)
    return { status: 'warning', severity: 'p2', summary: `New third-party script domain(s): ${added.join(', ')}. Check they are expected (card skimmers and injected trackers appear this way), then accept.`, detail };
  return { status: 'up', summary: `${current.length} known third-party script domain(s)${removed.length ? `; ${removed.length} no longer loaded` : ''}`, detail, baseline: removed.length ? { domains: current } : undefined };
};
