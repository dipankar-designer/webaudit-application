import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ListChecks, Search, X } from 'lucide-react';
import { CATEGORIES, CATEGORY_INFO, ISSUE_STATUSES, ISSUE_STATUS_LABELS, SEVERITIES, SEVERITY_LABELS, type IssueDTO, type WebsiteDTO } from '@wpcg/shared';
import { useApi } from '../lib/useApi';
import { fmtRelative, pathOf, plural } from '../lib/format';
import { Button, Card, EmptyState, ErrorState, IssueStatusBadge, LoadingState, PageHeader, SeverityBadge } from '../components/ui';

const LIMIT = 50;

export function IssuesPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'active';
  const severity = params.get('severity') ?? '';
  const category = params.get('category') ?? '';
  const websiteId = params.get('websiteId') ?? '';
  const scanId = params.get('scanId') ?? '';
  const q = params.get('q') ?? '';
  const page = Math.max(0, Math.floor(Number(params.get('page') ?? 0)) || 0);
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const query = new URLSearchParams({ status, limit: String(LIMIT), offset: String(page * LIMIT) });
  if (severity) query.set('severity', severity);
  if (category) query.set('category', category);
  if (websiteId) query.set('websiteId', websiteId);
  if (scanId) query.set('scanId', scanId);
  if (q) query.set('q', q);
  const { data, error, loading, reload } = useApi<{ items: IssueDTO[]; total: number }>(`/issues?${query}`, { keepPrevious: true });
  const websites = useApi<WebsiteDTO[]>('/websites');
  // A page past the end (issues resolved since, or an old link) would show "no issues" with no pager:
  // go to the last page that exists instead.
  const lastPage = data ? Math.max(0, Math.ceil(data.total / LIMIT) - 1) : 0;
  useEffect(() => {
    if (!loading && data && page > lastPage) set('page', lastPage ? String(lastPage) : '');
  }, [loading, data, page, lastPage]);
  const filtered = status !== 'active' || severity || category || websiteId || scanId || q;

  return (
    <>
      <PageHeader title="Issues" description="Every problem found by your scans, most severe first. Open an issue for evidence, step-by-step fixes and a verification scan." />
      <Card className="mb-4">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))]">
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              set('q', search.trim());
            }}
            className="relative sm:col-span-2 lg:col-span-1"
          >
            <label htmlFor="issue-search" className="sr-only">Search issues</label>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input id="issue-search" className="input pl-9" placeholder="Search by title or rule" value={search} onChange={(e) => setSearch(e.target.value)} />
          </form>
          <Select label="Status" value={status} onChange={(v) => set('status', v === 'active' ? '' : v)} options={[['active', 'Active (not resolved)'], ['review', 'Awaiting review (needs a person)'], ['all', 'All statuses'], ...ISSUE_STATUSES.map((s) => [s, ISSUE_STATUS_LABELS[s]] as [string, string])]} />
          <Select label="Severity" value={severity} onChange={(v) => set('severity', v)} options={[['', 'All severities'], ...SEVERITIES.map((s) => [s, SEVERITY_LABELS[s]] as [string, string])]} />
          <Select label="Category" value={category} onChange={(v) => set('category', v)} options={[['', 'All categories'], ...CATEGORIES.map((c) => [c, CATEGORY_INFO[c].label] as [string, string])]} />
          <Select label="Website" value={websiteId} onChange={(v) => set('websiteId', v)} options={[['', 'All websites'], ...(websites.data ?? []).map((w) => [w.id, w.name] as [string, string])]} />
        </div>
        {(scanId || filtered) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2.5 text-sm">
            {scanId && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs">
                Issues found in <Link to={`/scans/${scanId}`} className="font-medium underline">one scan</Link>
                <button type="button" onClick={() => set('scanId', '')} aria-label="Remove scan filter" className="ml-0.5 rounded-full p-0.5 hover:bg-slate-200">
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            )}
            <button type="button" className="ml-auto text-xs font-medium text-brand-700 hover:underline" onClick={() => setParams({}, { replace: true })}>
              Clear filters
            </button>
          </div>
        )}
      </Card>

      <Card>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <div className="p-5">
            <ErrorState error={error} onRetry={reload} />
          </div>
        ) : !data?.items.length ? (
          <EmptyState icon={<ListChecks className="size-6" aria-hidden />} title={filtered ? 'No issues match these filters' : 'No active issues'}>
            {filtered ? 'Try another filter.' : 'Either you have not run a scan yet, or every issue found so far has been resolved. Automated checks cannot catch everything, so keep scanning after changes.'}
          </EmptyState>
        ) : (
          <>
            <div className="border-b border-slate-100 px-5 py-2.5 text-xs text-slate-500">{plural(data.total, 'issue')}</div>
            <ul className="divide-y divide-slate-100">
              {data.items.map((i) => (
                <li key={i.id}>
                  <Link to={`/issues/${i.id}`} className="grid gap-2 px-5 py-3.5 hover:bg-slate-50 md:grid-cols-[7rem_minmax(0,1fr)_8rem_7rem] md:items-center">
                    <div>
                      <SeverityBadge severity={i.severity} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900">{i.title}</div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">
                        {i.websiteName} · {CATEGORY_INFO[i.category].label} · {i.affectedCount === 1 ? pathOf(i.affectedUrls[0] ?? '') : plural(i.affectedCount, 'page')}
                        {i.wcag.length > 0 && ` · WCAG ${i.wcag.join(', ')}`}
                      </div>
                    </div>
                    <div>
                      <IssueStatusBadge status={i.status} />
                    </div>
                    <div className="text-xs text-slate-500 md:text-right">Seen {fmtRelative(i.lastDetectedAt)}</div>
                  </Link>
                </li>
              ))}
            </ul>
            {data.total > LIMIT && (
              <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-sm">
                <span className="text-slate-600">
                  {page * LIMIT + 1}–{Math.min(data.total, (page + 1) * LIMIT)} of {data.total}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => set('page', String(page - 1))}>
                    Previous
                  </Button>
                  <Button size="sm" variant="secondary" disabled={(page + 1) * LIMIT >= data.total} onClick={() => set('page', String(page + 1))}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  const id = `f-${label.toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
