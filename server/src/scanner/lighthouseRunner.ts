// Child-process entry that runs one Lighthouse audit. Lighthouse does long synchronous trace
// processing and can throw unhandled protocol errors; running it here keeps the scan worker's
// event loop (heartbeats, cancellation) responsive and a Lighthouse crash from killing the worker.
//
// Protocol (IPC): parent sends one RunnerJob, child replies with one RunnerReply and exits.

import { pathToFileURL } from 'node:url';
import type { LhAuditDTO, LhCategoryDTO, LhDetails, LhResourceDTO, LhResourceFindingDTO, LhResourceSummaryDTO, LhTestConfigDTO, LhThirdPartyDTO, LhValue } from '@wpcg/shared';
import { extractResources, extractTestConfig } from './lighthouseExtract.js';

export interface RunnerJob {
  url: string;
  mobile: boolean;
  proxyUrl: string;
  chromePath: string | undefined;
}

export interface SlimAudit {
  title: string;
  score: number | null;
  numericValue?: number;
  displayValue?: string;
  metricSavings?: Record<string, number>;
  overallSavingsMs?: number;
}

/** The PageSpeed-style report body (pageUrl and viewport are added by the caller). */
export interface CompactReport {
  lighthouseVersion: string;
  fetchTime: string;
  formFactor: 'mobile' | 'desktop';
  environment: string[];
  categories: LhCategoryDTO[];
  audits: Record<string, LhAuditDTO>;
  finalScreenshot: string | null;
  filmstrip: { timingMs: number; data: string }[];
  resources?: LhResourceDTO[];
  resourcesTotal?: number;
  resourceSummary?: LhResourceSummaryDTO[];
  thirdParties?: LhThirdPartyDTO[];
  findingsByUrl?: Record<string, LhResourceFindingDTO[]>;
  testConfig?: LhTestConfigDTO;
}

export type RunnerReply =
  | { ok: true; lighthouseVersion: string; runtimeError: { code: string; message: string } | null; performanceScore: number | null; audits: Record<string, SlimAudit>; report: CompactReport }
  | { ok: false; error: string };

type LighthouseFn = (url: string, flags: Record<string, unknown>, config?: unknown) => Promise<{ lhr: Lhr } | undefined>;
interface LhrAudit {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  numericValue?: number;
  displayValue?: string;
  metricSavings?: Record<string, number>;
  warnings?: string[];
  errorMessage?: string;
  details?: Record<string, unknown> & { type?: string; overallSavingsMs?: number };
}
interface Lhr {
  lighthouseVersion: string;
  fetchTime: string;
  runtimeError?: { code: string; message: string };
  configSettings: { formFactor: 'mobile' | 'desktop'; throttlingMethod?: string };
  environment?: { hostUserAgent?: string };
  categories: Record<string, { id: string; title: string; description?: string; score: number | null; auditRefs: { id: string; group?: string; relevantAudits?: string[]; acronym?: string }[] }>;
  categoryGroups?: Record<string, { title: string; description?: string }>;
  audits: Record<string, LhrAudit>;
}

// ---------------------------------------------------------------- compaction (keeps the report small)

const clip = (v: string, n = 300) => (v.length > n ? `${v.slice(0, n)}…` : v);

function slimValue(v: unknown, valueType?: string): LhValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return valueType === 'url' ? { type: 'url', value: clip(v, 500) } : valueType === 'code' ? { type: 'code', value: clip(v) } : clip(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'node')
      return {
        type: 'node',
        snippet: typeof o.snippet === 'string' ? clip(o.snippet, 400) : undefined,
        selector: typeof o.selector === 'string' ? clip(o.selector, 200) : undefined,
        label: typeof o.nodeLabel === 'string' ? clip(o.nodeLabel, 120) : undefined,
      };
    if (o.type === 'url' && typeof o.value === 'string') return { type: 'url', value: clip(o.value, 500) };
    if (o.type === 'code' && o.value !== undefined) return { type: 'code', value: clip(String(o.value)) };
    if (o.type === 'source-location' && typeof o.url === 'string') return { type: 'source', value: `${clip(o.url, 400)}:${Number(o.line ?? 0) + 1}` };
    if (o.type === 'link' && typeof o.text === 'string') return clip(o.text);
    if (o.type === 'text' && o.value !== undefined) return clip(String(o.value));
    if (o.type === 'numeric' && typeof o.value === 'number') return o.value;
  }
  return null;
}

