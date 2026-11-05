import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleHelp, Clock, PauseCircle, XCircle } from 'lucide-react';
import { CHECK_STATUS_LABELS, PRIORITY_LABELS, type CheckStatus, type MonitorDTO, type Priority } from '@wpcg/shared';
import { Badge, cx } from './ui';

// ---------------------------------------------------------------- status and priority

type MonitorStatus = MonitorDTO['status'];

/** Status colours are reserved for state and always ship with an icon and a label. */
export const STATUS_META: Record<MonitorStatus, { label: string; dot: string; badge: string; icon: ReactNode; help: string }> = {
  up: { label: 'Up', dot: 'bg-emerald-500', badge: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: <CheckCircle2 className="size-3.5" aria-hidden />, help: 'The last check passed.' },
  warning: { label: 'Warning', dot: 'bg-amber-400', badge: 'border-amber-200 bg-amber-50 text-amber-800', icon: <AlertTriangle className="size-3.5" aria-hidden />, help: 'Working, but something needs attention.' },
  down: { label: 'Down', dot: 'bg-red-500', badge: 'border-red-200 bg-red-50 text-red-800', icon: <XCircle className="size-3.5" aria-hidden />, help: 'Failed after retries.' },
  not_assessed: {
    label: CHECK_STATUS_LABELS.not_assessed,
    dot: 'bg-slate-400',
    badge: 'border-slate-300 bg-slate-100 text-slate-700',
    icon: <CircleHelp className="size-3.5" aria-hidden />,
    help: 'The site blocked or challenged the check, so no verdict was given. This never opens or closes an incident.',
  },
  error: {
    label: CHECK_STATUS_LABELS.error,
    dot: 'bg-violet-500',
    badge: 'border-violet-200 bg-violet-50 text-violet-800',
    icon: <AlertOctagon className="size-3.5" aria-hidden />,
    help: 'Our own check failed to complete. This is a monitoring failure, not a verdict about the site.',
  },
  paused: { label: 'Paused', dot: 'bg-slate-400', badge: 'border-slate-300 bg-slate-100 text-slate-700', icon: <PauseCircle className="size-3.5" aria-hidden />, help: 'Checks are paused.' },
  pending: { label: 'Waiting for first check', dot: 'bg-slate-400', badge: 'border-slate-300 bg-slate-100 text-slate-700', icon: <Clock className="size-3.5" aria-hidden />, help: 'No check has run yet.' },
};

export function MonitorStatusBadge({ status }: { status: MonitorStatus | CheckStatus | null }) {
  const s = STATUS_META[status ?? 'pending'];
  return (
    <Badge className={s.badge} title={s.help}>
      {s.icon}
      {s.label}
    </Badge>
  );
}

const PRIORITY_STYLES: Record<Priority, string> = {
  p1: 'border-red-200 bg-red-50 text-red-800',
  p2: 'border-orange-200 bg-orange-50 text-orange-800',
  p3: 'border-amber-200 bg-amber-50 text-amber-800',
  p4: 'border-sky-200 bg-sky-50 text-sky-800',
};

export function PriorityBadge({ priority, short }: { priority: Priority; short?: boolean }) {
  return (
    <Badge className={PRIORITY_STYLES[priority]} title={PRIORITY_LABELS[priority]}>
      {short ? priority.toUpperCase() : PRIORITY_LABELS[priority]}
    </Badge>
  );
}

export function fmtInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)} d`;
  return `${Math.round(seconds / 604800)} wk`;
}

export const fmtPct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n >= 99.995 ? '100' : n.toFixed(2)}%`);
export const fmtMs = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);

// ---------------------------------------------------------------- uptime bars (one bar per day)

export interface DayBar {
  day: string;
  up: number;
  down: number;
  other: number;
}

const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function dayState(d: DayBar): { cls: string; text: string } {
  const assessed = d.up + d.down;
  if (!assessed && !d.other) return { cls: 'bg-slate-200', text: 'No data' };
  if (!assessed) return { cls: 'bg-slate-400', text: `Not assessed (${d.other} check${d.other === 1 ? '' : 's'} blocked or failed to run)` };
  const pct = (d.up / assessed) * 100;
  const text = `${fmtPct(pct)} uptime · ${d.up + d.down} checks${d.down ? ` · ${d.down} down` : ''}${d.other ? ` · ${d.other} not assessed` : ''}`;
  if (d.down === 0) return { cls: 'bg-emerald-500', text };
  return { cls: pct >= 95 ? 'bg-amber-400' : 'bg-red-500', text };
}

/**
 * UptimeRobot-style daily bars. Hover or focus the strip and use the arrow keys to read each day;
 * the reading is announced politely and is also listed in the table view.
 */
