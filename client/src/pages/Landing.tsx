import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  FileText,
  Globe,
  Menu,
  RefreshCw,
  Scan,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  User,
  Users,
  Wrench,
  X,
  Layers,
} from 'lucide-react';
import { CATEGORY_INFO, PLANS, type Category } from '@wpcg/shared';
import { useSession } from '../lib/session';
import { categoryIcon } from '../lib/categoryIcons';
import { SeverityBadge, cx } from '../components/ui';

const LANDING_CHECKS: Category[] = ['availability', 'html', 'accessibility', 'seo', 'security', 'links', 'images', 'javascript', 'responsive', 'visual', 'performance'];

const NAV = [
  ['#checks', 'What it checks'],
  ['#how', 'How it works'],
  ['#plans', 'Plans'],
  ['#faq', 'FAQ'],
] as const;

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label="WebAudit AI home">
      <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-on-brand shadow-sm">
        <ShieldCheck className="size-5" aria-hidden />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-slate-900">WebAudit AI</span>
    </Link>
  );
}

/** Primary call to action: enter a website address. */
function ScanForm({ size = 'lg', id }: { size?: 'lg' | 'md'; id: string }) {
  const { session } = useSession();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = url.trim() ? `?url=${encodeURIComponent(url.trim())}` : '';
    if (session) navigate(`/scans/new${q}`);
    else navigate(`/signup${q}`);
  };
  return (
    <form onSubmit={submit} className="w-full" aria-label="Start a website scan">
      <div className={cx('flex flex-col gap-2 rounded-2xl border border-slate-200 bg-surface p-2 shadow-lg shadow-slate-900/5 sm:flex-row', size === 'md' && 'shadow-none')}>
        <label htmlFor={id} className="sr-only">
          Website address
        </label>
        <div className="relative flex-1">
          <Globe className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            id={id}
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="https://your-website.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="h-12 w-full rounded-xl border-0 bg-transparent pr-3 pl-11 text-base text-slate-900 placeholder:text-slate-500 focus:ring-0 focus:outline-none"
          />
        </div>
        <button type="submit" className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-brand-600 px-6 text-base font-semibold text-on-brand shadow-sm transition hover:bg-brand-700">
          <Scan className="size-5" aria-hidden />
          Scan my website
        </button>
      </div>
    </form>
  );
}

