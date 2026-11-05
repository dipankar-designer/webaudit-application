// R20 mail DNS (MX, SPF, DMARC), CAA, and DNS change alerts (A, AAAA, MX, NS).
// Queries go to public resolvers so results do not depend on the server's local DNS.

import { Resolver } from 'node:dns/promises';
import type { Priority } from '@wpcg/shared';
import { registrableDomain } from '../probe.js';
import type { CheckRunner } from '../types.js';

const resolver = new Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

const NO_DATA = new Set(['ENODATA', 'ENOTFOUND', 'ENONAME']);

/** Runs a lookup; "no records" becomes [], resolver failures throw. */
async function lookup<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    if (NO_DATA.has((e as NodeJS.ErrnoException).code ?? '')) return [];
    throw e;
  }
}

export const dnsCheck: CheckRunner = async ({ monitor, baseline }) => {
  const host = new URL(monitor.url!).hostname;
  const domain = registrableDomain(host);
  let records: { a: string[]; aaaa: string[]; mx: string[]; ns: string[]; spf: string[]; dmarc: string[]; caa: string[] };
  try {
    const [a, aaaa, mx, ns, txt, dmarc, caa] = await Promise.all([
      lookup(() => resolver.resolve4(host)),
      lookup(() => resolver.resolve6(host)),
      lookup(() => resolver.resolveMx(domain)),
      lookup(() => resolver.resolveNs(domain)),
      lookup(() => resolver.resolveTxt(domain)),
      lookup(() => resolver.resolveTxt(`_dmarc.${domain}`)),
      lookup(() => resolver.resolveCaa(domain)),
    ]);
    const flat = (t: string[][]) => t.map((parts) => parts.join(''));
    records = {
      a: a.sort(),
      aaaa: aaaa.sort(),
      mx: mx.map((m) => `${m.priority} ${m.exchange.toLowerCase()}`).sort(),
      ns: ns.map((n) => n.toLowerCase()).sort(),
      spf: flat(txt).filter((t) => /^v=spf1/i.test(t)),
      dmarc: flat(dmarc).filter((t) => /^v=DMARC1/i.test(t)),
      caa: caa.map((c) => Object.entries(c).filter(([k]) => k !== 'critical').map(([k, v]) => `${k} ${v}`).join(' ')).sort(),
    };
  } catch (e) {
    return { status: 'not_assessed', summary: `Not assessed: DNS lookup failed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
  }

  const findings: { severity: Priority; text: string }[] = [];
  if (!records.mx.length) findings.push({ severity: 'p3', text: `No MX record for ${domain} (fine only if the domain never receives e-mail)` });
  if (!records.spf.length) findings.push({ severity: 'p3', text: 'No SPF record' });
  else if (records.spf.length > 1) findings.push({ severity: 'p3', text: 'More than one SPF record (receivers treat this as an error)' });
  else if (/\+all\b/i.test(records.spf[0])) findings.push({ severity: 'p3', text: 'SPF ends in +all, which lets anyone send as this domain' });
  if (!records.dmarc.length) findings.push({ severity: 'p3', text: 'No DMARC record' });
  else if (/\bp=none\b/i.test(records.dmarc[0])) findings.push({ severity: 'p3', text: 'DMARC policy is p=none (monitoring only; spoofed mail is still delivered)' });
  if (!records.caa.length) findings.push({ severity: 'p4', text: 'No CAA record (any certificate authority may issue certificates)' });

  // Change detection on the records that move a site or its mail.
  const tracked = { a: records.a, aaaa: records.aaaa, mx: records.mx, ns: records.ns };
  const prev = baseline as typeof tracked | null;
  const changes: string[] = [];
  if (prev) for (const k of Object.keys(tracked) as (keyof typeof tracked)[]) if (JSON.stringify(prev[k] ?? []) !== JSON.stringify(tracked[k])) changes.push(`${k.toUpperCase()}: ${(prev[k] ?? []).join(', ') || '(none)'} → ${tracked[k].join(', ') || '(none)'}`);
  if (changes.length) findings.unshift({ severity: 'p2', text: `DNS records changed: ${changes.join('; ')}` });

  const detail = { domain, host, records, changes };
  if (!findings.length) return { status: 'up', summary: 'MX, SPF, DMARC and CAA in place; no record changes', detail, baseline: tracked };
  const severity = (['p1', 'p2', 'p3', 'p4'] as Priority[]).find((p) => findings.some((f) => f.severity === p))!;
  return { status: 'warning', severity, summary: findings.map((f) => f.text).join('. '), detail, baseline: tracked, event: changes.length > 0 && findings.length === 1 };
};
