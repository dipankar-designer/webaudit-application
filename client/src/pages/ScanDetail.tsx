import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Bookmark, FileText, Gauge, Images, RotateCcw, Sparkles, Square, Trash2 } from 'lucide-react';
import {
  SEVERITY_LABELS,
  VIEWPORTS,
  type CheckRunDTO,
  type LabMetricsDTO,
  type ReportDTO,
  type ReportPageDTO,
  type ScanDTO,
  type Severity,
  type VisualComparisonDTO,
} from '@wpcg/shared';
import { del, errorMessage, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { fmtDateTime, fmtDuration, pathOf, plural } from '../lib/format';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ErrorState,
  InfoTip,
  LinkButton,
  LoadingState,
  RefreshFailed,
  Modal,
  PageHeader,
  Pagination,
  ScanStatusBadge,
  SeverityBadge,
  Spinner,
  cx,
} from '../components/ui';
import { VerificationPanel, WordPressSection } from '../components/AuditSections';
import { IssueExplorer } from '../components/IssueExplorer';

interface ScanDetail {
  scan: ScanDTO;
  checkRuns: CheckRunDTO[];
  pages: ReportPageDTO[];
  visual: VisualComparisonDTO[];
}

const PHASES: Record<string, string> = {
  starting: 'Starting',
  discovery: 'Discovering pages',
  pages: 'Testing pages in Chrome',
  site: 'Site-wide checks',
  links: 'Checking links',
  visual: 'Comparing screenshots',
  performance: 'Lighthouse performance',
};

