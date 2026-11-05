// axe-core in the scanned page. Results are converted to findings with WCAG references,
// selectors and axe's own failure summaries as evidence.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'playwright-core';
import { AXE_DISABLED_RULES, axeRuleDef, wcagFromTags, type AxeResultLike } from '../axeRules.js';
import type { EvidenceItem } from '@wpcg/shared';
import { elementSig } from '../consolidate.js';
import type { RawFinding } from '../types.js';
import { scrub } from './pageRuntime.js';

const require = createRequire(import.meta.url);
let axeSource: string | null = null;
export function axeVersion(): string {
  return (require('axe-core/package.json') as { version: string }).version;
}
function source(): string {
  axeSource ??= fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

interface AxeNode {
  target: unknown[];
  html: string;
  failureSummary?: string;
  any?: { message: string; data?: unknown }[];
}
interface AxeRuleResult extends AxeResultLike {
  nodes: AxeNode[];
}
interface AxeRun {
  violations: AxeRuleResult[];
  incomplete: AxeRuleResult[];
  passes: number;
  inapplicable: number;
  testEngine: { version: string };
}

const RUN_OPTIONS = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
  rules: Object.fromEntries(AXE_DISABLED_RULES.map((r) => [r, { enabled: false }])),
  resultTypes: ['violations', 'incomplete'],
  iframes: false,
};

export async function runAxe(page: Page): Promise<AxeRun> {
  // Shadow AMD/CommonJS globals so pages using RequireJS etc. do not capture axe as a module.
  await page.evaluate(`(function(){ var define, module, exports; ${source()}\n; window.axe = axe; })()`);
  const json = await page.evaluate(`(async () => {
    const r = await axe.run(document, ${JSON.stringify(RUN_OPTIONS)});
    const slim = (list) => list.map((v) => ({ id: v.id, impact: v.impact, tags: v.tags, description: v.description, help: v.help, helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, 25).map((n) => ({ target: n.target, html: n.html, failureSummary: n.failureSummary })) }));
    return JSON.stringify({ violations: slim(r.violations), incomplete: slim(r.incomplete), passes: r.passes.length, inapplicable: r.inapplicable.length, testEngine: r.testEngine });
  })()`);
  return JSON.parse(json as string) as AxeRun;
}

const selector = (n: AxeNode) => n.target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : String(t))).join(' | ');

export function axeFindings(pageUrl: string, run: AxeRun): RawFinding[] {
  const out: RawFinding[] = [];
  const convert = (list: AxeRuleResult[], incomplete: boolean) => {
    for (const v of list) {
      // Manual-review items are only raised for impacts that matter, to avoid burying real failures.
      if (incomplete && !(v.impact === 'serious' || v.impact === 'critical')) continue;
      // "frame-tested" only says iframes were not analysed (we run with iframes: false); that is a
      // scanner limitation stated in the check notes, not a problem with the site.
      if (v.id === 'frame-tested') continue;
      const rule = axeRuleDef(v, incomplete);
      const wcag = wcagFromTags(v.tags);
      const headEvidence: EvidenceItem[] = [
        { label: 'Rule', value: `${v.id} — ${v.help}` },
        ...(wcag.length ? [{ label: 'WCAG success criteria', value: wcag.join(', ') }] : []),
        { label: 'Impact (axe-core)', value: String(v.impact ?? 'unknown') },
        {
          label: 'Verification',
          value: incomplete
            ? 'axe-core could not decide this automatically (for example text over an image or gradient). A person must check it against the WCAG criterion before it is treated as a failure.'
            : 'axe-core evaluated the rendered element and it failed this rule. Automated results cover only part of WCAG; they do not by themselves establish conformance.',
        },
      ];
      out.push({
        rule,
        target: pageUrl,
        pageUrl,
        viewport: null,
        evidence: [
          { label: 'Rule', value: `${v.id} — ${v.help}` },
          ...(wcag.length ? [{ label: 'WCAG success criteria', value: wcag.join(', ') }] : []),
          { label: 'Impact (axe-core)', value: String(v.impact ?? 'unknown') },
          { label: `Affected elements (${v.nodes.length}${v.nodes.length === 25 ? '+' : ''})`, value: v.nodes.slice(0, 10).map(selector).join('\n'), code: true },
          ...v.nodes.slice(0, 3).flatMap((n, i) => [
            { label: `Element ${i + 1} HTML`, value: scrub(n.html).slice(0, 400), code: true },
            ...(n.failureSummary ? [{ label: `Element ${i + 1} — what to fix`, value: n.failureSummary.slice(0, 600) }] : []),
          ]),
        ],
        status: incomplete ? 'needs_review' : undefined,
        technical: [{ label: 'axe-core version', value: run.testEngine.version }],
        headEvidence,
        elements: v.nodes.map((n) => ({
          sig: elementSig(v.id, scrub(n.html)),
          label: selector(n),
          html: scrub(n.html).slice(0, 400),
          note: n.failureSummary?.slice(0, 600),
        })),
      });
    }
  };
  convert(run.violations, false);
  convert(run.incomplete, true);
  return out;
}
