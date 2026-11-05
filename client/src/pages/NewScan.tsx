import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { CheckCircle2, Info, Monitor, Radar, ShieldAlert, Smartphone, Zap } from 'lucide-react';
import {
  CATEGORY_INFO,
  FULL_SCAN_CHECKS,
  QUICK_SCAN_CHECKS,
  type BaselineDTO,
  type Category,
  type ScanDTO,
  type UsageDTO,
  type ViewportName,
  type WebsiteDTO,
} from '@wpcg/shared';
import { errorMessage, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { fmtDateTime } from '../lib/format';
import { Alert, Button, Card, CardHeader, InfoTip, LoadingState, PageHeader, Spinner, cx } from '../components/ui';

interface Limits {
  usage: UsageDTO;
  hardMaxPages: number;
  linkCheckMax: number;
  lighthouseMaxPages: number;
  maxDurationMinutes: number;
}

interface Preflight {
  ok: boolean;
  message?: string;
  normalizedUrl?: string;
  reachable?: boolean;
  status?: number | null;
  finalUrl?: string;
  /** How long the server took to start responding (null when it did not). */
  responseMs?: number | null;
  notes?: string[];
}

/** A server that takes this long to start answering is reported as reachable but slow. */
const SLOW_START_MS = 3000;

const SELECTABLE: Category[] = ['availability', 'html', 'seo', 'accessibility', 'security', 'javascript', 'images', 'links', 'responsive', 'performance'];

export function NewScanPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const limits = useApi<Limits>('/scans/meta/limits');
  const websites = useApi<WebsiteDTO[]>('/websites');

  const [websiteId, setWebsiteId] = useState<string>(params.get('websiteId') ?? '');
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [kind, setKind] = useState<'quick' | 'full'>('quick');
  const [viewportMode, setViewportMode] = useState<'desktop' | 'mobile' | 'both'>('desktop');
  const [maxPages, setMaxPages] = useState(5);
  const [allPages, setAllPages] = useState(false);
  const [pageMode, setPageMode] = useState<'discover' | 'selected'>('discover');
  const [selectedUrls, setSelectedUrls] = useState('');
  const [checks, setChecks] = useState<Category[]>(QUICK_SCAN_CHECKS);
  const [externalLinks, setExternalLinks] = useState(false);
  const [visualCompare, setVisualCompare] = useState(false);
  const [baselineId, setBaselineId] = useState('');
  const [threshold, setThreshold] = useState(1);
  const [ignore, setIgnore] = useState('');
  const [authorised, setAuthorised] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const slowStart = (preflight?.responseMs ?? 0) >= SLOW_START_MS;
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const site = websites.data?.find((w) => w.id === websiteId) ?? null;
  const baselines = useApi<BaselineDTO[]>(websiteId ? `/baselines?websiteId=${websiteId}` : null);
  const plan = limits.data?.usage.plan;
  const pageCap = plan ? Math.min(plan.maxPagesPerScan, limits.data!.hardMaxPages) : 10;
  const scansLeft = limits.data ? limits.data.usage.plan.scansPerMonth - limits.data.usage.scansUsed : null;

  useEffect(() => {
    setChecks(kind === 'full' ? FULL_SCAN_CHECKS.filter((c) => c !== 'visual') : QUICK_SCAN_CHECKS);
    if (kind === 'full') {
      setViewportMode('both');
      setAllPages(true);
    } else {
      setViewportMode('desktop');
      setAllPages(false);
    }
  }, [kind, pageCap]);

  useEffect(() => {
    if (site) setUrl(site.baseUrl);
  }, [site]);

  const target = websiteId && site ? site.baseUrl : url;

  // A check can take up to 30 s: only the latest one may set the result (an older, slower answer for a
  // previous address must not overwrite it or clear the spinner early).
  const preflightSeq = useRef(0);
  const runPreflight = async () => {
    if (!target.trim()) return;
    const seq = ++preflightSeq.current;
    setChecking(true);
    try {
      const r = await post<Preflight>('/scans/preflight', { url: target });
      if (seq === preflightSeq.current) setPreflight(r);
    } catch (e) {
      if (seq === preflightSeq.current) setPreflight({ ok: false, message: errorMessage(e) });
    } finally {
      if (seq === preflightSeq.current) setChecking(false);
    }
  };

  const pageLimit = allPages ? pageCap : maxPages;
  const viewports: ViewportName[] = viewportMode === 'both' ? ['desktop', 'mobile'] : [viewportMode];
  const toggleCheck = (c: Category) => setChecks((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  const scope = useMemo(() => {
    const items = [
      pageMode === 'discover'
        ? allPages
          ? `Scan every page found from the start page, its links and the XML sitemap (up to ${pageCap}; robots.txt rules are respected).`
          : `Discover up to ${maxPages} page${maxPages === 1 ? '' : 's'} from the start page, its links and the XML sitemap (robots.txt rules are respected).`
        : `Scan only the ${selectedUrls.split(/\s+/).filter(Boolean).length} page(s) you listed.`,
      `Load each page in Chrome at ${viewports.map((v) => (v === 'desktop' ? 'desktop 1366px' : 'mobile 390px')).join(' and ')}.`,
      `Run ${checks.length} check categor${checks.length === 1 ? 'y' : 'ies'}: ${checks.map((c) => CATEGORY_INFO[c].label).join(', ')}.`,
    ];
    if (checks.includes('links')) items.push(`Check up to ${limits.data?.linkCheckMax ?? 300} unique links${externalLinks ? ', including links to other websites' : ' on this website (external links are not requested)'}.`);
    if (checks.includes('performance')) items.push(`Run Lighthouse lab tests on the first ${limits.data?.lighthouseMaxPages ?? 3} page(s) — this adds roughly 20–40 seconds per page and viewport.`);
    if (visualCompare) items.push(`Compare screenshots with the selected baseline (changes above ${threshold}% of pixels are flagged for review).`);
    return items;
  }, [pageMode, maxPages, allPages, pageCap, selectedUrls, viewports, checks, externalLinks, visualCompare, threshold, limits.data]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!authorised) return setError('Please confirm that you are authorised to scan this website.');
    setSubmitting(true);
    try {
      const scan = await post<ScanDTO>('/scans', {
        ...(websiteId ? { websiteId } : { url }),
        kind,
        viewports,
        maxPages: pageMode === 'selected' ? Math.max(1, Math.min(pageCap, selectedUrls.split(/\s+/).filter(Boolean).length)) : pageLimit,
        pageMode,
        selectedUrls: pageMode === 'selected' ? selectedUrls.split(/\s+/).filter(Boolean) : [],
        checks,
        checkExternalLinks: externalLinks,
        visualCompare,
        baselineId: visualCompare ? baselineId || null : null,
        visualThresholdPct: threshold,
        ignoreSelectors: ignore.split('\n').map((s) => s.trim()).filter(Boolean),
        authorised: true,
      });
      navigate(`/scans/${scan.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  if (limits.loading && !limits.data) return <LoadingState />;

  return (
    <>
      <PageHeader title="New scan" description="Scan a public website with a real browser. You will see exactly what will be tested before the scan starts." />
      <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]" noValidate>
        <div className="space-y-6">
          <Card>
            <div className="p-5 sm:p-6">
              <label htmlFor="scan-url" className="text-base font-semibold text-slate-900">
                Website address
              </label>
              <p className="mt-1 text-sm text-slate-600">The page where the scan starts — usually the home page. Staging sites must be publicly reachable.</p>
              {websites.data && websites.data.length > 0 && (
                <div className="mt-4">
                  <label htmlFor="scan-website" className="label">Or choose a website from your workspace</label>
                  <select id="scan-website" className="input" value={websiteId} onChange={(e) => { setWebsiteId(e.target.value); setPreflight(null); setVisualCompare(false); setBaselineId(''); }}>
                    <option value="">— A new address —</option>
                    {websites.data.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.baseUrl})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <input
                  id="scan-url"
                  className="input h-12 text-base"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com"
                  value={target}
                  disabled={!!websiteId}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setPreflight(null);
                  }}
                  onBlur={() => !websiteId && url && void runPreflight()}
                  required
                  aria-describedby="preflight-result"
                />
                <Button type="button" variant="secondary" size="lg" onClick={runPreflight} loading={checking} disabled={!target}>
                  Check address
                </Button>
              </div>
              <div id="preflight-result" className="mt-3" aria-live="polite">
                {checking ? (
                  <Spinner label="Checking the address… a slow server can take up to 30 seconds." />
                ) : preflight ? (
                  preflight.ok ? (
                    <Alert
                      tone={preflight.reachable && !slowStart ? 'success' : 'warning'}
                      title={preflight.reachable ? `Reachable — HTTP ${preflight.status}${slowStart ? ' (slow)' : ''}` : 'The address did not respond'}
                    >
                      {preflight.notes?.map((n) => <p key={n}>{n}</p>)}
                    </Alert>
                  ) : (
                    <Alert tone="error" title="This address cannot be scanned">
                      {preflight.message}
                    </Alert>
                  )
                ) : null}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Scan type" />
            <div className="grid gap-3 p-5 sm:grid-cols-2">
              {(
                [
                  ['quick', 'Quick scan', 'Availability, HTML, SEO, accessibility, security headers, JavaScript errors and images. Desktop by default.', <Zap key="z" className="size-5" aria-hidden />],
                  ['full', 'Full scan', 'Everything in Quick, plus broken links, responsive layout with screenshots, and Lighthouse performance. Desktop and mobile.', <Radar key="r" className="size-5" aria-hidden />],
                ] as const
              ).map(([value, title, desc, icon]) => (
                <label
                  key={value}
                  className={cx(
                    'flex cursor-pointer gap-3 rounded-xl border p-4 transition',
                    kind === value ? 'border-brand-600 bg-brand-50/60 ring-2 ring-brand-600/20' : 'border-slate-200 hover:border-slate-300',
                  )}
                >
                  <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} className="sr-only" />
                  <div className={cx('mt-0.5', kind === value ? 'text-brand-700' : 'text-slate-500')}>{icon}</div>
                  <div>
                    <div className="font-semibold text-slate-900">{title}</div>
                    <div className="mt-1 text-sm text-slate-600">{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Pages and devices" />
            <div className="space-y-6 p-5">
              <fieldset>
                <legend className="label">Viewports</legend>
                <div className="inline-flex rounded-lg border border-slate-300 bg-surface p-1" role="radiogroup">
                  {(
                    [
                      ['desktop', 'Desktop', <Monitor key="m" className="size-4" aria-hidden />],
                      ['mobile', 'Mobile', <Smartphone key="s" className="size-4" aria-hidden />],
                      ['both', 'Both', null],
                    ] as const
                  ).map(([v, label, icon]) => (
                    <label key={v} className={cx('inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium', viewportMode === v ? 'bg-slate-900 text-slate-50' : 'text-slate-700 hover:bg-slate-100')}>
                      <input type="radio" name="viewport" className="sr-only" checked={viewportMode === v} onChange={() => setViewportMode(v)} />
                      {icon}
                      {label}
                    </label>
                  ))}
                </div>
                <p className="help">Desktop is 1366×900. Mobile is 390×844 with touch and mobile rendering.</p>
              </fieldset>

              <fieldset>
                <legend className="label">Which pages</legend>
                <div className="space-y-2">
                  <label className="flex items-start gap-2.5 text-sm">
                    <input type="radio" name="pageMode" className="mt-0.5 size-4 accent-brand-600" checked={pageMode === 'discover'} onChange={() => setPageMode('discover')} />
                    <span>
                      <span className="font-medium">Discover pages automatically</span>
                      <span className="block text-slate-600">From links on the site and its XML sitemap. Admin, login, cart, checkout and logout links are never visited.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 text-sm">
                    <input type="radio" name="pageMode" className="mt-0.5 size-4 accent-brand-600" checked={pageMode === 'selected'} onChange={() => setPageMode('selected')} />
                    <span>
                      <span className="font-medium">Only the pages I list</span>
                      <span className="block text-slate-600">One URL per line, on the same website.</span>
                    </span>
                  </label>
                </div>
                {pageMode === 'discover' ? (
                  <div className="mt-4 max-w-sm">
                    <label className="mb-3 flex items-start gap-2.5 text-sm">
                      <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={allPages} onChange={(e) => setAllPages(e.target.checked)} />
                      <span>
                        <span className="font-medium">All pages</span>
                        <span className="block text-slate-600">Scan every page found (up to {pageCap} on your {plan?.name} plan).</span>
                      </span>
                    </label>
                    {!allPages && (
                      <>
                        <label htmlFor="max-pages" className="label">
                          Maximum pages: <span className="tabular-nums">{maxPages}</span>
                        </label>
                        <input id="max-pages" type="range" min={1} max={pageCap} value={Math.min(maxPages, pageCap)} onChange={(e) => setMaxPages(Number(e.target.value))} className="w-full accent-brand-600" />
                      </>
                    )}
                    <p className="help">Your {plan?.name} plan allows up to {pageCap} pages per scan.</p>
                  </div>
                ) : (
                  <div className="mt-4">
                    <label htmlFor="selected-urls" className="label">Page URLs</label>
                    <textarea id="selected-urls" className="input min-h-28 font-mono text-xs" value={selectedUrls} onChange={(e) => setSelectedUrls(e.target.value)} placeholder={`${target || 'https://example.com'}\n${(target || 'https://example.com/').replace(/\/?$/, '/')}contact`} />
                  </div>
                )}
              </fieldset>
            </div>
          </Card>

          <Card>
            <CardHeader title="Checks" description="Pre-selected for the scan type. Turn individual categories on or off." />
            <div className="grid gap-2 p-5 sm:grid-cols-2">
              {SELECTABLE.map((c) => (
                <label key={c} className="flex items-start gap-2.5 rounded-lg p-2 text-sm hover:bg-slate-50">
                  <input type="checkbox" className="mt-0.5 size-4 rounded accent-brand-600" checked={checks.includes(c)} disabled={c === 'availability'} onChange={() => toggleCheck(c)} />
                  <span>
                    <span className="font-medium">{CATEGORY_INFO[c].label}</span>
                    <span className="block text-slate-600">{CATEGORY_INFO[c].description}</span>
                  </span>
                </label>
              ))}
              {checks.includes('links') && (
                <label className="flex items-start gap-2.5 rounded-lg p-2 text-sm sm:col-span-2">
                  <input type="checkbox" className="mt-0.5 size-4 rounded accent-brand-600" checked={externalLinks} onChange={(e) => setExternalLinks(e.target.checked)} />
                  <span>
                    <span className="font-medium">Also check links to other websites</span>
                    <span className="block text-slate-600">Each external URL is requested once with HEAD (or GET if HEAD is refused). Links that block automated checks are reported as inconclusive.</span>
                  </span>
                </label>
              )}
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 sm:col-span-2">
                <strong className="font-medium text-slate-700">Forms:</strong> forms are inspected (labels, insecure actions) but never submitted. Configurable form tests are not available yet.
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Visual comparison"
              description="Compare full-page screenshots with a saved baseline scan."
              actions={!plan?.visualComparison ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Pro and Agency plans</span> : undefined}
            />
            <div className="space-y-4 p-5">
              {!plan?.visualComparison ? (
                <p className="text-sm text-slate-600">Screenshots are still captured on Full scans so you can review layouts. Comparing them with a baseline needs the Pro plan.</p>
              ) : !websiteId ? (
                <p className="text-sm text-slate-600">Choose a website from your workspace above to compare against one of its baselines.</p>
              ) : !baselines.data?.length ? (
                <p className="text-sm text-slate-600">This website has no baseline yet. Run a Full scan, then use “Save as baseline” on its results page.</p>
              ) : (
                <>
                  <label className="flex items-center gap-2.5 text-sm font-medium">
                    <input type="checkbox" className="size-4 rounded accent-brand-600" checked={visualCompare} onChange={(e) => setVisualCompare(e.target.checked)} />
                    Compare with a baseline
                  </label>
                  {visualCompare && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="baseline" className="label">Baseline</label>
                        <select id="baseline" className="input" value={baselineId} onChange={(e) => setBaselineId(e.target.value)} required>
                          <option value="">Choose…</option>
                          {baselines.data.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name} — {fmtDateTime(b.scanFinishedAt)} ({b.viewports.join(' + ')})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="threshold" className="label">
                          Flag changes above <span className="tabular-nums">{threshold}%</span> of pixels
                          <InfoTip>Small differences from font rendering are normal. Raise the threshold for busy pages; lower it to catch subtle changes.</InfoTip>
                        </label>
                        <input id="threshold" type="range" min={0.1} max={10} step={0.1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="w-full accent-brand-600" />
                      </div>
                      <div className="sm:col-span-2">
                        <label htmlFor="ignore" className="label">Hide dynamic areas (CSS selectors, one per line)</label>
                        <textarea id="ignore" className="input min-h-20 font-mono text-xs" value={ignore} onChange={(e) => setIgnore(e.target.value)} placeholder={'.cookie-banner\n#live-chat\n.hero-slider'} />
                        <p className="help">These areas are painted over in both screenshots so sliders, dates and adverts do not trigger false changes. Use the same list as the baseline scan.</p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <Card>
            <CardHeader title="What this scan will do" icon={<Info className="size-5" aria-hidden />} />
            <ul className="space-y-2.5 p-5 text-sm text-slate-700">
              {scope.map((s) => (
                <li key={s} className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
            <div className="border-t border-slate-100 p-5 text-sm text-slate-700">
              <p className="mb-2 font-medium text-slate-900">What it will not do</p>
              <ul className="list-disc space-y-1.5 pl-5 text-slate-600">
                <li>Submit forms, log in, buy anything or send messages.</li>
                <li>Contact private, internal or local network addresses.</li>
                <li>Prove WCAG compliance — automated checks find only part of accessibility issues.</li>
                <li>Measure real-visitor speed — performance numbers are lab measurements.</li>
              </ul>
              <p className="mt-3 text-xs text-slate-500">Time limit: {limits.data?.maxDurationMinutes ?? 20} minutes per scan.</p>
            </div>
          </Card>
          <Card>
            <div className="space-y-4 p-5">
              <label className="flex items-start gap-2.5 text-sm text-slate-800">
                <input type="checkbox" className="mt-0.5 size-4 rounded accent-brand-600" checked={authorised} onChange={(e) => setAuthorised(e.target.checked)} />
                <span>
                  <ShieldAlert className="mr-1 inline size-4 align-text-bottom text-amber-600" aria-hidden />I confirm I own this website or have permission from its owner to scan it.
                </span>
              </label>
              {error && <Alert tone="error">{error}</Alert>}
              {scansLeft !== null && scansLeft <= 0 && <Alert tone="warning">You have used all scans included in your plan this month.</Alert>}
              <Button type="submit" size="lg" className="w-full" loading={submitting} disabled={!target || !authorised || (scansLeft !== null && scansLeft <= 0) || (visualCompare && !baselineId)}>
                Start scan
              </Button>
              {scansLeft !== null && <p className="text-center text-xs text-slate-500">{scansLeft} of {plan?.scansPerMonth} scans left this month</p>}
            </div>
          </Card>
        </aside>
      </form>
    </>
  );
}