export function ScanDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<ScanDetail>(`/scans/${id}`, {
    pollMs: 2500,
    shouldPoll: (d) => d.scan.status === 'queued' || d.scan.status === 'running',
  });
  const done = data?.scan.status === 'completed';
  const report = useApi<ReportDTO>(done ? `/reports/${id}` : null);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading && !data) return <LoadingState />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const { scan, pages, visual } = data!;
  const s = scan.summary;

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      after?.();
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const rescan = () =>
    act(async () => {
      const c = scan.config;
      const r = await post<ScanDTO>('/scans', {
        websiteId: scan.websiteId,
        kind: c.kind === 'verification' ? 'quick' : c.kind,
        viewports: c.viewports,
        maxPages: c.maxPages,
        pageMode: c.pageMode,
        selectedUrls: c.selectedUrls,
        checks: c.checks.filter((x) => x !== 'visual'),
        checkExternalLinks: c.checkExternalLinks,
        visualCompare: false,
        authorised: true,
      });
      navigate(`/scans/${r.id}`);
    });

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/scans" className="hover:underline">
            Scan history
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {scan.websiteName}
            <ScanStatusBadge status={scan.status} />
            {scan.isBaseline && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">Baseline</span>}
          </span>
        }
        description={`${scan.kind === 'verification' ? 'Verification' : scan.kind === 'full' ? 'Full' : 'Quick'} scan of ${scan.websiteUrl} · started ${fmtDateTime(scan.startedAt ?? scan.createdAt)} · ${fmtDuration(scan.durationMs)}`}
        actions={
          <>
            {(scan.status === 'queued' || scan.status === 'running') && (
              <Button variant="secondary" onClick={() => act(() => post(`/scans/${scan.id}/cancel`))} loading={busy} icon={<Square className="size-4" aria-hidden />}>
                Cancel scan
              </Button>
            )}
            {(scan.status === 'completed' || scan.status === 'failed' || scan.status === 'cancelled') && (
              <>
                <Button variant="ghost" onClick={() => setDeleteOpen(true)} icon={<Trash2 className="size-4" aria-hidden />}>
                  Delete
                </Button>
                <Button variant="secondary" onClick={rescan} loading={busy} icon={<RotateCcw className="size-4" aria-hidden />}>
                  Run again
                </Button>
              </>
            )}
            {done && !scan.isBaseline && (
              <Button variant="secondary" onClick={() => setBaselineOpen(true)} icon={<Bookmark className="size-4" aria-hidden />}>
                Save as baseline
              </Button>
            )}
            {done && (
              <LinkButton to={`/reports/${scan.id}`} icon={<FileText className="size-4" aria-hidden />}>
                View report
              </LinkButton>
            )}
          </>
        }
      />
      <RefreshFailed error={data ? error : null} onRetry={reload} />

      {actionError && <Alert tone="error" className="mb-4" onDismiss={() => setActionError(null)}>{actionError}</Alert>}
      {notice && <Alert tone="success" className="mb-4" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {(scan.status === 'queued' || scan.status === 'running') && <ProgressCard scan={scan} />}
      {scan.status === 'failed' && (
        <Alert tone="error" title={scan.error?.startsWith('Scanner limitation') ? 'The scanner could not run this scan' : 'The scan did not finish'} className="mb-6">
          <p>{scan.error}</p>
          <p className="text-xs opacity-80">No issue statuses were changed by this scan.</p>
        </Alert>
      )}
      {scan.status === 'cancelled' && (
        <Alert tone="info" title="Scan cancelled" className="mb-6">
          {scan.error ?? 'Cancelled before it finished. No issue statuses were changed.'}
        </Alert>
      )}

      {done && s && (
        <div className="space-y-6">
          <SummaryCard scan={scan} />

          {s.notes && s.notes.length > 0 && (
            <Alert tone="info" title="Scope notes">
              <ul className="list-disc pl-4">
                {s.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Alert>
          )}

          {report.data && <VerificationPanel counts={report.data.verification} summary={s} />}
          <WordPressSection wp={s.wordpress} />

          {report.data ? <AiSummaryCard report={report.data} onDone={report.reload} /> : null}

          <div id="results" className="scroll-mt-6">
            {report.error ? <ErrorState error={report.error} onRetry={report.reload} /> : report.data ? <IssueExplorer report={report.data} /> : <LoadingState label="Loading results…" />}
          </div>

          <PagesCard scanId={scan.id} total={pages.length} />
          {visual.length > 0 && <VisualCard items={visual} />}
          <LabMetricsCard pages={pages} />
        </div>
      )}

      <BaselineModal
        open={baselineOpen}
        onClose={() => setBaselineOpen(false)}
        scanId={scan.id}
        onSaved={(n) => {
          setNotice(`Saved as baseline with ${plural(n, 'screenshot')}.${n === 0 ? ' This scan has no screenshots, so it can only be used for issue comparison — run a Full scan to capture screenshots.' : ''}`);
          reload();
        }}
      />
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this scan?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              Keep it
            </Button>
            <Button variant="danger" loading={busy} onClick={() => act(() => del(`/scans/${scan.id}`), () => navigate('/scans'))}>
              Delete scan
            </Button>
          </>
        }
      >
        {/* The page behind an open dialog is inert: show a failed delete here, where it is seen. */}
        {actionError && (
          <Alert tone="error" className="mb-3">
            {actionError}
          </Alert>
        )}
        Its pages, findings and screenshots are deleted permanently. Issues stay in your list with their history from other scans.
      </Modal>
    </>
  );
}

function ProgressCard({ scan }: { scan: ScanDTO }) {
  const p = scan.progress;
  const pct = p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
  return (
    <Card className="mb-6">
      <div className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-slate-900">{scan.status === 'queued' ? 'Waiting for a scanner…' : PHASES[p?.phase ?? 'starting'] ?? 'Working'}</div>
            <div className="mt-0.5 text-sm text-slate-600" aria-live="polite">
              {p?.message ?? 'The scan will start shortly.'}
            </div>
          </div>
          {pct !== null && <div className="text-2xl font-semibold tabular-nums text-slate-900">{pct}%</div>}
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label="Scan progress">
          <div className={cx('h-full rounded-full bg-brand-600 transition-all', pct === null && 'w-1/3 animate-pulse')} style={pct !== null ? { width: `${Math.max(4, pct)}%` } : undefined} />
        </div>
        <p className="mt-3 text-xs text-slate-500">You can leave this page — the scan keeps running and results appear in Scan history.</p>
      </div>
    </Card>
  );
}

const PAGES_PER_VIEW = 10;

