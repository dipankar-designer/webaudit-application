import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  BellRing,
  Siren,
  CreditCard,
  FileText,
  Globe,
  History,
  Images,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  PlusCircle,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import { PLANS } from '@wpcg/shared';
import { useSession } from '../lib/session';
import { LoadingState, cx } from './ui';

/** Where "Back" goes when there is no in-app history (opened from a bookmark or e-mail link). */
export function parentPath(pathname: string): string {
  const p = pathname.replace(/\/+$/, '');
  if (p === '/scans/new') return '/scans';
  if (p === '/monitors/new') return '/monitors';
  const parts = p.split('/').filter(Boolean);
  return parts.length > 1 ? `/${parts[0]}` : '/dashboard';
}

/** "Back" on every page except the overview: previous page in this tab, otherwise the parent page. */
function BackButton() {
  const location = useLocation();
  const navigate = useNavigate();
  if (location.pathname === '/dashboard') return null;
  // React Router stores the position in this tab's history; 0 means this is the first app page visited.
  const canGoBack = ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={() => (canGoBack ? navigate(-1) : navigate(parentPath(location.pathname)))}
      className="no-print mb-4 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back
    </button>
  );
}

const NAV_MONITORING = [
  { to: '/dashboard', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/monitors', label: 'Monitors', icon: Activity },
  { to: '/incidents', label: 'Incidents', icon: Siren },
  { to: '/alerts', label: 'Alerts', icon: BellRing },
];
const NAV = [
  { to: '/websites', label: 'Websites', icon: Globe },
  { to: '/scans/new', label: 'New Scan', icon: PlusCircle },
  { to: '/scans', label: 'Scan History', icon: History, end: true },
  { to: '/issues', label: 'Issues', icon: ListChecks },
  { to: '/baselines', label: 'Baselines', icon: Images },
  { to: '/reports', label: 'Reports', icon: FileText },
];
const NAV_BOTTOM = [
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/billing', label: 'Billing', icon: CreditCard },
];

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 rounded-lg px-2 hover:opacity-90" aria-label="WebAudit AI home">
      <div className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-on-brand shadow-sm">
        <ShieldCheck className="size-5" aria-hidden />
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-slate-900">WebAudit AI</div>
        <div className="text-[11px] font-medium tracking-wide text-brand-700 uppercase">Monitoring &amp; QA</div>
      </div>
    </Link>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const link = (item: (typeof NAV)[number]) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-50 text-brand-800 shadow-[inset_3px_0_0_var(--color-brand-600)]' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
        )
      }
    >
      <item.icon className="size-[18px] shrink-0" aria-hidden />
      {item.label}
    </NavLink>
  );
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-1 overflow-y-auto">
      <h2 className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Monitoring</h2>
      {NAV_MONITORING.map(link)}
      <h2 className="mt-4 px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Audits</h2>
      {NAV.map(link)}
      <div className="my-3 border-t border-slate-200" />
      {NAV_BOTTOM.map(link)}
    </nav>
  );
}

function Account() {
  const { session, logout } = useSession();
  const navigate = useNavigate();
  if (!session) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-surface p-3">
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-slate-50" aria-hidden>
          {session.user.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">{session.user.name}</div>
          <div className="truncate text-xs text-slate-500">{session.workspace.name}</div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800">
          <BadgeCheck className="size-3.5" aria-hidden />
          {PLANS[session.workspace.plan].name} plan
        </span>
        <button
          type="button"
          onClick={async () => {
            await logout();
            navigate('/');
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          <LogOut className="size-3.5" aria-hidden />
          Sign out
        </button>
      </div>
    </div>
  );
}

export function AppLayout() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // The drawer is a modal dialog: focus moves into it, Tab stays inside, Escape closes it, and focus
  // returns to "Open menu" afterwards (unless a link already moved it to a new page).
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return setOpen(false);
      if (e.key !== 'Tab' || !drawer.current) return;
      const items = [...drawer.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const trigger = menuButton.current;
    return () => {
      document.removeEventListener('keydown', onKey);
      if (trigger && (document.activeElement === document.body || drawer.current?.contains(document.activeElement))) trigger.focus();
    };
  }, [open]);

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only z-50 rounded bg-brand-600 px-3 py-2 font-semibold text-on-brand focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="no-print fixed inset-y-0 left-0 hidden w-64 flex-col gap-6 border-r border-slate-200 bg-[#07080d] px-4 py-5 lg:flex">
        <Brand />
        <NavItems />
        <Account />
      </aside>

      {/* Mobile top bar + drawer */}
      <header className="no-print sticky top-0 z-30 flex h-14 items-center justify-between border-b border-slate-200 bg-surface/90 px-4 backdrop-blur lg:hidden">
        <Brand />
        <button ref={menuButton} type="button" onClick={() => setOpen(true)} className="rounded-lg p-2 text-slate-700 hover:bg-slate-100" aria-label="Open menu" aria-expanded={open}>
          <Menu className="size-5" aria-hidden />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div ref={drawer} className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-6 bg-slate-50 px-4 py-5 shadow-xl">
            <div className="flex items-center justify-between">
              <Brand />
              <button ref={closeButton} type="button" onClick={() => setOpen(false)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100" aria-label="Close menu">
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <NavItems onNavigate={() => setOpen(false)} />
            <Account />
          </div>
        </div>
      )}

      <main id="main" className="lg:pl-64">
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <BackButton />
          {/* Pages load on first use (App.tsx): show the usual loading state while one downloads. */}
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
