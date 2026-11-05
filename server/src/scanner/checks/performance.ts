// Lighthouse lab measurements. Each audit runs in a child process (lighthouseRunner.ts) with its
// own headless Chrome, routed through the SSRF-filtering egress proxy. The child keeps
// Lighthouse's long synchronous work and occasional unhandled errors away from the scan worker.
// These are lab numbers (the median of LIGHTHOUSE_RUNS runs) — never presented as real-user (field) Core Web Vitals.

import { fork } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EvidenceItem } from '@wpcg/shared';
import { config } from '../../config.js';
import { getEgressProxy, findChrome } from '../browser.js';
import { R } from '../rules.js';
import type { RawFinding, Viewport } from '../types.js';
import type { CompactReport, RunnerJob, RunnerReply, SlimAudit } from '../lighthouseRunner.js';

export interface LabMetrics {
  tool: string;
  formFactor: 'desktop' | 'mobile';
  performanceScore: number | null;
  lcpMs: number | null;
  fcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  speedIndexMs: number | null;
  measuredAt: string;
}

/** Hard limit per Lighthouse run (one page, one form factor). */
const RUN_TIMEOUT_MS = 150_000;

/** Source layout (tsx) or bundled build (dist/scanner/lighthouseRunner.js). */
function runnerPath(): string | null {
  for (const rel of ['../lighthouseRunner.ts', './lighthouseRunner.js', './scanner/lighthouseRunner.js', '../scanner/lighthouseRunner.js']) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function lighthouseAvailable(): Promise<boolean> {
  try {
    import.meta.resolve('lighthouse');
    import.meta.resolve('chrome-launcher');
  } catch {
    return false;
  }
  return !!findChrome() && !!runnerPath();
}

function runInChild(job: RunnerJob, signal?: AbortSignal): Promise<RunnerReply> {
  const script = runnerPath();
  if (!script) return Promise.resolve({ ok: false, error: 'Lighthouse runner not found' });
  return new Promise((resolve) => {
    // execArgv is inherited, so under tsx the child can load the TypeScript runner directly.
    const child = fork(script, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    const done = (r: RunnerReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
      // Let the child kill its Chrome and exit; force it if it does not.
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 5000).unref();
    };
    const timer = setTimeout(() => {
      done({ ok: false, error: `Lighthouse did not finish within ${RUN_TIMEOUT_MS / 1000} s` });
      child.disconnect?.();
    }, RUN_TIMEOUT_MS);
    // Scan cancelled or out of time: stop now; disconnecting makes the runner close its Chrome and exit.
    const onAbort = () => {
      done({ ok: false, error: 'Scan stopped' });
      child.disconnect?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('message', (m: RunnerReply) => done(m));
    child.on('error', (e) => done({ ok: false, error: e.message }));
    child.on('exit', (code) => done({ ok: false, error: `Lighthouse process exited unexpectedly (code ${code})` }));
    child.send(job);
  });
}

const num = (a: SlimAudit | undefined) => (a && typeof a.numericValue === 'number' ? a.numericValue : null);

export async function runLighthouse(url: string, vp: Viewport, signal?: AbortSignal): Promise<{ findings: RawFinding[]; metrics: LabMetrics | null; report: CompactReport | null; error: string | null }> {
  const proxy = await getEgressProxy();
  // Several runs, keeping the median by performance score: one run can swing 20+ points with network
  // conditions (Lighthouse's own guidance for variable environments). Runs are sequential so they
  // do not compete for CPU or bandwidth.
  const runs: Extract<RunnerReply, { ok: true }>[] = [];
  let lastError = 'Lighthouse did not run';
  for (let i = 0; i < config.LIGHTHOUSE_RUNS; i++) {
    if (signal?.aborted) return { findings: [], metrics: null, report: null, error: 'Scan stopped' };
    const one = await runInChild({ url, mobile: vp.mobile, proxyUrl: proxy.url, chromePath: findChrome() }, signal);
    if (!one.ok) lastError = one.error;
    else if (one.runtimeError) lastError = `${one.runtimeError.code}: ${one.runtimeError.message}`.slice(0, 300);
    else runs.push(one);
  }
  if (!runs.length) return { findings: [], metrics: null, report: null, error: lastError };
  const byScore = [...runs].sort((x, y) => (x.performanceScore ?? 0) - (y.performanceScore ?? 0));
  const r = byScore[Math.floor((byScore.length - 1) / 2)];
  if (r.report.testConfig) r.report.testConfig.runs = runs.length;
  if (runs.length > 1)
    r.report.environment = [
      ...r.report.environment.filter((e) => e !== 'Single page load'),
      `Median of ${runs.length} runs (performance ${byScore.map((x) => Math.round((x.performanceScore ?? 0) * 100)).join(', ')})`,
    ];

  const a = r.audits;
  const metrics: LabMetrics = {
    tool: `Lighthouse ${r.lighthouseVersion} (${vp.mobile ? 'mobile emulation, simulated slow 4G' : 'desktop preset'}${runs.length > 1 ? `, median of ${runs.length} runs` : ''})`,
    formFactor: vp.mobile ? 'mobile' : 'desktop',
    performanceScore: r.performanceScore,
    lcpMs: num(a['largest-contentful-paint']),
    fcpMs: num(a['first-contentful-paint']),
    cls: num(a['cumulative-layout-shift']),
    tbtMs: num(a['total-blocking-time']),
    speedIndexMs: num(a['speed-index']),
    measuredAt: new Date().toISOString(),
  };
  const base: EvidenceItem[] = [
    { label: 'Measurement', value: `${metrics.tool}, lab data` },
    { label: 'Not field data', value: 'Real-user Core Web Vitals (from Chrome UX Report) can differ. INP can only be measured from real visitors.' },
  ];
  const findings: RawFinding[] = [];
  const add = (rule: RawFinding['rule'], ev: EvidenceItem[]) => findings.push({ rule, target: url, pageUrl: url, viewport: vp.name, evidence: [...ev, ...base] });
  const band = (v: number, good: number, poor: number) => (v > poor ? 'poor' : v > good ? 'needs improvement' : 'good');

  if (metrics.lcpMs !== null && metrics.lcpMs > 2500)
    add(R.perfLcp, [{ label: 'Largest Contentful Paint (lab)', value: `${(metrics.lcpMs / 1000).toFixed(2)} s — ${band(metrics.lcpMs, 2500, 4000)} (good ≤ 2.5 s)` }]);
  if (metrics.cls !== null && metrics.cls > 0.1)
    add(R.perfCls, [{ label: 'Cumulative Layout Shift (lab)', value: `${metrics.cls.toFixed(3)} — ${band(metrics.cls, 0.1, 0.25)} (good ≤ 0.1)` }]);
  if (metrics.tbtMs !== null && metrics.tbtMs > 200)
    add(R.perfTbt, [{ label: 'Total Blocking Time (lab)', value: `${Math.round(metrics.tbtMs)} ms — ${band(metrics.tbtMs, 200, 600)} (good ≤ 200 ms)` }]);

  const opportunities = Object.values(a)
    .map((au) => ({ au, savings: Math.max(au.overallSavingsMs ?? 0, au.metricSavings?.LCP ?? 0, au.metricSavings?.FCP ?? 0) }))
    .filter(({ au, savings }) => savings >= 300 && au.score !== null && au.score < 0.9)
    .sort((x, y) => y.savings - x.savings)
    .slice(0, 8);
  if (opportunities.length)
    add(R.perfOpportunity, [
      {
        label: `${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'}`,
        value: opportunities.map(({ au, savings }) => `${au.title} — est. ${Math.round(savings)} ms${au.displayValue ? ` (${au.displayValue})` : ''}`).join('\n'),
      },
    ]);
  return { findings, metrics, report: r.report ?? null, error: null };
}
