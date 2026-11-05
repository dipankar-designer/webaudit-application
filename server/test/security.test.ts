import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertHostAllowed, guardedLookup, isBlockedIp, validateScanUrl } from '../src/security/ssrf.js';
import { safeFetch } from '../src/security/safeFetch.js';
import { startEgressProxy, type EgressProxy } from '../src/security/egressProxy.js';
import { startFixtureSite, type FixtureSite } from './fixtureSite.js';

describe('IP classification', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.100.200',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2001:db8::1',
    '2002:7f00:1::1',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4001:82a::200e'])('allows public %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );
});

describe('URL validation', () => {
  it('normalises and accepts public URLs', () => {
    expect(validateScanUrl('example.com').href).toBe('https://example.com/');
    expect(validateScanUrl('https://Example.com/path#frag').href).toBe('https://example.com/path');
  });
  it.each([
    ['file:///etc/passwd', /http/],
    ['ftp://example.com', /http/],
    ['http://user:pw@example.com', /username or password/],
    ['http://localhost/', /internal or reserved/],
    ['http://app.localhost/', /internal or reserved/],
    ['http://metadata.google.internal/', /internal or reserved/],
    ['http://169.254.169.254/latest/meta-data', /private/],
    ['http://2130706433/', /private/], // decimal form of 127.0.0.1
    ['http://0x7f.1/', /private/],
    ['http://[::1]/', /private/],
    ['http://intranet/', /fully qualified/],
    ['http://example.com:22/', /Port 22/],
    ['javascript:alert(1)', /http/],
  ])('rejects %s', (u, msg) => expect(() => validateScanUrl(u)).toThrow(msg));

  it('lets only the configured test target through', () => {
    expect(() => assertHostAllowed('127.0.0.1', 4598)).not.toThrow();
    expect(() => assertHostAllowed('127.0.0.1', 4599)).toThrow(/private/);
  });

  it('refuses hosts that resolve to loopback at connect time', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => guardedLookup('localhost', {}, (e) => r(e)));
    expect(err?.code).toBe('EBLOCKEDTARGET');
  });
});

describe('safeFetch', () => {
  let site: FixtureSite;
  let internal: http.Server;
  let internalPort: number;
  beforeAll(async () => {
    site = await startFixtureSite(4598);
    // A "sensitive" internal service on a non-allowlisted port.
    internal = http.createServer((_q, s) => s.end('secret'));
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
    internalPort = (internal.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await site.close();
    internal.close();
  });

  it('fetches the allowed fixture and decompresses gzip', async () => {
    const r = await safeFetch(site.url);
    expect(r.status).toBe(200);
    expect(r.body?.toString()).toContain('Welcome to the fixture');
  });

  it('records redirect chains', async () => {
    const r = await safeFetch(`${site.url}old-about`);
    expect(r.redirects).toHaveLength(1);
    expect(r.finalUrl).toBe(`${site.url}about`);
  });

  it('blocks direct requests to internal services', async () => {
    const r = await safeFetch(`http://127.0.0.1:${internalPort}/`);
    expect(r.failure?.kind).toBe('blocked');
  });

  it('re-validates every redirect hop (open redirect to an internal service)', async () => {
    const r = await safeFetch(`${site.url}go?to=${encodeURIComponent(`http://127.0.0.1:${internalPort}/`)}`);
    expect(r.failure?.kind).toBe('blocked');
    expect(r.redirects).toHaveLength(1);
    expect(r.body).toBeNull();
  });

  it('caps response size', async () => {
    const r = await safeFetch(`${site.url}img/big.png`, { maxBytes: 1000, readBody: () => true });
    expect(r.truncated).toBe(true);
    expect(r.body!.length).toBeLessThanOrEqual(1000);
  });
});

describe('egress proxy', () => {
  let proxy: EgressProxy;
  let site: FixtureSite;
  let internal: http.Server;
  let internalPort: number;
  beforeAll(async () => {
    proxy = await startEgressProxy();
    site = await startFixtureSite(4598);
    internal = http.createServer((_q, s) => s.end('secret'));
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
    internalPort = (internal.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await proxy.close();
    await site.close();
    internal.close();
  });

  const viaProxy = (target: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const p = new URL(proxy.url);
      const req = http.request({ host: p.hostname, port: p.port, path: target, method: 'GET', headers: { host: new URL(target).host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

  const connect = (authority: string) =>
    new Promise<string>((resolve) => {
      const p = new URL(proxy.url);
      const s = net.connect(Number(p.port), p.hostname, () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
      s.once('data', (d) => {
        resolve(d.toString().split('\r\n')[0]);
        s.destroy();
      });
    });

  it('forwards requests to allowed targets', async () => {
    const r = await viaProxy(site.url);
    expect(r.status).toBe(200);
  });
  it('refuses plain requests to internal services', async () => {
    const r = await viaProxy(`http://127.0.0.1:${internalPort}/`);
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('secret');
  });
  it('refuses CONNECT tunnels to metadata and loopback addresses', async () => {
    expect(await connect('169.254.169.254:443')).toMatch(/403/);
    expect(await connect(`127.0.0.1:${internalPort}`)).toMatch(/403/);
    expect(await connect('localhost:443')).toMatch(/403/);
  });
});
