// Filtering forward proxy for the headless browser.
//
// Chrome is launched with --proxy-server pointing here (Playwright also forces
// loopback traffic through the proxy), so every request a scanned page makes —
// navigations, sub-resources, redirects, fetch/XHR — is resolved and checked by
// this process. The proxy connects to the exact address it validated, so DNS
// rebinding cannot swap in an internal address after the check.

import http from 'node:http';
import net from 'node:net';
import { BlockedTargetError, assertHostAllowed, guardedLookup } from './ssrf.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface EgressProxy {
  url: string;
  stats: { allowed: number; blocked: number; lastBlocked: string[] };
  close(): Promise<void>;
}

function lookupAsync(host: string): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    guardedLookup(host, {}, (err, address, family) => (err ? reject(err) : resolve({ address: address as string, family: family ?? 4 })));
  });
}

export async function startEgressProxy(): Promise<EgressProxy> {
  const stats = { allowed: 0, blocked: 0, lastBlocked: [] as string[] };
  const noteBlocked = (target: string) => {
    stats.blocked++;
    stats.lastBlocked.push(target);
    if (stats.lastBlocked.length > 20) stats.lastBlocked.shift();
  };
  // No proxy credentials: the proxy only ever narrows what a local process could reach directly,
  // and it listens on loopback only. (Chrome launched by Lighthouse cannot answer auth challenges.)

  const server = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if (target.protocol !== 'http:') throw new BlockedTargetError('Only http is proxied without CONNECT.');
      assertHostAllowed(target.hostname, Number(target.port || 80));
    } catch (e) {
      noteBlocked(String(req.url).slice(0, 200));
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end(e instanceof Error ? e.message : 'Blocked');
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    const upstream = http.request(
      { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers, lookup: guardedLookup as never },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.setTimeout(60000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'EBLOCKEDTARGET') noteBlocked(target.host);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end();
    });
    stats.allowed++;
    req.pipe(upstream);
  });

  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const m = String(req.url ?? '').match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const host = m[1];
    const port = Number(m[2]);
    try {
      assertHostAllowed(host, port);
      const { address } = await lookupAsync(host);
      // No Nagle on either side of the tunnel: TLS and HTTP/2 send many small records, and holding them
      // back for delayed ACKs (up to 200 ms on Windows) inflated every timing Lighthouse measured.
      client.setNoDelay(true);
      const upstream = net.connect({ host: address, port, noDelay: true }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.setTimeout(60000, () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      stats.allowed++;
    } catch {
      noteBlocked(`${host}:${port}`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });

  // Plain ws:// upgrades are not needed for auditing; refuse them rather than tunnelling unchecked.
  server.on('upgrade', (_req, socket: net.Socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));

  // Track raw sockets: CONNECT tunnels are detached from the HTTP server and would keep close() waiting.
  const sockets = new Set<net.Socket>();
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
