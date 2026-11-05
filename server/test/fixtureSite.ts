// A small local website with known, deliberate defects. Used by the integration tests and for
// manual end-to-end checks (`npx tsx test/fixtureSite.ts 4599`). `setFixed(true)` repairs most
// defects so verification / resolved / reopened behaviour can be tested.

import http from 'node:http';
import zlib from 'node:zlib';
import { PNG } from 'pngjs';
import { pathToFileURL } from 'node:url';

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = 255;
  }
  return PNG.sync.write(img);
}

const BIG = png(2400, 1600, [70, 120, 200]);
const SMALL = png(120, 80, [40, 160, 90]);

export interface FixtureSite {
  url: string;
  port: number;
  setFixed(v: boolean): void;
  setBanner(v: boolean): void;
  /** Monitoring scenarios (see the /__control endpoint for the same switches over HTTP). */
  set(patch: Partial<MonitorState>): void;
  close(): Promise<void>;
}

export interface MonitorState {
  /** Homepage title (defacement canary). */
  title: string;
  /** Extra delay before the homepage responds, in ms. */
  delayMs: number;
  /** Homepage mode: normal, a 503 outage, a bot challenge, or a 200 page showing a database error. */
  mode: 'normal' | 'down' | 'challenge' | 'dberror';
  /** Serve leaked files (.env, .git/HEAD, backup.zip, a directory listing). */
  exposed: boolean;
  /** Answer 200 for unknown URLs (soft 404). */
  soft404: boolean;
  /** Extra third-party script on the homepage. */
  extraScript: boolean;
}

