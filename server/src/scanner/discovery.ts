// Page discovery: robots.txt, XML sitemaps and a breadth-first crawl of same-host links
// in the server-delivered HTML. Only GET requests are made, and URLs that commonly
// change state (logout, cart, checkout, admin) are never visited.

import * as cheerio from 'cheerio';
import { safeFetch, type SafeResponse } from '../security/safeFetch.js';
import { BlockedTargetError, validateScanUrl } from '../security/ssrf.js';
import { isAllowed, parseRobots, type RobotsRules } from './robots.js';

export interface DiscoveredPage {
  url: string;
  source: 'start' | 'sitemap' | 'link' | 'selected';
  depth: number;
  response: SafeResponse | null;
}

export interface DiscoveryResult {
  startUrl: string;
  scopeHosts: string[];
  pages: DiscoveredPage[];
  robots: RobotsRules | null;
  robotsStatus: number | null;
  sitemapUrls: string[];
  sitemapFound: boolean;
  skipped: { robots: number; unsafe: number; offsite: number; nonHtml: number; overLimit: number; redirects: number };
  notes: string[];
}

const NON_HTML_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|zip|gz|tgz|rar|7z|exe|dmg|msi|docx?|xlsx?|pptx?|csv|txt|xml|json|js|css|woff2?|ttf|eot|rss|atom)$/i;
// /cdn-cgi/ is Cloudflare's service path (e.g. e-mail obfuscation links that only work via JavaScript).
const UNSAFE_PATH = /(\/cdn-cgi\/|\/wp-admin|\/wp-login\.php|\/xmlrpc\.php|\/wp-json\/|logout|log-out|signout|sign-out|\/cart\b|\/basket\b|\/checkout\b|\/my-account|add-to-cart|add_to_cart|remove_item|\/feed\/?$|replytocom=|\/wp-cron\.php|[?&]action=|\/unsubscribe|delete)/i;
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|msclkid|mc_cid|mc_eid|_ga|_gl)$/i;

export function normalisePageUrl(href: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : '';
  return u.href;
}

export function extractLinksFromHtml(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').attr('href');
  let base = baseUrl;
  if (baseHref) {
    try {
      base = new URL(baseHref, baseUrl).href;
    } catch {
      /* ignore invalid <base> */
    }
  }
  const out: string[] = [];
  $('a[href]').each((_, el) => {
    const raw = ($(el).attr('href') ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|sms|data):/i.test(raw)) return;
    if (($(el).attr('rel') ?? '').toLowerCase().includes('nofollow')) return;
    const n = normalisePageUrl(raw, base);
    if (n) out.push(n);
  });
  return out;
}

function extractSitemapLocs(xml: string): { urls: string[]; childSitemaps: string[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    m[1].trim().replace(/&amp;/g, '&'),
  );
  return isIndex ? { urls: [], childSitemaps: locs } : { urls: locs, childSitemaps: [] };
}

const isHtmlResponse = (r: SafeResponse) => /text\/html|application\/xhtml\+xml/i.test(r.headers['content-type'] ?? '');

