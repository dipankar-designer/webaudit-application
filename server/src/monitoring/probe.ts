// Shared plumbing for monitoring checks: polite per-host pacing, bot-challenge detection
// (the R0 honesty rule) and retry with backoff.

import { safeFetch, type SafeFetchOptions, type SafeResponse } from '../security/safeFetch.js';

// ---------------------------------------------------------------- pacing (build note 8)

const HOST_GAP_MS = 250;
const nextSlot = new Map<string, number>();

/** Waits so requests to one host are at least 250 ms apart, across all concurrent checks. */
export async function paceHost(host: string, signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + HOST_GAP_MS);
  if (nextSlot.size > 5000) for (const [h, t] of nextSlot) if (t < now) nextSlot.delete(h);
  if (slot > now) await sleep(slot - now, signal);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** safeFetch with host pacing, a fresh connection (honest timings) and the monitoring user agent. */
export async function monitorFetch(url: string | URL, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const u = new URL(String(url));
  await paceHost(u.hostname, opts.signal);
  return safeFetch(u, { freshConnection: true, timeoutMs: 30_000, ...opts });
}

// ---------------------------------------------------------------- R0: blocked is not broken

export interface ChallengeVerdict {
  blocked: boolean;
  reason: string;
}

/**
 * Detects firewall blocks and bot challenges (Cloudflare, Sucuri, Wordfence, generic WAF 403s).
 * Such responses mean "not assessed": never a pass, never a failure, never a baseline.
 */
export function detectChallenge(res: SafeResponse): ChallengeVerdict {
  if (res.status === null) return { blocked: false, reason: '' };
  const h = res.headers;
  const body = res.body ? res.body.subarray(0, 64 * 1024).toString('utf8') : '';
  const server = (h.server ?? '').toLowerCase();
  if (h['cf-mitigated'] === 'challenge') return { blocked: true, reason: 'Cloudflare served a bot challenge (cf-mitigated: challenge).' };
  if (/<title>\s*(Just a moment|Attention Required!|Please Wait\.\.\.)/i.test(body) || /cf-chl-|challenge-platform/i.test(body))
    return { blocked: true, reason: 'A bot challenge page was served instead of the site.' };
  if (/Sucuri WebSite Firewall|Access Denied - Sucuri/i.test(body)) return { blocked: true, reason: 'The Sucuri firewall blocked the request.' };
  if (/Wordfence|Your access to this site has been limited/i.test(body)) return { blocked: true, reason: 'The Wordfence firewall blocked the request.' };
  if (res.status === 202 && server.includes('cloudflare')) return { blocked: true, reason: 'Cloudflare answered 202 (challenge in progress).' };
  if (res.status === 403 || res.status === 401 || res.status === 429 || res.status === 407)
    return { blocked: true, reason: `The server refused the monitor (HTTP ${res.status}). This often means a firewall, rate limit or login wall; real visitors may not be affected.` };
  return { blocked: false, reason: '' };
}

// ---------------------------------------------------------------- retries (build note 2)

/**
 * Runs `attempt` up to `tries` times with backoff while `shouldRetry` says the result is
 * transient. Returns the last result and how many attempts were made.
 */
export async function withRetry<T>(attempt: () => Promise<T>, shouldRetry: (r: T) => boolean, opts: { tries?: number; backoffMs?: number[]; signal?: AbortSignal } = {}): Promise<{ result: T; attempts: number }> {
  const tries = opts.tries ?? 3;
  const backoff = opts.backoffMs ?? [2000, 5000];
  let result = await attempt();
  let attempts = 1;
  while (attempts < tries && shouldRetry(result)) {
    await sleep(backoff[Math.min(attempts - 1, backoff.length - 1)], opts.signal);
    result = await attempt();
    attempts++;
  }
  return { result, attempts };
}

export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** Registrable domain for DNS/RDAP lookups (handles common two-level public suffixes). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const twoLevel = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'co.in', 'gov.ie', 'co.jp', 'com.sg', 'com.mx']);
  const lastTwo = labels.slice(-2).join('.');
  return twoLevel.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}
