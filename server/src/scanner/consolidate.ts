// Groups page-scoped findings by the element that causes them, so a defect in a shared header,
// footer or template is reported once — not once per page.
//
// Per rule (and viewport):
//   • elements seen on two or more pages → ONE site-wide issue ("shared elements") that lists each
//     element with the pages it appears on. Its target is stable (`shared:<rule>`), so it resolves
//     only when every shared element is fixed.
//   • elements seen on one page only     → that page's own issue (target = the page URL, the same
//     fingerprint as before grouping existed, so issue history continues).
// A finding row is kept for every affected page — coverage, verification and resolution use them.

import crypto from 'node:crypto';
import type { EvidenceItem } from '@wpcg/shared';
import type { FindingElement, RawFinding } from './types.js';

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

/** Normalises markup so the same element on different pages has the same signature. */
export function elementSig(ruleId: string, raw: string): string {
  const norm = raw
    .replace(/\s+/g, ' ')
    .replace(/\b(nonce|data-nonce|data-id|data-elementor-id|id)="[^"]*\d{4,}[^"]*"/gi, '$1=""') // per-request ids
    .replace(/\?ver=[^"'\s&]+/gi, '')
    .trim()
    .slice(0, 2000);
  return hash(`${ruleId}|${norm}`);
}

export const SHARED_PREFIX = 'shared:';

function pageList(pages: string[], max = 25): string {
  return pages.slice(0, max).join('\n') + (pages.length > max ? `\n… and ${pages.length - max} more` : '');
}

function elementEvidence(els: FindingElement[], pagesOf?: (sig: string) => string[]): EvidenceItem[] {
  return [
    {
      label: `Affected element${els.length === 1 ? '' : 's'} (${els.length})`,
      value: els
        .slice(0, 20)
        .map((e) => (pagesOf ? `${e.label}   — on ${pagesOf(e.sig).length} pages` : e.label))
        .join('\n'),
      code: true,
    },
    ...els.slice(0, 3).flatMap((e, i) => [
      ...(e.html ? [{ label: `Element ${i + 1} HTML`, value: e.html, code: true }] : []),
      ...(e.note ? [{ label: `Element ${i + 1} — details`, value: e.note }] : []),
    ]),
  ];
}

export function consolidateFindings(findings: RawFinding[]): RawFinding[] {
  const out: RawFinding[] = [];
  const buckets = new Map<string, RawFinding[]>();
  for (const f of findings) {
    if (!f.elements?.length || f.rule.scope !== 'page') {
      out.push(f);
      continue;
    }
    const key = `${f.rule.id}|${f.rule.viewportDependent ? (f.viewport ?? '') : ''}|${f.status ?? ''}`;
    buckets.set(key, [...(buckets.get(key) ?? []), f]);
  }

  for (const list of buckets.values()) {
    const bySig = new Map<string, { el: FindingElement; pages: Set<string> }>();
    for (const f of list)
      for (const el of f.elements!) {
        const e = bySig.get(el.sig) ?? { el, pages: new Set<string>() };
        e.pages.add(f.pageUrl);
        bySig.set(el.sig, e);
      }
    const shared = [...bySig.values()].filter((e) => e.pages.size >= 2).sort((a, b) => b.pages.size - a.pages.size);
    const sharedSigs = new Set(shared.map((e) => e.el.sig));
    const sample = list[0];
    const head = sample.headEvidence ?? [];

    if (shared.length) {
      const pages = [...new Set(shared.flatMap((e) => [...e.pages]))].sort();
      const pagesOf = (sig: string) => [...(bySig.get(sig)?.pages ?? [])];
      const evidence: EvidenceItem[] = [
        ...head,
        {
          label: 'Scope',
          value: `Shared element${shared.length === 1 ? '' : 's'} that appear${shared.length === 1 ? 's' : ''} on several pages (usually a header, footer, menu or template). Fixing ${shared.length === 1 ? 'it' : 'each one'} once fixes every page listed.`,
        },
        ...elementEvidence(
          shared.map((e) => e.el),
          pagesOf,
        ),
        { label: `Found on ${pages.length} pages`, value: pageList(pages) },
      ];
      for (const page of pages) {
        const orig = list.find((f) => f.pageUrl === page)!;
        out.push({ ...sample, target: `${SHARED_PREFIX}${sample.rule.id}${sample.rule.viewportDependent && sample.viewport ? `|${sample.viewport}` : ''}`, pageUrl: page, viewport: orig.viewport, evidence, elements: undefined, headEvidence: undefined });
      }
    }

    for (const f of list) {
      const own = f.elements!.filter((e) => !sharedSigs.has(e.sig));
      if (!own.length) continue;
      out.push({ ...f, target: f.pageUrl, evidence: [...head, ...elementEvidence(own)], elements: undefined, headEvidence: undefined });
    }
  }
  return out;
}
