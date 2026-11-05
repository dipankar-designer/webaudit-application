import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import {
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CircleHelp,
  Clock,
  Info,
  Loader2,
  MinusCircle,
  RotateCcw,
  SearchCheck,
  X,
  XCircle,
} from 'lucide-react';
import {
  ISSUE_STATUS_LABELS,
  SEVERITY_LABELS,
  type CheckRunStatus,
  type IssueStatus,
  type ScanStatus,
  type Severity,
} from '@wpcg/shared';
import { errorMessage } from '../lib/api';

const cx = (...c: unknown[]) => c.filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ');
export { cx };

// ---------------------------------------------------------------- buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-on-brand hover:bg-brand-400 shadow-sm disabled:bg-brand-600/60',
  secondary: 'bg-surface text-slate-800 border border-slate-300 hover:bg-slate-50 shadow-sm disabled:text-slate-400',
  ghost: 'text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-600/85 shadow-sm disabled:bg-red-600/50',
};
const SIZES = { sm: 'h-8 px-3 text-xs gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-5 text-base gap-2' };

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof SIZES; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors disabled:cursor-not-allowed', VARIANTS[variant], SIZES[size], className)}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function LinkButton({ variant = 'primary', size = 'md', icon, className, children, ...rest }: LinkProps & { variant?: Variant; size?: keyof typeof SIZES; icon?: ReactNode }) {
  return (
    <Link {...rest} className={cx('inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors', VARIANTS[variant], SIZES[size], className)}>
      {icon}
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------- layout primitives

export function Card({ children, className, as: As = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' }) {
  return <As className={cx('card', className)}>{children}</As>;
}

export function CardHeader({ title, description, actions, icon }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <div className="mt-0.5 text-slate-500">{icon}</div>}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-slate-600">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-sm text-slate-500">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[1.65rem]">{title}</h1>
        {description && <p className="mt-1.5 max-w-3xl text-sm text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-slate-500">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center">
      <Spinner label={label} />
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">{icon}</div>}
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {children && <div className="mt-1.5 max-w-md text-sm text-slate-600">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert tone="error" title="This could not be loaded">
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry} icon={<RotateCcw className="size-3.5" aria-hidden />}>
          Try again
        </Button>
      )}
    </Alert>
  );
}

const ALERT_TONES = {
  info: { box: 'border-sky-200 bg-sky-50 text-sky-900', icon: <Info className="size-5 text-sky-600" aria-hidden /> },
  success: { box: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: <CheckCircle2 className="size-5 text-emerald-600" aria-hidden /> },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-950', icon: <AlertTriangle className="size-5 text-amber-600" aria-hidden /> },
  error: { box: 'border-red-200 bg-red-50 text-red-900', icon: <AlertCircle className="size-5 text-red-600" aria-hidden /> },
};

/**
 * A live (polling) view whose latest refresh failed while older data is on screen: say so, instead of
 * silently showing data that may be stale. useApi keeps retrying by itself.
 */
export function RefreshFailed({ error, onRetry, className }: { error: unknown; onRetry: () => void; className?: string }) {
  if (!error) return null;
  return (
    <Alert tone="warning" className={cx('mb-4', className)}>
      Couldn’t refresh just now ({errorMessage(error)}). Showing the last loaded data and retrying automatically.{' '}
      <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
        Retry now
      </button>
    </Alert>
  );
}

export function Alert({ tone = 'info', title, children, className, onDismiss }: { tone?: keyof typeof ALERT_TONES; title?: ReactNode; children?: ReactNode; className?: string; onDismiss?: () => void }) {
  const t = ALERT_TONES[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-lg border p-4 text-sm', t.box, className)}>
      <div className="shrink-0">{t.icon}</div>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cx(!!title && 'mt-1', 'space-y-1')}>{children}</div>}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100" aria-label="Dismiss">
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- badges

export function Badge({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', className)}>
      {children}
    </span>
  );
}

export const SEVERITY_STYLES: Record<Severity, { badge: string; dot: string; icon: ReactNode; text: string }> = {
  critical: { badge: 'border-red-200 bg-red-50 text-red-800', dot: 'bg-red-600', text: 'text-red-700', icon: <AlertOctagon className="size-3.5" aria-hidden /> },
  high: { badge: 'border-orange-200 bg-orange-50 text-orange-800', dot: 'bg-orange-500', text: 'text-orange-700', icon: <AlertTriangle className="size-3.5" aria-hidden /> },
  medium: { badge: 'border-amber-200 bg-amber-50 text-amber-900', dot: 'bg-amber-400', text: 'text-amber-700', icon: <AlertCircle className="size-3.5" aria-hidden /> },
  low: { badge: 'border-sky-200 bg-sky-50 text-sky-800', dot: 'bg-sky-500', text: 'text-sky-700', icon: <Info className="size-3.5" aria-hidden /> },
  info: { badge: 'border-slate-200 bg-slate-100 text-slate-700', dot: 'bg-slate-400', text: 'text-slate-600', icon: <Info className="size-3.5" aria-hidden /> },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLES[severity];
  return (
    <Badge className={s.badge}>
      {s.icon}
      {SEVERITY_LABELS[severity]}
    </Badge>
  );
}