export async function discoverPages(
  startInput: string,
  opts: { maxPages: number; maxDepth: number; selectedUrls?: string[]; signal?: AbortSignal; onProgress?: (msg: string, found: number) => void },
): Promise<DiscoveryResult> {
  const start = validateScanUrl(startInput);
  const notes: string[] = [];
  const skipped = { robots: 0, unsafe: 0, offsite: 0, nonHtml: 0, overLimit: 0, redirects: 0 };

  const startResponse = await safeFetch(start, { signal: opts.signal });
  const finalStart = startResponse.status !== null ? new URL(startResponse.finalUrl) : start;
  const scopeHosts = [...new Set([start.hostname.toLowerCase(), finalStart.hostname.toLowerCase()])];
  if (finalStart.hostname !== start.hostname) notes.push(`The start URL redirects to ${finalStart.origin}; pages on both hosts are in scope.`);
  const inScope = (u: URL) => scopeHosts.includes(u.hostname.toLowerCase()) && (u.port || '') === (finalStart.port || '');

  // robots.txt and sitemaps (fetched for SEO checks even when pages are hand-selected).
  const robotsRes = await safeFetch(new URL('/robots.txt', finalStart.origin), { maxBytes: 512 * 1024, signal: opts.signal, readBody: () => true });
  const robots = robotsRes.status === 200 && robotsRes.body ? parseRobots(robotsRes.body.toString('utf8')) : null;

  const sitemapCandidates = new Set<string>(robots?.sitemaps ?? []);
  if (!sitemapCandidates.size) {
    sitemapCandidates.add(new URL('/sitemap.xml', finalStart.origin).href);
    sitemapCandidates.add(new URL('/sitemap_index.xml', finalStart.origin).href);
    sitemapCandidates.add(new URL('/wp-sitemap.xml', finalStart.origin).href);
  }
  const sitemapUrls: string[] = [];
  let sitemapFound = false;
  const sitemapQueue = [...sitemapCandidates];
  let sitemapFetches = 0;
  while (sitemapQueue.length && sitemapFetches < 8 && sitemapUrls.length < 1000) {
    const sm = sitemapQueue.shift()!;
    let smUrl: URL;
    try {
      smUrl = validateScanUrl(sm);
    } catch {
      continue;
    }
    if (smUrl.pathname.endsWith('.gz')) {
      notes.push(`Compressed sitemap ${smUrl.href} was not read (gzip sitemaps are not supported yet).`);
      continue;
    }
    sitemapFetches++;
    const r = await safeFetch(smUrl, { maxBytes: 5 * 1024 * 1024, signal: opts.signal, readBody: () => true });
    if (r.status !== 200 || !r.body) continue;
    const text = r.body.toString('utf8');
    if (!/<(urlset|sitemapindex)[\s>]/i.test(text)) continue;
    sitemapFound = true;
    const { urls, childSitemaps } = extractSitemapLocs(text);
    sitemapQueue.push(...childSitemaps.slice(0, 10));
    for (const u of urls) {
      const n = normalisePageUrl(u);
      if (n) sitemapUrls.push(n);
    }
  }

  const pages: DiscoveredPage[] = [];
  const seen = new Set<string>();

  if (opts.selectedUrls && opts.selectedUrls.length) {
    for (const raw of opts.selectedUrls.slice(0, opts.maxPages)) {
      let u: URL;
      try {
        u = validateScanUrl(raw);
      } catch (e) {
        notes.push(`Skipped ${raw}: ${(e as Error).message}`);
        continue;
      }
      if (!inScope(u)) {
        skipped.offsite++;
        notes.push(`Skipped ${u.href}: it is not on ${scopeHosts.join(' / ')}.`);
        continue;
      }
      const n = normalisePageUrl(u.href)!;
      if (seen.has(n)) continue;
      seen.add(n);
      pages.push({ url: n, source: 'selected', depth: 0, response: n === normalisePageUrl(start.href) ? startResponse : null });
    }
    return { startUrl: start.href, scopeHosts, pages, robots, robotsStatus: robotsRes.status, sitemapUrls, sitemapFound, skipped, notes };
  }

  // Breadth-first crawl from the start page; sitemap URLs join at depth 1.
  const startNorm = normalisePageUrl(start.href)!;
  seen.add(startNorm);
  // When the start URL redirects (example.com → www.example.com, http → https), its final address is the
  // same page: without this, the home page's own "Home" link queued it as a second, duplicate page.
  // (The page keeps the typed address so issue fingerprints stay stable between scans.)
  if (startResponse.status !== null && !startResponse.failure) {
    const finalNorm = normalisePageUrl(startResponse.finalUrl);
    if (finalNorm) seen.add(finalNorm);
  }
  pages.push({ url: startNorm, source: 'start', depth: 0, response: startResponse });
  const queue: { url: string; depth: number; source: DiscoveredPage['source'] }[] = [];

  const consider = (href: string, depth: number, source: DiscoveredPage['source']) => {
    const n = normalisePageUrl(href);
    if (!n || seen.has(n)) return;
    seen.add(n);
    let u: URL;
    try {
      u = validateScanUrl(n);
    } catch (e) {
      if (e instanceof BlockedTargetError) skipped.offsite++;
      return;
    }
    if (!inScope(u)) return void skipped.offsite++;
    if (NON_HTML_EXT.test(u.pathname)) return void skipped.nonHtml++;
    if (UNSAFE_PATH.test(u.pathname + u.search)) return void skipped.unsafe++;
    if (robots && !isAllowed(robots, u.pathname + u.search)) return void skipped.robots++;
    queue.push({ url: n, depth, source });
  };

  const linksFrom = (page: DiscoveredPage) =>
    page.response?.body && isHtmlResponse(page.response) ? extractLinksFromHtml(page.response.body.toString('utf8'), page.response.finalUrl) : [];

  for (const href of linksFrom(pages[0])) consider(href, 1, 'link');
  for (const href of sitemapUrls) consider(href, 1, 'sitemap');

  while (queue.length && pages.length < opts.maxPages) {
    if (opts.signal?.aborted) break;
    const batch = queue.splice(0, Math.min(3, opts.maxPages - pages.length));
    const fetched = await Promise.all(
      batch.map(async (item) => ({ item, res: await safeFetch(item.url, { signal: opts.signal }) })),
    );
    for (const { item, res } of fetched) {
      // A URL that redirects inside the site is scanned under its final address, once.
      let url = item.url;
      if (res.redirects.length && res.status !== null && !res.failure) {
        const fin = normalisePageUrl(res.finalUrl);
        let finUrl: URL | null = null;
        try {
          finUrl = fin ? new URL(fin) : null;
        } catch {
          finUrl = null;
        }
        if (fin && finUrl && inScope(finUrl)) {
          if (pages.some((p) => p.url === fin) || (seen.has(fin) && fin !== item.url && queue.every((q) => q.url !== fin))) {
            skipped.redirects++;
            continue;
          }
          seen.add(fin);
          url = fin;
          // The final address may still be waiting in the queue: it is handled now, so drop that entry.
          const waiting = queue.findIndex((q) => q.url === fin);
          if (waiting >= 0) queue.splice(waiting, 1);
        }
      }
      if (pages.some((p) => p.url === url)) {
        skipped.redirects++;
        continue;
      }
      const page: DiscoveredPage = { url, source: item.source, depth: item.depth, response: res };
      if (res.status !== null && res.ok && !isHtmlResponse(res)) {
        skipped.nonHtml++;
        continue;
      }
      pages.push(page);
      if (item.depth < opts.maxDepth) for (const href of linksFrom(page)) consider(href, item.depth + 1, 'link');
    }
    opts.onProgress?.(`Discovered ${pages.length} page(s)`, pages.length);
  }
  skipped.overLimit = queue.length;
  if (queue.length) notes.push(`${queue.length} more page(s) were found but not scanned because of the page limit (${opts.maxPages}). Raise the limit or upgrade the plan to scan every page.`);
  if (skipped.robots) notes.push(`${skipped.robots} page(s) were skipped because robots.txt disallows them.`);
  if (skipped.unsafe) notes.push(`${skipped.unsafe} link(s) were skipped because they look like admin, login, cart, checkout or logout URLs that can change state.`);

  return { startUrl: start.href, scopeHosts, pages, robots, robotsStatus: robotsRes.status, sitemapUrls, sitemapFound, skipped, notes };
}

