// Passive, non-invasive configuration checks. Nothing here probes for vulnerabilities:
// it reads response headers of normal page requests and inspects the rendered DOM.

import type { EvidenceItem } from '@wpcg/shared';
import { safeFetch, type SafeResponse } from '../../security/safeFetch.js';
import type { Extracted } from '../browserScripts.js';
import { R } from '../rules.js';
import type { RawFinding } from '../types.js';

export async function siteSecurityFindings(startUrl: string, startRes: SafeResponse, signal?: AbortSignal): Promise<RawFinding[]> {
  const out: RawFinding[] = [];
  if (startRes.status === null) return out;
  const final = new URL(startRes.finalUrl);
  const origin = final.origin;
  const add = (rule: RawFinding['rule'], evidence: EvidenceItem[]) => out.push({ rule, target: origin, pageUrl: startUrl, viewport: null, evidence });
  const h = startRes.headers;

  if (final.protocol === 'http:') {
    const httpsUrl = new URL(final.href);
    httpsUrl.protocol = 'https:';
    httpsUrl.port = '';
    const httpsRes = await safeFetch(httpsUrl, { method: 'GET', timeoutMs: 15000, maxRedirects: 3, signal, readBody: () => false });
    if (!httpsRes.ok) {
      add(R.noHttps, [
        { label: 'Final URL of the start page', value: final.href },
        { label: 'HTTPS attempt', value: httpsRes.failure ? `${httpsUrl.href}: ${httpsRes.failure.message}` : `${httpsUrl.href} returned HTTP ${httpsRes.status}` },
      ]);
    } else {
      add(R.httpNotRedirected, [
        { label: 'HTTP URL', value: final.href },
        { label: 'Response', value: `HTTP ${startRes.status} served without redirecting to https://` },
        { label: 'HTTPS version', value: `${httpsRes.finalUrl} responds with HTTP ${httpsRes.status}` },
      ]);
    }
  } else {
    // HTTPS site: does the http:// variant redirect to https?
    const httpUrl = new URL(final.href);
    httpUrl.protocol = 'http:';
    httpUrl.port = '';
    const httpRes = await safeFetch(httpUrl, { method: 'GET', timeoutMs: 15000, maxRedirects: 0, signal, readBody: () => false });
    const loc = httpRes.redirects[0]?.location ?? httpRes.headers.location;
    if (httpRes.status !== null && httpRes.status >= 200 && httpRes.status < 300) {
      add(R.httpNotRedirected, [
        { label: 'HTTP URL', value: httpUrl.href },
        { label: 'Response', value: `HTTP ${httpRes.status} served without redirecting to https://` },
      ]);
    } else if (loc && loc.startsWith('http://') && httpRes.status !== null && httpRes.status < 400) {
      // Redirects to another http URL first; only flagged if it never reaches https within a few hops.
      const follow = await safeFetch(httpUrl, { method: 'GET', timeoutMs: 15000, maxRedirects: 5, signal, readBody: () => false });
      if (follow.status !== null && new URL(follow.finalUrl).protocol === 'http:')
        add(R.httpNotRedirected, [
          { label: 'HTTP URL', value: httpUrl.href },
          { label: 'Ends at', value: follow.finalUrl },
        ]);
    }
  }
  const https = final.protocol === 'https:';

  const headerEv = (names: string[]): EvidenceItem => ({
    label: 'Response headers checked',
    value: names.map((n) => `${n}: ${h[n] ?? '(not set)'}`).join('\n'),
    code: true,
  });
  if (https && !h['strict-transport-security']) add(R.missingHsts, [{ label: 'URL', value: final.href }, headerEv(['strict-transport-security'])]);
  if (!h['content-security-policy']) add(R.missingCsp, [{ label: 'URL', value: final.href }, headerEv(['content-security-policy', 'content-security-policy-report-only'])]);
  if ((h['x-content-type-options'] ?? '').toLowerCase().trim() !== 'nosniff') add(R.missingNosniff, [{ label: 'URL', value: final.href }, headerEv(['x-content-type-options'])]);
  const csp = h['content-security-policy'] ?? '';
  if (!h['x-frame-options'] && !/frame-ancestors/i.test(csp)) add(R.missingFrameProtection, [{ label: 'URL', value: final.href }, headerEv(['x-frame-options', 'content-security-policy'])]);
  if (!h['referrer-policy']) add(R.missingReferrerPolicy, [{ label: 'URL', value: final.href }, headerEv(['referrer-policy'])]);

  const disclosed = (['server', 'x-powered-by', 'x-aspnet-version', 'x-generator'] as const)
    .filter((n) => h[n] && /\d+\.\d+/.test(h[n]))
    .map((n) => `${n}: ${h[n]}`);
  if (disclosed.length) add(R.versionDisclosure, [{ label: 'Headers', value: disclosed.join('\n'), code: true }]);

  // Set-Cookie arrives joined with ", " by our header flattening; split on cookie boundaries.
  const setCookie = h['set-cookie'];
  if (https && setCookie) {
    const cookies = setCookie.split(/,\s*(?=[^;=\s]+=)/);
    const insecure = cookies.filter((c) => !/;\s*secure\b/i.test(c)).map((c) => c.split('=')[0].trim()).filter(Boolean);
    if (insecure.length)
      add(R.insecureCookie, [
        { label: 'Cookie names (values are not stored)', value: insecure.slice(0, 10).join(', '), code: true },
      ]);
  }
  return out;
}

export function pageSecurityFindings(pageUrl: string, x: Extracted): RawFinding[] {
  const out: RawFinding[] = [];
  const active = x.mixed.filter((m) => m.kind === 'active');
  const passive = x.mixed.filter((m) => m.kind === 'passive');
  const list = (items: Extracted['mixed']) => items.slice(0, 15).map((m) => `<${m.tag}> ${m.url}`).join('\n');
  if (active.length) out.push({ rule: R.mixedContentActive, target: pageUrl, pageUrl, viewport: null, evidence: [{ label: `${active.length} insecure reference(s)`, value: list(active), code: true }] });
  if (passive.length) out.push({ rule: R.mixedContentPassive, target: pageUrl, pageUrl, viewport: null, evidence: [{ label: `${passive.length} insecure reference(s)`, value: list(passive), code: true }] });

  const insecure = x.forms.filter((f) => /^http:\/\//i.test(f.action) || (f.hasPassword && x.protocol === 'http:'));
  if (insecure.length)
    out.push({
      rule: R.insecureForm,
      target: pageUrl,
      pageUrl,
      viewport: null,
      evidence: [
        { label: 'Forms', value: insecure.slice(0, 10).map((f) => `${f.selector}  method=${f.method}  action=${f.action}${f.hasPassword ? '  (has password field)' : ''}`).join('\n'), code: true },
        { label: 'Note', value: 'Forms were inspected only; nothing was submitted.' },
      ],
    });
  return out;
}
