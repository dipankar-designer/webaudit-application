// HTML-structure and SEO checks over the DOM extracted from Chrome after page load.

import type { EvidenceItem } from '@wpcg/shared';
import type { SafeResponse } from '../../security/safeFetch.js';
import type { Extracted } from '../browserScripts.js';
import { isAllowed, type RobotsRules } from '../robots.js';
import { R } from '../rules.js';
import type { RawFinding } from '../types.js';

const BCP47 = /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?(-[a-z0-9]{5,8})*$/i;

const SOURCE: EvidenceItem = { label: 'Source', value: 'Rendered DOM in Chrome after page load' };

export function htmlFindings(pageUrl: string, x: Extracted, res: SafeResponse | null): RawFinding[] {
  const out: RawFinding[] = [];
  const add = (rule: RawFinding['rule'], evidence: EvidenceItem[]) => out.push({ rule, target: pageUrl, pageUrl, viewport: null, evidence: [...evidence, SOURCE] });

  if (!x.doctype) add(R.missingDoctype, [{ label: 'Doctype', value: 'none found' }]);
  if (x.doctype && x.doctype.toLowerCase() !== 'html') add(R.missingDoctype, [{ label: 'Doctype', value: x.doctype, code: true }]);

  if (x.lang === null || x.lang.trim() === '') add(R.missingLang, [{ label: '<html> lang attribute', value: x.lang === null ? 'not present' : 'empty' }]);
  else if (!BCP47.test(x.lang.trim())) add(R.invalidLang, [{ label: '<html> lang attribute', value: x.lang, code: true }]);

  const headerCharset = /charset=/i.test(res?.headers['content-type'] ?? '');
  if (!x.metaCharset && !headerCharset)
    add(R.missingCharset, [
      { label: 'Content-Type header', value: res?.headers['content-type'] ?? '(not available)', code: true },
      { label: 'Encoding the browser guessed', value: x.characterSet },
    ]);

  if (!x.viewport) add(R.missingViewport, [{ label: '<meta name="viewport">', value: 'not present' }]);

  const h1s = x.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) add(R.missingH1, [{ label: 'Headings found', value: x.headings.length ? x.headings.slice(0, 8).map((h) => `h${h.level}: ${h.text}`).join('\n') : 'none', code: x.headings.length > 0 }]);
  if (h1s.length > 1) add(R.multipleH1, [{ label: `${h1s.length} <h1> elements`, value: h1s.slice(0, 6).map((h) => `${h.text || '(empty)'}  —  ${h.selector}`).join('\n'), code: true }]);

  const skips: { text: string; key: string }[] = [];
  let prev = 0;
  for (const h of x.headings) {
    if (prev && h.level > prev + 1) skips.push({ text: `h${prev} → h${h.level}: "${h.text}"  (${h.selector})`, key: `h${prev}>h${h.level}:${h.text}` });
    prev = h.level;
  }
  // Grouped by heading, so a skip in a shared footer is one issue listing its pages.
  if (skips.length)
    out.push({
      rule: R.headingSkip,
      target: pageUrl,
      pageUrl,
      viewport: null,
      evidence: [],
      headEvidence: [{ label: 'Detection', value: 'Heading levels read from the rendered page in document order; a jump of more than one level (for example h2 → h4) is reported.' }, SOURCE],
      elements: skips.map((s) => ({ sig: `heading:${s.key}`, label: s.text })),
    });

  if (x.duplicateIds.length)
    add(R.duplicateIds, [{ label: `${x.duplicateIds.length} duplicated id value(s)`, value: x.duplicateIds.slice(0, 15).map((d) => `#${d.id} × ${d.count}`).join('\n'), code: true }]);

  if (x.deprecated.length) add(R.deprecatedElements, [{ label: 'Obsolete elements', value: x.deprecated.map((d) => `<${d.tag}> × ${d.count}`).join(', '), code: true }]);

  return out;
}

