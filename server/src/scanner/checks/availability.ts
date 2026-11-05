import type { EvidenceItem } from '@wpcg/shared';
import type { SafeResponse } from '../../security/safeFetch.js';
import { R } from '../rules.js';
import type { RawFinding } from '../types.js';

export function redirectEvidence(res: SafeResponse): EvidenceItem[] {
  if (!res.redirects.length) return [];
  return [
    {
      label: 'Redirect chain',
      value: [...res.redirects.map((h) => `${h.status}  ${h.url}`), `→  ${res.finalUrl}`].join('\n'),
      code: true,
    },
  ];
}

/**
 * Findings from the HTTP response of one page. `isStart` marks the scan's start page, where
 * failures mean the whole site is down (Critical) rather than one page (High).
 * Returns `testable=false` when the page cannot be loaded for further checks.
 */
export function availabilityFindings(pageUrl: string, res: SafeResponse, isStart: boolean, origin: string): { findings: RawFinding[]; testable: boolean } {
  const findings: RawFinding[] = [];
  const base: EvidenceItem[] = [{ label: 'Requested URL', value: pageUrl }];
  const add = (rule: RawFinding['rule'], evidence: EvidenceItem[], target = pageUrl) =>
    findings.push({ rule, target, pageUrl, viewport: null, evidence: [...base, ...evidence] });

  if (res.failure) {
    const ev: EvidenceItem[] = [
      { label: 'Failure', value: res.failure.message },
      ...(res.failure.code ? [{ label: 'Error code', value: res.failure.code, code: true }] : []),
      { label: 'Elapsed', value: `${res.durationMs} ms` },
      ...redirectEvidence(res),
    ];
    switch (res.failure.kind) {
      case 'blocked':
        // A policy decision of the scanner, not a website defect: reported on the scan, not as an issue.
        return { findings: [], testable: false };
      case 'tls':
        add(R.tlsError, ev, origin);
        break;
      case 'too_many_redirects':
        add(R.tooManyRedirects, ev);
        break;
      case 'timeout':
        add(isStart ? R.siteUnreachable : R.timeout, ev, isStart ? origin : pageUrl);
        break;
      default:
        if (isStart) add(R.siteUnreachable, ev, origin);
        else add(R.pageFailed, ev);
    }
    return { findings, testable: false };
  }

  const status = res.status ?? 0;
  const ev: EvidenceItem[] = [
    { label: 'HTTP status', value: String(status) },
    ...(res.finalUrl !== pageUrl ? [{ label: 'Final URL', value: res.finalUrl }] : []),
    ...redirectEvidence(res),
  ];
  if (status >= 500) {
    add(isStart ? R.serverErrorHome : R.serverError, ev, isStart ? origin : pageUrl);
    return { findings, testable: false };
  }
  if (status === 404 || status === 410) {
    add(R.notFound, ev);
    return { findings, testable: false };
  }
  if (status === 401 || status === 403) {
    add(R.accessDenied, ev);
    return { findings, testable: false };
  }
  if (status === 429) {
    add(R.rateLimited, ev);
    return { findings, testable: false };
  }
  if (status >= 400) {
    add(R.notFound, ev);
    return { findings, testable: false };
  }
  if (res.redirects.length > 1) add(R.redirectChain, [{ label: 'Redirects', value: String(res.redirects.length) }, ...redirectEvidence(res)]);
  if (res.durationMs > 3000) add(R.slowResponse, [{ label: 'Time to complete HTML response', value: `${(res.durationMs / 1000).toFixed(1)} s (single measurement from the scanner)` }]);
  return { findings, testable: true };
}