/** Pages tested, 10 at a time, fetched page by page (only this section updates). */
function PagesCard({ scanId, total }: { scanId: string; total: number }) {
  const [shot, setShot] = useState<{ url: string; title: string } | null>(null);
  const [page, setPage] = useState(1);
  const heading = useRef<HTMLDivElement>(null);
  const { data, error, loading, reload } = useApi<{ items: ReportPageDTO[]; total: number }>(`/scans/${scanId}/pages?limit=${PAGES_PER_VIEW}&offset=${(page - 1) * PAGES_PER_VIEW}`, { keepPrevious: true });
  const pages = data?.items ?? [];
  const go = (p: number) => {
    setPage(p);
    // Keep the reader at the top of this section, and tell keyboard / screen-reader users where they are.
    heading.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    heading.current?.focus({ preventScroll: true });
  };
  return (
    <Card>
      <div ref={heading} tabIndex={-1} className="scroll-mt-6 rounded-t-xl focus:outline-none">
        <CardHeader title="Pages tested" description={`HTTP result, findings and screenshots for each of the ${(data?.total ?? total).toLocaleString()} pages.`} icon={<Images className="size-5" aria-hidden />} />
      </div>
      {error ? (
        <div className="p-5">
          <ErrorState error={error} onRetry={reload} />
        </div>
      ) : !data && loading ? (
        <LoadingState label="Loading pages…" />
      ) : null}
      <ul className={cx('divide-y divide-slate-100 transition-opacity', loading && data && 'opacity-50')} aria-busy={loading || undefined}>
        {pages.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
            <div className="min-w-0 flex-1 basis-64">
              <a href={p.url} target="_blank" rel="noreferrer noopener" className="block truncate text-sm font-medium text-slate-900 hover:underline" title={p.url}>
                {pathOf(p.url)}
              </a>
              <div className="truncate text-xs text-slate-500">{p.title ?? (p.error ? '' : 'No title')}</div>
              {p.error && <div className="mt-0.5 text-xs text-red-700">{p.error}</div>}
            </div>
            <span className={cx('rounded px-1.5 py-0.5 font-mono text-xs', p.statusCode && p.statusCode < 400 ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800')}>{p.statusCode ?? 'ERR'}</span>
            <span className="w-20 text-xs text-slate-500">{p.loadMs !== null ? `${p.loadMs} ms` : ''}</span>
            <span className="w-24 text-xs text-slate-600">{plural(p.findings, 'finding')}</span>
            <div className="flex gap-2">
              {p.screenshots.map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  onClick={() => setShot({ url: sc.url, title: `${pathOf(p.url)} — ${VIEWPORTS[sc.viewport].label}` })}
                  className="overflow-hidden rounded border border-slate-200 hover:border-brand-500"
                  aria-label={`View ${sc.viewport} screenshot of ${pathOf(p.url)}`}
                >
                  <img src={sc.url} alt="" loading="lazy" className={cx('object-cover object-top', sc.viewport === 'mobile' ? 'h-14 w-8' : 'h-14 w-20')} />
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {data && data.total > PAGES_PER_VIEW && (
        <div className="border-t border-slate-100 px-5 py-4">
          <Pagination page={page} pageSize={PAGES_PER_VIEW} total={data.total} onChange={go} label="Pages tested" />
        </div>
      )}
      {shot && (
        <Modal open onClose={() => setShot(null)} title={shot.title}>
          <div className="max-h-[70vh] overflow-auto rounded border border-slate-200">
            <img src={shot.url} alt={`Screenshot: ${shot.title}`} className="w-full" />
          </div>
        </Modal>
      )}
    </Card>
  );
}

function VisualCard({ items }: { items: VisualComparisonDTO[] }) {
  const [open, setOpen] = useState<VisualComparisonDTO | null>(null);
  return (
    <Card>
      <CardHeader
        title="Visual comparison"
        description="Screenshots compared with the baseline. Differences can come from dynamic content — review before acting."
      />
      <ul className="divide-y divide-slate-100">
        {items.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span className="min-w-0 flex-1 basis-56 truncate font-medium" title={v.pageUrl}>
              {pathOf(v.pageUrl)} <span className="font-normal text-slate-500">· {v.viewport}</span>
            </span>
            <span
              className={cx(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                v.status === 'changed' ? 'bg-amber-50 text-amber-900' : v.status === 'match' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700',
              )}
            >
              {v.status === 'changed' ? 'Changed' : v.status === 'match' ? 'Within threshold' : v.status === 'incomparable' ? 'No baseline image' : 'Comparison failed'}
            </span>
            <span className="w-36 text-xs text-slate-600 tabular-nums">{v.diffRatio !== null ? `${(v.diffRatio * 100).toFixed(2)}% changed (limit ${v.thresholdPct}%)` : v.note}</span>
            {v.diffImage && (
              <Button size="sm" variant="secondary" onClick={() => setOpen(v)}>
                Compare
              </Button>
            )}
          </li>
        ))}
      </ul>
      {open && (
        <Modal open onClose={() => setOpen(null)} title={`${pathOf(open.pageUrl)} — ${open.viewport}`}>
          {open.note && <p className="mb-3 text-xs text-slate-600">{open.note}</p>}
          <div className="grid max-h-[70vh] grid-cols-3 gap-2 overflow-auto">
            {(
              [
                ['Baseline', open.baselineImage],
                ['Current', open.currentImage],
                ['Difference', open.diffImage],
              ] as const
            ).map(([label, src]) => (
              <figure key={label}>
                <figcaption className="mb-1 text-xs font-medium text-slate-600">{label}</figcaption>
                {src ? <img src={src} alt={`${label} screenshot`} className="w-full rounded border border-slate-200" /> : <div className="text-xs text-slate-500">Not available</div>}
              </figure>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">Red pixels in the difference image changed. If the page height changed, the extra area counts as changed. Areas hidden by your ignore rules appear as flat blocks in both screenshots.</p>
        </Modal>
      )}
    </Card>
  );
}

function LabMetricsCard({ pages }: { pages: ReportPageDTO[] }) {
  const rows = pages.flatMap((p) => Object.entries(p.labMetrics ?? {}).map(([vp, m]) => ({ url: p.url, vp, m: m as LabMetricsDTO })));
  if (!rows.length) return null;
  const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1">
            Lab performance
            <InfoTip>Measured by Lighthouse in a controlled lab run, once. Real visitors&apos; Core Web Vitals (field data) can be different, and INP can only be measured from real visitors.</InfoTip>
          </span>
        }
        icon={<Gauge className="size-5" aria-hidden />}
        description={rows[0].m.tool}
      />
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Checks run (scrolls sideways)">
        <table className="table-base min-w-[40rem]">
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Viewport</th>
              <th scope="col">Score</th>
              <th scope="col">LCP</th>
              <th scope="col">FCP</th>
              <th scope="col">CLS</th>
              <th scope="col">TBT</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.url}-${r.vp}`}>
                <td className="max-w-56 truncate" title={r.url}>{pathOf(r.url)}</td>
                <td>{r.vp}</td>
                <td className="tabular-nums">{r.m.performanceScore !== null ? Math.round(r.m.performanceScore * 100) : '—'}</td>
                <td className="tabular-nums">{ms(r.m.lcpMs)}</td>
                <td className="tabular-nums">{ms(r.m.fcpMs)}</td>
                <td className="tabular-nums">{r.m.cls !== null ? r.m.cls.toFixed(3) : '—'}</td>
                <td className="tabular-nums">{ms(r.m.tbtMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function BaselineModal({ open, onClose, scanId, onSaved }: { open: boolean; onClose: () => void; scanId: string; onSaved: (screens: number) => void }) {
  const [name, setName] = useState(`Baseline ${new Date().toLocaleDateString()}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ screenshotCount: number }>('/baselines', { scanId, name });
      onSaved(r.screenshotCount);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save as baseline"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim()}>
            Save baseline
          </Button>
        </>
      }
    >
      {err && <Alert tone="error" className="mb-3">{err}</Alert>}
      <p className="mb-3">Later scans can compare their screenshots with this one. Choose a name you will recognise, such as “Before plugin updates”.</p>
      <label className="label" htmlFor="baseline-name">Name</label>
      <input id="baseline-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
    </Modal>
  );
}