function slimDetails(d: Record<string, unknown> | undefined, depth = 0): LhDetails | undefined {
  if (!d || typeof d.type !== 'string') return undefined;
  if ((d.type === 'table' || d.type === 'opportunity') && Array.isArray(d.items)) {
    const headings = ((d.headings as Record<string, unknown>[]) ?? [])
      .map((h) => ({
        key: String(h.key ?? ''),
        label: typeof h.label === 'string' ? h.label : typeof h.text === 'string' ? h.text : '',
        valueType: typeof h.valueType === 'string' ? h.valueType : typeof h.itemType === 'string' ? h.itemType : undefined,
      }))
      .filter((h) => h.key);
    const items = (d.items as Record<string, unknown>[]).slice(0, 12).map((it) => Object.fromEntries(headings.map((h) => [h.key, slimValue(it[h.key], h.valueType)])));
    return { type: 'table', headings, items, totalItems: (d.items as unknown[]).length };
  }
  if (d.type === 'list' && Array.isArray(d.items) && depth === 0) {
    const lists = (d.items as Record<string, unknown>[])
      .slice(0, 5)
      .map((x) => slimDetails(x, 1))
      .filter((x): x is LhDetails => !!x);
    return lists.length ? { type: 'list', lists } : undefined;
  }
  if (d.type === 'checklist' && d.items && typeof d.items === 'object') {
    const items = Object.entries(d.items as Record<string, { value?: boolean; label?: string }>).map(([k, v]) => ({ check: v.label ?? k, passed: !!v.value }));
    return { type: 'table', headings: [{ key: 'check', label: 'Check' }, { key: 'passed', label: 'Passed' }], items, totalItems: items.length };
  }
  return undefined;
}

function compact(lhr: Lhr): CompactReport {
  const audits: Record<string, LhAuditDTO> = {};
  const used = new Set<string>();
  const categories: LhCategoryDTO[] = Object.values(lhr.categories).map((c) => {
    const byGroup = new Map<string, string[]>();
    const relevantAudits: Record<string, string[]> = {};
    for (const ref of c.auditRefs) {
      if (ref.group === 'hidden') continue;
      used.add(ref.id);
      const g = ref.group ?? '';
      byGroup.set(g, [...(byGroup.get(g) ?? []), ref.id]);
      if (ref.relevantAudits?.length && ref.acronym) relevantAudits[ref.acronym] = ref.relevantAudits;
    }
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      score: c.score,
      groups: [...byGroup.entries()].map(([id, auditIds]) => ({ id, title: lhr.categoryGroups?.[id]?.title ?? '', description: lhr.categoryGroups?.[id]?.description, auditIds })),
      ...(Object.keys(relevantAudits).length ? { relevantAudits } : {}),
    };
  });
  for (const id of used) {
    const a = lhr.audits[id];
    if (!a) continue;
    audits[id] = {
      id,
      title: a.title,
      description: clip(a.description ?? '', 1500),
      score: a.score,
      scoreDisplayMode: a.scoreDisplayMode,
      displayValue: a.displayValue,
      numericValue: a.numericValue,
      metricSavings: a.metricSavings,
      details: slimDetails(a.details),
      warnings: a.warnings?.length ? a.warnings.slice(0, 3).map((w) => clip(String(w))) : undefined,
      errorMessage: a.errorMessage ? clip(a.errorMessage) : undefined,
    };
  }
  const shot = lhr.audits['final-screenshot']?.details as { data?: string } | undefined;
  const film = lhr.audits['screenshot-thumbnails']?.details as { items?: { timing: number; data: string }[] } | undefined;
  const cs = lhr.configSettings;
  const chromeVersion = lhr.environment?.hostUserAgent?.match(/(HeadlessChrome|Chrome)\/[\d.]+/)?.[0];
  return {
    lighthouseVersion: lhr.lighthouseVersion,
    fetchTime: lhr.fetchTime,
    formFactor: cs.formFactor,
    environment: [
      cs.formFactor === 'mobile' ? 'Emulated mobile device (Moto G Power class)' : 'Emulated desktop',
      cs.throttlingMethod === 'simulate' ? (cs.formFactor === 'mobile' ? 'Simulated slow 4G throttling' : 'Simulated desktop network') : `Throttling: ${cs.throttlingMethod ?? 'none'}`,
      'Single page load',
      `Lighthouse ${lhr.lighthouseVersion}`,
      ...(chromeVersion ? [chromeVersion] : []),
    ],
    categories,
    audits,
    finalScreenshot: shot?.data && shot.data.length < 400_000 ? shot.data : null,
    filmstrip: (film?.items ?? []).slice(0, 10).map((f) => ({ timingMs: Math.round(f.timing), data: f.data })),
    // Resource-level data and the exact test settings, taken from the full result before compaction.
    ...extractResources(lhr as unknown as Record<string, unknown>),
    testConfig: extractTestConfig(lhr as unknown as Record<string, unknown>),
  };
}

