// EXP domain expiry: RDAP via rdap.org (follows the registry's RDAP server), with a port-43
// WHOIS fallback for registries without RDAP (.ie). Also reports a missing transfer lock.

import net from 'node:net';
import type { Priority } from '@wpcg/shared';
import { guardedLookup } from '../../security/ssrf.js';
import { monitorFetch, registrableDomain } from '../probe.js';
import type { CheckRunner, CheckOutcome } from '../types.js';

/** Registries known not to publish RDAP, with their WHOIS servers. */
const WHOIS_SERVERS: Record<string, string> = { ie: 'whois.weare.ie', eu: 'whois.eu' };

export function whoisQuery(server: string, query: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = net.connect({ host: server, port: 43, lookup: guardedLookup as never, timeout: timeoutMs }, () => sock.write(`${query}\r\n`));
    sock.on('data', (c: Buffer) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 256 * 1024) sock.destroy();
    });
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('timeout', () => sock.destroy(new Error('WHOIS timed out')));
    sock.on('error', reject);
  });
}

/** Parses an expiry date from common WHOIS layouts. */
export function parseWhoisExpiry(text: string): Date | null {
  const m = text.match(/^\s*(?:Registry Expiry Date|Expiry Date|Expiration Date|Renewal Date|paid-till|Expires On)\s*:\s*(.+)$/im);
  if (!m) return null;
  const raw = m[1].trim();
  const d = new Date(raw.replace(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/, '$2 $1 $3'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function verdict(domain: string, expiry: Date, source: string, statuses: string[] | null): CheckOutcome {
  const days = Math.floor((expiry.getTime() - Date.now()) / 86_400_000);
  const detail = { domain, expiresAt: expiry.toISOString(), daysLeft: days, source, statuses };
  const lockMissing = statuses !== null && !statuses.some((s) => /transfer ?prohibited/i.test(s));
  let severity: Priority | null = null;
  let summary = `${domain} is registered until ${expiry.toISOString().slice(0, 10)} (${days} days)`;
  if (days < 0) [severity, summary] = ['p1', `${domain} registration expired ${-days} day(s) ago`];
  else if (days < 14) [severity, summary] = ['p1', `${domain} expires in ${days} day(s)`];
  else if (days < 30) [severity, summary] = ['p2', `${domain} expires in ${days} days`];
  else if (days < 60) [severity, summary] = ['p3', `${domain} expires in ${days} days`];
  if (lockMissing) {
    summary += '. No registrar transfer lock is set (clientTransferProhibited)';
    severity ??= 'p3';
  }
  if (!severity) return { status: 'up', summary, detail };
  return { status: days < 0 ? 'down' : 'warning', severity, summary, detail };
}

export const domainCheck: CheckRunner = async ({ monitor, signal }) => {
  const domain = registrableDomain(new URL(monitor.url!).hostname);
  const tld = domain.split('.').pop()!;

  if (WHOIS_SERVERS[tld]) {
    try {
      const text = await whoisQuery(WHOIS_SERVERS[tld], domain);
      const expiry = parseWhoisExpiry(text);
      if (!expiry) return { status: 'not_assessed', summary: `Not assessed: the .${tld} WHOIS answer did not include an expiry date`, detail: { domain, source: WHOIS_SERVERS[tld] } };
      const statuses = [...text.matchAll(/^\s*Domain Status:\s*(\S+)/gim)].map((m) => m[1]);
      return verdict(domain, expiry, `WHOIS ${WHOIS_SERVERS[tld]}`, statuses.length ? statuses : null);
    } catch (e) {
      return { status: 'not_assessed', summary: `Not assessed: WHOIS lookup failed (${(e as Error).message})`, detail: { domain } };
    }
  }

  const res = await monitorFetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    signal,
    maxBytes: 512 * 1024,
    readBody: () => true,
    headers: { accept: 'application/rdap+json, application/json' },
  });
  if (res.status === 404) return { status: 'not_assessed', summary: `Not assessed: the registry for .${tld} does not publish ${domain} over RDAP`, detail: { domain } };
  if (res.failure || !res.body || (res.status ?? 0) >= 400) return { status: 'not_assessed', summary: `Not assessed: RDAP lookup failed (${res.failure?.message ?? `HTTP ${res.status}`})`, detail: { domain } };
  try {
    const data = JSON.parse(res.body.toString('utf8')) as { events?: { eventAction: string; eventDate: string }[]; status?: string[] };
    const exp = data.events?.find((e) => e.eventAction === 'expiration');
    if (!exp) return { status: 'not_assessed', summary: 'Not assessed: the registry does not publish an expiry date', detail: { domain, statuses: data.status } };
    return verdict(domain, new Date(exp.eventDate), `RDAP (${new URL(res.finalUrl).hostname})`, data.status ?? null);
  } catch {
    return { status: 'not_assessed', summary: 'Not assessed: the RDAP answer could not be read', detail: { domain } };
  }
};
