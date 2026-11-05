// SSRF protection: decides which URLs and IP addresses the scanner may contact.
//
// The rule that matters most is "validate the address we actually connect to".
// Every outbound connection made by the scanner (Node HTTP requests and the
// browser, via the filtering proxy) resolves DNS through `guardedLookup`, which
// rejects internal addresses at connect time. That closes DNS rebinding and
// redirect-based bypasses, because there is no gap between checking an address
// and using it.

import dns from 'node:dns';
import net from 'node:net';
import { config } from '../config.js';

export class BlockedTargetError extends Error {
  code = 'BLOCKED_TARGET';
  constructor(message: string) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

const blockedV4 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blockedV4.addSubnet(addr, prefix, 'ipv4');
}

// IPv6 is handled as an allowlist: only global unicast (2000::/3) is permitted,
// minus the special-purpose blocks inside it.
const globalUnicastV6 = new net.BlockList();
globalUnicastV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new net.BlockList();
for (const [addr, prefix] of [
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 — embeds an IPv4 address we cannot vet
  ['3fff::', 20], // documentation
] as const) {
  blockedV6.addSubnet(addr, prefix, 'ipv6');
}

/** True when the address is loopback, private, link-local, reserved or otherwise not public. */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blockedV4.check(ip, 'ipv4');
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / NAT64 forms carry an IPv4 address: judge that address.
    const mapped = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:')) return true;
    if (!globalUnicastV6.check(lower, 'ipv6')) return true;
    return blockedV6.check(lower, 'ipv6');
  }
  return true; // not an IP at all
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp', '.localdomain'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default']);
export const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

function allowlisted(host: string, port?: number): boolean {
  const list = config.privateTargetAllowlist;
  if (list.size === 0) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (list.has(h)) return true;
  if (port !== undefined) return list.has(`${h}:${port}`);
  // DNS-level check (no port known): the port is enforced separately on every request.
  for (const entry of list) if (entry.startsWith(`${h}:`)) return true;
  return false;
}

/** Host-level check that does not need DNS (used for every hop and every proxy request). */
export function assertHostAllowed(hostname: string, port: number): void {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (allowlisted(host, port)) return;
  if (!host) throw new BlockedTargetError('The URL has no host name.');
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedTargetError(`"${host}" is an internal or reserved host name and cannot be scanned.`);
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new BlockedTargetError(`${host} is a private, loopback, link-local or reserved address and cannot be scanned.`);
  }
  if (!net.isIP(host) && !host.includes('.')) {
    throw new BlockedTargetError(`"${host}" is not a public, fully qualified host name.`);
  }
  if (!ALLOWED_PORTS.has(port)) {
    throw new BlockedTargetError(`Port ${port} is not allowed. Only ports 80, 443, 8080 and 8443 can be scanned.`);
  }
}

export function effectivePort(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

/**
 * Parse and check a user-supplied or discovered URL without touching the network.
 * Returns a normalised URL (no credentials, no fragment).
 */
export function validateScanUrl(input: string): URL {
  let raw = String(input ?? '').trim();
  if (!raw) throw new BlockedTargetError('Enter a website address, for example https://example.com');
  if (raw.length > 2048) throw new BlockedTargetError('That URL is too long.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedTargetError('That does not look like a valid web address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BlockedTargetError('Only http:// and https:// addresses can be scanned.');
  }
  if (u.username || u.password) {
    throw new BlockedTargetError('Addresses containing a username or password are not accepted.');
  }
  assertHostAllowed(u.hostname, effectivePort(u));
  u.hash = '';
  return u;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * Drop-in replacement for dns.lookup that refuses internal addresses.
 * A host that resolves to any blocked address is rejected outright.
 */
export function guardedLookup(hostname: string, options: dns.LookupOptions | number | LookupCallback, callback?: LookupCallback): void {
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
  const opts: dns.LookupOptions = typeof options === 'object' && options ? options : {};
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  dns.lookup(host, { all: true, verbatim: true, family: opts.family }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = addresses as dns.LookupAddress[];
    if (!list.length) return cb(Object.assign(new Error(`No addresses for ${host}`), { code: 'ENOTFOUND' }), '');
    if (!allowlisted(host)) {
      const bad = list.find((a) => isBlockedIp(a.address));
      if (bad) {
        const e = new BlockedTargetError(`${host} resolves to ${bad.address}, which is a private or reserved address.`);
        return cb(Object.assign(e, { code: 'EBLOCKEDTARGET' }) as unknown as NodeJS.ErrnoException, '');
      }
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

/** Resolve a host once and report whether it is public (used for pre-flight validation and UI messages). */
export async function resolvePublic(hostname: string, port: number): Promise<string[]> {
  assertHostAllowed(hostname, port);
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return [host];
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new BlockedTargetError(
      code === 'ENOTFOUND' || code === 'ENODATA'
        ? `The domain "${host}" could not be found. Check the spelling, or that DNS is set up.`
        : `The domain "${host}" could not be resolved (${code ?? 'DNS error'}).`,
    );
  }
  if (!allowlisted(host)) {
    const bad = addrs.find((a) => isBlockedIp(a.address));
    if (bad) throw new BlockedTargetError(`${host} resolves to ${bad.address}, a private or reserved address, so it cannot be scanned.`);
  }
  return addrs.map((a) => a.address);
}
