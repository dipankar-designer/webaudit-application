// Link checking. Each unique target URL is requested once (HEAD, then GET when HEAD is not
// supported) with per-host concurrency limits; repeated targets are grouped into one issue
// that lists every page linking to them.

import type { EvidenceItem } from '@wpcg/shared';
import { config } from '../../config.js';
import { safeFetch, type SafeResponse } from '../../security/safeFetch.js';
import { BlockedTargetError, validateScanUrl } from '../../security/ssrf.js';
import { R } from '../rules.js';
import type { RawFinding } from '../types.js';

export interface LinkCheckInput {
  /** target URL → pages that link to it (with the link text seen on that page) */
  targets: Map<string, { pageUrl: string; text: string }[]>;
  /** Results already known from page fetches (internal pages that were scanned). */
  known: Map<string, SafeResponse>;
  siteHosts: string[];
  /** Pages whose links were collected (coverage is reported for these). */
  pages: string[];
  checkExternal: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface LinkCheckOutput {
  findings: RawFinding[];
  checked: number;
  skippedExternal: number;
  skippedOverLimit: number;
  blocked: number;
  /**
   * Pages whose links of each kind all got a definitive result (used for coverage). Internal and
   * external links are tracked separately so a scan with external checking off never resolves
   * an external-link issue.
   */
  covered: { internal: Set<string>; external: Set<string> };
}

function hostOf(u: string) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function checkOne(url: string, signal?: AbortSignal): Promise<SafeResponse> {
  const head = await safeFetch(url, { method: 'HEAD', timeoutMs: 15000, signal });
  // Many servers mishandle HEAD; retry with GET (body not read beyond headers for non-text).
  if (head.status !== null && [400, 403, 405, 406, 429, 500, 501, 503].includes(head.status)) {
    return safeFetch(url, { method: 'GET', timeoutMs: 15000, maxBytes: 256 * 1024, signal, readBody: () => false });
  }
  if (head.failure && head.failure.kind !== 'blocked' && head.failure.kind !== 'dns') {
    return safeFetch(url, { method: 'GET', timeoutMs: 15000, maxBytes: 256 * 1024, signal, readBody: () => false });
  }
  return head;
}

export async function checkLinks(input: LinkCheckInput): Promise<LinkCheckOutput> {
  const findings: RawFinding[] = [];
  const results = new Map<string, SafeResponse | 'blocked'>();
  let skippedExternal = 0;
  let blocked = 0;

  const all = [...input.targets.keys()];
  const internal = all.filter((u) => input.siteHosts.includes(hostOf(u)));
  const external = all.filter((u) => !input.siteHosts.includes(hostOf(u)));
  if (!input.checkExternal) skippedExternal = external.length;
  const queue = [...internal, ...(input.checkExternal ? external : [])];
  const limited = queue.slice(0, config.LINK_CHECK_MAX);
  const skippedOverLimit = queue.length - limited.length;

  for (const u of limited) {
    const k = input.known.get(u);
    if (k) results.set(u, k);
  }
  const todo = limited.filter((u) => !results.has(u));

  // Per-host limit of 2 concurrent requests, global limit from config.
  const perHost = new Map<string, number>();
  let done = 0;
  let idx = 0;
  const worker = async () => {
    for (;;) {
      if (input.signal?.aborted) return;
      let pick = -1;
      for (let i = idx; i < todo.length; i++) {
        const h = hostOf(todo[i]);
        if ((perHost.get(h) ?? 0) < 2 && !results.has(todo[i])) {
          pick = i;
          break;
        }
      }
      if (pick < 0) {
        if (todo.slice(idx).every((u) => results.has(u))) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const url = todo[pick];
      results.set(url, 'blocked'); // placeholder so no other worker takes it
      if (pick === idx) while (idx < todo.length && results.has(todo[idx])) idx++;
      const h = hostOf(url);
      perHost.set(h, (perHost.get(h) ?? 0) + 1);
      try {
        validateScanUrl(url);
        results.set(url, await checkOne(url, input.signal));
      } catch (e) {
        if (e instanceof BlockedTargetError) {
          blocked++;
          results.set(url, 'blocked');
        } else throw e;
      } finally {
        perHost.set(h, (perHost.get(h) ?? 1) - 1);
        done++;
        input.onProgress?.(done, todo.length);
      }
    }
  };
  await Promise.all(Array.from({ length: config.LINK_CHECK_CONCURRENCY }, worker));

  // No definite answer (refused, rate-limited, timed out): the linking pages do not count as re-checked,
  // so an open broken-link issue is not "resolved" just because this run could not tell.
  const indefinite = (r: SafeResponse | 'blocked' | undefined) =>
    r === undefined || r === 'blocked' || (r.failure ? !['dns', 'too_many_redirects'].includes(r.failure.kind) : [401, 403, 407, 429].includes(r.status ?? 0));
  const unchecked = new Set(queue.filter((u) => indefinite(results.get(u))));
  for (const [url, res] of results) {
    if (res === 'blocked') continue;
    const sources = input.targets.get(url) ?? [];
    const isInternal = input.siteHosts.includes(hostOf(url));
    const pagesEv: EvidenceItem = {
      label: `Linked from ${sources.length} page(s)`,
      value: sources.slice(0, 15).map((s) => `${s.pageUrl}${s.text ? `   (link text: "${s.text}")` : ''}`).join('\n'),
    };
    const statusEv: EvidenceItem = res.failure
      ? { label: 'Result', value: `${res.failure.message}${res.failure.code ? ` (${res.failure.code})` : ''}` }
      : { label: 'Result', value: `HTTP ${res.status}${res.finalUrl !== url ? ` after redirect to ${res.finalUrl}` : ''}` };

    let rule: RawFinding['rule'] | null = null;
    let status: RawFinding['status'];
    const s = res.status ?? 0;
    if (res.failure) {
      if (res.failure.kind === 'dns') rule = isInternal ? R.brokenInternalLink : R.brokenExternalLink;
      else if (res.failure.kind === 'blocked') continue;
      else if (res.failure.kind === 'too_many_redirects') rule = isInternal ? R.brokenInternalLink : R.brokenExternalLink;
      else {
        rule = R.linkUnverifiable;
        status = 'inconclusive';
      }
    } else if (s === 404 || s === 410 || (s >= 500 && s < 600) || (s >= 400 && s < 500 && ![401, 403, 407, 429].includes(s))) {
      rule = isInternal ? R.brokenInternalLink : R.brokenExternalLink;
    } else if ([401, 403, 407, 429].includes(s)) {
      rule = R.linkUnverifiable;
      status = 'inconclusive';
    } else if (isInternal && res.redirects.length > 0 && s < 400) {
      // Internal links that only differ by a trailing slash or scheme upgrade are still worth fixing.
      rule = R.internalRedirectLink;
    }
    if (!rule) continue;
    const evidence: EvidenceItem[] = [
      { label: 'Link target', value: url },
      statusEv,
      ...(res.redirects.length ? [{ label: 'Redirects', value: [...res.redirects.map((r) => `${r.status} ${r.url}`), `→ ${res.finalUrl}`].join('\n'), code: true }] : []),
      pagesEv,
    ];
    for (const src of sources) findings.push({ rule, target: url, pageUrl: src.pageUrl, viewport: null, evidence, status, check: isInternal ? 'links' : 'links-external' });
  }

  const internalCovered = new Set(input.pages);
  const externalCovered = new Set(input.checkExternal ? input.pages : []);
  for (const [target, sources] of input.targets) {
    if (!unchecked.has(target)) continue;
    const set = input.siteHosts.includes(hostOf(target)) ? internalCovered : externalCovered;
    for (const s of sources) set.delete(s.pageUrl);
  }
  if (input.checkExternal) for (const u of external) if (!results.has(u) || results.get(u) === 'blocked') for (const s of input.targets.get(u) ?? []) externalCovered.delete(s.pageUrl);

  return { findings, checked: results.size, skippedExternal, skippedOverLimit, blocked, covered: { internal: internalCovered, external: externalCovered } };
}
