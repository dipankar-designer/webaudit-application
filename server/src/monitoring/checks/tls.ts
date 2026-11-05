// R2 TLS certificate: full handshake with chain validation, three attempts with backoff.
// "The certificate is bad" (P1) is kept separate from "could not connect" (not assessed),
// because a dropped connection makes Node report errors that look like certificate faults.

import tls from 'node:tls';
import { assertHostAllowed, guardedLookup } from '../../security/ssrf.js';
import { paceHost, withRetry } from '../probe.js';
import type { CheckRunner } from '../types.js';

interface Handshake {
  ok: boolean;
  connectError?: string;
  connectCode?: string;
  authorized?: boolean;
  authorizationError?: string | null;
  identityError?: string | null;
  protocol?: string | null;
  validTo?: string;
  validFrom?: string;
  issuer?: string;
  subject?: string;
  altNames?: string;
}

const CONNECT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ESOCKETTIMEDOUT']);

function handshake(host: string, port: number): Promise<Handshake> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (h: Handshake) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(h);
    };
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: false, // inspect the certificate ourselves
      lookup: guardedLookup as never,
      timeout: 15000,
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true);
      const identity = cert && Object.keys(cert).length ? tls.checkServerIdentity(host, cert) : new Error('No certificate presented');
      finish({
        ok: true,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        identityError: identity ? identity.message : null,
        protocol: socket.getProtocol(),
        validTo: cert?.valid_to,
        validFrom: cert?.valid_from,
        issuer: cert?.issuer ? [cert.issuer.O, cert.issuer.CN].filter(Boolean).join(' / ') : undefined,
        subject: cert?.subject?.CN ? String(cert.subject.CN) : undefined,
        altNames: cert?.subjectaltname?.slice(0, 500),
      });
    });
    socket.once('timeout', () => finish({ ok: false, connectError: 'TLS handshake timed out', connectCode: 'ETIMEDOUT' }));
    socket.once('error', (e: NodeJS.ErrnoException) => finish({ ok: false, connectError: e.message.split('\n')[0], connectCode: e.code }));
  });
}

export const tlsCheck: CheckRunner = async ({ monitor, signal }) => {
  const u = new URL(monitor.url!);
  const host = u.hostname;
  const port = u.protocol === 'https:' && u.port ? Number(u.port) : 443;
  try {
    assertHostAllowed(host, port);
  } catch (e) {
    return { status: 'not_assessed', summary: `Not assessed: ${(e as Error).message}` };
  }
  const started = Date.now();
  const { result: h, attempts } = await withRetry(
    async () => {
      await paceHost(host, signal);
      return handshake(host, port);
    },
    (r) => !r.ok && CONNECT_CODES.has(r.connectCode ?? ''),
    { signal },
  );
  const responseMs = Date.now() - started;

  if (!h.ok) {
    const code = h.connectCode ?? '';
    // Protocol-level refusals are about the server's TLS setup, not connectivity.
    if (/EPROTO|ERR_SSL|WRONG_VERSION|UNSUPPORTED_PROTOCOL|ALERT/i.test(code + h.connectError))
      return { status: 'warning', severity: 'p2', attempts, responseMs, summary: `TLS handshake rejected: ${h.connectError} (the server may only offer TLS below 1.2 or no HTTPS at all)`, detail: { code } };
    if (code === 'ECONNREFUSED') return { status: 'not_assessed', attempts, responseMs, summary: `Not assessed: nothing is listening for HTTPS on port ${port}. See the HTTPS watcher.`, detail: { code } };
    return { status: 'not_assessed', attempts, responseMs, summary: `Not assessed: could not complete a TLS connection after ${attempts} attempts (${h.connectError}). Investigate if this persists.`, detail: { code } };
  }

  const detail = { protocol: h.protocol, issuer: h.issuer, subject: h.subject, validFrom: h.validFrom, validTo: h.validTo, altNames: h.altNames, authorizationError: h.authorizationError };
  const expires = h.validTo ? Date.parse(h.validTo) : NaN;
  const daysLeft = Number.isFinite(expires) ? Math.floor((expires - Date.now()) / 86_400_000) : null;
  const common = { attempts, responseMs, detail: { ...detail, daysLeft } };

  if (daysLeft !== null && daysLeft < 0) return { ...common, status: 'down', severity: 'p1', summary: `Certificate expired ${-daysLeft} day(s) ago (${h.validTo})` };
  if (h.authorizationError && h.authorizationError !== 'CERT_HAS_EXPIRED')
    return { ...common, status: 'down', severity: 'p1', summary: `Certificate not trusted: ${h.authorizationError}` };
  if (h.identityError) return { ...common, status: 'down', severity: 'p1', summary: `Certificate does not match ${host}: ${h.identityError}` };
  if (h.protocol && /^TLSv1(\.1)?$/.test(h.protocol)) return { ...common, status: 'warning', severity: 'p2', summary: `Server negotiated ${h.protocol}; TLS 1.2 or newer is required` };
  if (daysLeft !== null && daysLeft < 14) return { ...common, status: 'warning', severity: 'p2', summary: `Certificate expires in ${daysLeft} day(s) (${h.validTo})` };
  return { ...common, status: 'up', summary: `Valid ${h.protocol} certificate from ${h.issuer ?? 'unknown issuer'}, expires in ${daysLeft} days` };
};

