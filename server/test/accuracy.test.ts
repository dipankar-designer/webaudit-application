// Accuracy of reporting: element grouping across pages, re-verification before reporting (real
// requests against the local fixture site), and WordPress fingerprinting helpers.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consolidateFindings, elementSig } from '../src/scanner/consolidate.js';
import { verifyFindings } from '../src/scanner/verify.js';
import { isBenignThirdParty } from '../src/scanner/checks/pageRuntime.js';
import { R } from '../src/scanner/rules.js';
import type { RawFinding } from '../src/scanner/types.js';
import { collectMarkers, emptyMarkers, parseFeedGenerator, parsePluginReadme } from '../src/scanner/wordpress/detect.js';
import { compareVersions, isVersionLike, satisfies } from '../src/scanner/wordpress/versions.js';
import { fingerprintOf } from '../src/scanner/persist.js';
import { discoverPages } from '../src/scanner/discovery.js';
import { startFixtureSite, type FixtureSite } from './fixtureSite.js';

let site: FixtureSite;
beforeAll(async () => {
  site = await startFixtureSite(4598);
});
afterAll(() => site.close());

const axeFinding = (page: string, htmls: string[]): RawFinding => ({
  rule: R.headingSkip, // any page-scoped rule

  target: page,
  pageUrl: page,
  viewport: null,
  evidence: [],
  headEvidence: [{ label: 'Rule', value: 'link-name' }],
  elements: htmls.map((h) => ({ sig: elementSig('link-name', h), label: h.slice(0, 30), html: h })),
});

describe('grouping by element across pages', () => {
  const header = '<a href="https://facebook.com/x"><i class="fab fa-facebook"></i></a>';
  const pages = ['https://s.test/', 'https://s.test/a', 'https://s.test/b'];

  it('reports a shared header problem once, listing every page; page-only elements stay with their page', () => {
    const footer = '<a href="/terms"><i class="icon"></i></a>'; // on two pages only
    const out = consolidateFindings([
      axeFinding(pages[0], [header, footer]),
      axeFinding(pages[1], [header, footer]),
      axeFinding(pages[2], [header]),
      axeFinding('https://s.test/c', ['<a href="/x"><img src="y.png"></a>']),
    ]);
    const shared = out.filter((f) => f.target.startsWith('shared:'));
    expect(new Set(shared.map(fingerprintOf)).size).toBe(1); // ONE site-wide issue for all shared elements
    expect(shared.map((f) => f.pageUrl).sort()).toEqual([...pages].sort()); // a finding row per page, for coverage
    expect(shared[0].evidence.find((e) => e.label === 'Found on 3 pages')?.value).toContain('https://s.test/b');
    expect(shared[0].evidence.find((e) => e.label.startsWith('Affected elements'))?.value).toMatch(/on 3 pages[\s\S]*on 2 pages/);
    const own = out.filter((f) => !f.target.startsWith('shared:'));
    expect(own).toHaveLength(1);
    expect(own[0].target).toBe('https://s.test/c'); // same identity as before grouping existed
  });

  it('ignores per-request noise when comparing elements', () => {
    expect(elementSig('r', '<div  id="x-123456">a</div>')).toBe(elementSig('r', '<div id="x-987654">a</div>'));
    expect(elementSig('r', '<link href="a.css?ver=1.2">')).toBe(elementSig('r', '<link href="a.css?ver=9.9">'));
  });
});

describe('verification before reporting (real requests to the fixture)', () => {
  it('dismisses an image that loads on re-request and confirms one that does not', async () => {
    const img = (u: string) => ({ sig: `img:${site.url}${u}`, label: `${site.url}${u}` });
    const f: RawFinding = { rule: R.brokenImage, target: site.url, pageUrl: site.url, viewport: null, evidence: [], elements: [img('img/small.png'), img('img/nope.png')] };
    const { findings, record } = await verifyFindings([f]);
    expect(record.dismissed.map((d) => d.item)).toEqual([`${site.url}img/small.png`]);
    expect(record.dismissed[0].reason).toMatch(/valid image data/);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBeUndefined(); // confirmed
    expect(findings[0].elements!.map((e) => e.label)).toEqual([`${site.url}img/nope.png`]);
    expect(findings[0].elements![0].note).toMatch(/404/);
  }, 60_000);

  it('confirms a broken link only when the re-check reproduces it', async () => {
    const link = (u: string): RawFinding => ({ rule: R.brokenInternalLink, target: u, pageUrl: site.url, viewport: null, evidence: [], check: 'links' });
    const { findings } = await verifyFindings([link(`${site.url}does-not-exist`), link(`${site.url}about`)]);
    const broken = findings.find((f) => f.target.endsWith('does-not-exist'))!;
    expect(broken.status).toBeUndefined();
    expect(broken.evidence.at(-1)?.value).toMatch(/404/);
    const flaky = findings.find((f) => f.target.endsWith('about'))!;
    expect(flaky.status).toBe('inconclusive'); // works now → pending verification, not a defect
  }, 60_000);

  it('ignores expected Cloudflare Turnstile behaviour but not real third-party failures', () => {
    expect(isBenignThirdParty('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/pat/abc/123/xyz', 401)).toBe(true);
    expect(isBenignThirdParty('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0', null)).toBe(true);
    expect(isBenignThirdParty('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/x.js', 500)).toBe(false);
    expect(isBenignThirdParty('https://maps.googleapis.com/maps/api/js', 403)).toBe(false);
  });

  it('a redirecting internal link is informational, not a broken link', () => {
    expect(R.internalRedirectLink.severity).toBe('info');
    expect(R.internalRedirectLink.title).toMatch(/the link works/);
  });
});

