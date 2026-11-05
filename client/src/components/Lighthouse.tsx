// PageSpeed-style Lighthouse report: score gauges, lab metrics, insights, diagnostics and every
// category's audit groups as accordions with step-by-step fixes. Ratings always use a shape and a
// label as well as colour (triangle = poor, square = needs improvement, circle = good).

import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { CalendarClock, CalendarDays, ChevronDown, CircleHelp, Cpu, ExternalLink, FlaskConical, Gauge as GaugeIcon, GitCompareArrows, Globe, Monitor, Network, Smartphone, Sparkles, Timer, Users, Wifi } from 'lucide-react';
import {
  FIELD_THRESHOLDS,
  type FieldDataDTO,
  type FieldMetricDTO,
  type FieldMetricId,
  type FieldRecordDTO,
  type LhAuditDTO,
  type LhCategoryDTO,
  type LhDetails,
  type LhValue,
  type LighthouseIndexDTO,
  type LighthouseReportDTO,
  type WordPressReportDTO,
} from '@wpcg/shared';
import { useApi } from '../lib/useApi';
import { fmtBytes, fmtDateTime } from '../lib/format';
import { GENERIC_FIX, LH_FIXES } from '../lib/lighthouseFixes';
import { AiFixAssistant, Panel, ResourceAnalysis, ScanComparison, TestConditions } from './PerformanceInsights';
import { ErrorState, LoadingState, cx } from './ui';

// ---------------------------------------------------------------- ratings

type Rating = 'pass' | 'average' | 'fail' | 'info' | 'na';

function ratingOf(a: Pick<LhAuditDTO, 'score' | 'scoreDisplayMode'>): Rating {
  if (a.scoreDisplayMode === 'notApplicable' || a.scoreDisplayMode === 'manual') return 'na';
  if (a.scoreDisplayMode === 'informative' || a.scoreDisplayMode === 'error' || a.score === null) return 'info';
  return a.score >= 0.9 ? 'pass' : a.score >= 0.5 ? 'average' : 'fail';
}
const scoreRating = (s: number | null): Rating => (s === null ? 'na' : s >= 0.9 ? 'pass' : s >= 0.5 ? 'average' : 'fail');

// PageSpeed Insights' own rating colours (all ≥ 4.5:1 on the dark surface).
const PSI = { fail: '#ff4e42', average: '#ffa400', pass: '#0cce6b' };

const TONE: Record<Rating, { text: string; ring: string; track: string; label: string }> = {
  pass: {
    text: 'text-[#0cce6b]',
    ring: PSI.pass,
    track: 'rgba(12,206,107,0.12)',
    label: 'Good',
  },
  average: {
    text: 'text-[#ffa400]',
    ring: PSI.average,
    track: 'rgba(255,164,0,0.12)',
    label: 'Needs improvement',
  },
  fail: {
    text: 'text-[#ff4e42]',
    ring: PSI.fail,
    track: 'rgba(255,78,66,0.12)',
    label: 'Poor',
  },
  info: {
    text: 'text-slate-600',
    ring: 'var(--color-slate-400)',
    track: 'var(--color-slate-200)',
    label: 'Informative',
  },
  na: {
    text: 'text-slate-500',
    ring: 'var(--color-slate-400)',
    track: 'var(--color-slate-200)',
    label: 'Not applicable',
  },
};

/** Shape + colour marker (never colour alone). */
export function RatingShape({ rating, className }: { rating: Rating; className?: string }) {
  const c = cx('size-3 shrink-0', className);
  if (rating === 'fail')
    return (
      <svg viewBox="0 0 12 12" className={c} aria-hidden>
        <path d="M6 1 11.5 11H.5Z" fill={PSI.fail} />
      </svg>
    );
  if (rating === 'average')
    return (
      <svg viewBox="0 0 12 12" className={c} aria-hidden>
        <rect x="1.5" y="1.5" width="9" height="9" fill={PSI.average} />
      </svg>
    );
  if (rating === 'pass')
    return (
      <svg viewBox="0 0 12 12" className={c} aria-hidden>
        <circle cx="6" cy="6" r="5" fill={PSI.pass} />
      </svg>
    );
  return (
    <svg viewBox="0 0 12 12" className={c} aria-hidden>
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--color-slate-400)" strokeWidth="1.5" />
    </svg>
  );
}