export function UptimeBars({ days }: { days: DayBar[] }) {
  const [active, setActive] = useState<number | null>(null);
  const assessed = days.reduce((s, d) => s + d.up + d.down, 0);
  const up = days.reduce((s, d) => s + d.up, 0);
  const overall = assessed ? (up / assessed) * 100 : null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(days.length - 1, (i ?? days.length) + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(days.length - 1);
  };
  const a = active !== null ? days[active] : null;
  return (
    <div>
      <div
        tabIndex={0}
        role="group"
        aria-label={`Daily uptime for the last ${days.length} days. Overall ${fmtPct(overall)}. Use the left and right arrow keys to read each day.`}
        onKeyDown={onKey}
        onFocus={() => setActive((i) => i ?? days.length - 1)}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
        className="flex h-10 items-stretch gap-px rounded-md sm:gap-[2px]"
      >
        {days.map((d, i) => (
          <div
            key={d.day}
            onMouseEnter={() => setActive(i)}
            className={cx('min-w-px flex-1 rounded-[2px] transition-opacity sm:min-w-[3px] sm:rounded-[3px]', dayState(d).cls, active !== null && active !== i && 'opacity-50')}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-500">
        <span>{days.length ? dayLabel(days[0].day) : ''}</span>
        <span aria-live="polite" className="min-h-4 text-center font-medium text-slate-800">
          {a ? `${dayLabel(a.day)}: ${dayState(a).text}` : `${fmtPct(overall)} uptime over ${days.length} days`}
        </span>
        <span>Today</span>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Legend">
        {[
          ['bg-emerald-500', 'No downtime'],
          ['bg-amber-400', 'Some downtime'],
          ['bg-red-500', 'Below 95%'],
          ['bg-slate-400', 'Not assessed'],
          ['bg-slate-200', 'No data'],
        ].map(([c, l]) => (
          <li key={l} className="inline-flex items-center gap-1.5">
            <span className={cx('size-2.5 rounded-sm', c)} aria-hidden />
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- response-time chart

export interface SeriesPoint {
  t: string;
  ms: number | null;
  ttfb: number | null;
  status: string;
}

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * Single-series line chart of response time (one series, so no legend box: the card title names it).
 * Failed checks are drawn as red ticks on the baseline, never as a zero response time.
 */
export function ResponseChart({ points, range }: { points: SeriesPoint[]; range: string }) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const H = 200;
  const M = { t: 12, r: 12, b: 26, l: 48 };
  const iw = width - M.l - M.r;
  const ih = H - M.t - M.b;

  const { xs, max, t0, t1 } = useMemo(() => {
    const ts = points.map((p) => Date.parse(p.t));
    const end = Date.now();
    const start = end - ({ '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }[range] ?? 864e5);
    const vals = points.map((p) => p.ms).filter((v): v is number => v !== null);
    return { xs: ts, max: niceMax(Math.max(...vals, 0) * 1.1), t0: start, t1: end };
  }, [points, range]);

  const x = (t: number) => M.l + ((t - t0) / (t1 - t0)) * iw;
  const y = (v: number) => M.t + ih - (v / max) * ih;

  // Break the line where a check failed (no response time).
  const segments: string[] = [];
  let cur = '';
  points.forEach((p, i) => {
    if (p.ms === null) {
      if (cur) segments.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${x(xs[i]).toFixed(1)},${y(p.ms).toFixed(1)}`;
  });
  if (cur) segments.push(cur);
  const area = segments.map((s) => {
    const nums = s.slice(1).split(/[LM]/).map((pair) => pair.split(',').map(Number));
    return `${s}L${nums[nums.length - 1][0]},${M.t + ih}L${nums[0][0]},${M.t + ih}Z`;
  });

  const ticks = [0, max / 2, max];
  // Fewer time labels on narrow charts so they never collide.
  const nX = width < 480 ? 3 : 5;
  const xTicks = Array.from({ length: nX }, (_, i) => t0 + ((t1 - t0) * i) / (nX - 1));
  const fmtT = (t: number) =>
    range === '24h' ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  const nearest = (px: number) => {
    let best = -1;
    let bd = Infinity;
    xs.forEach((t, i) => {
      const d = Math.abs(x(t) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best >= 0 ? best : null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (!points.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(points.length - 1, (i ?? points.length) + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(points.length - 1);
  };

  const ok = points.filter((p) => p.ms !== null);
  const avg = ok.length ? ok.reduce((s, p) => s + p.ms!, 0) / ok.length : null;
  const sorted = ok.map((p) => p.ms!).sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null;
  const ap = active !== null ? points[active] : null;

  if (!points.length) return <p className="py-10 text-center text-sm text-slate-500">No checks in this period yet.</p>;

  return (
    <div>
      <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="inline text-slate-500">Average </dt>
          <dd className="inline font-semibold text-slate-900">{fmtMs(avg)}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">95th percentile </dt>
          <dd className="inline font-semibold text-slate-900">{fmtMs(p95)}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">Checks </dt>
          <dd className="inline font-semibold text-slate-900">{points.length}</dd>
        </div>
      </dl>
      <div
        ref={wrap}
        className="relative"
        tabIndex={0}
        role="group"
        aria-label={`Response time, ${range}. Average ${fmtMs(avg)}. Use the arrow keys to read individual checks.`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
        onMouseMove={(e) => setActive(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
      >
        <svg width={width} height={H} className="block" aria-hidden>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={width - M.r} y1={y(v)} y2={y(v)} stroke="var(--color-slate-200)" strokeWidth={1} />
              <text x={M.l - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--color-slate-500)" className="tabular-nums">
                {fmtMs(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={t} x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === nX - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--color-slate-500)">
              {fmtT(t)}
            </text>
          ))}
          {area.map((d, i) => (
            <path key={`a${i}`} d={d} fill="var(--color-sky-500)" opacity={0.1} />
          ))}
          {segments.map((d, i) => (
            <path key={`l${i}`} d={d} fill="none" stroke="var(--color-sky-500)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {/* Isolated readings (a single check, or one between failures) get a marker so they stay visible. */}
          {points.map((p, i) =>
            p.ms !== null && (points[i - 1]?.ms ?? null) === null && (points[i + 1]?.ms ?? null) === null ? (
              <circle key={`d${i}`} cx={x(xs[i])} cy={y(p.ms)} r={4} fill="var(--color-sky-500)" stroke="var(--color-surface)" strokeWidth={2} />
            ) : null,
          )}
          {points.map((p, i) =>
            p.ms === null || p.status === 'down' ? <rect key={`f${i}`} x={x(xs[i]) - 1} y={M.t + ih - 10} width={2} height={10} rx={1} fill="var(--color-red-500)" /> : null,
          )}
          {ap && (
            <g>
              <line x1={x(xs[active!])} x2={x(xs[active!])} y1={M.t} y2={M.t + ih} stroke="var(--color-slate-400)" strokeWidth={1} />
              {ap.ms !== null && <circle cx={x(xs[active!])} cy={y(ap.ms)} r={5} fill="var(--color-sky-500)" stroke="var(--color-surface)" strokeWidth={2} />}
            </g>
          )}
        </svg>
        {ap && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-52 rounded-lg border border-slate-300 bg-raised px-3 py-2 text-xs shadow-lg"
            style={{ left: Math.min(Math.max(0, x(xs[active!]) - 104), width - 208) }}
          >
            <div className="text-slate-500">{new Date(ap.t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div>
            <div className="mt-1 flex items-center gap-1.5 font-medium text-slate-900">
              <span className={cx('size-2 rounded-full', STATUS_META[(ap.status as CheckStatus) ?? 'pending']?.dot ?? 'bg-slate-400')} aria-hidden />
              {STATUS_META[ap.status as CheckStatus]?.label ?? ap.status}
            </div>
            <div className="mt-0.5 text-slate-700">
              Response {fmtMs(ap.ms)}
              {ap.ttfb !== null && ` · first byte ${fmtMs(ap.ttfb)}`}
            </div>
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {ap ? `${new Date(ap.t).toLocaleString()}: ${STATUS_META[ap.status as CheckStatus]?.label ?? ap.status}, response ${fmtMs(ap.ms)}` : ''}
        </span>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer rounded text-slate-600 hover:text-slate-900">Show as table</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-slate-200" tabIndex={0} role="region" aria-label="Response time checks">
          <table className="table-base">
            <caption className="sr-only">Response time checks, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-right">Response</th>
                <th scope="col" className="text-right">First byte</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().slice(0, 200).map((p) => (
                <tr key={p.t}>
                  <td className="whitespace-nowrap">{new Date(p.t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td>{STATUS_META[p.status as CheckStatus]?.label ?? p.status}</td>
                  <td className="text-right tabular-nums">{fmtMs(p.ms)}</td>
                  <td className="text-right tabular-nums">{fmtMs(p.ttfb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Segmented control (radio group semantics) used for ranges and filters. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-slate-300 bg-slate-50 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx('rounded-md px-3 py-1 text-xs font-medium', value === o.value ? 'bg-slate-200 text-slate-950' : 'text-slate-600 hover:text-slate-900')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
