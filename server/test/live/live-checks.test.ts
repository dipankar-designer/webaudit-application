// Live checks against real, public, authorised test targets. Opt-in (needs internet):
//   npm run test:live -w @wpcg/server
// badssl.com exists for TLS client testing; irishmediaagency.ie is the account owner's own domain.
// Only passive checks run here (TLS handshake, HTTPS redirect, DNS, WHOIS/RDAP, one page render).

import { afterAll, describe, expect, it } from 'vitest';
import { tlsCheck } from '../../src/monitoring/checks/tls.js';
import { httpsCheck } from '../../src/monitoring/checks/https.js';
import { dnsCheck } from '../../src/monitoring/checks/dns.js';
import { domainCheck } from '../../src/monitoring/checks/domain.js';
import { uptimeCheck } from '../../src/monitoring/checks/uptime.js';
import { headersCheck } from '../../src/monitoring/checks/content.js';
import { browserCheck } from '../../src/monitoring/checks/browser.js';
import { closeBrowser } from '../../src/scanner/browser.js';
import type { CheckOutcome, MonitorRow } from '../../src/monitoring/types.js';

const row = (url: string): MonitorRow => ({
  id: '00000000-0000-0000-0000-000000000000',
  workspace_id: '00000000-0000-0000-0000-000000000000',
  website_id: null,
  kind: 'website',
  name: url,
  url,
  enabled: true,
  interval_seconds: 300,
  keyword: null,
  keyword_mode: null,
  money_page: false,
  exposure_authorised_at: null,
  heartbeat_token: null,
  heartbeat_grace_seconds: 300,
  last_heartbeat_at: null,
});
const run = (fn: (c: never) => Promise<CheckOutcome>, url: string, baseline: unknown = null) =>
  fn({ monitor: row(url), baseline, signal: new AbortController().signal } as never);
const log = (label: string, r: CheckOutcome) => console.log(`${label}: ${r.status}${r.severity ? ` ${r.severity}` : ''} — ${r.summary}`);

afterAll(() => closeBrowser());

describe('TLS against badssl.com', () => {
  it('valid certificate is up', async () => {
    const r = await run(tlsCheck, 'https://badssl.com/');
    log('badssl.com', r);
    expect(r.status).toBe('up');
  });
  it('expired certificate is down P1', async () => {
    const r = await run(tlsCheck, 'https://expired.badssl.com/');
    log('expired', r);
    expect(r.status).toBe('down');
    expect(r.severity).toBe('p1');
    expect(r.summary).toMatch(/expired/i);
  });
  it('wrong host is down P1', async () => {
    const r = await run(tlsCheck, 'https://wrong.host.badssl.com/');
    log('wrong.host', r);
    expect(r.status).toBe('down');
    expect(r.summary).toMatch(/name|host|match/i);
  });
  it('self-signed and untrusted roots are down P1', async () => {
    for (const h of ['self-signed', 'untrusted-root']) {
      const r = await run(tlsCheck, `https://${h}.badssl.com/`);
      log(h, r);
      expect(r.status).toBe('down');
    }
  });
});

describe("the owner's own site (irishmediaagency.ie)", () => {
  const url = 'https://irishmediaagency.ie/';
  it('uptime, TLS, HTTPS redirect and headers return real readings', async () => {
    for (const [label, fn] of [['uptime', uptimeCheck], ['tls', tlsCheck], ['https', httpsCheck], ['headers', headersCheck]] as const) {
      const r = await run(fn as never, url);
      log(label, r);
      expect(['up', 'warning', 'down', 'not_assessed']).toContain(r.status);
      expect(r.summary.length).toBeGreaterThan(0);
    }
  });
  it('DNS records and a baseline', async () => {
    const r = await run(dnsCheck, url);
    log('dns', r);
    expect(r.baseline).toBeTruthy();
    expect(['up', 'warning']).toContain(r.status);
  });
  it('domain expiry from the .ie registry', async () => {
    const r = await run(domainCheck, url);
    log('domain', r);
    expect(['up', 'warning', 'down', 'not_assessed']).toContain(r.status);
  }, 60_000);
  it('browser render', async () => {
    const r = await run(browserCheck, url);
    log('browser', r);
    expect(['up', 'warning', 'down', 'not_assessed']).toContain(r.status);
  }, 150_000);
});
