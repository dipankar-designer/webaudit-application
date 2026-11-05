import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { isAllowed, parseRobots } from '../src/scanner/robots.js';
import { extractLinksFromHtml, normalisePageUrl } from '../src/scanner/discovery.js';
import { AXE_IMPACT_TO_SEVERITY, axeRuleDef, wcagFromTags } from '../src/scanner/axeRules.js';
import { compareScreenshots } from '../src/scanner/checks/visual.js';
import { isFirstParty, scrub } from '../src/scanner/checks/pageRuntime.js';
import { csvCell } from '../src/reports/exporters.js';
import { coverageKeyOf, fingerprintOf } from '../src/scanner/persist.js';
import { R, RULES } from '../src/scanner/rules.js';
import { SEVERITIES } from '@wpcg/shared';

describe('robots.txt', () => {
  const robots = parseRobots(`# comment
User-agent: *
Disallow: /private/
Allow: /private/ok$
Disallow: /*.pdf$

User-agent: WebAuditAIBot
Disallow: /bot-only

Sitemap: https://example.com/sitemap.xml`);
  it('collects sitemaps', () => expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']));
  it('applies the group for the specific agent', () => {
    expect(isAllowed(robots, '/bot-only')).toBe(false);
    expect(isAllowed(robots, '/private/x')).toBe(true); // our own group has no /private rule
  });
  it('applies the * group with longest match and wildcards', () => {
    expect(isAllowed(robots, '/private/x', 'googlebot')).toBe(false);
    expect(isAllowed(robots, '/private/ok', 'googlebot')).toBe(true);
    expect(isAllowed(robots, '/file.pdf', 'googlebot')).toBe(false);
    expect(isAllowed(robots, '/file.pdf?x', 'googlebot')).toBe(true);
  });
  it('treats an empty Disallow as allow-all', () => expect(isAllowed(parseRobots('User-agent: *\nDisallow:'), '/')).toBe(true));
});

describe('discovery helpers', () => {
  it('normalises URLs and strips tracking parameters', () => {
    expect(normalisePageUrl('/a?utm_source=x&id=2#top', 'https://Example.com/')).toBe('https://example.com/a?id=2');
    expect(normalisePageUrl('mailto:x@y.z')).toBeNull();
  });
  it('extracts links, honours <base> and skips nofollow and non-web schemes', () => {
    const links = extractLinksFromHtml(
      '<base href="https://example.com/sub/"><a href="page">p</a><a href="#x">x</a><a href="tel:1">t</a><a rel="nofollow" href="/nf">n</a><a href="https://other.org/">o</a>',
      'https://example.com/',
    );
    expect(links).toEqual(['https://example.com/sub/page', 'https://other.org/']);
  });
});

describe('axe mapping', () => {
  it('maps WCAG tags to success criteria', () => expect(wcagFromTags(['wcag2a', 'wcag111', 'wcag1412', 'cat.text'])).toEqual(['1.1.1', '1.4.12']));
  it('reserves Critical for availability', () => expect(Object.values(AXE_IMPACT_TO_SEVERITY)).not.toContain('critical'));
  it('marks incomplete results for manual review', () => {
    const r = axeRuleDef({ id: 'color-contrast', impact: 'serious', tags: ['wcag143'], description: 'd', help: 'h', helpUrl: 'u' }, true);
    expect(r.id).toBe('axe-review.color-contrast');
    expect(r.initialStatus).toBe('needs_review');
    expect(r.remediation.manualReview).toBeTruthy();
  });
});

describe('rule catalogue', () => {
  it('every rule has a valid severity, a documented reason and remediation steps', () => {
    for (const rule of Object.values(RULES)) {
      expect(SEVERITIES).toContain(rule.severity);
      expect(rule.severityReason.length).toBeGreaterThan(20);
      expect(rule.remediation.steps.length).toBeGreaterThan(0);
      expect(rule.remediation.verify.length).toBeGreaterThan(0);
      if (rule.severity === 'critical') expect(rule.category).toBe('availability');
    }
  });
  it('fingerprints include the viewport only for viewport-dependent rules', () => {
    const base = { target: 'https://e.com/', pageUrl: 'https://e.com/', evidence: [] };
    expect(fingerprintOf({ ...base, rule: R.horizontalOverflow, viewport: 'mobile' })).not.toBe(fingerprintOf({ ...base, rule: R.horizontalOverflow, viewport: 'desktop' }));
    expect(fingerprintOf({ ...base, rule: R.missingLang, viewport: 'mobile' })).toBe(fingerprintOf({ ...base, rule: R.missingLang, viewport: 'desktop' }));
    expect(coverageKeyOf({ ...base, rule: R.missingHsts, viewport: null })).toBe('security-site|-|https://e.com/');
  });
});

describe('visual comparison', () => {
  const img = (w: number, h: number, fill: number, patch?: { x: number; y: number; s: number }) => {
    const p = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inPatch = patch && x >= patch.x && x < patch.x + patch.s && y >= patch.y && y < patch.y + patch.s;
        p.data[i] = p.data[i + 1] = p.data[i + 2] = inPatch ? 0 : fill;
        p.data[i + 3] = 255;
      }
    return PNG.sync.write(p);
  };
  it('reports zero difference for identical images', () => {
    const r = compareScreenshots(img(50, 50, 255), img(50, 50, 255), 0.1);
    expect(r.diffPixels).toBe(0);
  });
  it('measures a changed region', () => {
    const r = compareScreenshots(img(100, 100, 255), img(100, 100, 255, { x: 10, y: 10, s: 10 }), 0.1);
    expect(r.diffPixels).toBe(100);
    expect(r.ratio).toBeCloseTo(0.01, 5);
  });
  it('counts added height as changed area', () => {
    const r = compareScreenshots(img(10, 10, 255), img(10, 20, 255), 0.1);
    expect(r.height).toBe(20);
    expect(r.diffPixels).toBe(100);
  });
});

describe('privacy and export helpers', () => {
  it('scrubs tokens, e-mail addresses and JWTs from evidence', () => {
    expect(scrub('GET /api?token=abc123&x=1 failed for jane@example.com')).toBe('GET /api?token=[redacted]&x=1 failed for [email]');
    expect(scrub('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('Bearer [jwt]');
  });
  it('classifies first-party hosts including www and subdomains', () => {
    expect(isFirstParty('https://cdn.example.com/a.js', ['www.example.com'])).toBe(true);
    expect(isFirstParty('https://example.com/a.js', ['www.example.com'])).toBe(true);
    expect(isFirstParty('https://www.google-analytics.com/a.js', ['www.example.com'])).toBe(false);
  });
  it('quotes CSV cells and neutralises formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1')).toBe("'-1");
  });
});

describe('AI output clean-up', () => {
  it('turns Markdown into plain text', async () => {
    const { toPlainText } = await import('../src/ai/provider.js');
    expect(toPlainText('## Summary\n**What the problem is:** a *missing* label.\n* Step one\n+ Step two\n\n\n\nUse `alt` text.')).toBe(
      'Summary\nWhat the problem is: a missing label.\n- Step one\n- Step two\n\nUse alt text.',
    );
  });
});