describe('WordPress fingerprinting', () => {
  const html = `<html><head><meta name="generator" content="WordPress 6.6.2">
<link rel="https://api.w.org/" href="https://wp.test/wp-json/">
<link rel="stylesheet" href="https://wp.test/wp-includes/css/dist/block-library/style.min.css?ver=6.6.2">
<link rel="stylesheet" href="/wp-content/plugins/contact-form-7/includes/css/styles.css?ver=5.9.8">
<script src="https://cdn.other.test/wp-content/plugins/evil/x.js"></script>
<link rel="stylesheet" href="/wp-content/themes/astra/style.css?ver=4.6.1"></head><body></body></html>`;

  it('reads WordPress, plugins and themes from the site’s own files only', () => {
    const acc = emptyMarkers();
    collectMarkers(acc, html, new URL('https://wp.test/'));
    expect(acc.strong).toBe(true);
    expect(acc.generatorVersion).toBe('6.6.2');
    expect([...acc.plugins.keys()]).toEqual(['contact-form-7']); // the CDN file of another site is ignored
    expect([...acc.plugins.get('contact-form-7')!.assetVersions]).toEqual(['5.9.8']);
    expect([...acc.themes.keys()]).toEqual(['astra']);
  });

  it('parses readme.txt and feed generators; rejects non-readme files', () => {
    expect(parsePluginReadme('=== Contact Form 7 ===\nContributors: x\nStable tag: 5.9.8\n')).toEqual({ name: 'Contact Form 7', stableTag: '5.9.8' });
    expect(parsePluginReadme('<html>Not found</html>')).toBeNull();
    expect(parseFeedGenerator('<generator>https://wordpress.org/?v=6.6.2</generator>')).toBe('6.6.2');
  });

  it('compares versions like WordPress and matches vulnerability ranges', () => {
    expect(compareVersions('5.3.1', '5.3.2')).toBe(-1);
    expect(compareVersions('5.10', '5.9')).toBe(1);
    expect(compareVersions('5.0', '5.0.0')).toBe(0);
    expect(compareVersions('1.0-beta', '1.0')).toBe(-1);
    expect(satisfies('5.3.1', 'lt', '5.3.2')).toBe(true);
    expect(satisfies('5.3.2', 'lt', '5.3.2')).toBe(false);
    expect(isVersionLike('trunk')).toBe(false);
    expect(isVersionLike('2.4.1')).toBe(true);
  });
});

describe('discovery never scans a page twice', () => {
  it('does not add the start address’s redirect target as a second page', async () => {
    const d = await discoverPages(`${new URL('/start-redirect', site.url).href}`, { maxPages: 50, maxDepth: 3 });
    const urls = d.pages.map((p) => p.url);
    expect(urls[0]).toBe(`${new URL('/start-redirect', site.url).href}`);
    // The home page's own "Home" link points at the redirect target, which is the same page.
    expect(urls).not.toContain(`${new URL("/", site.url).href}`);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('lists each page once when a redirecting link and its target are both found', async () => {
    const d = await discoverPages(`${new URL("/", site.url).href}`, { maxPages: 50, maxDepth: 3 });
    const urls = d.pages.map((p) => p.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.filter((u) => u === `${new URL('/about', site.url).href}`)).toHaveLength(1);
    expect(urls).not.toContain(`${new URL('/old-about', site.url).href}`);
  });
});

describe('verification after the scan has stopped', () => {
  it('leaves findings pending without waiting on requests', async () => {
    const stopped = new AbortController();
    stopped.abort(Object.assign(new Error('time limit'), { name: 'TimeoutError' }));
    const f: RawFinding = { rule: R.brokenInternalLink, target: `${new URL('/missing', site.url).href}`, pageUrl: `${new URL("/", site.url).href}`, viewport: null, evidence: [] };
    const t0 = Date.now();
    const r = await verifyFindings([f], stopped.signal);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.findings[0].status).toBe('inconclusive');
    expect(r.record).toMatchObject({ checked: 1, confirmed: 0, pending: 1 });
  });
});