/** Circular progress gauge for a 0–1 score. */
export function ScoreGauge({ score, label, size = 'md', href }: { score: number | null; label: string; size?: 'sm' | 'md' | 'lg'; href?: string }) {
  const r = scoreRating(score);
  const px = { sm: 72, md: 88, lg: 140 }[size];
  const stroke = { sm: 6, md: 8, lg: 11 }[size];
  const rad = (px - stroke) / 2;
  const circ = 2 * Math.PI * rad;
  const value = score === null ? null : Math.round(score * 100);
  const body = (
    <>
      <span className="relative inline-flex" style={{ width: px, height: px }}>
        <svg width={px} height={px} viewBox={`0 0 ${px} ${px}`} aria-hidden className="-rotate-90">
          <circle cx={px / 2} cy={px / 2} r={rad} fill={score === null ? 'none' : TONE[r].track} stroke={TONE[r].track} strokeWidth={stroke} />
          {value !== null && (
            <circle
              cx={px / 2}
              cy={px / 2}
              r={rad}
              fill="none"
              stroke={TONE[r].ring}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${(circ * value) / 100} ${circ}`}
              className="transition-[stroke-dasharray] duration-700"
            />
          )}
        </svg>
        <span
          className={cx(
            'absolute inset-0 flex items-center justify-center font-semibold tabular-nums',
            TONE[r].text,
            size === 'lg' ? 'text-4xl' : size === 'md' ? 'text-2xl' : 'text-lg',
          )}
        >
          {value ?? '–'}
        </span>
      </span>
      <span className={cx('mt-2 text-center font-medium text-slate-800', size === 'lg' ? 'text-xl' : 'w-24 text-sm leading-tight')}>{label}</span>
    </>
  );
  const aria = `${label}: ${value === null ? 'not scored' : `${value} out of 100, ${TONE[r].label.toLowerCase()}`}`;
  return href ? (
    <a href={href} className="flex flex-col items-center rounded-xl p-2 hover:bg-slate-100" aria-label={aria}>
      {body}
    </a>
  ) : (
    <div className="flex flex-col items-center" role="img" aria-label={aria}>
      {body}
    </div>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs text-slate-600" aria-label="Score legend">
      <li className="inline-flex items-center gap-1.5">
        <RatingShape rating="fail" /> 0–49 Poor
      </li>
      <li className="inline-flex items-center gap-1.5">
        <RatingShape rating="average" /> 50–89 Needs improvement
      </li>
      <li className="inline-flex items-center gap-1.5">
        <RatingShape rating="pass" /> 90–100 Good
      </li>
    </ul>
  );
}

// ---------------------------------------------------------------- text and values

/** Lighthouse descriptions use Markdown links and `code`. */
function Markdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1])
      parts.push(
        <a
          key={m.index}
          href={m[2]}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-0.5 font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          {m[1]}
          <ExternalLink className="size-3" aria-hidden />
        </a>,
      );
    else
      parts.push(
        <code key={m.index} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800">
          {m[3]}
        </code>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const kib = (b: number) => `${(b / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v).toLocaleString()} ms`);

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname.length > 60 ? `…${x.pathname.slice(-58)}` : x.pathname;
    return `${path}${x.search ? '?…' : ''}`;
  } catch {
    return u.length > 70 ? `${u.slice(0, 67)}…` : u;
  }
}

function Cell({ v, valueType }: { v: LhValue | undefined; valueType?: string }) {
  if (v === null || v === undefined) return <span className="text-slate-500">—</span>;
  if (typeof v === 'boolean') return <span>{v ? 'Yes' : 'No'}</span>;
  if (typeof v === 'number') {
    if (valueType === 'bytes') return <span className="tabular-nums">{kib(v)}</span>;
    if (valueType === 'ms' || valueType === 'timespanMs') return <span className="tabular-nums">{ms(v)}</span>;
    return <span className="tabular-nums">{v.toLocaleString(undefined, { maximumFractionDigits: 3 })}</span>;
  }
  if (typeof v === 'string') return <span className="break-words">{v}</span>;
  if (v.type === 'node')
    return (
      <span className="block min-w-0">
        {v.label && <span className="block text-slate-800">{v.label}</span>}
        {v.snippet && <code className="mt-0.5 block font-mono text-[11px] break-all text-sky-700">{v.snippet}</code>}
        {v.selector && <span className="mt-0.5 block font-mono text-[11px] break-all text-slate-500">{v.selector}</span>}
      </span>
    );
  if (v.type === 'url' || v.type === 'source')
    return (
      <span className="block min-w-0">
        <span className="block font-medium break-all text-slate-800">{shortUrl(v.value)}</span>
        <span className="block text-[11px] break-all text-slate-500">
          {(() => {
            try {
              return new URL(v.value).host;
            } catch {
              return '';
            }
          })()}
        </span>
      </span>
    );
  return <code className="font-mono text-[11px] break-all">{v.value}</code>;
}

function DetailsTable({ d }: { d: LhDetails }) {
  if (d.type === 'list' && d.lists)
    return (
      <div className="space-y-3">
        {d.lists.map((x, i) => (
          <DetailsTable key={i} d={x} />
        ))}
      </div>
    );
  if (!d.headings?.length || !d.items?.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label="Affected items">
      <table className="w-full min-w-[28rem] text-left text-xs">
        <thead>
          <tr className="bg-slate-50">
            {d.headings.map((h) => (
              <th key={h.key} scope="col" className="px-3 py-2 font-semibold text-slate-600">
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.items.map((it, i) => (
            <tr key={i} className="border-t border-slate-100 align-top">
              {d.headings!.map((h) => (
                <td key={h.key} className="max-w-md px-3 py-2 text-slate-700">
                  <Cell v={it[h.key]} valueType={h.valueType} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {d.totalItems !== undefined && d.totalItems > (d.items?.length ?? 0) && (
        <p className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
          Showing {d.items.length} of {d.totalItems} items.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- audits

function savingsText(a: LhAuditDTO): string | null {
  const s = a.metricSavings;
  if (!s) return null;
  const parts = Object.entries(s)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => (k === 'CLS' ? `${k} ${v.toFixed(3)}` : `${k} ${ms(v)}`));
  return parts.length ? `Est. savings: ${parts.join(' · ')}` : null;
}

// Cloudflare adds its bot-detection script ("JavaScript Detections") to every page it serves. Newer Chrome
// versions report deprecated APIs inside it, which lowers Best Practices without any fault in the site's code.
const CLOUDFLARE_JSD = '/cdn-cgi/challenge-platform/';
const CLOUDFLARE_DEPRECATION_FIX = [
  'These warnings come from `/cdn-cgi/challenge-platform/…/main.js` — Cloudflare’s **JavaScript Detections** script, which Cloudflare adds to every page. Your theme and plugins are not the cause.',
  'Newer Chrome versions flag APIs this script uses. PageSpeed Insights may run an older Chrome that does not flag them yet, which is why its Best Practices score can be higher than this one.',
  'To remove the warnings: in the Cloudflare dashboard open **Security → Bots** and turn off **JavaScript Detections** (on the Free plan it comes with Bot Fight Mode) — only if you do not rely on it for bot protection.',
  'Otherwise leave it: Cloudflare updates this script itself, and the score recovers when it does. Nothing on the website needs changing.',
];

function deprecationSources(a: LhAuditDTO): { cloudflare: number; total: number } {
  const items = a.details && 'items' in a.details && Array.isArray(a.details.items) ? a.details.items : [];
  return { cloudflare: items.filter((i) => JSON.stringify(i).includes(CLOUDFLARE_JSD)).length, total: items.length };
}

export function AuditItem({ a }: { a: LhAuditDTO }) {
  const rating = ratingOf(a);
  const dep = a.id === 'deprecations' ? deprecationSources(a) : null;
  const steps = dep && dep.cloudflare > 0 && dep.cloudflare === dep.total ? CLOUDFLARE_DEPRECATION_FIX : (LH_FIXES[a.id] ?? GENERIC_FIX);
  const savings = savingsText(a);
  return (
    <details className="group border-t border-slate-200 first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-slate-100 [&::-webkit-details-marker]:hidden">
        <RatingShape rating={rating} />
        <span className="sr-only">{TONE[rating].label}: </span>
        <span className="min-w-0 flex-1 text-sm text-slate-900">
          <Markdown text={a.title} />
          {a.displayValue && (
            <span className={cx('ml-2 text-sm', rating === 'fail' ? 'text-red-700' : rating === 'average' ? 'text-orange-700' : 'text-slate-500')}>— {a.displayValue}</span>
          )}
        </span>
        <ChevronDown className="size-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-4 border-t border-slate-100 bg-slate-50/40 px-4 py-4 sm:pl-10">
        <p className="text-sm leading-relaxed text-slate-700">
          <Markdown text={a.description} />
        </p>
        {savings && <p className="inline-flex rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-xs font-medium text-orange-800">{savings}</p>}
        {dep && dep.cloudflare > 0 && (
          <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
            {dep.cloudflare === dep.total ? 'All' : `${dep.cloudflare} of ${dep.total}`} of these warnings come from Cloudflare’s bot-detection script, not from the website’s own
            code.
          </p>
        )}
        {rating !== 'pass' && rating !== 'na' && (
          <div>
            <h5 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">How to fix</h5>
            <ol className="mt-2 space-y-2">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-3 text-sm text-slate-800">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-on-brand">{i + 1}</span>
                  <span className="pt-0.5">
                    <Markdown text={s} />
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {a.details && (
          <div>
            <h5 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">What Lighthouse found</h5>
            <DetailsTable d={a.details} />
          </div>
        )}
        {a.warnings?.map((w) => (
          <p key={w} className="text-xs text-amber-800">
            Warning: {w}
          </p>
        ))}
        {a.errorMessage && <p className="text-xs text-red-700">Lighthouse error: {a.errorMessage}</p>}
      </div>
    </details>
  );
}

function AuditList({ title, audits, description, collapsed, count = true }: { title: string; audits: LhAuditDTO[]; description?: string; collapsed?: boolean; count?: boolean }) {
  if (!audits.length) return null;
  const list = (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-surface">
      {audits.map((a) => (
        <AuditItem key={a.id} a={a} />
      ))}
    </div>
  );
  const heading = (
    <>
      {title}
      {count && <span className="ml-1 font-normal text-slate-500">({audits.length})</span>}
    </>
  );
  if (collapsed)
    return (
      <details className="group/list mt-6">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg py-2 text-xs font-semibold tracking-wide text-slate-600 uppercase hover:text-slate-900 [&::-webkit-details-marker]:hidden">
          <span>{heading}</span>
          <span className="inline-flex items-center gap-1 text-xs font-medium tracking-normal normal-case text-brand-700">
            <span className="group-open/list:hidden">Show</span>
            <span className="hidden group-open/list:inline">Hide</span>
            <ChevronDown className="size-4 transition-transform group-open/list:rotate-180" aria-hidden />
          </span>
        </summary>
        {description && (
          <p className="mb-2 text-xs text-slate-500">
            <Markdown text={description} />
          </p>
        )}
        {list}
      </details>
    );
  return (
    <section className="mt-6">
      <h4 className="mb-2 text-xs font-semibold tracking-wide text-slate-600 uppercase">{heading}</h4>
      {list}
      {description && (
        <p className="mt-2 text-xs text-slate-500">
          <Markdown text={description} />
        </p>
      )}
    </section>
  );
}

const severityOrder = (a: LhAuditDTO) => ({ fail: 0, average: 1, info: 2, pass: 3, na: 4 })[ratingOf(a)];
const biggestSaving = (a: LhAuditDTO) =>
  Math.max(
    0,
    ...Object.entries(a.metricSavings ?? {})
      .filter(([k]) => k !== 'CLS')
      .map(([, v]) => v),
  );
const sortAudits = (list: LhAuditDTO[]) => [...list].sort((x, y) => severityOrder(x) - severityOrder(y) || biggestSaving(y) - biggestSaving(x));

// ---------------------------------------------------------------- performance

function EnvIcon({ text }: { text: string }) {
  const c = 'size-4 shrink-0 text-slate-500';
  if (/^Captured/.test(text)) return <CalendarClock className={c} aria-hidden />;
  if (/mobile device/i.test(text)) return <Smartphone className={c} aria-hidden />;
  if (/desktop/i.test(text) && /Emulated/.test(text)) return <Monitor className={c} aria-hidden />;
  if (/throttl|network/i.test(text)) return <Wifi className={c} aria-hidden />;
  if (/Single page/i.test(text)) return <Timer className={c} aria-hidden />;
  if (/Lighthouse/i.test(text)) return <GaugeIcon className={c} aria-hidden />;
  return <Globe className={c} aria-hidden />;
}

function PerformanceSection({ cat, r }: { cat: LhCategoryDTO; r: LighthouseReportDTO }) {
  const [expanded, setExpanded] = useState(false);
  const [metricFilter, setMetricFilter] = useState<string>('All');
  const group = (id: string) =>
    cat.groups
      .find((g) => g.id === id)
      ?.auditIds.map((a) => r.audits[a])
      .filter(Boolean) ?? [];
  const metrics = group('metrics');
  const relevant = (a: LhAuditDTO) => metricFilter === 'All' || (a.metricSavings && metricFilter in a.metricSavings);
  const split = (list: LhAuditDTO[]) => ({
    open: sortAudits(list.filter((a) => relevant(a) && ['fail', 'average', 'info'].includes(ratingOf(a)))),
    passed: list.filter((a) => relevant(a) && ['pass', 'na'].includes(ratingOf(a))),
  });
  const insights = split(group('insights'));
  const diagnostics = split(group('diagnostics'));

  return (
    <section id="lh-performance" className="scroll-mt-6">
      <div className="grid items-center gap-6 md:grid-cols-[1fr_auto]">
        <div className="flex flex-col items-center gap-3 text-center">
          <ScoreGauge score={cat.score} label="Performance" size="lg" />
          <p className="max-w-md text-xs text-slate-600">
            Values are estimated and may vary. The performance score is calculated directly from these metrics. These are lab measurements from one page load, not data from real
            visitors.
          </p>
          <Legend />
        </div>
        {r.finalScreenshot && (
          <figure className="mx-auto w-40 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 md:w-48">
            <img src={r.finalScreenshot} alt={`How ${r.pageUrl} looked when the ${r.formFactor} test finished`} className="w-full" />
          </figure>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between border-b border-slate-200 pb-2">
        <h4 className="text-xs font-semibold tracking-wide text-slate-600 uppercase">Metrics</h4>
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="rounded text-xs font-medium text-brand-700 hover:underline">
          {expanded ? 'Collapse view' : 'Expand view'}
        </button>
      </div>
      <dl className="grid gap-x-8 sm:grid-cols-2">
        {metrics.map((m) => {
          const rt = ratingOf(m);
          return (
            <div key={m.id} className="border-b border-slate-200 py-4">
              <dt className="flex items-center gap-2 text-sm text-slate-800">
                <RatingShape rating={rt} />
                {m.title}
                <span className="sr-only">({TONE[rt].label})</span>
              </dt>
              <dd className={cx('mt-1 pl-5 text-3xl font-semibold tabular-nums', TONE[rt].text)}>{m.displayValue ?? '—'}</dd>
              {expanded && (
                <dd className="mt-2 pl-5 text-xs leading-relaxed text-slate-600">
                  <Markdown text={m.description} />
                </dd>
              )}
            </div>
          );
        })}
      </dl>

      <ul className="mt-4 grid gap-x-6 gap-y-2 rounded-lg bg-slate-100 px-4 py-3 text-xs text-slate-700 sm:grid-cols-2 lg:grid-cols-3" aria-label="Test conditions">
        {[`Captured at ${fmtDateTime(r.fetchTime)}`, ...r.environment].map((e) => (
          <li key={e} className="flex items-center gap-2">
            <EnvIcon text={e} />
            {e}
          </li>
        ))}
      </ul>

      {r.filmstrip.length > 0 && (
        <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Filmstrip of the page loading">
          <ol className="flex gap-2">
            {r.filmstrip.map((f) => (
              <li key={f.timingMs} className="shrink-0 text-center">
                <img src={f.data} alt={`At ${ms(f.timingMs)}`} className="h-24 rounded border border-slate-200 bg-slate-50" />
                <span className="mt-1 block text-[11px] text-slate-500 tabular-nums">{ms(f.timingMs)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2" role="group" aria-label="Show audits relevant to a metric">
        <span className="text-xs text-slate-600">Show audits relevant to:</span>
        {['All', 'FCP', 'LCP', 'TBT', 'CLS'].map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={metricFilter === k}
            onClick={() => setMetricFilter(k)}
            className={cx(
              'rounded-full border px-3 py-1 text-xs font-semibold',
              metricFilter === k ? 'border-brand-600 bg-brand-600 text-on-brand' : 'border-slate-300 text-slate-700 hover:bg-slate-100',
            )}
          >
            {k}
          </button>
        ))}
      </div>

      <AuditList
        title="Insights"
        audits={insights.open}
        description="Opportunities found in this page load, with estimated savings. Fixing them is the most direct way to improve the score."
        count={false}
      />
      <AuditList
        title="Diagnostics"
        audits={diagnostics.open}
        description="More information about the performance of your application. These numbers do not directly affect the score."
        count={false}
      />
      <AuditList title="Passed audits" audits={[...insights.passed, ...diagnostics.passed]} collapsed />
    </section>
  );
}

// ---------------------------------------------------------------- other categories

function CategorySection({ cat, r }: { cat: LhCategoryDTO; r: LighthouseReportDTO }) {
  const all = cat.groups.flatMap((g) => g.auditIds.map((id) => ({ a: r.audits[id], g })).filter((x) => x.a));
  // As in PageSpeed Insights, a group lists its failing audits and its informative ones (grey circle,
  // e.g. Trust and Safety: CSP, HSTS, COOP, XFO) — passed, manual and not-applicable audits go below.
  const failing = (ids: string[]) => sortAudits(ids.map((id) => r.audits[id]).filter((a) => a && ['fail', 'average', 'info'].includes(ratingOf(a))));
  const manual = all.filter(({ a }) => a.scoreDisplayMode === 'manual').map(({ a }) => a);
  const passed = all.filter(({ a }) => ratingOf(a) === 'pass').map(({ a }) => a);
  const na = all.filter(({ a }) => a.scoreDisplayMode === 'notApplicable').map(({ a }) => a);
  const groups = cat.groups.filter((g) => g.title && failing(g.auditIds).length);
  const ungroupedFailing = failing(cat.groups.filter((g) => !g.title).flatMap((g) => g.auditIds));
  const anyFailing = all.some(({ a }) => ['fail', 'average'].includes(ratingOf(a)));

  return (
    <section id={`lh-${cat.id}`} className="scroll-mt-6 border-t border-slate-200 pt-10">
      <div className="flex flex-col items-center text-center">
        <ScoreGauge score={cat.score} label={cat.title} size="lg" />
        {cat.description && (
          <p className="mt-3 max-w-xl text-xs leading-relaxed text-slate-600">
            <Markdown text={cat.description} />
          </p>
        )}
      </div>
      {groups.map((g) => (
        <AuditList key={g.id} title={g.title} audits={failing(g.auditIds)} description={g.description} count={false} />
      ))}
      <AuditList title="Other findings" audits={ungroupedFailing} count={false} />
      {!anyFailing && (
        <p className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Every automatically scored {cat.title.toLowerCase()} audit passed.
        </p>
      )}
      <AuditList
        title="Additional items to manually check"
        audits={manual}
        description="These items address areas an automated testing tool cannot cover. Check them yourself."
        collapsed
      />
      <AuditList title="Passed audits" audits={passed} collapsed />
      <AuditList title="Not applicable" audits={na} collapsed />
    </section>
  );
}

// ---------------------------------------------------------------- report

function ReportBody({ r }: { r: LighthouseReportDTO }) {
  const perf = r.categories.find((c) => c.id === 'performance');
  const others = r.categories.filter((c) => c.id !== 'performance');
  return (
    <div>
      <div className="grid grid-cols-3 justify-items-center gap-y-4 sm:grid-cols-5" role="list" aria-label="Category scores">
        {r.categories.map((c) => (
          <div key={c.id} role="listitem">
            <ScoreGauge score={c.score} label={c.title} size="sm" href={`#lh-${c.id}`} />
          </div>
        ))}
      </div>
      <div className="mt-8 space-y-10">
        {perf && <PerformanceSection cat={perf} r={r} />}
        {others.map((c) => (
          <Fragment key={c.id}>
            <CategorySection cat={c} r={r} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- real-user (field) data

const FIELD_INFO: Record<FieldMetricId, { name: string; abbr: string; href: string; experimental?: boolean }> = {
  lcp: {
    name: 'Largest Contentful Paint',
    abbr: 'LCP',
    href: 'https://web.dev/articles/lcp',
  },
  inp: {
    name: 'Interaction to Next Paint',
    abbr: 'INP',
    href: 'https://web.dev/articles/inp',
  },
  cls: {
    name: 'Cumulative Layout Shift',
    abbr: 'CLS',
    href: 'https://web.dev/articles/cls',
  },
  fcp: {
    name: 'First Contentful Paint',
    abbr: 'FCP',
    href: 'https://web.dev/articles/fcp',
  },
  ttfb: {
    name: 'Time to First Byte',
    abbr: 'TTFB',
    href: 'https://web.dev/articles/ttfb',
    experimental: true,
  },
};
const CORE_VITALS: FieldMetricId[] = ['lcp', 'inp', 'cls'];
const OTHER_FIELD: FieldMetricId[] = ['fcp', 'ttfb'];
const DIST_LABELS = ['Good', 'Needs improvement', 'Poor'] as const;
const DIST_COLOURS = [PSI.pass, PSI.average, PSI.fail];

const fieldRating = (id: FieldMetricId, v: number): Rating => (v <= FIELD_THRESHOLDS[id][0] ? 'pass' : v <= FIELD_THRESHOLDS[id][1] ? 'average' : 'fail');
function fmtField(id: FieldMetricId, v: number): string {
  if (id === 'cls') return v === 0 ? '0' : String(Number(v.toFixed(2)));
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
function fmtPeriod(first: string, last: string): string {
  const d = (s: string, year: boolean) =>
    new Date(`${s}T00:00:00`).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      ...(year ? { year: 'numeric' } : {}),
    });
  return first && last ? `${d(first, false)} – ${d(last, true)}` : '';
}

function ExternalText({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx('underline decoration-slate-400 underline-offset-2 hover:decoration-slate-900', className)}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * "?" help with a tooltip, as in PageSpeed Insights: shown on hover or keyboard focus, stays while the
 * pointer is over it, and Escape dismisses it (WCAG 1.4.13).
 */
function HelpTip({ label, children, align = 'center' }: { label: string; children: ReactNode; align?: 'center' | 'start' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900"
      >
        <CircleHelp className="size-3.5" aria-hidden />
        <span className="sr-only">{label}</span>
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className={cx(
            'absolute bottom-full z-20 mb-1.5 w-max max-w-72 rounded-md bg-slate-900 px-2.5 py-1.5 text-left text-xs leading-snug font-normal text-slate-50 shadow-lg',
            align === 'center' ? 'left-1/2 -translate-x-1/2' : '-left-2',
          )}
        >
          {children}
        </span>
      )}
    </span>
  );
}

/** PageSpeed Insights' Core Web Vitals badge: a pulse line ending in the result's shape. */
function VitalsBadge({ state }: { state: 'passed' | 'failed' | null }) {
  const colour = state === 'passed' ? PSI.pass : state === 'failed' ? PSI.fail : 'var(--color-slate-400)';
  return (
    <span
      className={cx(
        'flex size-14 shrink-0 items-center justify-center rounded-full',
        state === 'passed' ? 'bg-[#0cce6b]/15' : state === 'failed' ? 'bg-[#ff4e42]/15' : 'bg-slate-100',
      )}
    >
      <svg viewBox="0 0 32 16" className="w-8" aria-hidden>
        {state === 'failed' ? (
          <>
            <polyline points="1,8 9,8 11,6 13,10 15,8 19,8" fill="none" stroke={colour} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
            <path d="M24 4.5 28 11.5H20Z" fill={colour} />
            <circle cx="30.5" cy="8" r="1" fill={colour} />
          </>
        ) : (
          <>
            <polyline points="1,8 8,8 11,3 14,13 17,8 22,8" fill="none" stroke={colour} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
            {state === 'passed' && <circle cx="27" cy="8" r="2.6" fill={colour} />}
          </>
        )}
      </svg>
    </span>
  );
}

/** The round "real users" badge beside the section title. */
function RealUsersBadge() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-sky-200 to-sky-100" aria-hidden>
      <svg viewBox="0 0 20 20" className="size-5">
        <circle cx="10" cy="6" r="1.8" fill="#1a73e8" />
        <rect x="8.4" y="9" width="3.2" height="7" rx="1" fill="#1a73e8" />
        <rect x="3.6" y="11.5" width="3.2" height="4.5" rx="1" fill="#669df6" />
        <rect x="13.2" y="10.5" width="3.2" height="5.5" rx="1" fill="#669df6" />
      </svg>
    </span>
  );
}

