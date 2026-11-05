// Checks fed by what Chrome observed while loading the page: console errors, uncaught
// exceptions, failed requests, images and layout. All are pure functions over collected data.

import type { EvidenceItem, ViewportName } from '@wpcg/shared';
import type { Extracted } from '../browserScripts.js';
import { R } from '../rules.js';
import { elementSig } from '../consolidate.js';
import type { RawFinding } from '../types.js';

export interface RuntimeLog {
  consoleErrors: { text: string; source: string }[];
  pageErrors: { message: string; stack: string }[];
  failedRequests: { url: string; status: number | null; error: string | null; resourceType: string }[];
  /** Image URLs whose responses failed (status ≥ 400 or network error). */
  failedImages: Set<string>;
}

const stripQuery = (u: string) => u.replace(/[?#].*$/, '');

/** Mask anything that looks like a credential or e-mail before it is stored. */
export function scrub(text: string): string {
  return text
    .replace(/([?&](?:token|key|apikey|api_key|auth|password|pass|secret|session|sid|code|signature|sig)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]')
    .slice(0, 600);
}

export function isFirstParty(url: string, siteHosts: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return siteHosts.some((h) => host === h || host.endsWith(`.${h.replace(/^www\./, '')}`) || h.endsWith(`.${host.replace(/^www\./, '')}`) || host.replace(/^www\./, '') === h.replace(/^www\./, ''));
  } catch {
    return false;
  }
}

function sourceOfStack(stack: string): string | null {
  const m = stack.match(/(https?:\/\/[^\s)]+?):\d+:\d+/);
  return m ? m[1] : null;
}

/**
 * Third-party behaviour that is expected and not something the site owner can fix:
 *   • Cloudflare Turnstile / challenge-platform: its Private Access Token probe (…/pat/…) answers
 *     401 by design, and its sandboxed iframe logs fingerprinting messages to the console.
 */
export function isBenignThirdParty(url: string | null | undefined, status?: number | null): boolean {
  if (!url) return false;
  if (/^https:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\//.test(url)) return status === undefined || status === null || status === 401;
  return false;
}

export function javascriptFindings(pageUrl: string, log: RuntimeLog, siteHosts: string[]): RawFinding[] {
  const out: RawFinding[] = [];
  const add = (rule: RawFinding['rule'], evidence: EvidenceItem[], technical?: RawFinding['technical']) =>
    out.push({ rule, target: pageUrl, pageUrl, viewport: null, evidence, technical });
  // One element per distinct error / request, so the same error on many pages groups into one issue.
  const addLines = (rule: RawFinding['rule'], what: string, lines: string[]) =>
    out.push({
      rule,
      target: pageUrl,
      pageUrl,
      viewport: null,
      evidence: [],
      headEvidence: [{ label: 'Detection', value: `${what} recorded while the page loaded in Chrome.` }],
      // Per-request tokens and timestamps are removed from the signature so the same error groups across pages.
      elements: [...new Set(lines)].slice(0, 30).map((l) => ({ sig: elementSig(rule.id, l.replace(/[A-Za-z0-9_.~-]{24,}/g, '…').replace(/\d{6,}/g, '#')), label: l })),
    });

  const fpErrors: string[] = [];
  const tpErrors: string[] = [];
  const stacks: string[] = [];
  for (const e of log.pageErrors) {
    const src = sourceOfStack(e.stack);
    const line = `${scrub(e.message)}${src ? `\n    at ${scrub(stripQuery(src))}` : ''}`;
    (src && !isFirstParty(src, siteHosts) ? tpErrors : fpErrors).push(line);
    if (e.stack) stacks.push(scrub(e.stack.split('\n').slice(0, 6).join('\n')));
  }
  const uniq = (a: string[]) => [...new Set(a)];
  if (fpErrors.length)
    add(R.jsUncaught, [{ label: `${uniq(fpErrors).length} uncaught error(s)`, value: uniq(fpErrors).slice(0, 8).join('\n'), code: true }], stacks.length ? [{ label: 'Stack traces (first lines)', value: stacks.slice(0, 3).join('\n\n') }] : undefined);
  if (tpErrors.length) add(R.jsUncaughtThirdParty, [{ label: `${uniq(tpErrors).length} error(s)`, value: uniq(tpErrors).slice(0, 8).join('\n'), code: true }]);

  // Console errors that merely echo a failed request are reported once, under failed requests.
  const consoleFp: string[] = [];
  const consoleTp: string[] = [];
  for (const c of log.consoleErrors) {
    if (/^Failed to load resource/i.test(c.text)) continue;
    if (isBenignThirdParty(c.source)) continue;
    const line = `${scrub(c.text)}${c.source ? `\n    source: ${scrub(stripQuery(c.source))}` : ''}`;
    (c.source && !isFirstParty(c.source, siteHosts) ? consoleTp : consoleFp).push(line);
  }
  if (consoleFp.length) addLines(R.jsConsoleError, 'Console errors', consoleFp);
  if (consoleTp.length) addLines(R.jsConsoleErrorThirdParty, 'Console errors from third-party scripts', consoleTp);

  const reqFp: string[] = [];
  const reqTp: string[] = [];
  for (const r of log.failedRequests) {
    if (r.resourceType === 'image') continue; // reported by the image check
    if (r.error && /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/i.test(r.error) && r.status === null) continue; // navigation aborts / our own blocks
    if (isBenignThirdParty(r.url, r.status)) continue;
    const line = `${r.status ? `HTTP ${r.status}` : r.error ?? 'failed'}  ${r.resourceType}  ${scrub(stripQuery(r.url))}`;
    (isFirstParty(r.url, siteHosts) ? reqFp : reqTp).push(line);
  }
  if (reqFp.length) addLines(R.failedRequest, 'Failed requests (CSS, scripts, fonts, data)', reqFp);
  if (reqTp.length) addLines(R.failedRequestThirdParty, 'Failed requests to third-party services', reqTp);
  return out;
}

export function imageFindings(pageUrl: string, x: Extracted, log: RuntimeLog, viewport: ViewportName, dpr: number): RawFinding[] {
  const out: RawFinding[] = [];

  const broken = x.images.filter((i) => i.src && !i.src.startsWith('data:') && ((i.complete && i.naturalWidth === 0) || log.failedImages.has(stripQuery(i.src))));
  const brokenUrls = new Set(broken.map((i) => stripQuery(i.src)));
  for (const u of log.failedImages) if (!brokenUrls.has(u)) brokenUrls.add(u);
  // Candidates only: the verification step re-requests every URL before anything is reported.
  if (brokenUrls.size)
    out.push({
      rule: R.brokenImage,
      target: pageUrl,
      pageUrl,
      viewport: null,
      evidence: [],
      headEvidence: [{ label: 'Detection', value: 'The image did not render in Chrome (failed request, or loaded with no pixels), and re-requesting the file confirmed the failure.' }],
      elements: [...brokenUrls].map((u) => {
        const el = broken.find((i) => stripQuery(i.src) === u);
        return { sig: `img:${u}`, label: scrub(u), note: el ? `Element: ${el.selector}` : undefined };
      }),
    });

  const noDims = x.images.filter((i) => i.visible && i.naturalWidth > 0 && !(i.hasWidthAttr && i.hasHeightAttr) && !i.cssSized && !i.src.startsWith('data:') && !/\.svg(\?|$)/i.test(i.src));
  if (noDims.length >= 1)
    out.push({
      rule: R.imageMissingDimensions,
      target: pageUrl,
      pageUrl,
      viewport: null,
      evidence: [],
      headEvidence: [{ label: 'Detection', value: 'Visible <img> without both width and height attributes, and not sized by CSS (aspect-ratio or fixed dimensions).' }],
      elements: [...new Map(noDims.map((i) => [stripQuery(i.src), i])).values()].map((i) => ({ sig: `img:${stripQuery(i.src)}`, label: scrub(stripQuery(i.src)), note: `Element: ${i.selector}` })),
    });

  // Oversized: more than 2× the pixels needed at this device pixel ratio, and at least 400px wider than needed.
  const oversized = x.images.filter((i) => {
    if (!i.visible || i.renderedWidth < 16 || i.naturalWidth === 0 || /\.svg(\?|$)/i.test(i.src)) return false;
    const needed = i.renderedWidth * dpr;
    return i.naturalWidth > needed * 2 && i.naturalWidth - needed > 400;
  });
  if (oversized.length)
    out.push({
      rule: R.oversizedImage,
      target: pageUrl,
      pageUrl,
      viewport,
      evidence: [],
      headEvidence: [{ label: 'Viewport', value: `${viewport} (${dpr}× pixel density)` }],
      elements: [...new Map(oversized.map((i) => [stripQuery(i.src), i])).values()].map((i) => ({
        sig: `img:${stripQuery(i.src)}`,
        label: scrub(stripQuery(i.src)),
        note: `${i.naturalWidth}×${i.naturalHeight} delivered, shown at ${i.renderedWidth}×${i.renderedHeight}`,
      })),
    });

  const large = x.resources.filter((r) => r.encoded > 300 * 1024);
  if (large.length)
    out.push({
      rule: R.largeImageFile,
      target: pageUrl,
      pageUrl,
      viewport: null,
      evidence: [],
      headEvidence: [{ label: 'Detection', value: 'Transfer size of each image measured by the browser (Resource Timing); files over 300 KB are listed.' }],
      elements: [...new Map(large.map((r) => [stripQuery(r.name), r])).values()].map((r) => ({ sig: `img:${stripQuery(r.name)}`, label: `${Math.round(r.encoded / 1024)} KB  ${scrub(stripQuery(r.name))}` })),
    });
  return out;
}

export function overflowFindings(pageUrl: string, x: Extracted, viewport: ViewportName): RawFinding[] {
  const o = x.overflow;
  if (o.scrollWidth <= o.innerWidth + 1) return [];
  return [
    {
      rule: R.horizontalOverflow,
      target: pageUrl,
      pageUrl,
      viewport,
      evidence: [
        { label: 'Viewport', value: `${viewport} — ${o.innerWidth}px wide` },
        { label: 'Page width', value: `${o.scrollWidth}px (${o.scrollWidth - o.innerWidth}px too wide)` },
        {
          label: 'Elements extending past the right edge',
          value: o.offenders.length ? o.offenders.map((e) => `${e.selector}  (right edge at ${e.right}px, width ${e.width}px)`).join('\n') : 'Could not attribute the overflow to a specific element.',
          code: o.offenders.length > 0,
        },
      ],
    },
  ];
}

export function mobileContentFindings(pageUrl: string, desktop: Extracted, mobile: Extracted): RawFinding[] {
  const textRatio = desktop.textLength > 400 ? mobile.textLength / desktop.textLength : 1;
  const headingDrop = desktop.visibleHeadings >= 4 ? mobile.visibleHeadings / desktop.visibleHeadings : 1;
  if (textRatio >= 0.5 && headingDrop >= 0.5) return [];
  return [
    {
      rule: R.mobileContentMissing,
      target: pageUrl,
      pageUrl,
      viewport: 'mobile',
      evidence: [
        { label: 'Visible text length', value: `desktop ${desktop.textLength} characters, mobile ${mobile.textLength} characters` },
        { label: 'Visible h1–h3 headings', value: `desktop ${desktop.visibleHeadings}, mobile ${mobile.visibleHeadings}` },
      ],
    },
  ];
}
