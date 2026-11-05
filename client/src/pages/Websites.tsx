import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ExternalLink, Globe, PlusCircle, Trash2 } from 'lucide-react';
import type { BaselineDTO, IssueDTO, ScanDTO, WebsiteDTO } from '@wpcg/shared';
import { del, errorMessage, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { fmtDateTime, fmtRelative, hostOf, plural } from '../lib/format';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  IssueStatusBadge,
  LinkButton,
  LoadingState,
  Modal,
  PageHeader,
  ScanStatusBadge,
  SeverityBadge,
} from '../components/ui';
import { ScanTable } from './ScanHistory';

export function WebsitesPage() {
  const { data, error, loading, reload } = useApi<WebsiteDTO[]>('/websites');
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<WebsiteDTO | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await del(`/websites/${removing.id}`);
      setNotice(`${removing.name} was removed.`);
      setRemoving(null);
      reload();
    } catch (err) {
      setRemoveError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setFormError(null);
    try {
      await post('/websites', { url: f.get('url'), name: f.get('name') || undefined });
      setAdding(false);
      reload();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Websites"
        description="Sites in this workspace. A website is added automatically the first time you scan it."
        actions={
          <>
            <Button variant="secondary" onClick={() => { setFormError(null); setAdding(true); }} icon={<PlusCircle className="size-4" aria-hidden />}>
              Add website
            </Button>
            <LinkButton to="/scans/new">New scan</LinkButton>
          </>
        }
      />
      {notice && (
        <Alert tone="success" className="mb-4" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {loading && !data ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={<Globe className="size-6" aria-hidden />} title="No websites yet" action={<LinkButton to="/scans/new">Scan a website</LinkButton>}>
            Start a scan and the website will appear here with its history and open issues.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((w) => (
            <article key={w.id} className="card group relative p-5 transition focus-within:border-brand-500/60 hover:border-brand-500/40 hover:shadow-md">
              <div className="flex items-start gap-3 pr-10">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                  <Globe className="size-5" aria-hidden />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate font-semibold text-slate-900 group-hover:text-brand-700">
                    {/* The link covers the whole card; the Remove button sits above it. */}
                    <Link to={`/websites/${w.id}`} className="rounded after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none">
                      {w.name}
                    </Link>
                  </h2>
                  <p className="truncate text-sm text-slate-500">{w.baseUrl}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRemoving(w)}
                className="absolute top-4 right-4 z-10 inline-flex items-center gap-1.5 rounded-lg border border-transparent p-2 text-sm text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-800"
                aria-label={`Remove ${w.name}`}
                title="Remove website"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
              <dl className="mt-5 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">Active issues</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{w.activeIssues}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Scans</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{w.scanCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Last scan</dt>
                  <dd className="mt-1 text-xs text-slate-700">{w.lastScanAt ? fmtRelative(w.lastScanAt) : 'Never'}</dd>
                </div>
              </dl>
              {w.lastScanStatus && (
                <div className="mt-4">
                  <ScanStatusBadge status={w.lastScanStatus} />
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <Modal
        open={!!removing}
        onClose={() => {
          setRemoving(null);
          setRemoveError(null);
        }}
        title={`Remove ${removing?.name ?? 'website'}?`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setRemoving(null);
                setRemoveError(null);
              }}
            >
              Keep it
            </Button>
            <Button variant="danger" loading={busy} onClick={remove}>
              Remove website
            </Button>
          </>
        }
      >
        {removeError && (
          <Alert tone="error" className="mb-3">
            {removeError}
          </Alert>
        )}
        <p>
          This permanently deletes <strong>{removing?.baseUrl}</strong> and its {removing ? plural(removing.scanCount, 'scan') : 'scans'}, {removing ? plural(removing.activeIssues, 'active issue') : 'issues'}, reports, screenshots
          and baselines. This cannot be undone.
        </p>
        <p className="mt-2 text-slate-600">Monitors of this address keep running; they are only unlinked from the website.</p>
      </Modal>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a website"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" form="add-website" loading={busy}>
              Add website
            </Button>
          </>
        }
      >
        {/* Mounted only while open, so the form starts empty each time. */}
        {adding && (
          <form id="add-website" onSubmit={add} className="space-y-4">
            {formError && <Alert tone="error">{formError}</Alert>}
            <div>
              <label className="label" htmlFor="w-url">Website address</label>
              <input className="input" id="w-url" name="url" placeholder="https://example.com" required inputMode="url" />
              <p className="help">Public http or https sites only. Local, private and internal addresses are blocked for security.</p>
            </div>
            <div>
              <label className="label" htmlFor="w-name">Display name <span className="font-normal text-slate-500">(optional)</span></label>
              <input className="input" id="w-name" name="name" />
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

export function WebsiteDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const site = useApi<WebsiteDTO>(`/websites/${id}`);
  const scans = useApi<{ items: ScanDTO[]; total: number }>(`/scans?websiteId=${id}&limit=20`, {
    pollMs: 5000,
    shouldPoll: (d) => d.items.some((s) => s.status === 'queued' || s.status === 'running'),
  });
  const issues = useApi<{ items: IssueDTO[]; total: number }>(`/issues?websiteId=${id}&status=active&limit=8`);
  const baselines = useApi<BaselineDTO[]>(`/baselines?websiteId=${id}`);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (site.loading && !site.data) return <LoadingState />;
  if (site.error) return <ErrorState error={site.error} onRetry={site.reload} />;
  const w = site.data!;

  const remove = async () => {
    setBusy(true);
    try {
      await del(`/websites/${w.id}`);
      navigate('/websites');
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={<Link to="/websites" className="hover:underline">Websites</Link>}
        title={w.name}
        description={
          <a href={w.baseUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:underline">
            {w.baseUrl}
            <ExternalLink className="size-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(true)} icon={<Trash2 className="size-4" aria-hidden />}>
              Delete
            </Button>
            <LinkButton to={`/scans/new?websiteId=${w.id}`} icon={<PlusCircle className="size-4" aria-hidden />}>
              New scan
            </LinkButton>
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title="Scan history" description={plural(scans.data?.total ?? 0, 'scan')} />
            {scans.data ? <ScanTable scans={scans.data.items} hideWebsite /> : scans.error ? <ErrorState error={scans.error} onRetry={scans.reload} /> : <LoadingState />}
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Top open issues" actions={<Link to={`/issues?websiteId=${w.id}`} className="text-sm font-medium text-brand-700 hover:underline">All {issues.data?.total ?? ''}</Link>} />
            {!issues.data ? (
              issues.error ? <ErrorState error={issues.error} onRetry={issues.reload} /> : <LoadingState />
            ) : issues.data.items.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-600">No open issues from completed scans.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {issues.data.items.map((i) => (
                  <li key={i.id}>
                    <Link to={`/issues/${i.id}`} className="block px-5 py-3 hover:bg-slate-50">
                      <div className="flex flex-wrap gap-1.5">
                        <SeverityBadge severity={i.severity} />
                        <IssueStatusBadge status={i.status} />
                      </div>
                      <div className="mt-1.5 text-sm font-medium text-slate-900">{i.title}</div>
                      <div className="text-xs text-slate-500">{plural(i.affectedCount, 'page')}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Baselines" description="Saved scans used for visual comparison." />
            {baselines.error && !baselines.data ? (
              <ErrorState error={baselines.error} onRetry={baselines.reload} />
            ) : !baselines.data?.length ? (
              <p className="px-5 py-6 text-sm text-slate-600">No baselines yet. Open a completed scan and choose “Save as baseline”.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {baselines.data.map((b) => (
                  <li key={b.id} className="px-5 py-3">
                    <div className="font-medium">{b.name}</div>
                    <div className="text-xs text-slate-500">
                      {fmtDateTime(b.scanFinishedAt)} · {plural(b.screenshotCount, 'screenshot')} · {hostOf(w.baseUrl)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this website?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={remove} loading={busy}>
              Delete website and data
            </Button>
          </>
        }
      >
        {err && <Alert tone="error" className="mb-3">{err}</Alert>}
        <p>
          This permanently deletes <strong>{w.name}</strong> with all {plural(w.scanCount, 'scan')}, issues, screenshots and baselines. It cannot be undone.
        </p>
      </Modal>
    </>
  );
}
