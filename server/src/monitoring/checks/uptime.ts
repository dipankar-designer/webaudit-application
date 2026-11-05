// R1 uptime and status, R1 slow response with re-samples, R1b slow redirect, keyword
// present/absent and well-known fatal-error pages.

import type { SafeResponse } from '../../security/safeFetch.js';
import { detectChallenge, monitorFetch, sleep, withRetry } from '../probe.js';
import type { CheckRunner, CheckOutcome } from '../types.js';

const SLOW_TTFB_MS = 3000;
const SLOW_REDIRECT_MS = 1500;

/** Error pages that answer 200 but mean the site is broken for visitors. */
const FATAL_TEXTS: { re: RegExp; label: string }[] = [
  { re: /Error establishing a database connection/i, label: 'WordPress cannot reach its database ("Error establishing a database connection")' },
  { re: /There has been a critical error on (this|your) website/i, label: 'WordPress critical error page' },
  { re: /<b>Fatal error<\/b>:.{0,300} on line <b>\d+<\/b>/i, label: 'PHP fatal error printed on the page' },
  { re: /Briefly unavailable for scheduled maintenance/i, label: 'WordPress maintenance mode is stuck on' },
];

const transient = (r: SafeResponse) => (!!r.failure && r.failure.kind !== 'blocked') || (r.status !== null && r.status >= 500);

export const uptimeCheck: CheckRunner = async ({ monitor, signal }) => {
  const url = monitor.url!;
  const isHome = new URL(url).pathname === '/';
  const downSeverity = monitor.money_page || isHome ? 'p1' : 'p2';
  const fetchPage = () => monitorFetch(url, { signal, maxBytes: 2 * 1024 * 1024 });

  // Three attempts with 2 s / 5 s backoff before calling anything down (build note 2).
  const { result: r, attempts } = await withRetry(fetchPage, transient, { signal });
  const base = { responseMs: r.durationMs, ttfbMs: r.ttfbMs, httpStatus: r.status, attempts };
  const redirectMs = r.redirects.reduce((s, h) => s + h.ms, 0);
  const detail: Record<string, unknown> = {
    finalUrl: r.finalUrl,
    redirects: r.redirects.map((h) => ({ url: h.url, status: h.status, ms: h.ms })),
    redirectMs,
    pageTtfbMs: r.ttfbMs,
  };

  if (r.failure?.kind === 'blocked') return { ...base, status: 'not_assessed', summary: `Not assessed: ${r.failure.message}`, detail };
  const challenge = detectChallenge(r);
  if (challenge.blocked) return { ...base, status: 'not_assessed', summary: `Not assessed: ${challenge.reason}`, detail: { ...detail, blocked: challenge.reason } };

  // Our own time limit stopping the request says nothing about the site: a monitoring error, not "down".
  if (signal.aborted) throw new Error('the check was stopped by its time limit');
  if (r.failure)
    return { ...base, status: 'down', severity: downSeverity, summary: `No response after ${attempts} attempts: ${r.failure.message}`, detail: { ...detail, failure: r.failure } };
  const status = r.status!;
  if (status >= 400) return { ...base, status: 'down', severity: downSeverity, summary: `HTTP ${status} after ${attempts} attempt${attempts === 1 ? '' : 's'}`, detail };

  const body = r.body?.toString('utf8') ?? '';
  for (const f of FATAL_TEXTS)
    if (f.re.test(body)) return { ...base, status: 'down', severity: downSeverity, summary: `HTTP ${status} but the page shows an error: ${f.label}`, detail: { ...detail, fatalText: f.label } };

  if (monitor.keyword && monitor.keyword_mode) {
    const found = body.toLowerCase().includes(monitor.keyword.toLowerCase());
    if (monitor.keyword_mode === 'present' && !found)
      return { ...base, status: 'down', severity: 'p2', summary: `Expected text "${monitor.keyword}" was not found on the page`, detail: { ...detail, keyword: monitor.keyword, keywordMode: 'present' } };
    if (monitor.keyword_mode === 'absent' && found)
      return { ...base, status: 'down', severity: 'p2', summary: `Unwanted text "${monitor.keyword}" appeared on the page`, detail: { ...detail, keyword: monitor.keyword, keywordMode: 'absent' } };
  }

  // Slow page: re-sample twice; a failed re-sample means an intermittent outage (build note 3).
  if (r.ttfbMs !== null && r.ttfbMs > SLOW_TTFB_MS) {
    const samples: { ttfbMs: number | null; ok: boolean; status: number | null }[] = [];
    for (let i = 0; i < 2; i++) {
      await sleep(1000, signal);
      const s = await fetchPage();
      samples.push({ ttfbMs: s.ttfbMs, ok: !s.failure && (s.status ?? 0) < 500, status: s.status });
    }
    if (signal.aborted) throw new Error('the check was stopped by its time limit during a re-sample');
    const failed = samples.find((s) => !s.ok);
    if (failed)
      return { ...base, attempts: attempts + 2, status: 'down', severity: 'p1', summary: `Intermittent outage: first response took ${r.ttfbMs} ms and a re-sample failed (${failed.status ?? 'no response'})`, detail: { ...detail, samples } };
    const best = Math.min(r.ttfbMs, ...samples.map((s) => s.ttfbMs ?? Infinity));
    if (best > SLOW_TTFB_MS)
      return { ...base, attempts: attempts + 2, status: 'warning', severity: 'p3', summary: `Slow response: first byte after ${(best / 1000).toFixed(1)} s (budget 3 s)`, detail: { ...detail, samples } };
    detail.samples = samples;
  }

  // R1b: measure the redirect separately from the page (build note 5).
  if (redirectMs > SLOW_REDIRECT_MS)
    return { ...base, status: 'warning', severity: 'p3', summary: `Slow redirect: ${(redirectMs / 1000).toFixed(1)} s before the page itself (${r.ttfbMs} ms)`, detail };

  const out: CheckOutcome = { ...base, status: 'up', summary: `HTTP ${status} · first byte ${r.ttfbMs} ms${redirectMs ? ` · redirect ${redirectMs} ms` : ''}`, detail };
  return out;
};
