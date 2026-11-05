// Scan results explorer: a category list on the left ("All issues" plus one entry per check
// category) and that category's issues on the right, grouped by priority. The selection lives
// in the URL (?category=…&severity=…) so a filtered view can be shared or bookmarked.

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowRight, CheckCircle2, ChevronDown, LayoutList, MinusCircle } from 'lucide-react';
import {
  CATEGORIES,
  CATEGORY_INFO,
  SEVERITIES,
  SEVERITY_LABELS,
  type Category,
  type CheckRunDTO,
  type ReportDTO,
  type ReportIssueDTO,
  type Severity,
} from '@wpcg/shared';
import { categoryIcon } from '../lib/categoryIcons';
import { pathOf, plural } from '../lib/format';
import { CheckStatusBadge, IssueStatusBadge, Pagination, SEVERITY_STYLES, SeverityBadge, cx } from './ui';
import { LighthouseReport } from './Lighthouse';

type Selection = 'all' | Category;
const ROWS_PER_PAGE = 10;

function worstSeverity(issues: ReportIssueDTO[]): Severity | null {
  for (const s of SEVERITIES) if (issues.some((i) => i.severity === s)) return s;
  return null;
}

function IssueRow({ issue }: { issue: ReportIssueDTO }) {
  const r = issue.remediation;
  return (
    <li className="rounded-xl border border-slate-200 bg-surface" data-issues="1">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 p-4">
        <SeverityBadge severity={issue.severity} />
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/issues/${issue.id}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
              {issue.title}
            </Link>
            {issue.changeInScan !== 'existing' && (
              <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-50">{issue.changeInScan === 'new' ? 'New' : 'Reopened'}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-600">{issue.description}</p>
          <p className="mt-1.5 text-xs text-slate-500">
            {issue.affectedCount === 1 ? pathOf(issue.affectedUrls[0] ?? '') : plural(issue.affectedCount, 'page')}
            {issue.affectedCount > 1 && issue.affectedUrls.length > 0 && ` · ${issue.affectedUrls.slice(0, 3).map(pathOf).join(', ')}${issue.affectedCount > 3 ? ', …' : ''}`}
            {issue.wcag.length > 0 && ` · WCAG ${issue.wcag.join(', ')}`}
            {issue.evidence[0]?.viewport && ` · ${issue.evidence[0].viewport}`}
          </p>
        </div>
        <IssueStatusBadge status={issue.status} />
      </div>
      <details className="group border-t border-slate-100">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium text-brand-700 hover:bg-slate-50">
          How to fix
          <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden />
        </summary>
        <div className="space-y-3 px-4 pb-4 text-sm text-slate-700">
          <p>{r.whyItMatters}</p>
          <ol className="list-decimal space-y-1.5 pl-5 marker:text-slate-500">
            {r.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {r.codeExample && <pre className="code-block">{r.codeExample.after}</pre>}
          <Link to={`/issues/${issue.id}`} className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
            Evidence, verification and full details
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </details>
    </li>
  );
}

/** Issues that share a rule (one issue per page, e.g. contrast on 9 pages) are shown as one row. */
function groupByRule(issues: ReportIssueDTO[]): ReportIssueDTO[][] {
  const groups = new Map<string, ReportIssueDTO[]>();
  for (const i of issues) groups.set(i.ruleId, [...(groups.get(i.ruleId) ?? []), i]);
  return [...groups.values()];
}

function IssueGroupRow({ issues }: { issues: ReportIssueDTO[] }) {
  const first = issues[0];
  const r = first.remediation;
  const pages = issues.reduce((n, i) => n + i.affectedCount, 0);
  const newCount = issues.filter((i) => i.changeInScan === 'new').length;
  const reopened = issues.filter((i) => i.changeInScan === 'reopened').length;
  return (
    <li className="rounded-xl border border-slate-200 bg-surface" data-issues={issues.length}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 p-4">
        <SeverityBadge severity={first.severity} />
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-900">{first.title}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">{plural(pages, 'page')}</span>
            {newCount > 0 && <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-50">{newCount === issues.length ? 'New' : `${newCount} new`}</span>}
            {reopened > 0 && <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[11px] font-medium text-white">{reopened} reopened</span>}
          </div>
          <p className="mt-1 text-sm text-slate-600">{first.description}</p>
          {first.wcag.length > 0 && <p className="mt-1.5 text-xs text-slate-500">WCAG {first.wcag.join(', ')}</p>}
        </div>
      </div>
      <details className="group border-t border-slate-100">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium text-brand-700 hover:bg-slate-50">
          Affected pages and how to fix
          <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden />
        </summary>
        <div className="space-y-4 px-4 pb-4 text-sm text-slate-700">
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {issues.map((i) => (
              <li key={i.id}>
                <Link to={`/issues/${i.id}`} className="flex flex-wrap items-center gap-2 px-3 py-2 hover:bg-slate-50">
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{i.affectedUrls.map(pathOf).join(', ') || i.title}</span>
                  {i.evidence[0]?.viewport && <span className="text-xs text-slate-500">{i.evidence[0].viewport}</span>}
                  <IssueStatusBadge status={i.status} />
                  <ArrowRight className="size-4 text-slate-400" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          <p>{r.whyItMatters}</p>
          <ol className="list-decimal space-y-1.5 pl-5 marker:text-slate-500">
            {r.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {r.codeExample && <pre className="code-block">{r.codeExample.after}</pre>}
          <p className="text-xs text-slate-500">Open a page above for its own evidence, selectors and a verification scan.</p>
        </div>
      </details>
    </li>
  );
}

export function IssueExplorer({ report }: { report: ReportDTO }) {
  const [params, setParams] = useSearchParams();
  const runs = new Map<Category, CheckRunDTO>(report.checkRuns.map((r) => [r.category, r]));
  // Categories worth listing: selected for this scan, or with issues (e.g. availability findings).
  const categories = CATEGORIES.filter((c) => report.scan.config.checks.includes(c) || report.issues.some((i) => i.category === c));
  const byCategory = new Map<Category, ReportIssueDTO[]>(categories.map((c) => [c, report.issues.filter((i) => i.category === c)]));

  const rawSel = params.get('category');
  const selected: Selection = rawSel && (categories as string[]).includes(rawSel) ? (rawSel as Category) : 'all';
  const rawSev = params.get('severity');
  const severity: Severity | null = rawSev && (SEVERITIES as readonly string[]).includes(rawSev) ? (rawSev as Severity) : null;

  const select = (c: Selection) => {
    const next = new URLSearchParams(params);
    if (c === 'all') next.delete('category');
    else next.set('category', c);
    next.delete('severity');
    setParams(next, { replace: true, preventScrollReset: true });
  };
  const setSeverity = (s: Severity | null) => {
    const next = new URLSearchParams(params);
    if (s) next.set('severity', s);
    else next.delete('severity');
    setParams(next, { replace: true, preventScrollReset: true });
  };

  const inScope = selected === 'all' ? report.issues : byCategory.get(selected) ?? [];
  const visible = severity ? inScope.filter((i) => i.severity === severity) : inScope;
  // Rows (single issues or groups of the same rule) in priority order, 10 per page.
  const rows = SEVERITIES.flatMap((s) => groupByRule(visible.filter((i) => i.severity === s)).map((g) => ({ s, g })));
  const [listPage, setListPage] = useState(1);
  const listTop = useRef<HTMLDivElement>(null);
  useEffect(() => setListPage(1), [selected, severity]);
  const lastPage = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const currentListPage = Math.min(listPage, lastPage);
  const pageRows = rows.slice((currentListPage - 1) * ROWS_PER_PAGE, currentListPage * ROWS_PER_PAGE);
  const goToListPage = (p: number) => {
    setListPage(p);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    listTop.current?.focus({ preventScroll: true });
  };
  const run = selected === 'all' ? null : runs.get(selected);
  const sevCounts = Object.fromEntries(SEVERITIES.map((s) => [s, inScope.filter((i) => i.severity === s).length])) as Record<Severity, number>;

  const navItem = (key: Selection, label: string, icon: React.ReactNode, count: number, worst: Severity | null, note?: string) => {
    const active = selected === key;
    return (
      <li key={key}>
        <button
          type="button"
          onClick={() => select(key)}
          aria-current={active ? 'true' : undefined}
          className={cx(
            'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
            active ? 'bg-brand-50 font-semibold text-brand-800 ring-1 ring-brand-100' : 'text-slate-700 hover:bg-slate-100',
          )}
        >
          <span className={cx('shrink-0', active ? 'text-brand-700' : 'text-slate-500')}>{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{label}</span>
            {note && <span className="block truncate text-[11px] font-normal text-slate-500">{note}</span>}
          </span>
          {worst && <span className={cx('size-2 shrink-0 rounded-full', SEVERITY_STYLES[worst].dot)} aria-hidden />}
          <span className={cx('min-w-7 rounded-full px-2 py-0.5 text-center text-xs tabular-nums', count ? 'bg-slate-900 text-slate-50' : 'bg-slate-100 text-slate-500')}>{count}</span>
        </button>
      </li>
    );
  };

  const runNote = (c: Category) => {
    const r = runs.get(c);
    if (!r) return undefined;
    if (r.status === 'skipped') return 'Not run';
    if (r.status === 'unavailable') return 'Unavailable';
    if (r.status === 'failed') return 'Could not run';
    if (r.status === 'partial') return 'Partly tested';
    return undefined;
  };

  return (
    <section aria-labelledby="results-heading" className="card overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 id="results-heading" className="text-base font-semibold text-slate-900">
          Audit results
        </h2>
        <p className="mt-0.5 text-sm text-slate-600">Choose a category on the left to see its issues. Every issue includes evidence and step-by-step fixes.</p>
      </div>
      <div className="grid lg:grid-cols-[17rem_minmax(0,1fr)]">
        {/* Category list: a sidebar on large screens, a select on small ones. */}
        <div className="border-b border-slate-100 p-3 lg:border-r lg:border-b-0">
          <div className="lg:hidden">
            <label htmlFor="category-select" className="label px-1">
              Category
            </label>
            <select id="category-select" className="input" value={selected} onChange={(e) => select(e.target.value as Selection)}>
              <option value="all">All issues ({report.issues.length})</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_INFO[c].label} ({byCategory.get(c)!.length}){runNote(c) ? ` — ${runNote(c)}` : ''}
                </option>
              ))}
            </select>
          </div>
          <nav aria-label="Issue categories" className="hidden lg:block">
            <ul className="space-y-0.5">
              {navItem('all', 'All issues', <LayoutList className="size-[18px]" aria-hidden />, report.issues.length, worstSeverity(report.issues))}
            </ul>
            <div className="mx-3 my-2 border-t border-slate-100" />
            <ul className="space-y-0.5">
              {categories.map((c) => navItem(c, CATEGORY_INFO[c].label, categoryIcon(c, 'size-[18px]'), byCategory.get(c)!.length, worstSeverity(byCategory.get(c)!), runNote(c)))}
            </ul>
          </nav>
        </div>

        <div className="min-w-0 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                {selected === 'all' ? <LayoutList className="size-5 text-slate-500" aria-hidden /> : <span className="text-slate-500">{categoryIcon(selected)}</span>}
                {selected === 'all' ? 'All issues' : CATEGORY_INFO[selected].label}
              </h3>
              <p className="mt-0.5 text-sm text-slate-600">
                {selected === 'all' ? `Every issue found in this scan, most important first.` : CATEGORY_INFO[selected].description}
              </p>
            </div>
            {run && <CheckStatusBadge status={run.status} />}
          </div>
          {run?.detail && <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{run.detail}</p>}

          {selected === 'performance' && run && run.status !== 'skipped' && run.status !== 'unavailable' && (
            <div className="mt-5">
              <LighthouseReport scanId={report.scan.id} wordpress={report.scan.summary?.wordpress} />
              {inScope.length > 0 && <h4 className="mt-8 text-sm font-semibold text-slate-900">Tracked performance issues</h4>}
            </div>
          )}

          {inScope.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by priority">
              <button
                type="button"
                onClick={() => setSeverity(null)}
                aria-pressed={!severity}
                className={cx('rounded-full border px-3 py-1 text-xs font-medium', !severity ? 'border-slate-900 bg-slate-900 text-slate-50' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}
              >
                All priorities · {inScope.length}
              </button>
              {SEVERITIES.filter((s) => sevCounts[s] > 0).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(severity === s ? null : s)}
                  aria-pressed={severity === s}
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium',
                    severity === s ? 'border-slate-900 bg-slate-900 text-slate-50' : 'border-slate-300 text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <span className={cx('size-2 rounded-full', SEVERITY_STYLES[s].dot)} aria-hidden />
                  {SEVERITY_LABELS[s]} · {sevCounts[s]}
                </button>
              ))}
            </div>
          )}

          <div ref={listTop} tabIndex={-1} className="mt-5 scroll-mt-6 focus:outline-none">
            {visible.length === 0 && selected === 'performance' && run && run.status !== 'skipped' && run.status !== 'unavailable' ? null : visible.length === 0 ? (
              run && (run.status === 'skipped' || run.status === 'unavailable') ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center">
                  <MinusCircle className="size-8 text-slate-400" aria-hidden />
                  <p className="mt-3 font-medium text-slate-900">Not tested in this scan</p>
                  <p className="mt-1 max-w-md text-sm text-slate-600">{run.detail || 'This category was not selected.'} Run a Full scan to include it.</p>
                </div>
              ) : (
                <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center">
                  <CheckCircle2 className="size-8 text-emerald-600" aria-hidden />
                  <p className="mt-3 font-medium text-slate-900">No issues found{selected === 'all' ? '' : ` in ${CATEGORY_INFO[selected].label}`}</p>
                  <p className="mt-1 max-w-md text-sm text-slate-600">
                    {run?.status === 'partial' || run?.status === 'failed'
                      ? 'Note: this check did not run on every page, so some problems may not have been tested.'
                      : 'The checks that ran did not detect problems. Automated testing cannot catch everything.'}
                  </p>
                </div>
              )
            ) : (
              <div className="space-y-6">
                {SEVERITIES.filter((s) => pageRows.some((r) => r.s === s)).map((s) => (
                  <div key={s}>
                    <h4 className={cx('mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide uppercase', SEVERITY_STYLES[s].text)}>
                      <span className={cx('size-2 rounded-full', SEVERITY_STYLES[s].dot)} aria-hidden />
                      {SEVERITY_LABELS[s]} priority · {visible.filter((i) => i.severity === s).length}
                    </h4>
                    <ul className="space-y-3">
                      {pageRows
                        .filter((r) => r.s === s)
                        .map(({ g }) => (g.length === 1 ? <IssueRow key={g[0].id} issue={g[0]} /> : <IssueGroupRow key={g[0].ruleId} issues={g} />))}
                    </ul>
                  </div>
                ))}
                <Pagination page={listPage} pageSize={ROWS_PER_PAGE} total={rows.length} onChange={goToListPage} label="Issues" />
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