/** This scan's Lighthouse values in the field layout's shape (lab: one emulated visit, not real users). */
interface LabSnapshot {
  values: Partial<Record<FieldMetricId, number>>;
  fetchTime: string;
  environment: string[];
  version: string;
}

function labSnapshot(r: LighthouseReportDTO): LabSnapshot {
  const values: Partial<Record<FieldMetricId, number>> = {};
  const num = (id: string) => r.audits[id]?.numericValue;
  for (const [key, audit] of [
    ['lcp', 'largest-contentful-paint'],
    ['cls', 'cumulative-layout-shift'],
    ['fcp', 'first-contentful-paint'],
  ] as const) {
    const v = num(audit);
    if (typeof v === 'number' && Number.isFinite(v)) values[key] = v;
  }
  // TTFB: the main document's server response time Lighthouse observed (older reports: the server-response-time audit).
  const srt = num('server-response-time');
  const observed = /observed ([\d,.]+)\s*ms/i.exec(JSON.stringify(r.audits['document-latency-insight']?.details ?? ''))?.[1];
  const ttfb = typeof srt === 'number' ? srt : observed ? Number(observed.replace(/,/g, '')) : undefined;
  if (ttfb !== undefined && Number.isFinite(ttfb)) values.ttfb = ttfb;
  // INP needs real interactions, so a lab run cannot measure it.
  return { values, fetchTime: r.fetchTime, environment: r.environment, version: r.lighthouseVersion };
}