/** Priority overview: one tile per severity; clicking a tile filters the results below. */
function SummaryCard({ scan }: { scan: ScanDTO }) {
  const s = scan.summary!;
  const [params, setParams] = useSearchParams();
  const pick = (sev: Severity) => {
    const next = new URLSearchParams(params);
    next.delete('category');
    next.set('severity', sev);
    setParams(next, { replace: true, preventScrollReset: true });
    document.getElementById('results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const tiles: { sev: Severity; tone: string; ring: string }[] = [
    { sev: 'critical', tone: 'text-red-700', ring: 'hover:border-red-300' },
    { sev: 'high', tone: 'text-orange-700', ring: 'hover:border-orange-300' },
    { sev: 'medium', tone: 'text-amber-700', ring: 'hover:border-amber-300' },
    { sev: 'low', tone: 'text-sky-700', ring: 'hover:border-sky-300' },
    { sev: 'info', tone: 'text-slate-700', ring: 'hover:border-slate-300' },
  ];
  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Audit summary</h2>
          <p className="mt-0.5 text-sm text-slate-600">
            {s.confirmedIssues !== undefined ? (
              <>
                <strong className="font-semibold text-slate-900">{plural(s.confirmedIssues, 'confirmed issue')}</strong>
                {s.needsManualReview ? `, ${s.needsManualReview} need manual review` : ''}
                {s.pendingVerification ? `, ${s.pendingVerification} pending verification` : ''}
              </>
            ) : (
              <strong className="font-semibold text-slate-900">{plural(s.issuesDetected, 'issue')}</strong>
            )}{' '}
            on {plural(s.pagesScanned, 'page')}
            {s.pagesFailed ? ` (${s.pagesFailed} could not be tested)` : ''} · {s.newIssues} new · {s.resolvedIssues} resolved · {s.reopenedIssues} reopened since earlier scans
          </p>
        </div>
        <Link to={`/reports/${scan.id}`} className="text-sm font-medium text-brand-700 hover:underline">
          Full report
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <button
            key={t.sev}
            type="button"
            onClick={() => pick(t.sev)}
            className={cx('rounded-xl border border-slate-200 p-4 text-left transition hover:shadow-sm', t.ring)}
            aria-label={`Show ${SEVERITY_LABELS[t.sev]} priority issues (${s.bySeverity[t.sev]})`}
          >
            <SeverityBadge severity={t.sev} />
            <div className={cx('mt-2 text-3xl font-semibold tracking-tight tabular-nums', s.bySeverity[t.sev] ? t.tone : 'text-slate-300')}>{s.bySeverity[t.sev]}</div>
          </button>
        ))}
      </div>
    </Card>
  );
}

