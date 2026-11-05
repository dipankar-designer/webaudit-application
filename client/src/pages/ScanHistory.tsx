import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { History, PlusCircle, Trash2 } from 'lucide-react';
import { emptySeverityCounts, type ScanDTO, type ScanStatus } from '@wpcg/shared';
import { errorMessage, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { fmtDateTime, fmtDuration, plural } from '../lib/format';
import { Alert, Button, Card, EmptyState, ErrorState, LinkButton, LoadingState, Modal, PageHeader, ScanStatusBadge, SeverityBar, cx } from '../components/ui';

const KIND_LABEL = { quick: 'Quick', full: 'Full', verification: 'Verification' } as const;

const isActive = (s: ScanDTO) => s.status === 'queued' || s.status === 'running';

/** Row selection and removal (Scan history only; other lists show the plain table). */
interface ScanTableActions {
  selected: Set<string>;
  onToggle: (id: string) => void;
  onRemove: (scan: ScanDTO) => void;
}

export function ScanTable({ scans, hideWebsite, actions }: { scans: ScanDTO[]; hideWebsite?: boolean; actions?: ScanTableActions }) {
  if (!scans.length) return <p className="px-5 py-6 text-sm text-slate-600">No scans yet.</p>;
  return (
    <ul className="divide-y divide-slate-100" aria-label="Scans">
      {scans.map((s) => (
        <li key={s.id} className={cx(actions && 'flex items-center', actions?.selected.has(s.id) && 'bg-brand-50/40')}>
          {actions && (
            <label
              className="flex shrink-0 cursor-pointer items-center self-stretch py-3.5 pr-1 pl-5"
              title={isActive(s) ? 'Queued or running scans cannot be deleted' : undefined}
            >
              <input
                type="checkbox"
                className="size-4 rounded accent-brand-600 disabled:cursor-not-allowed"
                checked={actions.selected.has(s.id)}
                disabled={isActive(s)}
                onChange={() => actions.onToggle(s.id)}
              />
              <span className="sr-only">
                Select the {s.websiteName} scan from {fmtDateTime(s.createdAt)}
                {isActive(s) ? ' (queued or running scans cannot be deleted)' : ''}
              </span>
            </label>
          )}
          <Link
            to={`/scans/${s.id}`}
            className={cx(
              'grid grid-cols-1 gap-2 py-3.5 hover:bg-slate-50 sm:grid-cols-[1fr_auto] sm:items-center md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_7rem_7rem]',
              actions ? 'min-w-0 flex-1 px-3' : 'px-5',
            )}
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-900">
                {hideWebsite ? fmtDateTime(s.createdAt) : s.websiteName}
                {s.isBaseline && <span className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700">Baseline</span>}
              </div>
              <div className="truncate text-xs text-slate-500">
                {KIND_LABEL[s.kind]} scan · {s.config.viewports.join(' + ')} · {hideWebsite ? fmtDuration(s.durationMs) : fmtDateTime(s.createdAt)}
              </div>
            </div>
            <div className="min-w-0 max-md:hidden">
              {s.status === 'completed' && s.summary ? (
                <>
                  <SeverityBar counts={s.summary.bySeverity ?? emptySeverityCounts()} />
                  <div className="mt-1 text-xs text-slate-500">
                    {plural(s.summary.issuesDetected, 'issue')} · {plural(s.summary.pagesScanned, 'page')}
                  </div>
                </>
              ) : s.status === 'running' ? (
                <div className="truncate text-xs text-slate-600">{s.progress?.message ?? 'Starting…'}</div>
              ) : s.status === 'failed' ? (
                <div className="truncate text-xs text-red-700">{s.error}</div>
              ) : null}
            </div>
            <div className="text-xs text-slate-500 max-md:hidden">{s.summary ? `${s.summary.newIssues} new · ${s.summary.resolvedIssues} fixed` : ''}</div>
            <div className="sm:justify-self-end">
              <ScanStatusBadge status={s.status} />
            </div>
          </Link>
          {actions && (
            <div className="shrink-0 pr-4">
              {isActive(s) ? (
                // Keeps the column aligned; a running scan is cancelled from its own page first.
                <span className="block size-8" aria-hidden />
              ) : (
                <button
                  type="button"
                  onClick={() => actions.onRemove(s)}
                  className="inline-flex size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-800"
                  aria-label={`Remove the ${s.websiteName} scan from ${fmtDateTime(s.createdAt)}`}
                  title="Remove scan"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ScanHistoryPage() {
  const [status, setStatus] = useState<ScanStatus | ''>('');
  const [page, setPage] = useState(0);
  const limit = 25;
  const { data, error, loading, reload } = useApi<{ items: ScanDTO[]; total: number }>(`/scans?limit=${limit}&offset=${page * limit}${status ? `&status=${status}` : ''}`, {
    keepPrevious: true,
    pollMs: 4000,
    shouldPoll: (d) => d.items.some((s) => s.status === 'queued' || s.status === 'running'),
  });

  // Selection is per visible page; changing page or filter clears it so nothing hidden gets deleted.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ScanDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const items = data?.items ?? [];
  const deletable = items.filter((s) => !isActive(s));
  // Scans that started running since being ticked drop out of the selection.
  const chosen = deletable.filter((s) => selected.has(s.id));
  const allChosen = deletable.length > 0 && chosen.length === deletable.length;
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = chosen.length > 0 && !allChosen;
  }, [chosen.length, allChosen]);
  const goTo = (fn: () => void) => {
    setSelected(new Set());
    fn();
  };
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = async () => {
    if (!confirm) return;
    setBusy(true);
    setDeleteError(null);
    try {
      const r = await post<{ deleted: number; skipped: { id: string; reason: string }[] }>('/scans/delete', { ids: confirm.map((s) => s.id) });
      setNotice(
        `${plural(r.deleted, 'scan')} deleted.${r.skipped.length ? ` ${plural(r.skipped.length, 'scan')} could not be deleted: ${[...new Set(r.skipped.map((s) => s.reason))].join(' ')}` : ''}`,
      );
      setConfirm(null);
      setSelected(new Set());
      // Deleting everything on a later page would leave an empty page: step back one.
      if (page > 0 && r.deleted >= items.length) setPage((p) => p - 1);
      reload();
    } catch (e) {
      setDeleteError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const baselinesInConfirm = confirm?.filter((s) => s.isBaseline).length ?? 0;

  return (
    <>
      <PageHeader
        title="Scan history"
        description="Every scan is kept until your retention period ends, so you can compare results over time."
        actions={
          <LinkButton to="/scans/new" icon={<PlusCircle className="size-4" aria-hidden />}>
            New scan
          </LinkButton>
        }
      />
      {notice && (
        <Alert tone="success" className="mb-4" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label htmlFor="status-filter" className="text-sm text-slate-600">
          Status
        </label>
        <select
          id="status-filter"
          className="input w-auto"
          value={status}
          onChange={(e) =>
            goTo(() => {
              setStatus(e.target.value as ScanStatus | '');
              setPage(0);
            })
          }
        >
          <option value="">All</option>
          <option value="running">Running</option>
          <option value="queued">Queued</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <Card>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <div className="p-5">
            <ErrorState error={error} onRetry={reload} />
          </div>
        ) : !data?.total && !status ? (
          <EmptyState icon={<History className="size-6" aria-hidden />} title="No scans yet" action={<LinkButton to="/scans/new">Start a scan</LinkButton>}>
            Your scans will be listed here with their results.
          </EmptyState>
        ) : (
          <>
            {deletable.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-100 px-5 py-2.5">
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input
                    ref={selectAll}
                    type="checkbox"
                    className="size-4 rounded accent-brand-600"
                    checked={allChosen}
                    onChange={() => setSelected(allChosen ? new Set() : new Set(deletable.map((s) => s.id)))}
                  />
                  Select all on this page
                </label>
                <span className="text-sm text-slate-500" aria-live="polite">
                  {chosen.length ? `${chosen.length} selected` : ''}
                </span>
                {chosen.length > 0 && (
                  <Button size="sm" variant="danger" className="ml-auto" onClick={() => setConfirm(chosen)} icon={<Trash2 className="size-4" aria-hidden />}>
                    Delete selected ({chosen.length})
                  </Button>
                )}
              </div>
            )}
            <ScanTable scans={items} actions={{ selected, onToggle: toggle, onRemove: (s) => setConfirm([s]) }} />
            {data!.total > limit && (
              <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-sm">
                <span className="text-slate-600">
                  {page * limit + 1}–{Math.min(data!.total, (page + 1) * limit)} of {data!.total}
                </span>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => goTo(() => setPage((p) => p - 1))}>
                    Previous
                  </Button>
                  <Button size="sm" variant="secondary" disabled={(page + 1) * limit >= data!.total} onClick={() => goTo(() => setPage((p) => p + 1))}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <Modal
        open={!!confirm}
        onClose={() => {
          setConfirm(null);
          setDeleteError(null);
        }}
        title={confirm?.length === 1 ? 'Delete this scan?' : `Delete ${confirm?.length ?? 0} scans?`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirm(null);
                setDeleteError(null);
              }}
            >
              Keep {confirm?.length === 1 ? 'it' : 'them'}
            </Button>
            <Button variant="danger" loading={busy} onClick={remove}>
              Delete {confirm?.length === 1 ? 'scan' : plural(confirm?.length ?? 0, 'scan')}
            </Button>
          </>
        }
      >
        {deleteError && (
          <Alert tone="error" className="mb-3">
            {deleteError}
          </Alert>
        )}
        {confirm?.length === 1 ? (
          <p>
            The <strong>{confirm[0].websiteName}</strong> scan from {fmtDateTime(confirm[0].createdAt)} is deleted with its pages, findings, screenshots and report.
          </p>
        ) : (
          <>
            <p>These scans are deleted with their pages, findings, screenshots and reports:</p>
            <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-slate-600" tabIndex={0} aria-label="Scans to delete">
              {confirm?.map((s) => (
                <li key={s.id}>
                  {s.websiteName} · {fmtDateTime(s.createdAt)}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-2">This cannot be undone. Issues stay in your list with their history from other scans.</p>
        {baselinesInConfirm > 0 && (
          <p className="mt-2 font-medium text-amber-800">
            {baselinesInConfirm === 1
              ? confirm?.length === 1
                ? 'This scan is a baseline'
                : 'One of these scans is a baseline'
              : `${baselinesInConfirm} of these scans are baselines`}
            : the baseline is removed too, and later scans can no longer be compared with it.
          </p>
        )}
      </Modal>
    </>
  );
}
