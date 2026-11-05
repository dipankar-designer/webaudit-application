// R6 exposed backup archives, R7 directory listing, R8 sensitive files.
// Every hit is confirmed by content (build note 6), the soft-404 behaviour is measured first,
// file contents are never stored, and the sweep only runs with explicit authorisation because
// these requests look like reconnaissance to a firewall (build note 7).

import crypto from 'node:crypto';
import type { Priority } from '@wpcg/shared';
import { detectChallenge, monitorFetch, registrableDomain } from '../probe.js';
import type { CheckRunner } from '../types.js';

type Confirm = (body: Buffer, contentType: string) => boolean;
const text = (b: Buffer) => b.toString('utf8');
const notHtml = (b: Buffer, ct: string) => !/html/i.test(ct) && !/<html|<!doctype/i.test(text(b).slice(0, 500));
const isZip = (b: Buffer) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isGzip = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const isSqlDump: Confirm = (b, ct) => notHtml(b, ct) && /(CREATE TABLE|INSERT INTO|-- MySQL dump|-- PostgreSQL database dump)/i.test(text(b));

interface Probe {
  path: string;
  what: string;
  severity: Priority;
  confirm: Confirm;
}

function probesFor(domain: string): Probe[] {
  const archive: Confirm = (b) => isZip(b) || isGzip(b);
  const backups = ['backup.zip', 'backup.tar.gz', 'backup.tgz', 'site.zip', 'www.zip', 'public_html.zip', 'wordpress.zip', 'html.zip', 'web.zip', `${domain}.zip`, `${domain}.tar.gz`];
  const dumps = ['backup.sql', 'db.sql', 'database.sql', 'dump.sql', 'data.sql', `${domain}.sql`];
  return [
    ...backups.map((p) => ({ path: `/${p}`, what: 'Backup archive', severity: 'p1' as const, confirm: archive })),
    ...dumps.map((p) => ({ path: `/${p}`, what: 'Database dump', severity: 'p1' as const, confirm: isSqlDump })),
    { path: '/.env', what: 'Environment file with settings and secrets', severity: 'p1', confirm: (b, ct) => notHtml(b, ct) && (text(b).match(/^[A-Z][A-Z0-9_]{2,}\s*=.*$/gm) ?? []).length >= 2 },
    { path: '/.git/HEAD', what: 'Git repository metadata', severity: 'p1', confirm: (b) => /^ref: refs\//.test(text(b)) },
    { path: '/.git/config', what: 'Git repository configuration', severity: 'p1', confirm: (b, ct) => notHtml(b, ct) && /\[core\]/.test(text(b)) },
    ...['wp-config.php.bak', 'wp-config.php~', 'wp-config.bak', 'wp-config.php.save', 'wp-config.old', 'wp-config.txt'].map((p) => ({
      path: `/${p}`,
      what: 'WordPress configuration backup (database password)',
      severity: 'p1' as const,
      confirm: (b: Buffer) => /DB_PASSWORD|DB_NAME/.test(text(b)),
    })),
    { path: '/phpinfo.php', what: 'phpinfo() page', severity: 'p1', confirm: (b) => /phpinfo\(\)/.test(text(b)) && /PHP Version/.test(text(b)) },
    { path: '/info.php', what: 'phpinfo() page', severity: 'p1', confirm: (b) => /phpinfo\(\)/.test(text(b)) && /PHP Version/.test(text(b)) },
    { path: '/adminer.php', what: 'Adminer database tool', severity: 'p1', confirm: (b) => /Adminer/.test(text(b)) && /(Login|Server|Username)/i.test(text(b)) },
    { path: '/debug.log', what: 'PHP debug log', severity: 'p1', confirm: (b, ct) => notHtml(b, ct) && /PHP (Fatal error|Warning|Notice|Deprecated)/.test(text(b)) },
    { path: '/wp-content/debug.log', what: 'WordPress debug log', severity: 'p1', confirm: (b, ct) => notHtml(b, ct) && /PHP (Fatal error|Warning|Notice|Deprecated)/.test(text(b)) },
    { path: '/id_rsa', what: 'Private SSH key', severity: 'p1', confirm: (b) => /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text(b)) },
    { path: '/.htpasswd', what: 'Password file', severity: 'p1', confirm: (b, ct) => notHtml(b, ct) && /^[^:\s<]+:\S{8,}$/m.test(text(b)) },
    { path: '/.DS_Store', what: 'macOS folder index (lists files)', severity: 'p3', confirm: (b) => b.length > 8 && b.subarray(4, 8).toString('latin1') === 'Bud1' },
    ...['/wp-content/uploads/', '/wp-content/plugins/', '/wp-includes/', '/uploads/', '/backup/', '/backups/', '/files/', '/images/'].map((p) => ({
      path: p,
      what: 'Directory listing',
      severity: 'p2' as const,
      confirm: (b: Buffer) => /<title>\s*Index of \//i.test(text(b)),
    })),
  ];
}

export const exposureCheck: CheckRunner = async ({ monitor, signal }) => {
  if (!monitor.exposure_authorised_at)
    return { status: 'not_assessed', summary: 'Not assessed: exposed-file probes need your authorisation in the monitor settings (they look like attacks to a firewall).' };
  const origin = new URL(monitor.url!).origin;
  const domain = registrableDomain(new URL(origin).hostname).split('.')[0];

  // Soft-404 detection first: does the site answer 200 for any URL?
  const random = await monitorFetch(`${origin}/wpcg-${crypto.randomBytes(6).toString('hex')}.txt`, { signal, maxBytes: 16 * 1024, readBody: () => true });
  if (random.failure) return { status: 'not_assessed', summary: `Not assessed: ${random.failure.message}` };
  if (detectChallenge(random).blocked) return { status: 'not_assessed', summary: `Not assessed: ${detectChallenge(random).reason}` };
  const soft404 = random.status === 200;

  const hits: { path: string; what: string; severity: Priority; bytesRead: number; status: number | null }[] = [];
  let blocked = 0;
  const probes = probesFor(domain);
  for (const p of probes) {
    const r = await monitorFetch(`${origin}${p.path}`, { signal, maxBytes: 16 * 1024, maxRedirects: 0, readBody: () => true });
    if (detectChallenge(r).blocked) {
      blocked++;
      continue;
    }
    if (r.status !== 200 || !r.body) continue;
    if (p.confirm(r.body, r.headers['content-type'] ?? '')) hits.push({ path: p.path, what: p.what, severity: p.severity, bytesRead: r.body.length, status: r.status });
  }
  const detail = { checkedPaths: probes.length, soft404, blockedByFirewall: blocked, hits, note: 'File contents are never stored; only the path and the matched signature.' };
  if (blocked === probes.length) return { status: 'not_assessed', summary: 'Not assessed: the firewall blocked every probe', detail };
  if (!hits.length)
    return { status: 'up', summary: `No exposed files among ${probes.length} common paths${soft404 ? ' (the site answers 200 for unknown URLs; every candidate was content-checked)' : ''}${blocked ? `; ${blocked} probe(s) blocked` : ''}`, detail };
  const severity = (['p1', 'p2', 'p3', 'p4'] as Priority[]).find((s) => hits.some((h) => h.severity === s))!;
  return { status: 'warning', severity, summary: `Publicly readable: ${hits.map((h) => `${h.path} (${h.what})`).join(', ')}`, detail };
};