export function seoPageFindings(pageUrl: string, x: Extracted, res: SafeResponse | null, isStart: boolean, siteHosts: string[]): RawFinding[] {
  const out: RawFinding[] = [];
  const add = (rule: RawFinding['rule'], evidence: EvidenceItem[], target = pageUrl) => out.push({ rule, target, pageUrl, viewport: null, evidence: [...evidence, SOURCE] });

  const title = (x.title ?? '').trim();
  if (!title) add(R.missingTitle, [{ label: '<title>', value: x.title === null ? 'not present' : 'empty' }]);
  else if (title.length < 10 || title.length > 65) add(R.titleLength, [{ label: 'Title', value: title }, { label: 'Length', value: `${title.length} characters` }]);

  const desc = x.descriptions.map((d) => d.trim()).filter(Boolean);
  if (!desc.length) add(R.missingDescription, [{ label: '<meta name="description">', value: x.descriptions.length ? 'present but empty' : 'not present' }]);

  const headerRobots = res?.headers['x-robots-tag'] ?? '';
  const noindexSources = [
    ...x.robots.filter((r) => /\bnoindex\b|\bnone\b/i.test(r)).map((r) => `<meta name="robots" content="${r}">`),
    ...(/\bnoindex\b|\bnone\b/i.test(headerRobots) ? [`X-Robots-Tag: ${headerRobots}`] : []),
  ];
  if (noindexSources.length) {
    const ev = [{ label: 'Directive', value: noindexSources.join('\n'), code: true }];
    if (isStart) add(R.noindexHome, ev, new URL(pageUrl).origin);
    else add(R.noindexPage, ev);
  }

  if (!x.canonicals.length) add(R.canonicalMissing, [{ label: '<link rel="canonical">', value: 'not present' }]);
  else {
    const problems: string[] = [];
    if (x.canonicals.length > 1) problems.push(`${x.canonicals.length} canonical links found (there should be one)`);
    for (const c of x.canonicals) {
      if (!c.resolved) problems.push(`"${c.raw}" is not a valid URL`);
      else {
        const cu = new URL(c.resolved);
        if (!siteHosts.includes(cu.hostname.toLowerCase())) problems.push(`points to another host: ${c.resolved}`);
        if (cu.protocol === 'http:' && new URL(pageUrl).protocol === 'https:') problems.push(`uses insecure http:// on an https page: ${c.resolved}`);
      }
    }
    if (problems.length) add(R.canonicalProblem, [{ label: 'Canonical value(s)', value: x.canonicals.map((c) => c.raw).join('\n'), code: true }, { label: 'Problems', value: problems.join('\n') }]);
  }

  const badLd = x.jsonLd.filter((j) => !j.ok);
  if (badLd.length)
    add(R.structuredDataInvalid, badLd.slice(0, 3).flatMap((j, i) => [
      { label: `Block ${i + 1} error`, value: j.error ?? 'parse error' },
      { label: `Block ${i + 1} start`, value: j.snippet, code: true },
    ]));

  const internal = x.links.filter((l) => {
    try {
      return siteHosts.includes(new URL(l.href).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
  if (!internal.length) add(R.noInternalLinks, [{ label: 'Links found', value: `${x.links.length} total, 0 to this site` }]);

  return out;
}

/** Cross-page and site-level SEO checks, run after all pages are processed. */
export function seoSiteFindings(input: {
  startUrl: string;
  origin: string;
  pages: { url: string; title: string | null; description: string | null }[];
  robots: RobotsRules | null;
  sitemapFound: boolean;
}): RawFinding[] {
  const out: RawFinding[] = [];

  const group = (key: 'title' | 'description', rule: RawFinding['rule']) => {
    const map = new Map<string, string[]>();
    for (const p of input.pages) {
      const v = (p[key] ?? '').trim();
      if (!v) continue;
      map.set(v, [...(map.get(v) ?? []), p.url]);
    }
    for (const [value, urls] of map) {
      if (urls.length < 2) continue;
      // One issue per duplicated value; findings on each page so coverage follows those pages.
      for (const url of urls)
        out.push({
          rule,
          target: `${key}:${value}`,
          pageUrl: url,
          viewport: null,
          evidence: [
            { label: key === 'title' ? 'Shared title' : 'Shared description', value },
            { label: `Pages using it (${urls.length})`, value: urls.slice(0, 20).join('\n') },
          ],
        });
    }
  };
  group('title', R.duplicateTitle);
  group('description', R.duplicateDescription);

  if (input.robots) {
    const u = new URL(input.startUrl);
    if (!isAllowed(input.robots, u.pathname + u.search, 'googlebot'))
      out.push({
        rule: R.robotsBlocksHome,
        target: input.origin,
        pageUrl: input.startUrl,
        viewport: null,
        evidence: [{ label: 'robots.txt', value: `${input.origin}/robots.txt disallows ${u.pathname} for general crawlers` }],
      });
  }
  if (!input.sitemapFound)
    out.push({
      rule: R.sitemapMissing,
      target: input.origin,
      pageUrl: input.startUrl,
      viewport: null,
      evidence: [{ label: 'Checked', value: 'robots.txt Sitemap lines, /sitemap.xml, /sitemap_index.xml, /wp-sitemap.xml' }],
    });
  return out;
}