let chrome: { kill: () => void | Promise<void> } | null = null;
let replied = false;

function reply(msg: RunnerReply) {
  if (replied) return;
  replied = true;
  process.send?.(msg);
}

async function finish(code: number) {
  try {
    await Promise.resolve(chrome?.kill());
  } catch {
    /* already gone */
  }
  // Give the IPC message time to flush before exiting.
  setTimeout(() => process.exit(code), 50);
}

async function run(job: RunnerJob) {
  const lighthouse = (await import('lighthouse')).default as unknown as LighthouseFn;
  const { launch } = await import('chrome-launcher');
  const desktopConfig = (await import('lighthouse/core/config/desktop-config.js')).default;
  chrome = await launch({
    chromePath: job.chromePath,
    chromeFlags: [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
      `--proxy-server=${job.proxyUrl}`,
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
    logLevel: 'silent',
  });
  const result = await lighthouse(
    job.url,
    { port: (chrome as unknown as { port: number }).port, output: 'json', logLevel: 'silent', maxWaitForLoad: 45000 },
    job.mobile ? undefined : desktopConfig,
  );
  const lhr = result?.lhr;
  if (!lhr) return reply({ ok: false, error: 'Lighthouse returned no result' });
  const audits: Record<string, SlimAudit> = {};
  for (const [id, a] of Object.entries(lhr.audits)) {
    audits[id] = {
      title: a.title,
      score: a.score,
      numericValue: a.numericValue,
      displayValue: a.displayValue,
      metricSavings: a.metricSavings,
      overallSavingsMs: a.details?.overallSavingsMs,
    };
  }
  reply({
    ok: true,
    lighthouseVersion: lhr.lighthouseVersion,
    runtimeError: lhr.runtimeError ?? null,
    performanceScore: lhr.categories.performance?.score ?? null,
    audits,
    report: compact(lhr),
  });
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.on('unhandledRejection', (e) => {
    reply({ ok: false, error: firstLine(e) });
    void finish(1);
  });
  process.on('uncaughtException', (e) => {
    reply({ ok: false, error: firstLine(e) });
    void finish(1);
  });
  process.on('disconnect', () => void finish(0)); // parent gone or gave up
  process.once('message', (job: RunnerJob) => {
    run(job)
      .catch((e) => reply({ ok: false, error: firstLine(e) }))
      .finally(() => void finish(0));
  });
}