/** Static product illustration (not live data). */
function ReportPreview() {
  const rows: { sev: 'critical' | 'high' | 'medium' | 'low'; title: string; where: string; status: string; tone: string }[] = [
    { sev: 'high', title: 'Broken internal link', where: '/services → /pricing-old', status: 'Open', tone: 'border-slate-300 bg-surface text-slate-700' },
    { sev: 'high', title: 'Form elements must have labels', where: '/contact · WCAG 1.3.1, 4.1.2', status: 'Open', tone: 'border-slate-300 bg-surface text-slate-700' },
    { sev: 'medium', title: 'Page scrolls sideways', where: '/ · Mobile 390px', status: 'Resolved', tone: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
    { sev: 'low', title: 'Images are much larger than displayed', where: '/about · 2400×1600 shown at 200px', status: 'Needs Manual Review', tone: 'border-violet-200 bg-violet-50 text-violet-800' },
  ];
  return (
    <figure className="relative">
      <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-brand-100 via-transparent to-transparent blur-xl" aria-hidden />
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-surface shadow-2xl shadow-slate-900/10">
        <div className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-3" aria-hidden>
          <span className="size-2.5 rounded-full bg-slate-300" />
          <span className="size-2.5 rounded-full bg-slate-300" />
          <span className="size-2.5 rounded-full bg-slate-300" />
          <span className="ml-3 truncate rounded-md bg-surface px-2.5 py-0.5 text-[11px] text-slate-500 ring-1 ring-slate-200">Scan report · your-website.com</span>
        </div>
        <div className="p-5">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="text-xs font-medium text-slate-500">Full scan · 24 pages · desktop + mobile</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight">31 issues</div>
            </div>
            <div className="text-right text-xs text-slate-500">
              <span className="font-semibold text-emerald-700">9 fixed</span> since last scan
            </div>
          </div>
          <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
            <div className="w-[6%] bg-red-600" />
            <div className="w-[22%] bg-orange-500" />
            <div className="w-[30%] bg-amber-400" />
            <div className="w-[34%] bg-sky-500" />
            <div className="w-[8%] bg-slate-400" />
          </div>
          <ul className="mt-5 space-y-2.5">
            {rows.map((r) => (
              <li key={r.title} className="flex items-center gap-3 rounded-xl border border-slate-100 p-3">
                <SeverityBadge severity={r.sev} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">{r.title}</div>
                  <div className="truncate text-xs text-slate-500">{r.where}</div>
                </div>
                <span className={cx('hidden rounded-full border px-2 py-0.5 text-[11px] font-medium sm:inline', r.tone)}>{r.status}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-slate-500">Illustration of a report. Your results come from a real scan of your site.</figcaption>
    </figure>
  );
}

function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold tracking-wide text-brand-700 uppercase">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
      {children && <p className="mt-4 text-base leading-relaxed text-slate-600">{children}</p>}
    </div>
  );
}

const STEPS = [
  { icon: <Globe className="size-5" aria-hidden />, title: 'Enter your website', text: 'Add a public website address. We check it is reachable and show exactly what will be tested before anything runs.' },
  { icon: <Scan className="size-5" aria-hidden />, title: 'Real browser scan', text: 'Pages are discovered from your links and sitemap, then loaded in Chrome on desktop and mobile. No forms are submitted.' },
  { icon: <Wrench className="size-5" aria-hidden />, title: 'Plain-language fixes', text: 'Every issue shows the evidence, why it matters, how serious it is, and step-by-step instructions with example code.' },
  { icon: <RefreshCw className="size-5" aria-hidden />, title: 'Verify and report', text: 'Re-test an issue in one click. Share in-app, PDF or CSV reports with what changed since the last scan.' },
];

const TEN_QUESTIONS = [
  'What was detected?',
  'Where was it detected?',
  'Why does it matter?',
  'What evidence supports it?',
  'How serious is it?',
  'What should you do?',
  'Step-by-step fix',
  'Example code',
  'How to verify the fix',
  'One-click verification scan',
];

const AUDIENCES = [
  { icon: <Building2 className="size-5" aria-hidden />, title: 'Web design agencies', text: 'Audit client sites before launch and after every update, with reports you can hand over.' },
  { icon: <User className="size-5" aria-hidden />, title: 'Freelance developers', text: 'Catch regressions quickly and prove the fix with a verification scan.' },
  { icon: <Wrench className="size-5" aria-hidden />, title: 'WordPress maintenance', text: 'Compare screenshots with a baseline after plugin and theme updates.' },
  { icon: <ShoppingBag className="size-5" aria-hidden />, title: 'E-commerce businesses', text: 'Find broken links, script errors and slow pages that cost sales.' },
  { icon: <Store className="size-5" aria-hidden />, title: 'Website owners', text: 'Understand problems without being a developer, in plain language.' },
  { icon: <Users className="size-5" aria-hidden />, title: 'Marketing teams', text: 'Keep titles, descriptions, canonicals and indexing signals in order.' },
];

const FAQ: [string, ReactNode][] = [
  [
    'Is it safe to scan my website?',
    'Scans are passive. Pages are loaded like a visitor would load them, at a modest rate. Forms are never submitted, nothing is bought or sent, and admin, login, cart and checkout links are never visited. robots.txt rules are respected when discovering pages.',
  ],
  ['Can I scan any website?', 'Only websites you own or have permission to test. You confirm this before every scan. Private, internal and local network addresses are blocked for security.'],
  [
    'Does a clean accessibility result mean my site is WCAG compliant?',
    'No. Automated testing (axe-core) finds only part of accessibility barriers. WebAudit AI says so in every report and marks items that need a person to check.',
  ],
  ['Are the performance numbers my real Core Web Vitals?', 'No. They are Lighthouse lab measurements from one run, which are useful for finding problems but not the same as real-visitor (field) data.'],
  [
    'Do I need AI to use it?',
    'No. Every check is deterministic and works without AI. Where enabled, AI can explain an issue in plainer words using only the evidence from your scan. It never changes your website.',
  ],
  ['Is it a WordPress plugin?', 'No. It is a standalone web application, so it works with any public website: WordPress, Shopify, custom builds and static sites.'],
  ['What data do you keep?', 'Page addresses, results, short evidence snippets and screenshots of the scanned pages, for as long as your retention setting allows. You can delete any scan, website or all data at any time.'],
];

/** Header section links: a transparent brand-green pill with a soft glow on hover and keyboard focus. */
const NAV_LINK_GLOW =
  'rounded-lg px-3 py-1.5 transition-[background-color,box-shadow,color] duration-200 hover:bg-brand-500/10 hover:text-slate-900 hover:shadow-[0_0_18px_rgba(61,220,99,0.28),inset_0_0_0_1px_rgba(61,220,99,0.25)] focus-visible:bg-brand-500/10 focus-visible:text-slate-900';

export function LandingPage() {
  const { session } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const { hash } = useLocation();
  // Arriving from the app (e.g. the logo) keeps the app's scroll offset; open at the top unless a section was asked for.
  useEffect(() => {
    if (!hash) window.scrollTo({ top: 0, behavior: 'instant' });
  }, [hash]);
  // Section links glide to their section; only on this page, and never for reduced-motion users (styles.css).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('scroll-smooth');
    return () => root.classList.remove('scroll-smooth');
  }, []);
  const navigateTo = useNavigate();
  // The open mobile menu pushes the page down, so close it first, then scroll (smoothly, via the class above).
  const goToSection = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    flushSync(() => setMenuOpen(false));
    document.querySelector(href)?.scrollIntoView({ block: 'start' });
    navigateTo({ hash: href });
  };
  const free = PLANS.free;
  const pro = PLANS.pro;
  const agency = PLANS.agency;

  return (
    <div className="min-h-dvh bg-surface text-slate-900">
      <a href="#main" className="sr-only z-50 rounded bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>

      {/* ------------------------------------------------------------ header */}
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Brand />
          <nav aria-label="Sections" className="hidden items-center gap-1 text-sm font-medium text-slate-600 md:flex">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} className={NAV_LINK_GLOW}>
                {label}
              </a>
            ))}
          </nav>
          <div className="hidden items-center gap-1 md:flex">
            {session ? (
              <Link to="/dashboard" className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900">
                Open dashboard
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            ) : (
              <>
                <Link to="/login" className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                  Sign in
                </Link>
                <Link to="/signup" className="inline-flex h-9 items-center rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:text-slate-900">
                  Create account
                </Link>
              </>
            )}
          </div>
          <button type="button" className="rounded-lg p-2 text-slate-700 hover:bg-slate-100 md:hidden" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-controls="landing-menu" aria-label={menuOpen ? 'Close menu' : 'Open menu'}>
            {menuOpen ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </button>
        </div>
        {menuOpen && (
          <div id="landing-menu" className="border-t border-slate-200 bg-surface px-4 py-3 md:hidden">
            <nav aria-label="Sections" className="flex flex-col">
              {NAV.map(([href, label]) => (
                <a key={href} href={href} onClick={(e) => goToSection(e, href)} className={cx(NAV_LINK_GLOW, 'px-2 py-2.5 text-slate-700')}>
                  {label}
                </a>
              ))}
            </nav>
            <div className="mt-2 flex gap-2 border-t border-slate-100 pt-3">
              {session ? (
                <Link to="/dashboard" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-center text-sm font-medium">
                  Open dashboard
                </Link>
              ) : (
                <>
                  <Link to="/login" className="flex-1 rounded-lg px-3 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50">
                    Sign in
                  </Link>
                  <Link to="/signup" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-center text-sm font-medium text-slate-700">
                    Create account
                  </Link>
                </>
              )}
            </div>
          </div>
        )}
      </header>

      <main id="main">
        {/* ------------------------------------------------------------ hero */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 -z-10 bg-[radial-gradient(60rem_30rem_at_20%_-10%,rgba(99,102,241,0.12),transparent),radial-gradient(40rem_25rem_at_90%_10%,rgba(14,165,233,0.10),transparent)]" aria-hidden />
          <div className="mx-auto grid grid-cols-1 max-w-7xl items-center gap-14 px-4 pt-14 pb-20 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:px-8 lg:pt-20 lg:pb-28">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-800">
                <Sparkles className="size-3.5" aria-hidden />
                Website audits for agencies, developers and site owners
              </p>
              <h1 className="mt-5 text-4xl leading-[1.08] font-semibold tracking-tight text-slate-900 sm:text-5xl lg:text-[3.4rem]">
                Know what is broken on your website, and exactly how to fix it.
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
                WebAudit AI scans your pages in a real browser, finds accessibility, SEO, link, performance and security problems, and explains each one in plain language with
                evidence and step-by-step fixes.
              </p>
              <div className="mt-8 max-w-xl">
                <ScanForm id="hero-url" />
                <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
                    Free plan, no card
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
                    {free.scansPerMonth} scans a month
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
                    Passive, read-only scanning
                  </span>
                </p>
              </div>
            </div>
            <ReportPreview />
          </div>
        </section>

        {/* ------------------------------------------------------------ technology strip */}
        <section aria-label="How results are produced" className="border-y border-slate-100 bg-slate-50/70">
          <div className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-4 py-8 text-sm sm:px-6 md:grid-cols-4 lg:px-8">
            {[
              ['Real Chrome', 'Desktop and mobile rendering'],
              ['axe-core', 'Automated WCAG 2.2 A/AA rules'],
              ['Lighthouse', 'Lab performance metrics'],
              ['Evidence first', 'Every finding shows its proof'],
            ].map(([t, s]) => (
              <div key={t}>
                <div className="font-semibold text-slate-900">{t}</div>
                <div className="text-slate-500">{s}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------------ checks */}
        <section id="checks" className="scroll-mt-20 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <SectionHeading eyebrow="What it checks" title="Eleven kinds of problems, one scan">
              Each category reports whether it ran completely, partly or not at all, so “no issues” never hides “not tested”.
            </SectionHeading>
            <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {LANDING_CHECKS.map((c) => (
                <div key={c} className="rounded-2xl border border-slate-200 bg-surface p-6 transition hover:border-brand-500/30 hover:shadow-md">
                  <div className="flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">{categoryIcon(c)}</div>
                  <h3 className="mt-4 font-semibold text-slate-900">{CATEGORY_INFO[c].label}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{CATEGORY_INFO[c].description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ how it works */}
        <section id="how" className="scroll-mt-20 bg-ink py-20 text-white sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm font-semibold tracking-wide text-brand-800 uppercase">How it works</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">From address to verified fix in four steps</h2>
            </div>
            <ol className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s, i) => (
                <li key={s.title} className="rounded-2xl border border-white/10 bg-white/5 p-6">
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-brand-500/15 text-brand-800">{s.icon}</span>
                    <span className="text-sm font-semibold text-brand-800">Step {i + 1}</span>
                  </div>
                  <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-700">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------------------ issue explanations */}
        <section className="py-20 sm:py-24">
          <div className="mx-auto grid grid-cols-1 max-w-7xl items-center gap-14 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
            <div>
              <p className="text-sm font-semibold tracking-wide text-brand-700 uppercase">Clear, step-by-step reports</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Every issue answers ten questions</h2>
              <p className="mt-4 text-base leading-relaxed text-slate-600">
                Written for website owners first, with technical details for developers one click away. Nothing is invented: when the exact fix depends on your setup, the issue says what to
                investigate next.
              </p>
              <div className="mt-8 flex flex-wrap gap-3 text-sm">
                <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 font-medium text-slate-700">
                  <FileText className="size-4" aria-hidden />
                  In-app, PDF and CSV reports
                </span>
                <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 font-medium text-slate-700">
                  <Layers className="size-4" aria-hidden />
                  Before/after comparison
                </span>
              </div>
            </div>
            <ol className="grid gap-3 sm:grid-cols-2">
              {TEN_QUESTIONS.map((q, i) => (
                <li key={q} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-surface p-4 text-sm font-medium text-slate-800">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-on-brand">{i + 1}</span>
                  {q}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------------------ verification */}
        <section className="bg-gradient-to-b from-brand-50/60 to-slate-50 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl px-4 text-center sm:px-6 lg:px-8">
            <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-surface text-brand-700 shadow-sm ring-1 ring-brand-100">
              <RefreshCw className="size-6" aria-hidden />
            </div>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">“Fixed” means re-tested</h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-slate-600">
              An issue is marked resolved only when the same check runs again on the same pages and viewports and no longer finds it. If a later scan finds it again, it is reopened
              automatically. If a page cannot be loaded, the issue is marked “Not tested” instead of quietly disappearing.
            </p>
            <div className="mt-10 grid gap-4 text-left sm:grid-cols-3">
              {[
                ['Baselines', 'Save a good scan and compare later screenshots against it after updates.'],
                ['Verification scans', 'Re-run one issue’s check on its pages without scanning the whole site.'],
                ['History', 'Every status change is recorded with the scan that caused it.'],
              ].map(([t, d]) => (
                <div key={t} className="rounded-2xl border border-slate-200 bg-surface p-6">
                  <h3 className="font-semibold">{t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ audiences */}
        <section className="py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <SectionHeading eyebrow="Who it is for" title="Built for the people who look after websites" />
            <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {AUDIENCES.map((a) => (
                <div key={a.title} className="flex gap-4 rounded-2xl border border-slate-200 p-6">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">{a.icon}</div>
                  <div>
                    <h3 className="font-semibold text-slate-900">{a.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600">{a.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ plans */}
        <section id="plans" className="scroll-mt-20 border-t border-slate-100 bg-slate-50/70 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <SectionHeading eyebrow="Plans" title="Start free. Grow when you need to.">
              The Free plan is available now. Pro and Agency plans are being finalised; their limits are shown so you can plan ahead.
            </SectionHeading>
            <div className="mx-auto mt-14 grid grid-cols-1 max-w-5xl gap-6 lg:grid-cols-3">
              {[
                {
                  plan: free,
                  price: 'Free',
                  note: 'Available now',
                  features: [`${free.scansPerMonth} scans per month`, `Up to ${free.maxPagesPerScan} pages per scan`, `${free.maxWebsites} websites`, 'All checks, PDF and CSV reports', `${free.historyDays}-day history view`],
                  highlight: true,
                },
                {
                  plan: pro,
                  price: 'Coming soon',
                  note: 'For freelancers and growing sites',
                  features: [`${pro.scansPerMonth} scans per month`, `Up to ${pro.maxPagesPerScan} pages per scan`, `${pro.maxWebsites} websites`, 'Visual comparison with baselines', `${pro.maxMembers} team members`],
                },
                {
                  plan: agency,
                  price: 'Coming soon',
                  note: 'For agencies and client work',
                  features: [`${agency.scansPerMonth.toLocaleString()} scans per month`, `Up to ${agency.maxPagesPerScan} pages per scan`, `${agency.maxWebsites} websites`, 'Branded client reports', `${agency.maxMembers} team members`],
                },
              ].map(({ plan, price, note, features, highlight }) => (
                <div key={plan.id} className={cx('flex flex-col rounded-2xl border bg-surface p-7', highlight ? 'border-brand-600 shadow-xl shadow-brand-600/10 ring-1 ring-brand-600' : 'border-slate-200')}>
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="mt-1 text-sm text-slate-500">{note}</p>
                  <p className="mt-5 text-3xl font-semibold tracking-tight">{price}</p>
                  <ul className="mt-6 flex-1 space-y-3 text-sm text-slate-700">
                    {features.map((f) => (
                      <li key={f} className="flex gap-2.5">
                        <Check className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
                        {f}
                      </li>
                    ))}
                  </ul>
                  {highlight ? (
                    <a href="#top-scan" className="mt-8 inline-flex h-11 items-center justify-center rounded-xl bg-brand-600 text-sm font-semibold text-on-brand hover:bg-brand-700">
                      Scan your website free
                    </a>
                  ) : (
                    <span className="mt-8 inline-flex h-11 items-center justify-center rounded-xl border border-slate-200 text-sm font-medium text-slate-500">Not on sale yet</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ honesty */}
        <section className="py-20 sm:py-24">
          <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
            <SectionHeading eyebrow="No surprises" title="What WebAudit AI does not do" />
            <ul className="mt-12 grid gap-4 sm:grid-cols-2">
              {[
                'Submit forms, log in, place orders or send messages on your site.',
                'Claim your site is fully accessible or WCAG compliant: automated checks find only part of the barriers.',
                'Predict search rankings: SEO results are technical observations.',
                'Replace a penetration test: security checks are passive observations of public responses.',
                'Report real-visitor speed: performance numbers are lab measurements.',
                'Change your website. AI explanations are optional and only describe what to do.',
              ].map((t) => (
                <li key={t} className="flex gap-3 rounded-xl border border-slate-200 p-4 text-sm leading-relaxed text-slate-700">
                  <X className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------------------------ faq */}
        <section id="faq" className="scroll-mt-20 border-t border-slate-100 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
            <SectionHeading eyebrow="FAQ" title="Questions, answered" />
            <div className="mt-12 divide-y divide-slate-200 rounded-2xl border border-slate-200">
              {FAQ.map(([q, a]) => (
                <details key={q} className="group px-5 py-1">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-left font-medium text-slate-900">
                    {q}
                    <ChevronDown className="size-5 shrink-0 text-slate-500 transition group-open:rotate-180" aria-hidden />
                  </summary>
                  <p className="pb-5 text-sm leading-relaxed text-slate-600">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ final cta */}
        <section id="top-scan" className="scroll-mt-20 px-4 pb-20 sm:px-6 lg:px-8">
          <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl bg-ink px-6 py-14 text-center sm:px-12">
            <div className="absolute inset-0 bg-[radial-gradient(40rem_20rem_at_50%_0%,rgba(99,102,241,0.35),transparent)]" aria-hidden />
            <div className="relative">
              <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">See what your website needs</h2>
              <p className="mx-auto mt-3 max-w-xl text-slate-700">Enter an address you own or manage. Your first results usually arrive in about a minute.</p>
              <div className="mx-auto mt-8 max-w-xl text-left">
                <ScanForm id="footer-url" size="md" />
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <Brand />
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} className="hover:text-slate-900">
                {label}
              </a>
            ))}
            {!session && (
              <Link to="/login" className="hover:text-slate-900">
                Sign in
              </Link>
            )}
          </div>
          <p>© {new Date().getFullYear()} WebAudit AI</p>
        </div>
      </footer>
    </div>
  );
}