/** AI explanation of the whole scan (step 5). Shown only when an AI provider is configured. */
function AiSummaryCard({ report, onDone }: { report: ReportDTO; onDone: () => void }) {
  const ai = useApi<{ configured: boolean; enabledForWorkspace: boolean; provider: string | null; model: string | null }>('/ai/status');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ai.data?.configured || !ai.data.enabledForWorkspace) return null;
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/ai/scans/${report.scan.id}/summary`, {});
      onDone();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <div className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Sparkles className="size-5 text-brand-600" aria-hidden />
            AI analysis
          </h2>
          {!busy && (
            <Button size="sm" variant={report.aiSummary ? 'ghost' : 'primary'} onClick={run} icon={<Sparkles className="size-4" aria-hidden />}>
              {report.aiSummary ? 'Regenerate' : 'Explain these results with AI'}
            </Button>
          )}
        </div>
        {busy ? (
          <div className="mt-3">
            <Spinner label={`Analysing the results with ${ai.data.model ?? 'AI'}… this can take a minute or two.`} />
          </div>
        ) : report.aiSummary ? (
          <>
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">{report.aiSummary.content}</p>
            <p className="mt-3 text-xs text-slate-500">
              Written by {report.aiSummary.provider} · {report.aiSummary.model} from this scan&apos;s stored results only. Check its advice against the evidence before acting.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-600">Get a plain-language summary of what was found and what to fix first. Each issue also has its own “Explain this issue” button.</p>
        )}
        {err && (
          <Alert tone="error" className="mt-3">
            {err}
          </Alert>
        )}
      </div>
    </Card>
  );
}