const ISSUE_STATUS_STYLES: Record<IssueStatus, { cls: string; icon: ReactNode; help: string }> = {
  open: { cls: 'border-slate-300 bg-surface text-slate-800', icon: <CircleDashed className="size-3.5" aria-hidden />, help: 'A confirmed defect: detected by a deterministic check (and re-requested where a single observation could be wrong), not yet fixed.' },
  reopened: { cls: 'border-rose-200 bg-rose-50 text-rose-800', icon: <RotateCcw className="size-3.5" aria-hidden />, help: 'It was resolved, then detected again.' },
  needs_review: { cls: 'border-violet-200 bg-violet-50 text-violet-800', icon: <SearchCheck className="size-3.5" aria-hidden />, help: 'Needs manual review: the tool could not decide automatically (for example contrast over an image). Check it against the WCAG criterion; it is not counted as a confirmed defect.' },
  inconclusive: { cls: 'border-slate-200 bg-slate-100 text-slate-700', icon: <CircleHelp className="size-3.5" aria-hidden />, help: 'Pending verification: seen once but not reproduced (blocked, rate-limited, timed out or intermittent). Not counted as a confirmed defect.' },
  not_tested: { cls: 'border-slate-200 bg-slate-100 text-slate-700', icon: <MinusCircle className="size-3.5" aria-hidden />, help: 'The last verification could not re-run the check, so the result is unknown.' },
  resolved: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: <CheckCircle2 className="size-3.5" aria-hidden />, help: 'Not found when the same check re-ran under the same conditions.' },
};

export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  const s = ISSUE_STATUS_STYLES[status];
  return (
    <Badge className={s.cls} title={s.help}>
      {s.icon}
      {ISSUE_STATUS_LABELS[status]}
    </Badge>
  );
}
export const issueStatusHelp = (s: IssueStatus) => ISSUE_STATUS_STYLES[s].help;

const SCAN_STATUS: Record<ScanStatus, { cls: string; label: string; icon: ReactNode }> = {
  queued: { cls: 'border-slate-200 bg-slate-100 text-slate-700', label: 'Queued', icon: <Clock className="size-3.5" aria-hidden /> },
  running: { cls: 'border-brand-100 bg-brand-50 text-brand-800', label: 'Running', icon: <Loader2 className="size-3.5 animate-spin" aria-hidden /> },
  completed: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', label: 'Completed', icon: <CheckCircle2 className="size-3.5" aria-hidden /> },
  failed: { cls: 'border-red-200 bg-red-50 text-red-800', label: 'Failed', icon: <XCircle className="size-3.5" aria-hidden /> },
  cancelled: { cls: 'border-slate-200 bg-slate-100 text-slate-600', label: 'Cancelled', icon: <MinusCircle className="size-3.5" aria-hidden /> },
};

export function ScanStatusBadge({ status }: { status: ScanStatus }) {
  const s = SCAN_STATUS[status];
  return (
    <Badge className={s.cls}>
      {s.icon}
      {s.label}
    </Badge>
  );
}

const CHECK_STATUS: Record<CheckRunStatus, { cls: string; label: string; help: string }> = {
  completed: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', label: 'Completed', help: 'Ran on every page in scope.' },
  partial: { cls: 'border-amber-200 bg-amber-50 text-amber-900', label: 'Partial', help: 'Ran on some pages only — see the note.' },
  failed: { cls: 'border-red-200 bg-red-50 text-red-800', label: 'Not completed', help: 'Could not run — see the note.' },
  skipped: { cls: 'border-slate-200 bg-slate-100 text-slate-600', label: 'Not run', help: 'Not selected for this scan.' },
  unavailable: { cls: 'border-slate-200 bg-slate-100 text-slate-600', label: 'Unavailable', help: 'Not available in this deployment.' },
};

export function CheckStatusBadge({ status }: { status: CheckRunStatus }) {
  const s = CHECK_STATUS[status];
  return (
    <Badge className={s.cls} title={s.help}>
      {s.label}
    </Badge>
  );
}

// ---------------------------------------------------------------- tooltip

