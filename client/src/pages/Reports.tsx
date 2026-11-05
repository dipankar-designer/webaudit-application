import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Download, FileSpreadsheet, FileText, Printer, Sparkles } from 'lucide-react';
import {
  CATEGORY_INFO,
  SEVERITIES,
  SEVERITY_LABELS,
  VIEWPORTS,
  type ReportDTO,
  type ReportIssueDTO,
  type ScanDTO,
} from '@wpcg/shared';
import { errorMessage, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { fmtDateTime, fmtDuration, pathOf, plural } from '../lib/format';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  CheckStatusBadge,
  EmptyState,
  ErrorState,
  IssueStatusBadge,
  LinkButton,
  LoadingState,
  PageHeader,
  Pagination,
  SeverityBadge,
  SeverityBar,
  Spinner,
} from '../components/ui';
import { VerificationPanel, WordPressSection } from '../components/AuditSections';

const REPORTS_PER_PAGE = 25;

export function ReportsPage() {
  // Paged in place (older reports used to be cut off silently after the first 100).
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useApi<{ items: ScanDTO[]; total: number }>(`/scans?status=completed&limit=${REPORTS_PER_PAGE}&offset=${(page - 1) * REPORTS_PER_PAGE}`, {
    keepPrevious: true,
  });
  return (
    <>
      <PageHeader title="Reports" description="Every completed scan has a report you can read here, print, or download as PDF and CSV." />
      <Card>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <div className="p-5">
            <ErrorState error={error} onRetry={reload} />
          </div>
        ) : !data?.items.length ? (
          <EmptyState icon={<FileText className="size-6" aria-hidden />} title="No reports yet" action={<LinkButton to="/scans/new">Start a scan</LinkButton>}>
            Reports appear here when a scan completes.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <div className="min-w-0 flex-1 basis-60">
                  <Link to={`/reports/${s.id}`} className="font-medium text-slate-900 hover:underline">
                    {s.websiteName}
                  </Link>
                  <div className="text-xs text-slate-500">
                    {s.kind === 'verification' ? 'Verification' : s.kind === 'full' ? 'Full' : 'Quick'} scan · {fmtDateTime(s.finishedAt)} · {plural(s.summary?.issuesDetected ?? 0, 'issue')}
                  </div>
                </div>
                <div className="w-40 max-sm:w-full">{s.summary && <SeverityBar counts={s.summary.bySeverity} />}</div>
                <div className="flex gap-2">
                  <LinkButton to={`/reports/${s.id}`} size="sm" variant="secondary">
                    Open
                  </LinkButton>
                  <a href={`/api/reports/${s.id}/report.pdf`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-surface px-3 text-xs font-medium text-slate-800 shadow-sm hover:bg-slate-50">
                    <Download className="size-3.5" aria-hidden />
                    PDF
                  </a>
                  <a href={`/api/reports/${s.id}/issues.csv`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-surface px-3 text-xs font-medium text-slate-800 shadow-sm hover:bg-slate-50">
                    <FileSpreadsheet className="size-3.5" aria-hidden />
                    CSV
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
        {data && (
          <div className="border-t border-slate-100 px-5 py-3 empty:hidden">
            <Pagination page={page} pageSize={REPORTS_PER_PAGE} total={data.total} onChange={setPage} label="Reports" />
          </div>
        )}
      </Card>
    </>
  );
}

function IssueBlock({ issue }: { issue: ReportIssueDTO }) {
  const ev = issue.evidence[0];
  return (
    <article className="card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={issue.severity} />
        <IssueStatusBadge status={issue.status} />
        {issue.changeInScan !== 'existing' && (
          <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-medium text-slate-50">{issue.changeInScan === 'new' ? 'New' : 'Reopened'}</span>
        )}
        <span className="text-xs text-slate-500">
          {CATEGORY_INFO[issue.category].label}
          {issue.wcag.length ? ` · WCAG ${issue.wcag.join(', ')}` : ''}
        </span>
      </div>
      <h3 className="mt-2 font-semibold text-slate-900">
        <Link to={`/issues/${issue.id}`} className="hover:underline">
          {issue.title}
        </Link>
      </h3>
      <dl className="mt-3 space-y-2 text-sm text-slate-700">
        <div>
          <dt className="font-medium text-slate-900">What was detected</dt>
          <dd>{issue.description}</dd>
        </div>
        <div>
          <dt className="font-medium text-slate-900">Where</dt>
          <dd className="break-all">{issue.affectedUrls.slice(0, 5).map(pathOf).join(', ')}{issue.affectedCount > 5 ? `, and ${issue.affectedCount - 5} more` : ''}</dd>
        </div>
        <div>
          <dt className="font-medium text-slate-900">Why it matters</dt>
          <dd>{issue.remediation.whyItMatters}</dd>
        </div>
        {ev && (
          <div>
            <dt className="font-medium text-slate-900">Evidence</dt>
            <dd>
              <dl className="mt-1 space-y-1.5 rounded-lg bg-slate-50 p-3 text-xs">
                {ev.evidence.slice(0, 4).map((e, k) => (
                  <div key={k}>
                    <dt className="font-medium text-slate-600">{e.label}</dt>
                    <dd className={e.code ? 'font-mono break-words whitespace-pre-wrap' : ''}>{e.value.length > 600 ? `${e.value.slice(0, 600)}…` : e.value}</dd>
                  </div>
                ))}
              </dl>
            </dd>
          </div>
        )}
        <div>
          <dt className="font-medium text-slate-900">How to fix it</dt>
          <dd>
            <ol className="mt-1 list-decimal space-y-1 pl-5">
              {issue.remediation.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-900">How to verify</dt>
          <dd>{issue.remediation.verify.join(' ')}</dd>
        </div>
      </dl>
    </article>
  );
}

/** "All 57 pages found" when the scan covered everything; otherwise says how many were left out and why. */
export function scopeText(s: ScanDTO): string {
  const scanned = s.summary?.pagesScanned ?? 0;
  const found = s.summary?.pagesDiscovered ?? 0;
  if (s.config.pageMode === 'selected') return `${scanned} selected page${scanned === 1 ? '' : 's'}`;
  if (found <= scanned) return `All ${found} page${found === 1 ? '' : 's'} found (${scanned} scanned)`;
  return `${scanned} of ${found} pages found — ${found - scanned} not scanned because of the ${s.config.maxPages}-page limit`;
}

export function ReportViewPage() {
  const { scanId } = useParams();
  const { data, error, loading, reload } = useApi<ReportDTO>(`/reports/${scanId}`);
  const ai = useApi<{ configured: boolean; enabledForWorkspace: boolean }>('/ai/status');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfErr, setPdfErr] = useState<string | null>(null);

  if (loading && !data) return <LoadingState label="Building the report…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const r = data!;
  const s = r.scan;
  if (s.status !== 'completed')
    return (
      <Card>
        <EmptyState title="This scan has not completed" action={<LinkButton to={`/scans/${s.id}`}>Open the scan</LinkButton>}>
          Reports are available for completed scans only.
        </EmptyState>
      </Card>
    );

  const summarise = async () => {
    setAiBusy(true);
    setAiErr(null);
    try {
      await post(`/ai/scans/${s.id}/summary`, {});
      reload();
    } catch (e) {
      setAiErr(errorMessage(e));
    } finally {
      setAiBusy(false);
    }
  };

  // Download through fetch first so failures show as a message instead of a broken download.
  const downloadPdf = async () => {
    setPdfBusy(true);
    setPdfErr(null);
    try {
      const res = await fetch(`/api/reports/${s.id}/report.pdf`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `PDF export failed (${res.status}).`);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'report.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      setPdfErr(errorMessage(e));
    } finally {
      setPdfBusy(false);
    }
  };

  const newCount = r.issues.filter((i) => i.changeInScan === 'new').length;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="no-print">
        <PageHeader
          eyebrow={<Link to="/reports" className="hover:underline">Reports</Link>}
          title="Website audit report"
          actions={
            <>
              <Button variant="secondary" onClick={() => window.print()} icon={<Printer className="size-4" aria-hidden />}>
                Print
              </Button>
              <a href={`/api/reports/${s.id}/issues.csv`} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-surface px-4 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50">
                <FileSpreadsheet className="size-4" aria-hidden />
                CSV
              </a>
              <Button onClick={downloadPdf} loading={pdfBusy} icon={<Download className="size-4" aria-hidden />}>
                PDF
              </Button>
            </>
          }
        />
        {pdfErr && <Alert tone="error" className="mb-4">{pdfErr}</Alert>}
      </div>

      <div className="space-y-6">
        <Card>
          <div className="border-b-4 border-brand-600 p-6">
            <p className="text-sm text-slate-500">{r.brandName || 'WebAudit AI'} · Website audit report</p>
            <h1 className="mt-1 text-2xl font-semibold">{s.websiteName}</h1>
            <p className="text-sm break-all text-slate-600">{s.websiteUrl}</p>
          </div>
          <dl className="grid gap-x-6 gap-y-3 p-6 text-sm sm:grid-cols-2">
            {[
              ['Scan date', fmtDateTime(s.startedAt ?? s.createdAt)],
              ['Duration', fmtDuration(s.durationMs)],
              ['Scan type', s.kind === 'full' ? 'Full scan' : s.kind === 'quick' ? 'Quick scan' : 'Verification scan'],
              ['Scope', scopeText(s)],
              ['Viewports', s.config.viewports.map((v) => VIEWPORTS[v].label).join(', ')],
              ['Checks', s.config.checks.map((c) => CATEGORY_INFO[c].label).join(', ')],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs font-medium text-slate-500">{k}</dt>
                <dd className="mt-0.5 text-slate-900">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <CardHeader title="Summary" />
          <div className="space-y-4 p-5 text-sm text-slate-700">
            <p>
              This scan found <strong>{plural(r.verification.confirmed, 'confirmed issue')}</strong> on the pages tested
              {r.verification.needsManualReview ? `, plus ${r.verification.needsManualReview} item${r.verification.needsManualReview === 1 ? '' : 's'} that need manual review` : ''}
              {r.verification.pendingVerification ? ` and ${r.verification.pendingVerification} pending verification` : ''} (these are not counted as defects). {newCount} new, {r.reopened.length} reopened, and {r.resolved.length} previously reported issue{r.resolved.length === 1 ? '' : 's'} resolved.
              {r.notCompleted.length > 0 && ` ${plural(r.notCompleted.length, 'test category', 'test categories')} did not complete — see “Tests not completed”.`}
            </p>
            <SeverityBar counts={r.severity} />
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {SEVERITIES.map((k) => (
                <span key={k} className="flex items-center gap-2">
                  <SeverityBadge severity={k} />
                  <span className="tabular-nums">{r.severity[k]}</span>
                </span>
              ))}
            </div>
            {r.aiSummary ? (
              <div className="rounded-lg border border-brand-100 bg-brand-50/50 p-4">
                <p className="flex items-center gap-1.5 text-xs font-medium text-brand-800">
                  <Sparkles className="size-3.5" aria-hidden />
                  AI summary ({r.aiSummary.provider} · {r.aiSummary.model}), written from the results in this report
                </p>
                <p className="mt-2 whitespace-pre-wrap">{r.aiSummary.content}</p>
              </div>
            ) : ai.data?.configured && ai.data.enabledForWorkspace ? (
              <div className="no-print">
                {aiBusy ? <Spinner label="Writing a summary…" /> : (
                  <Button size="sm" variant="secondary" onClick={summarise} icon={<Sparkles className="size-4" aria-hidden />}>
                    Add an AI summary
                  </Button>
                )}
                {aiErr && <Alert tone="error" className="mt-2">{aiErr}</Alert>}
              </div>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader title="Results by category" />
          <ul className="divide-y divide-slate-100">
            {r.checkRuns
              .filter((c) => c.status !== 'skipped' || s.config.checks.includes(c.category))
              .map((c) => {
                const cat = r.byCategory.find((b) => b.category === c.category);
                return (
                  <li key={c.category} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                    <span className="min-w-0 flex-1 basis-40 font-medium">{CATEGORY_INFO[c.category].label}</span>
                    <CheckStatusBadge status={c.status} />
                    <span className="w-20 text-right text-slate-600 tabular-nums">{plural(cat?.total ?? 0, 'issue')}</span>
                    <div className="w-32">{cat && <SeverityBar counts={cat.bySeverity} />}</div>
                  </li>
                );
              })}
          </ul>
        </Card>

        {r.previous && (
          <Card>
            <CardHeader title="Compared with the previous scan" description={`Previous scan: ${fmtDateTime(r.previous.finishedAt)}`} />
            <div className="grid gap-6 p-5 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs text-slate-500">Issues then → now</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {r.previous.summary?.issuesDetected ?? '—'} → {r.issues.length}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Resolved</div>
                <div className="mt-1 text-xl font-semibold text-emerald-700 tabular-nums">{r.resolved.length}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">New / reopened</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {newCount} / {r.reopened.length}
                </div>
              </div>
            </div>
            {r.resolved.length > 0 && (
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {r.resolved.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-sm">
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">Resolved</span>
                    <span className="flex-1">{i.title}</span>
                    <span className="text-xs text-slate-500">{SEVERITY_LABELS[i.severity]}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card>
          <CardHeader title="Top priorities" description="Fix these first: the most severe active issues found in this scan." />
          {r.topPriorities.length ? (
            <ol className="divide-y divide-slate-100">
              {r.topPriorities.map((i, n) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                  <span className="w-6 text-right font-semibold text-slate-500 tabular-nums">{n + 1}</span>
                  <SeverityBadge severity={i.severity} />
                  <Link to={`/issues/${i.id}`} className="min-w-0 flex-1 basis-48 font-medium hover:underline">
                    {i.title}
                  </Link>
                  <span className="text-xs text-slate-500">{plural(i.affectedCount, 'page')}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="p-5 text-sm text-slate-600">No active issues above Informational were found by the checks that ran.</p>
          )}
        </Card>

        <Card>
          <CardHeader title="Pages tested" />
          <ul className="divide-y divide-slate-100 text-sm">
            {r.pages.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                <span className="min-w-0 flex-1 basis-56 break-all">{p.url}</span>
                <span className="font-mono text-xs">{p.statusCode ?? 'ERR'}</span>
                <span className="w-24 text-xs text-slate-500">{plural(p.findings, 'finding')}</span>
              </li>
            ))}
          </ul>
        </Card>

        {r.pages.some((p) => p.screenshots.length) && (
          <Card>
            <CardHeader title="Screenshot evidence" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              {r.pages
                .filter((p) => p.screenshots.length)
                .slice(0, 6)
                .map((p) => {
                  const sc = p.screenshots.find((x) => x.viewport === 'desktop') ?? p.screenshots[0];
                  return (
                    <figure key={p.id}>
                      <div className="h-56 overflow-hidden rounded-lg border border-slate-200">
                        <img src={sc.url} alt={`Screenshot of ${pathOf(p.url)} (${sc.viewport})`} loading="lazy" className="w-full object-cover object-top" />
                      </div>
                      <figcaption className="mt-1 text-xs text-slate-500">
                        {pathOf(p.url)} · {VIEWPORTS[sc.viewport].label}
                      </figcaption>
                    </figure>
                  );
                })}
            </div>
          </Card>
        )}

        <VerificationPanel counts={r.verification} summary={s.summary!} />
        <WordPressSection wp={s.summary?.wordpress} />

        <section className="print-break space-y-4">
          <h2 className="text-lg font-semibold">Issue details</h2>
          {r.issues.length ? r.issues.map((i) => <IssueBlock key={i.id} issue={i} />) : <p className="text-sm text-slate-600">No issues were detected.</p>}
        </section>

        {r.notCompleted.length > 0 && (
          <Card>
            <CardHeader title="Tests not completed" description="These checks did not run on every page, so absence of findings there means nothing." />
            <ul className="divide-y divide-slate-100 text-sm">
              {r.notCompleted.map((c) => (
                <li key={c.category} className="px-5 py-3">
                  <div className="flex items-center gap-2 font-medium">
                    {CATEGORY_INFO[c.category].label}
                    <CheckStatusBadge status={c.status} />
                  </div>
                  <p className="mt-1 text-slate-600">{c.detail}</p>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader title="Limitations" />
          <ul className="list-disc space-y-1.5 p-5 pl-10 text-sm text-slate-700">
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">Report generated {fmtDateTime(r.generatedAt)} from stored scan results.</p>
        </Card>
      </div>
    </div>
  );
}
