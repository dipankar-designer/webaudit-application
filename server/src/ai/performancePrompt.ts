// Prompt for the AI Performance Fix Assistant. Built only from one stored Lighthouse report (and the scan's
// WordPress findings): the model is given measured values and told not to invent causes, savings or scores.

import { findDuplicateAssets, groupWordPressAssets, type LhAuditDTO, type LighthouseReportDTO, type ViewportName, type WordPressReportDTO } from '@wpcg/shared';
import { scanData } from './provider.js';

type StoredReport = Omit<LighthouseReportDTO, 'pageUrl' | 'viewport'>;

const METRICS = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index'];

/** Lighthouse's own estimate of what an audit could save (ms of FCP/LCP, or bytes), for ordering only. */
function estimatedImpact(a: LhAuditDTO): number {
  const s = a.metricSavings ?? {};
  return Math.max(s.LCP ?? 0, s.FCP ?? 0, (s.TBT ?? 0) * 0.5, (s.CLS ?? 0) * 10_000);
}

export function performancePrompt(input: { website: string; pageUrl: string; viewport: ViewportName; report: StoredReport; wordpress: WordPressReportDTO | null }): string {
  const { report: r, wordpress: wp } = input;
  const perf = r.categories.find((c) => c.id === 'performance');
  const perfIds = new Set(perf?.groups.flatMap((g) => g.auditIds) ?? []);
  const failing = [...perfIds]
    .map((id) => r.audits[id])
    .filter((a): a is LhAuditDTO => !!a && a.score !== null && a.score < 0.9 && !METRICS.includes(a.id) && a.scoreDisplayMode !== 'informative')
    .sort((a, b) => estimatedImpact(b) - estimatedImpact(a))
    .slice(0, 6);
  const findingsByUrl = r.findingsByUrl ?? {};
  const assets = r.resources ? groupWordPressAssets(r.resources) : [];
  const flaggedFiles = (urls: string[]) => urls.filter((u) => findingsByUrl[u]?.length).map((u) => ({ url: u, lighthouseFindings: findingsByUrl[u].map((f) => f.label) }));
  const tc = r.testConfig;

  return `You are a web performance engineer. Write a prioritised fix plan for this page, for the site owner and their developer.

Rules:
- Use ONLY the measured data below. Quote numbers exactly as given. Do not invent scores, savings, load times or predicted improvements; where Lighthouse gives an estimated saving, call it "Lighthouse's estimate".
- Do not state a root cause the data does not show. If more information is needed, say what and how to get it.
- Name a WordPress plugin or theme only if it appears in the data. Loading files is not proof that a plugin slows the page: only say a plugin's files are a problem when those files have Lighthouse findings listed.
- Server-side causes (slow PHP, database queries, plugin execution time) cannot be measured from outside the site. If the server response time is high, explain that profiling needs access to the site (for example the Query Monitor plugin or the host's APM), with the owner's authorisation.
- These are lab results from ${tc?.throttlingMethod === 'simulate' ? 'simulated' : 'emulated'} ${input.viewport} conditions, not real-user measurements.

Format:
1. A two-sentence summary of the page's main performance problem.
2. Exactly one fix for EACH item in "failingAudits", in the order given (already sorted by impact), headed with the audit name exactly as given. Do not add fixes for anything that is not in failingAudits. For each:
   - **Why it matters** (cite the measured values)
   - **Steps** (numbered, practical)
   - **Code example** only when it genuinely helps and you are sure it is valid and safe (HTML attributes, .htaccess/nginx rules, or a WordPress functions.php snippet); otherwise leave it out
   - **WordPress** guidance when the site is WordPress. Name a plugin only if it appears in detectedPlugins or deliveryIndicators; otherwise describe the kind of tool (for example "a page-caching plugin") without naming one
   - **How to verify**: what to re-check after the fix (re-run the WebAudit AI scan and which Lighthouse audit or metric should change)
3. What could not be measured and how to find out.

${scanData({
  website: input.website,
  page: input.pageUrl,
  device: input.viewport,
  testConditions: tc
    ? { throttling: tc.throttlingMethod, rttMs: tc.rttMs, throughputKbps: tc.throughputKbps, cpuSlowdown: tc.cpuSlowdownMultiplier, screen: tc.screen, runsBehindMedian: tc.runs }
    : r.environment,
  scores: Object.fromEntries(r.categories.map((c) => [c.title, c.score === null ? null : Math.round(c.score * 100)])),
  labMetrics: Object.fromEntries(METRICS.map((id) => [r.audits[id]?.title ?? id, r.audits[id]?.displayValue ?? null])),
  failingAudits: failing.map((a) => ({
    audit: a.title,
    result: a.displayValue ?? null,
    lighthouseEstimatedSavings: a.metricSavings ?? null,
    topItems: a.details && 'items' in a.details ? (a.details.items ?? []).slice(0, 2).map(slimItem) : [],
  })),
  pageWeight: (r.resourceSummary ?? []).map((s) => ({ type: s.label, requests: s.requestCount, transferBytes: s.transferSize })),
  heaviestRequests: (r.resources ?? [])
    .slice()
    .sort((x, y) => (y.transferSize ?? 0) - (x.transferSize ?? 0))
    .slice(0, 6)
    .map((x) => ({ url: x.url.slice(0, 160), type: x.resourceType, transferBytes: x.transferSize, thirdParty: x.thirdParty })),
  thirdParties: (r.thirdParties ?? []).slice(0, 5).map((t) => ({ name: t.entity, transferBytes: t.transferSize, mainThreadMs: t.mainThreadMs === null ? null : Math.round(t.mainThreadMs) })),
  wordpress: wp?.detected
    ? {
        version: wp.core?.version ?? 'unknown',
        theme: wp.themes.map((t) => t.name ?? t.slug),
        detectedPlugins: wp.plugins.slice(0, 15).map((p) => `${p.name ?? p.slug}${p.installedVersion ? ` ${p.installedVersion}` : ''}`),
        frontEndAssetsByFolder: assets.slice(0, 6).map((g) => ({ [g.kind]: g.slug, requests: g.requests, transferBytes: g.transferSize, filesWithLighthouseFindings: flaggedFiles(g.urls).slice(0, 2) })),
        possibleDuplicateAssets: r.resources ? findDuplicateAssets(r.resources).slice(0, 3) : [],
        deliveryIndicators: wp.delivery ? { htmlCompression: wp.delivery.htmlCompression, indicators: wp.delivery.indicators.map((i) => `${i.label} (${i.evidence})`) } : null,
      }
    : 'Not detected as WordPress',
})}

Now write the fix plan described at the top, using only the data above: the two-sentence summary, then one fix per failingAudits item in the given order, headed with its audit name (Why it matters, Steps, Code example only if valid, WordPress, How to verify). No other fixes. Do not describe or summarise the data structure.`;
}

/** One Lighthouse table row reduced to short text and numbers (no HTML snippets), to keep the prompt small. */
function slimItem(item: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = typeof v === 'number' ? Math.round(v) : v;
    else if (typeof v === 'string') out[k] = v.slice(0, 160);
    else if (v && typeof v === 'object' && 'value' in v && typeof (v as { value: unknown }).value === 'string') out[k] = String((v as { value: string }).value).slice(0, 160);
    else if (v && typeof v === 'object' && 'label' in v && typeof (v as { label: unknown }).label === 'string') out[k] = String((v as { label: string }).label).slice(0, 120);
  }
  return out;
}