/** Accessible info tooltip: opens on hover, focus or tap; text is linked with aria-describedby. */
export function InfoTip({ children, label = 'More information' }: { children: ReactNode; label?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('mousedown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('mousedown', close);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="-my-1 rounded-full p-1 text-slate-500 hover:text-slate-700"
      >
        <CircleHelp className="size-4" aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute right-0 bottom-full z-50 mb-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg bg-slate-900 px-3 py-2 text-xs leading-relaxed font-normal text-slate-50 shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- modal

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Unique per dialog: pages with two dialogs must not share one title id.
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  // Removed from the page while open (conditionally rendered dialogs): close it first, so the browser
  // returns focus to the control that opened it instead of dropping it to <body>.
  useEffect(() => {
    const d = ref.current;
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby={titleId}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-slate-200 p-0 shadow-2xl backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <button type="button" onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="px-5 py-4 text-sm text-slate-700">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">{footer}</div>}
    </dialog>
  );
}

// ---------------------------------------------------------------- stats

export function Stat({ label, value, hint, tone = 'default', to, help }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'critical' | 'high' | 'good' | 'review'; to?: string; help?: ReactNode }) {
  const toneCls = {
    default: 'text-slate-900',
    critical: 'text-red-700',
    high: 'text-orange-700',
    good: 'text-emerald-700',
    review: 'text-violet-700',
  }[tone];
  const body = (
    <>
      <div className={cx('text-sm font-medium text-slate-600', help && 'pr-7')}>{label}</div>
      <div className={cx('mt-2 text-3xl font-semibold tracking-tight tabular-nums', toneCls)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </>
  );
  // The help button sits beside the link, not inside it (no nested interactive controls).
  return (
    <div className="card relative transition hover:border-brand-500/40 hover:shadow-md">
      {to ? (
        <Link to={to} className="block h-full rounded-xl p-5">
          {body}
        </Link>
      ) : (
        <div className="p-5">{body}</div>
      )}
      {help && (
        <span className="absolute top-4 right-4">
          <InfoTip label={`About ${label}`}>{help}</InfoTip>
        </span>
      )}
    </div>
  );
}

export function SeverityBar({ counts }: { counts: Record<Severity, number> }) {
  const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  const total = order.reduce((s, k) => s + counts[k], 0);
  if (!total) return <div className="h-2 rounded-full bg-slate-100" role="img" aria-label="No issues" />;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={order.map((k) => `${SEVERITY_LABELS[k]} ${counts[k]}`).join(', ')}>
      {order.map((k) => (counts[k] ? <div key={k} className={SEVERITY_STYLES[k].dot} style={{ width: `${(counts[k] / total) * 100}%` }} /> : null))}
    </div>
  );
}

// ---------------------------------------------------------------- pagination

/** Page numbers to show: first, last, and a window around the current page, with gaps as null. */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(null);
    out.push(p);
  });
  return out;
}

/** Numbered pagination (no page reload). `label` names what is being paged, for screen readers. */
export function Pagination({ page, pageSize, total, onChange, label }: { page: number; pageSize: number; total: number; onChange: (page: number) => void; label: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const btn = 'inline-flex h-9 min-w-9 items-center justify-center rounded-lg border px-2 text-sm font-medium tabular-nums';
  return (
    <nav aria-label={`${label} pages`} className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-slate-600" aria-live="polite">
        Showing <span className="font-medium text-slate-900">{from}–{to}</span> of <span className="font-medium text-slate-900">{total.toLocaleString()}</span>
      </p>
      <ul className="flex flex-wrap items-center gap-1">
        <li>
          <button type="button" className={cx(btn, 'gap-1 border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40')} onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label="Previous page">
            <ChevronLeft className="size-4" aria-hidden />
            <span className="hidden sm:inline">Previous</span>
          </button>
        </li>
        {pageWindow(page, pages).map((p, i) =>
          p === null ? (
            <li key={`gap${i}`} className="px-1 text-slate-500" aria-hidden>
              …
            </li>
          ) : (
            <li key={p}>
              <button
                type="button"
                onClick={() => onChange(p)}
                aria-current={p === page ? 'page' : undefined}
                aria-label={`Page ${p}`}
                className={cx(btn, p === page ? 'border-brand-600 bg-brand-600 text-on-brand' : 'border-slate-300 text-slate-700 hover:bg-slate-100')}
              >
                {p}
              </button>
            </li>
          ),
        )}
        <li>
          <button type="button" className={cx(btn, 'gap-1 border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40')} onClick={() => onChange(page + 1)} disabled={page >= pages} aria-label="Next page">
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </li>
      </ul>
    </nav>
  );
}