export function startFixtureSite(port = 0): Promise<FixtureSite> {
  const state = { fixed: false, banner: false };
  const mon: MonitorState = { title: 'Fixture home page for scanning tests', delayMs: 0, mode: 'normal', exposed: false, soft404: false, extraScript: false };
  const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]);

  const page = (opts: { lang?: string | null; title?: string | null; head?: string; body: string }) => `<!DOCTYPE html>
<html${opts.lang ? ` lang="${opts.lang}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.title !== null ? `<title>${opts.title ?? 'Fixture page'}</title>` : ''}
${opts.head ?? ''}
<style>body{font-family:sans-serif;margin:0;padding:16px;color:#222;background:#fff} .wide{width:1200px;height:40px;background:#eee}</style>
</head>
<body>
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>
<main>
${state.banner ? '<div style="height:300px;background:#c00;color:#fff">NEW PROMOTION BANNER</div>' : ''}
${opts.body}
</main>
<footer><p>© Fixture Ltd</p></footer>
</body></html>`;

  const routes: Record<string, () => { status: number; type: string; body: string | Buffer; headers?: Record<string, string> }> = {
    '/': () => ({
      status: 200,
      type: 'text/html; charset=utf-8',
      headers: { 'x-powered-by': 'PHP/7.4.3' },
      body: page({
        lang: state.fixed ? 'en' : null,
        title: mon.title,
        head: state.fixed ? '<meta name="description" content="A fixture site used to test the scanner.">' : '',
        body: `${mon.extraScript ? '<script src="https://cdn.skimmer-example.net/x.js"></script>' : ''}<h1>Welcome to the fixture</h1>
<p>Intro text with a <a href="/about">link to about</a>.</p>
${state.fixed ? '' : '<p><a href="/missing-page">A broken link</a></p>'}
<p><a href="/old-about">Old about link (redirects)</a></p>
${state.fixed ? '<img src="/img/small.png" alt="Green box" width="120" height="80">' : '<img src="/img/nope.png" alt="Missing picture">'}
<img src="/img/big.png" ${state.fixed ? 'alt="Blue box"' : ''} style="width:200px">
${state.fixed ? '' : '<div class="wide">This box is 1200px wide</div>'}
${state.fixed ? '' : '<script>window.addEventListener("load",function(){ undefinedFunctionCall(); });</script>'}
${state.fixed ? '' : '<script>console.error("Fixture console error: widget failed to initialise");</script>'}`,
      }),
    }),
    '/about': () => ({
      status: 200,
      type: 'text/html; charset=utf-8',
      body: page({
        lang: 'en',
        title: 'About the fixture company',
        head: `<meta name="description" content="About us page."><link rel="canonical" href="/about">`,
        body: `<h1>About us</h1><h2>History</h2>${state.fixed ? '<h3>Founding</h3>' : '<h4>Founding</h4>'}<p id="dup">One</p><p id="${state.fixed ? 'unique' : 'dup'}">Two</p>
<p><a href="/contact">Contact us</a></p>`,
      }),
    }),
    '/contact': () => ({
      status: 200,
      type: 'text/html; charset=utf-8',
      body: page({
        lang: 'en',
        title: 'Contact the fixture company',
        head: `<meta name="description" content="Contact page."><meta name="robots" content="noindex">
<script type="application/ld+json">${state.fixed ? '{"@context":"https://schema.org","@type":"Organization","name":"Fixture"}' : '{"@context": "https://schema.org", "@type": "Organization", name: Fixture}'}</script>`,
        body: `<h1>Contact</h1>
<form action="/contact" method="post">${state.fixed ? '<label for="email">Email</label>' : ''}<input id="email" type="email" name="email"><button type="submit">Send</button></form>
<p style="color:${state.fixed ? '#333' : '#bbb'};background:#fff">Low contrast note text that is hard to read.</p>
<p><a href="/">Home</a></p>`,
      }),
    }),
    '/old-about': () => ({ status: 301, type: 'text/plain', body: '', headers: { location: '/about' } }),
    // Not linked from any page: a start address that redirects to the home page (discovery tests).
    '/start-redirect': () => ({ status: 301, type: 'text/plain', body: '', headers: { location: '/' } }),
    '/blog': () => ({ status: 500, type: 'text/html', body: '<h1>Internal Server Error</h1>' }),
    '/robots.txt': () => ({ status: 200, type: 'text/plain', body: `User-agent: *\nDisallow: /private/\n\nSitemap: http://${host}/sitemap.xml\n` }),
    '/sitemap.xml': () => ({
      status: 200,
      type: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>http://${host}/</loc></url><url><loc>http://${host}/about</loc></url><url><loc>http://${host}/contact</loc></url>${state.fixed ? '' : `<url><loc>http://${host}/blog</loc></url>`}<url><loc>http://${host}/private/secret</loc></url></urlset>`,
    }),
    '/img/big.png': () => ({ status: 200, type: 'image/png', body: BIG }),
    '/img/small.png': () => ({ status: 200, type: 'image/png', body: SMALL }),
  };

  let host = '';
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/__control') {
      // Test-only switch so a separately running fixture can be repaired/broken between scans.
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      if (q.has('fixed')) state.fixed = q.get('fixed') === '1';
      if (q.has('banner')) state.banner = q.get('banner') === '1';
      if (q.has('title')) mon.title = q.get('title')!;
      if (q.has('delay')) mon.delayMs = Number(q.get('delay'));
      if (q.has('mode')) mon.mode = q.get('mode') as MonitorState['mode'];
      if (q.has('exposed')) mon.exposed = q.get('exposed') === '1';
      if (q.has('soft404')) mon.soft404 = q.get('soft404') === '1';
      if (q.has('extraScript')) mon.extraScript = q.get('extraScript') === '1';
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...state, ...mon }));
    }
    if (path === '/' && mon.mode !== 'normal') {
      setTimeout(() => {
        if (mon.mode === 'down') {
          res.writeHead(503, { 'content-type': 'text/html' });
          return res.end('<h1>Service Unavailable</h1>');
        }
        if (mon.mode === 'challenge') {
          res.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare', 'cf-mitigated': 'challenge' });
          return res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Database Error</title></head><body><h1>Error establishing a database connection</h1></body></html>');
      }, mon.delayMs);
      return;
    }
    if (mon.exposed) {
      const leaks: Record<string, [string, string | Buffer]> = {
        '/.env': ['text/plain', 'APP_ENV=production\nDB_PASSWORD=hunter2\nSECRET_KEY=abc123\n'],
        '/.git/HEAD': ['text/plain', 'ref: refs/heads/main\n'],
        '/backup.zip': ['application/zip', ZIP],
        '/uploads/': ['text/html', '<html><head><title>Index of /uploads</title></head><body><h1>Index of /uploads</h1></body></html>'],
      };
      if (leaks[path]) {
        res.writeHead(200, { 'content-type': leaks[path][0] });
        return res.end(leaks[path][1]);
      }
    }
    if (path === '/go') {
      // Open redirect, used to prove the scanner re-validates redirect targets.
      res.writeHead(302, { location: new URL(req.url ?? '/', 'http://x').searchParams.get('to') ?? '/' });
      return res.end();
    }
    const route = routes[path];
    if (!route && mon.soft404) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!DOCTYPE html><html><head><title>Page</title></head><body><h1>Sorry, nothing here</h1></body></html>');
    }
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!DOCTYPE html><html lang="en"><title>Not found</title><h1>Not found</h1></html>');
    }
    if (path === '/' && mon.delayMs) {
      const r0 = route();
      setTimeout(() => {
        res.writeHead(r0.status, { 'content-type': r0.type, ...(r0.headers ?? {}) });
        res.end(r0.body);
      }, mon.delayMs);
      return;
    }
    const r = route();
    const headers: Record<string, string> = { 'content-type': r.type, ...(r.headers ?? {}) };
    let body = typeof r.body === 'string' ? Buffer.from(r.body) : r.body;
    if (/html/.test(r.type) && /gzip/.test(String(req.headers['accept-encoding'] ?? ''))) {
      body = zlib.gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    res.writeHead(r.status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = (server.address() as { port: number }).port;
      host = `127.0.0.1:${p}`;
      resolve({
        url: `http://${host}/`,
        port: p,
        setFixed: (v) => void (state.fixed = v),
        setBanner: (v) => void (state.banner = v),
        set: (patch) => void Object.assign(mon, patch),
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const site = await startFixtureSite(Number(process.argv[2] ?? 4599));
  console.log(`[fixture] serving ${site.url}`);
}