/**
 * A lab value on the Core Web Vitals scale: green / orange / red zones sized by the thresholds and a
 * marker where the measured value falls (a single measurement has no distribution of visits).
 */
function LabScale({ id, value, rating, expanded }: { id: FieldMetricId; value: number; rating: Rating; expanded: boolean }) {
  const [good, poor] = FIELD_THRESHOLDS[id];
  const max = poor * 1.5;
  const zones = [good / max, (poor - good) / max, (max - poor) / max];
  const at = Math.min(Math.max(value / max, 0.01), 0.99) * 100;
  const text = fmtField(id, value);
  return (
    <>
      <div
        className={cx('mt-2 w-fit -translate-x-1/2 text-xl font-medium whitespace-nowrap tabular-nums', TONE[rating].text)}
        style={{ marginLeft: `${Math.min(Math.max(at, 12), 88)}%` }}
      >
        {text}
      </div>
      <div
        className="relative mt-1.5"
        role="img"
        aria-label={`${FIELD_INFO[id].abbr} lab value ${text}, ${TONE[rating].label.toLowerCase()}. Good up to ${fmtField(id, good)}, poor above ${fmtField(id, poor)}.`}
      >
        <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
          {zones.map((z, i) => (
            <span key={i} className="h-full" style={{ width: `${z * 100}%`, background: DIST_COLOURS[i] }} />
          ))}
        </div>
        <svg viewBox="0 0 10 16" className="absolute -top-2 h-4 w-2.5 -translate-x-1/2" style={{ left: `${at}%` }} aria-hidden>
          <line x1="5" y1="7" x2="5" y2="16" stroke="var(--color-slate-700)" strokeWidth="1.5" />
          <circle cx="5" cy="4.5" r="3" fill="var(--color-surface)" stroke="var(--color-slate-700)" strokeWidth="1.5" />
        </svg>
      </div>
      {expanded && (
        <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
          {[`≤ ${fmtField(id, good)}`, `≤ ${fmtField(id, poor)}`, `> ${fmtField(id, poor)}`].map((range, i) => (
            <div key={i} className="rounded-md bg-slate-100 px-2 py-1.5">
              <dt className="flex items-center gap-1 text-slate-600">
                <RatingShape rating={(['pass', 'average', 'fail'] as const)[i]} className="size-2.5" />
                {DIST_LABELS[i]}
              </dt>
              <dd className="mt-0.5 font-semibold text-slate-900 tabular-nums">{range}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/** One field metric: rating shape, linked name, 75th-percentile value and the good / NI / poor distribution with the p75 marker. */
function FieldMetric({
  id,
  m,
  lab,
  expanded,
  naReason = 'not enough real-user data',
}: {
  id: FieldMetricId;
  m: FieldMetricDTO | undefined;
  /** This scan's own Lighthouse measurement, shown only while real-user data is not connected. */
  lab?: number;
  expanded: boolean;
  naReason?: string;
}) {
  const info = FIELD_INFO[id];
  const r: Rating = m ? fieldRating(id, m.p75) : lab !== undefined ? fieldRating(id, lab) : 'na';
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        {m || lab !== undefined ? <RatingShape rating={r} /> : <span className="size-2.5 shrink-0 rounded-full bg-slate-400" aria-hidden />}
        <ExternalText href={info.href} className="text-sm text-slate-900 xl:text-[15px]">
          {info.name} ({info.abbr})
        </ExternalText>
        {info.experimental && (
          <span title="Experimental metric" className="inline-flex text-sky-600">
            <FlaskConical className="size-3.5" aria-hidden />
            <span className="sr-only">(experimental metric)</span>
          </span>
        )}
      </div>
      {m ? (
        <>
          {/* The 75th percentile always sits three-quarters of the way along the distribution, as in PageSpeed Insights. */}
          <div className={cx('mt-2 w-fit -translate-x-1/2 text-xl font-medium whitespace-nowrap tabular-nums', TONE[r].text)} style={{ marginLeft: '75%' }}>
            {fmtField(id, m.p75)}
          </div>
          <div
            className="relative mt-1.5"
            role="img"
            aria-label={`${info.abbr} 75th percentile ${fmtField(id, m.p75)}, ${TONE[r].label.toLowerCase()}. ${m.distribution.map((x, i) => `${pct(x)} ${DIST_LABELS[i].toLowerCase()}`).join(', ')}.`}
          >
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
              {m.distribution.map((x, i) =>
                x > 0 ? (
                  <span
                    key={i}
                    className="h-full"
                    style={{
                      width: `${x * 100}%`,
                      minWidth: 3,
                      background: DIST_COLOURS[i],
                    }}
                  />
                ) : null,
              )}
            </div>
            <svg viewBox="0 0 10 16" className="absolute -top-2 h-4 w-2.5 -translate-x-1/2" style={{ left: '75%' }} aria-hidden>
              <line x1="5" y1="7" x2="5" y2="16" stroke="var(--color-slate-700)" strokeWidth="1.5" />
              <circle cx="5" cy="4.5" r="3" fill="var(--color-surface)" stroke="var(--color-slate-700)" strokeWidth="1.5" />
            </svg>
          </div>
          {expanded && (
            <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
              {m.distribution.map((x, i) => (
                <div key={i} className="rounded-md bg-slate-100 px-2 py-1.5">
                  <dt className="flex items-center gap-1 text-slate-600">
                    <RatingShape rating={(['pass', 'average', 'fail'] as const)[i]} className="size-2.5" />
                    {DIST_LABELS[i]}
                  </dt>
                  <dd className="mt-0.5 font-semibold text-slate-900 tabular-nums">{pct(x)}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      ) : lab !== undefined ? (
        <LabScale id={id} value={lab} rating={r} expanded={expanded} />
      ) : (
        // Not enough data for this metric: PageSpeed Insights shows N/A on a grey bar.
        <>
          <div className="mt-2 w-fit -translate-x-1/2 text-xl font-medium text-slate-500" style={{ marginLeft: '75%' }}>
            N/A
          </div>
          <div className="relative mt-1.5" role="img" aria-label={`${info.abbr}: ${naReason} (N/A).`}>
            <div className="h-1.5 rounded-full bg-slate-300" />
            <svg viewBox="0 0 10 16" className="absolute -top-2 h-4 w-2.5 -translate-x-1/2" style={{ left: '75%' }} aria-hidden>
              <line x1="5" y1="7" x2="5" y2="16" stroke="var(--color-slate-500)" strokeWidth="1.5" />
              <circle cx="5" cy="4.5" r="3" fill="var(--color-surface)" stroke="var(--color-slate-500)" strokeWidth="1.5" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}

function FieldDataSection({ scanId, page, viewport, lab }: { scanId: string; page: string; viewport: 'mobile' | 'desktop'; lab: LabSnapshot | null }) {
  const field = useApi<FieldDataDTO>(`/scans/${scanId}/field-data?page=${encodeURIComponent(page)}`);
  const [scope, setScope] = useState<'url' | 'origin'>('url');
  const [expanded, setExpanded] = useState(false);
  const d = field.data;
  const device = d ? (viewport === 'mobile' ? d.phone : d.desktop) : null;
  // Like PageSpeed Insights: with too little traffic to this exact URL, fall back to the whole origin.
  const fellBack = scope === 'url' && !!device && !device.url && !!device.origin;
  const rec = device ? (scope === 'origin' || fellBack ? device.origin : device.url) : null;
  const lcp = rec?.metrics.lcp;
  const cls = rec?.metrics.cls;
  const assessment: 'passed' | 'failed' | null =
    lcp && cls ? (CORE_VITALS.every((id) => !rec.metrics[id] || fieldRating(id, rec.metrics[id]!.p75) === 'pass') ? 'passed' : 'failed') : null;

  // Not connected or unavailable: still the PageSpeed Insights layout, with every metric N/A and a notice.
  const notConnected = d?.status === 'not_configured' || d?.status === 'unavailable';
  const shown: FieldRecordDTO | null = notConnected ? { metrics: {}, firstDate: '', lastDate: '' } : rec;
  // Meanwhile, this scan's own Lighthouse measurements fill the layout, clearly labelled as lab values.
  const labVals = notConnected && lab && Object.keys(lab.values).length ? lab.values : undefined;
  const naReasonFor = (id: FieldMetricId) =>
    labVals && id === 'inp' ? 'needs real visitors; a lab test cannot measure it' : notConnected ? 'real-user data not connected' : undefined;
  // Lab mode: the same rule PageSpeed Insights uses without INP data — LCP and CLS both "Good" — applied
  // to this scan's measured values, and tagged "Lab" so it is never mistaken for the real-user verdict.
  const labAssessment: 'passed' | 'failed' | null =
    labVals?.lcp !== undefined && labVals.cls !== undefined
      ? fieldRating('lcp', labVals.lcp) === 'pass' && fieldRating('cls', labVals.cls) === 'pass'
        ? 'passed'
        : 'failed'
      : null;
  const shownAssessment = notConnected ? labAssessment : assessment;
  const verdict =
    shownAssessment === 'passed'
      ? { text: 'Passed', tone: 'text-[#0cce6b]' }
      : shownAssessment === 'failed'
        ? { text: 'Failed', tone: 'text-[#ff4e42]' }
        : notConnected
          ? { text: d?.status === 'unavailable' ? 'Unavailable' : 'Not connected', tone: 'text-slate-600' }
          : { text: 'Not enough data', tone: 'text-slate-600' };
  const labVerdict = notConnected && labAssessment !== null;
  const pad = 'px-4 sm:px-6';

  return (
    <section aria-labelledby="field-heading">
      <div className="flex flex-wrap items-center gap-3">
        <RealUsersBadge />
        <h4 id="field-heading" className="min-w-0 flex-1 text-base font-medium text-slate-900 sm:text-lg">
          Discover what your real users are experiencing
        </h4>
        <div role="group" aria-label="Field data for" className="inline-flex overflow-hidden rounded border border-slate-300 text-sm">
          {(['url', 'origin'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
              className={cx(
                'px-2.5 py-1 transition-colors',
                scope === s ? 'bg-slate-200 text-slate-900' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                s === 'origin' && 'border-l border-slate-300',
              )}
            >
              {s === 'url' ? 'This URL' : 'Origin'}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-surface">
        {field.loading && !d ? (
          <div className="p-6">
            <LoadingState label="Fetching real-user data from the Chrome UX Report…" />
          </div>
        ) : field.error ? (
          <div className="p-6">
            <ErrorState error={field.error} onRetry={field.reload} />
          </div>
        ) : d?.status === 'ok' && !rec ? (
          <div className="px-6 py-8 text-center text-sm">
            <p className="font-medium text-slate-900">No Data</p>
            <p className="mx-auto mt-1 max-w-xl text-slate-600">
              The Chrome UX Report does not have enough real-world speed data for {scope === 'url' ? 'this page or its origin' : 'this origin'} on{' '}
              {viewport === 'mobile' ? 'mobile' : 'desktop'}. Sites need a meaningful number of Chrome visitors to be included. The lab data below still applies.
            </p>
          </div>
        ) : shown ? (
          <>
            {notConnected && (
              <div className={cx('border-b border-slate-200 bg-slate-100 py-2.5 text-sm text-slate-700', pad)}>
                {d?.status === 'unavailable' ? (
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      <span className="font-medium text-slate-900">Real-user data could not be loaded.</span> {d.message}
                    </span>
                    <button type="button" onClick={field.reload} className="rounded font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800">
                      Try again
                    </button>
                  </p>
                ) : (
                  <details className="group/connect">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 [&::-webkit-details-marker]:hidden">
                      <span>
                        <span className="font-medium text-slate-900">Real-user data is not connected yet</span>
                        {labVals
                          ? ' — showing this scan’s lab measurements (one Lighthouse test visit) until it is. INP needs real visitors, so it shows N/A.'
                          : ' — values show N/A until it is. Nothing is estimated.'}
                      </span>
                      <span className="inline-flex items-center gap-1 font-medium text-brand-700">
                        How to connect
                        <ChevronDown className="size-4 transition-transform group-open/connect:rotate-180" aria-hidden />
                      </span>
                    </summary>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-700">
                      <li>
                        In <ExternalText href="https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com">Google Cloud Console</ExternalText>, enable the “Chrome
                        UX Report API” (free).
                      </li>
                      <li>Create an API key under APIs &amp; Services → Credentials, and restrict it to that API.</li>
                      <li>
                        Add <code className="rounded bg-surface px-1 py-0.5 text-xs">CRUX_API_KEY=your-key</code> to the server’s{' '}
                        <code className="rounded bg-surface px-1 py-0.5 text-xs">.env</code> and restart it.
                      </li>
                    </ol>
                  </details>
                )}
              </div>
            )}
            {fellBack && (
              <p className={cx('border-b border-slate-200 bg-slate-100 py-2.5 text-sm text-slate-700', pad)}>
                There is not enough real-user data for this exact URL, so the whole origin ({d!.origin}) is shown.
              </p>
            )}

            <div className={cx('pt-6', pad)}>
              <div className="flex items-center justify-center gap-3 sm:gap-5">
                <VitalsBadge state={shownAssessment} />
                <p className="text-base text-slate-900 sm:text-lg">
                  Core Web Vitals Assessment: <span className={cx('font-medium', verdict.tone)}>{verdict.text}</span>
                  {labVerdict && (
                    <span className="ml-2 inline-flex items-center rounded-full border border-slate-300 px-2 py-0.5 align-middle text-xs font-medium text-slate-700">
                      Lab<span className="sr-only"> result, from this scan’s Lighthouse test visit (not real-user data)</span>
                    </span>
                  )}{' '}
                  <HelpTip label="What is the Core Web Vitals assessment?">
                    {labVerdict
                      ? 'Lab result: Largest Contentful Paint and Cumulative Layout Shift from this scan’s Lighthouse test visit are both “Good” (passed) or not (failed). The official assessment uses real visitors over 28 days and appears here once real-user data is connected.'
                      : 'The assessment passes when the 75th percentile of LCP, INP and CLS are all “Good” — at least three in four real visits had a good experience. Without enough INP data it is judged on LCP and CLS.'}
                  </HelpTip>
                </p>
              </div>
              {labVerdict && labVals && (
                // Say exactly which measurement decided the lab verdict, against which limit.
                <p className="mx-auto mt-3 max-w-2xl text-center text-sm text-slate-600">
                  {labAssessment === 'passed' ? 'Passed: ' : 'Failed because '}
                  {(['lcp', 'cls'] as const)
                    .filter((id) => labAssessment === 'passed' || fieldRating(id, labVals[id]!) !== 'pass')
                    .map((id) => (
                      <span key={id} className="whitespace-nowrap">
                        {FIELD_INFO[id].name} is <span className={cx('font-medium', TONE[fieldRating(id, labVals[id]!)].text)}>{fmtField(id, labVals[id]!)}</span> (Good is ≤{' '}
                        {fmtField(id, FIELD_THRESHOLDS[id][0])})
                      </span>
                    ))
                    .reduce<ReactNode[]>((all, el, i) => (i ? [...all, <span key={`and${i}`}> and </span>, el] : [el]), [])}
                  .
                  {viewport === 'mobile' && labAssessment === 'failed' && (
                    <span className="mt-1 block text-xs text-slate-500">
                      The mobile lab test imitates a mid-range phone on slow 4G, so it is stricter than most real visits. Google’s official verdict uses real visitors — connect
                      real-user data to see it.
                    </span>
                  )}
                </p>
              )}
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} className="rounded px-1 text-sm text-slate-600 hover:text-slate-900">
                  {expanded ? 'Collapse view' : 'Expand view'}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-7 pb-6 sm:grid-cols-3">
                {CORE_VITALS.map((id) => (
                  <FieldMetric key={id} id={id} m={shown.metrics[id]} lab={labVals?.[id]} expanded={expanded} naReason={naReasonFor(id)} />
                ))}
              </div>
            </div>
            <div className={cx('border-t border-slate-200 pt-5 pb-6', pad)}>
              <h5 className="text-xs tracking-wide text-slate-600 uppercase">Other notable metrics</h5>
              <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-7 sm:grid-cols-3">
                {OTHER_FIELD.map((id) => (
                  <FieldMetric key={id} id={id} m={shown.metrics[id]} lab={labVals?.[id]} expanded={expanded} naReason={naReasonFor(id)} />
                ))}
              </div>
            </div>
            {labVals && lab ? (
              // Lab values: describe the one test visit they come from, not the field data's 28 days of visitors.
              <ul
                className={cx('grid grid-cols-1 gap-x-6 gap-y-3 border-t border-slate-200 bg-slate-100 py-4 text-[13px] text-slate-700 sm:grid-cols-3', pad)}
                aria-label="About these lab values"
              >
                <li className="flex items-center gap-2">
                  <CalendarDays className="size-4 shrink-0 text-slate-600" aria-hidden />
                  Measured {fmtDateTime(lab.fetchTime)}
                </li>
                <li className="flex items-center gap-2">
                  {viewport === 'mobile' ? (
                    <Smartphone className="size-4 shrink-0 text-slate-600" aria-hidden />
                  ) : (
                    <Monitor className="size-4 shrink-0 text-slate-600" aria-hidden />
                  )}
                  {lab.environment[0] ?? (viewport === 'mobile' ? 'Emulated mobile device' : 'Emulated desktop')}
                </li>
                <li className="flex items-center gap-2">
                  <GaugeIcon className="size-4 shrink-0 text-slate-600" aria-hidden />
                  Lighthouse {lab.version} (lab data)
                </li>
                <li className="flex items-center gap-2">
                  <Timer className="size-4 shrink-0 text-slate-600" aria-hidden />
                  Single page load
                </li>
                <li className="flex items-center gap-2">
                  <Wifi className="size-4 shrink-0 text-slate-600" aria-hidden />
                  {lab.environment.find((e) => /throttl|network|4G|3G/i.test(e)) ?? 'Throttled network'}
                </li>
                <li className="flex items-center gap-2">
                  <Users className="size-4 shrink-0 text-slate-600" aria-hidden />
                  Not real-user data
                </li>
              </ul>
            ) : (
              <ul className={cx('grid grid-cols-1 gap-x-6 gap-y-3 border-t border-slate-200 bg-slate-100 py-4 text-[13px] text-slate-700 sm:grid-cols-3', pad)}>
                <li className="flex items-center gap-2">
                  <CalendarDays className="size-4 shrink-0 text-slate-600" aria-hidden />
                  <span className="inline-flex flex-wrap items-center gap-x-1">
                    Latest 28-day period
                    {shown.firstDate && (
                      <HelpTip label="Collection period" align="start">
                        {fmtPeriod(shown.firstDate, shown.lastDate)}
                      </HelpTip>
                    )}
                    <span>
                      (<ExternalText href="https://cruxvis.withgoogle.com/">history</ExternalText>)
                    </span>
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  {viewport === 'mobile' ? (
                    <Smartphone className="size-4 shrink-0 text-slate-600" aria-hidden />
                  ) : (
                    <Monitor className="size-4 shrink-0 text-slate-600" aria-hidden />
                  )}
                  Various {viewport === 'mobile' ? 'mobile' : 'desktop'} devices
                </li>
                <li className="flex items-center gap-2">
                  <Users className="size-4 shrink-0 text-slate-600" aria-hidden />
                  <span>
                    Many samples (<ExternalText href="https://developer.chrome.com/docs/crux">Chrome UX Report</ExternalText>)
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <Timer className="size-4 shrink-0 text-slate-600" aria-hidden />
                  Full visit durations
                </li>
                <li className="flex items-center gap-2">
                  <Wifi className="size-4 shrink-0 text-slate-600" aria-hidden />
                  Various network connections
                </li>
                <li className="flex items-center gap-2">
                  <Globe className="size-4 shrink-0 text-slate-600" aria-hidden />
                  All Chrome versions
                </li>
              </ul>
            )}
          </>
        ) : null}
      </div>
      {d?.fetchedAt && rec && (
        <p className="mt-1.5 text-right text-[11px] text-slate-500">
          Fetched {fmtDateTime(d.fetchedAt)} for this scan · {scope === 'origin' || fellBack ? d.origin : d.pageUrl}
        </p>
      )}
    </section>
  );
}

export function LighthouseReport({ scanId, wordpress }: { scanId: string; wordpress?: WordPressReportDTO | null }) {
  const index = useApi<LighthouseIndexDTO[]>(`/scans/${scanId}/lighthouse`);
  // Homepage first (shortest path), as PageSpeed Insights would start with it.
  const pages = useMemo(
    () => [...new Set((index.data ?? []).map((e) => e.pageUrl))].sort((a, b) => new URL(a).pathname.length - new URL(b).pathname.length || a.localeCompare(b)),
    [index.data],
  );
  const [vp, setVp] = useState<'mobile' | 'desktop'>('mobile');
  // Like PageSpeed Insights: the home page's report (scans before this change may hold more pages).
  const currentPage = pages[0] ?? null;
  const available = (index.data ?? []).filter((e) => e.pageUrl === currentPage).map((e) => e.viewport);
  const viewport = available.includes(vp) ? vp : (available[0] ?? vp);
  const report = useApi<LighthouseReportDTO>(currentPage ? `/scans/${scanId}/lighthouse/report?page=${encodeURIComponent(currentPage)}&viewport=${viewport}` : null);

  if (index.loading && !index.data) return <LoadingState label="Loading the Lighthouse report…" />;
  if (index.error) return <ErrorState error={index.error} onRetry={index.reload} />;
  if (!index.data?.length)
    return (
      <div className="rounded-xl border border-dashed border-slate-300 px-6 py-8 text-center text-sm text-slate-600">
        <GaugeIcon className="mx-auto mb-2 size-7 text-slate-400" aria-hidden />
        No full Lighthouse report is stored for this scan. Scans run from 28 October 2026 include one; run a new Full scan to see the PageSpeed-style report.
      </div>
    );

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:p-5">
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-600">
          Lighthouse report for <span className="font-medium break-all text-slate-900">{currentPage}</span>
        </p>
      </div>
      <div className="mt-4 flex justify-center" role="tablist" aria-label="Device">
        {(['mobile', 'desktop'] as const).map((v) => {
          const on = viewport === v;
          const disabled = !available.includes(v);
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={on}
              disabled={disabled}
              onClick={() => setVp(v)}
              className={cx(
                'inline-flex items-center gap-2 border-b-2 px-5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                on ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900',
              )}
            >
              {v === 'mobile' ? <Smartphone className="size-4" aria-hidden /> : <Monitor className="size-4" aria-hidden />}
              {v === 'mobile' ? 'Mobile' : 'Desktop'}
            </button>
          );
        })}
      </div>
      <div className="mt-5 space-y-3" role="tabpanel" aria-label={`${viewport === 'mobile' ? 'Mobile' : 'Desktop'} report`}>
        {currentPage && (
          <FieldDataSection scanId={scanId} page={currentPage} viewport={viewport} lab={report.data && report.data.viewport === viewport ? labSnapshot(report.data) : null} />
        )}
        <details open className="group/diag rounded-xl border border-slate-200 bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 hover:bg-slate-100 [&::-webkit-details-marker]:hidden">
            <GaugeIcon className="size-5 shrink-0 text-brand-700" aria-hidden />
            <h4 id="lh-diagnose" className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
              Diagnose performance issues
              {/* Which version this report is for: each device tab has its own Lighthouse run. */}
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-700">
                {viewport === 'mobile' ? <Smartphone className="size-3.5" aria-hidden /> : <Monitor className="size-3.5" aria-hidden />}
                {viewport === 'mobile' ? 'Mobile' : 'Desktop'}
              </span>
            </h4>
            <ChevronDown className="size-4 shrink-0 text-slate-500 transition-transform group-open/diag:rotate-180" aria-hidden />
          </summary>
          <div className="border-t border-slate-100 p-4 sm:p-6">
            {report.loading && !report.data ? (
              <LoadingState label="Loading report…" />
            ) : report.error ? (
              <ErrorState error={report.error} onRetry={report.reload} />
            ) : report.data ? (
              <ReportBody r={report.data} />
            ) : null}
          </div>
        </details>
        {report.data && currentPage && (
          <>
            <Panel
              id="lh-resources"
              icon={<Network className="size-5" aria-hidden />}
              title="Resource analysis"
              badge={
                report.data.resourceSummary?.find((s) => s.resourceType === 'total') ? (
                  <span className="rounded-full border border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-700">
                    {report.data.resourceSummary.find((s) => s.resourceType === 'total')!.requestCount} requests ·{' '}
                    {fmtBytes(report.data.resourceSummary.find((s) => s.resourceType === 'total')!.transferSize)}
                  </span>
                ) : undefined
              }
            >
              <ResourceAnalysis report={report.data} wordpress={wordpress} />
            </Panel>
            <Panel id="lh-compare" icon={<GitCompareArrows className="size-5" aria-hidden />} title="Compared with the previous scan">
              <ScanComparison scanId={scanId} page={currentPage} viewport={viewport} />
            </Panel>
            <Panel id="lh-conditions" icon={<Cpu className="size-5" aria-hidden />} title="Test conditions">
              <TestConditions config={report.data.testConfig} environment={report.data.environment} viewport={viewport} />
            </Panel>
            <Panel id="lh-ai" icon={<Sparkles className="size-5" aria-hidden />} title="AI performance fix assistant">
              <AiFixAssistant scanId={scanId} viewport={viewport} />
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
